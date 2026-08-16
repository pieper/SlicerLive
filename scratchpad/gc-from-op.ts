// WebGPU consumer of the shared mrson SegEdit case: reconstruct the synthetic image from the spec,
// then let SegEditDriver replay the `seeds` op (grow-from-seeds) on-GPU. Reports timing + Dice vs the
// analytic sphere. The SAME segedit_case.json feeds gc-from-op.py (Slicer) — one op, two pipelines.
import { initDevice } from "../render/device.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { SegEditDriver } from "../algorithms/seg-edit-driver.ts";
import { uploadImage } from "../algorithms/effects/growcut.ts";
import type { Vec3 } from "../algorithms/geom.ts";

const cs = JSON.parse(await Deno.readTextFile(new URL("./segedit_case.json", import.meta.url)));
const dims = cs.grid.dims as Vec3, ijk = cs.grid.ijkToRAS as number[];
const [nx, ny, nz] = dims, N = nx * ny * nz;
const c = cs.image.centerRAS as Vec3, r = cs.image.radiusMm as number;
// RAS→grid is the inverse of the (axis-aligned, 1mm) ijkToRAS; reconstruct the sphere image + truth.
const img = new Float32Array(N), truth = new Uint8Array(N);
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const R = i * ijk[0] + ijk[3], A = j * ijk[5] + ijk[7], S = k * ijk[10] + ijk[11];
  const ins = (R - c[0]) ** 2 + (A - c[1]) ** 2 + (S - c[2]) ** 2 <= r * r;
  const idx = (k * ny + j) * nx + i;
  truth[idx] = ins ? 1 : 0; img[idx] = ins ? cs.image.inside : cs.image.outside;
}

const gpu = await initDevice();
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
const imageTex = uploadImage(gpu.device, img, dims);
const driver = new SegEditDriver(seg, { imageTex });

const t0 = performance.now();
await driver.applyEdit(cs.op);
await gpu.device.queue.onSubmittedWorkDone();
const ms = performance.now() - t0;

const lab = await seg.readLabelmap();
let inter = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { const s = lab[i] === 1 ? 1 : 0; inter += s & truth[i]; a += s; b += truth[i]; }
console.log(JSON.stringify({ engine: "webgpu", n: nx, ms: Math.round(ms), dice: +(2 * inter / (a + b)).toFixed(4), seg1_vox: a, sphere_vox: b }));
seg.destroy(); driver.destroy(); imageTex.destroy(); gpu.device.destroy();
