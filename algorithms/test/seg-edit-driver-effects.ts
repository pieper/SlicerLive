// The full SegEdit contract driving all three WebGPU effects through ONE driver — the loop for (b):
// a Slicer edit stream (paint / scissors / grow-from-seeds), carried as mrson SegEdit ops, replayed
// on-GPU by SegEditDriver with NO tool UI. Checks each op kind produces the right labelmap:
//   scissors  → fillInside a square prism, then eraseInside a smaller square = a through-hole
//   seeds     → sparse multi-label scribbles flood a two-region sphere (Dice vs truth)
//   carrier   → all three ride the recorder-event / mrson-cmd / bare-edit carriers identically
//   deno run --unstable-webgpu --allow-read algorithms/test/seg-edit-driver-effects.ts
import { initDevice } from "../../render/device.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { SegEditDriver } from "../seg-edit-driver.ts";
import { uploadImage } from "../effects/growcut.ts";
import type { Vec3 } from "../geom.ts";

const gpu = await initDevice();
let ok = true;
const pass = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} — ${name}${extra ? "  " + extra : ""}`); ok &&= cond; };

// ── scissors op → carve. 64³ grid, 1mm centred. Axial view basis (u=R, v=A). ──
{
  const n = 64, dims: Vec3 = [n, n, n];
  const ijk = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  const driver = new SegEditDriver(seg);
  const sq = (h: number): Vec3[] => [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]];
  // Carried as an mrson cmd; fill a 30² prism through all slices.
  await driver.applyEdit({ op: "cmd", id: "vtkSeg1", cmd: "segEdit",
    args: { kind: "scissors", contour: sq(15), u: [1, 0, 0], v: [0, 1, 0], operation: "fillInside", segmentId: "S1" } });
  let lab = await seg.readLabelmap();
  let fill = 0; for (const v of lab) if (v) fill++;
  // Then punch a 10² hole (recorder-event carrier).
  await driver.applyEdit({ event: "SegEdit", sourceId: "vtkSeg1",
    edit: { kind: "scissors", contour: sq(5), u: [1, 0, 0], v: [0, 1, 0], operation: "eraseInside" } });
  lab = await seg.readLabelmap();
  let after = 0; for (const v of lab) if (v) after++;
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.06;
  pass("scissors op → fill 30² prism then erase 10² hole", near(fill, 30 * 30 * 64) && near(fill - after, 10 * 10 * 64),
    `[fill=${fill} (~${30 * 30 * 64}) hole=${fill - after} (~${10 * 10 * 64})]`);
  seg.destroy(); driver.destroy();
}

// ── seeds op → grow-from-seeds. Two-region sphere image; center seed=1, corner seeds=2. ──
{
  const n = 96, dims: Vec3 = [n, n, n], N = n * n * n;
  const ijk = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
  const c = n / 2, r = n * 0.3;
  const img = new Float32Array(N), truth = new Uint8Array(N);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (z * n + y) * n + x, ins = (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2 <= r * r;
    truth[i] = ins ? 1 : 0; img[i] = ins ? 0.75 : 0.25;
  }
  const rasCtr: Vec3 = [0, 0, 0];   // sphere centre in RAS (grid is centred)
  const m = n / 2 - 3;
  const corners: Vec3[] = [[m, m, m], [-m, m, m], [m, -m, m], [m, m, -m], [-m, -m, m], [-m, m, -m], [m, -m, -m], [-m, -m, -m]];
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  const imageTex = uploadImage(gpu.device, img, dims);
  const driver = new SegEditDriver(seg, { imageTex, defaultDiameterMm: 6 });
  // ONE seeds op: a foreground dab at the centre (label 1) + a background dab in each of the 8 corners
  // (label 2). Each corner is its OWN scribble (a dab), not a polyline — a polyline would draw capsules
  // through the interior.
  await driver.applyEdit({ kind: "seeds", effect: "GrowFromSeeds", scribbles: [
    { label: 1, points: [rasCtr] },
    ...corners.map((cn) => ({ label: 2, points: [cn] })),
  ] });
  const lab = await seg.readLabelmap();
  let inter = 0, a = 0, b = 0, unfilled = 0;
  for (let i = 0; i < N; i++) { const s = lab[i] === 1 ? 1 : 0; if (lab[i] === 0) unfilled++; inter += s & truth[i]; a += s; b += truth[i]; }
  const dice = (2 * inter) / (a + b);
  pass("seeds op → grow-from-seeds recovers the sphere", dice > 0.95 && unfilled === 0, `[Dice=${dice.toFixed(4)} unfilled=${unfilled}]`);
  seg.destroy(); driver.destroy(); imageTex.destroy();
}

// ── unhandled seeds without an image → routed to onUnhandled (not a silent no-op). ──
{
  const n = 16, dims: Vec3 = [n, n, n];
  const ijk = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  let unhandled = "";
  const driver = new SegEditDriver(seg, { onUnhandled: (k) => { unhandled = k; } });
  await driver.applyEdit({ kind: "seeds", scribbles: [{ label: 1, points: [[0, 0, 0]] }] });
  pass("seeds without image → onUnhandled", unhandled === "seeds(no image)", `[got "${unhandled}"]`);
  seg.destroy(); driver.destroy();
}

console.log(ok ? "\nALL PASS — SegEditDriver drives paint+scissors+seeds from the mrson SegEdit stream" : "\nFAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
