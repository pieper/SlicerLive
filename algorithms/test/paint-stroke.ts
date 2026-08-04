// A-1a verification: PaintEffect interpolates sparse stroke samples into ONE continuous tube.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/paint-stroke.ts
// The decisive test: two points 80 mm apart with a 6 mm-radius brush. Without interpolation you'd get
// two separated dabs with an empty gap; the capsule fill means the MIDPOINT voxel (and the whole
// segment between) is painted. We read the labelmap back and assert exactly that.
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { PaintEffect } from "../effects/paint.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../geom.ts";

const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic = new SegmentationLogic(gpu.device, seg, { color: [0.30, 0.85, 0.55], opacity: 1.0, sigmaVoxels: 1.0 });
const paint = new PaintEffect(seg);

// RAS → voxel index (inverse of the diagonal ijkToRAS): i = (R + 96) / 2.
const vox = (ras: Vec3): [number, number, number] => [Math.round((ras[0] + 96) / sp), Math.round((ras[1] + 96) / sp), Math.round((ras[2] + 96) / sp)];
const at = (lab: Uint32Array, v: Vec3): number => { const [i, j, k] = vox(v); return lab[(k * dims[1] + j) * dims[0] + i]; };

// One stroke, two SPARSE samples 80 mm apart, 6 mm brush radius.
const P0: Vec3 = [-40, 0, 0], P1: Vec3 = [40, 0, 0];
paint.stampStroke([P0, P1], { radiusMm: 6, id: 1, mode: "add" });

const lab = await seg.readLabelmap();
const end0 = at(lab, P0), mid = at(lab, [0, 0, 0]), q = at(lab, [20, 0, 0]), end1 = at(lab, P1);
const off = at(lab, [0, 40, 0]);     // far off the stroke — must stay background
console.log(`stroke voxels: end0=${end0} quarter=${q} MID=${mid} end1=${end1}  off-stroke=${off}`);
const continuous = end0 === 1 && q === 1 && mid === 1 && end1 === 1 && off === 0;
console.log(continuous ? "PASS(interpolation) — sparse samples filled a continuous tube incl. midpoint" : "FAIL(interpolation)");

// Also render a bent 3-point stroke for the eye.
const seg2 = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic2 = new SegmentationLogic(gpu.device, seg2, { color: [0.35, 0.8, 0.95], opacity: 1.0, sigmaVoxels: 1.0 });
new PaintEffect(seg2).stampStroke([[-45, -30, -20], [30, -20, 10], [10, 45, 30]], { radiusMm: 7, id: 1, mode: "add" });
const scene = new SceneRenderer(gpu);
scene.build([logic2.field()]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera([90, -430, 150], [0, 0, 0], [0, 0, 1], 30, 640, 640);
await Deno.writeFile(new URL("./paint-stroke.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(640, 640), 640, 640));

gpu.device.destroy();
if (!continuous) Deno.exit(1);
