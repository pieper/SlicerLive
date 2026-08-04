// A-1b verification: SegEditDriver consumes the mrson SegEdit stream (no human events) and paints.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/seg-edit-driver.ts
// Checks: (1) unwrap accepts all three carriers (recorder event / mrson cmd / bare edit);
//         (2) a committed stroke op paints a continuous tube (replay path);
//         (3) the incremental path (begin/addPoint×N/end) grows monotonically (real-time apply).
import { initDevice } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { SegEditDriver } from "../seg-edit-driver.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../geom.ts";

const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];
const vox = (r: Vec3): [number, number, number] => [Math.round((r[0] + 96) / sp), Math.round((r[1] + 96) / sp), Math.round((r[2] + 96) / sp)];
const at = (lab: Uint32Array, v: Vec3): number => { const [i, j, k] = vox(v); return lab[(k * dims[1] + j) * dims[0] + i]; };
let ok = true;

// (1) unwrap the three carrier shapes → the same payload.
const edit = { kind: "stroke", segmentId: "Segment_1", effect: "Paint", points: [[-40, 0, 0], [40, 0, 0]], brush: { shape: "sphere", diameterMm: 12 }, mode: "add" };
const asEvent = { event: "SegEdit", sourceId: "vtkSeg1", edit };
const asCmd = { op: "cmd", id: "vtkSeg1", cmd: "segEdit", args: edit };
const u1 = SegEditDriver.unwrap(asEvent), u2 = SegEditDriver.unwrap(asCmd), u3 = SegEditDriver.unwrap(edit);
const unwrapOk = !!u1 && !!u2 && !!u3 && u1.kind === "stroke" && u2.kind === "stroke" && u3.kind === "stroke";
console.log(`unwrap(event/cmd/bare) → stroke: ${unwrapOk ? "PASS" : "FAIL"}`);
ok &&= unwrapOk;

// (2) committed stroke op (recorder-event carrier) → continuous tube via the mrson contract.
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const driver = new SegEditDriver(seg);
driver.applyEdit(asEvent);
const lab = await seg.readLabelmap();
const mid = at(lab, [0, 0, 0]), e0 = at(lab, [-40, 0, 0]), e1 = at(lab, [40, 0, 0]), off = at(lab, [0, 40, 0]);
const committedOk = e0 === 1 && mid === 1 && e1 === 1 && off === 0;
console.log(`committed stroke op → tube (ends+mid set, off clear): ${committedOk ? "PASS" : "FAIL"} [e0=${e0} mid=${mid} e1=${e1} off=${off}]`);
ok &&= committedOk;

// (3) incremental path: 6 samples along an arc, applied one at a time; count grows every step.
const seg2 = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic2 = new SegmentationLogic(gpu.device, seg2, { color: [0.9, 0.6, 0.3], opacity: 1.0, sigmaVoxels: 1.0 });
const d2 = new SegEditDriver(seg2, { defaultDiameterMm: 12 });
const scene = new SceneRenderer(gpu);
scene.build([logic2.field()]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera([90, -430, 150], [0, 0, 0], [0, 0, 1], 30, 480, 480);
// Color-agnostic "painted" count: any pixel brighter than the dark background (~13/255).
const countPainted = (rgba: Uint8Array): number => { let n = 0; for (let i = 0; i < 480 * 480; i++) { if (Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 45) n++; } return n; };

d2.beginStroke({ segmentId: "Segment_1", effect: "Paint" });
const arc: Vec3[] = [[-45, -30, 0], [-25, -5, 5], [0, 8, 8], [25, -2, 4], [45, -25, -2]];
let prev = 0, grew = true;
for (let i = 0; i < arc.length; i++) {
  d2.addPoint(arc[i]);
  const c = countPainted(await scene.renderToRGBA(480, 480));
  if (i > 0 && c <= prev) grew = false;
  console.log(`  addPoint ${i}: green=${c}`);
  prev = c;
}
d2.endStroke();
console.log(`incremental stroke grows monotonically: ${grew ? "PASS" : "FAIL"}`);
ok &&= grew;

console.log(ok ? "ALL PASS — SegEditDriver drives paint from the mrson SegEdit stream" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
