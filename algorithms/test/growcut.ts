// GrowCut correctness + speed: a synthetic two-region image (bright sphere in dark bg + noise), a few
// seeds per region, grow to fill. Check the grown label 1 matches the true sphere (Dice) and time it.
//   deno run --unstable-webgpu --allow-read algorithms/test/growcut.ts
import { initDevice } from "../../render/device.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { GrowCutEffect, uploadImage } from "../effects/growcut.ts";
import type { Vec3 } from "../geom.ts";

const gpu = await initDevice();
const n = 128, dims: Vec3 = [n, n, n];
const ijk = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
const N = n * n * n;
const img = new Float32Array(N);
const truth = new Uint8Array(N);   // 1 = inside sphere
const c = n / 2, r = 40;
let rng = 12345;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const i = (z * n + y) * n + x;
  const inside = (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2 <= r * r;
  truth[i] = inside ? 1 : 0;
  img[i] = (inside ? 0.75 : 0.25) + (rand() - 0.5) * 0.15;   // clear contrast + noise
}

// Sparse seeds: label 1 at the sphere centre, label 2 in the 8 corners.
const seeds = new Uint8Array(N);
const put = (x: number, y: number, z: number, id: number) => { for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) seeds[((z + dz) * n + (y + dy)) * n + (x + dx)] = id; };
put(c, c, c, 1);
for (const [x, y, z] of [[6, 6, 6], [n - 7, 6, 6], [6, n - 7, 6], [6, 6, n - 7], [n - 7, n - 7, 6], [n - 7, 6, n - 7], [6, n - 7, n - 7], [n - 7, n - 7, n - 7]] as Vec3[]) put(x, y, z, 2);

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
seg.loadLabelmap(seeds);
const imageTex = uploadImage(gpu.device, img, dims);
const gc = new GrowCutEffect(seg, imageTex);

const t0 = performance.now();
const iters = await gc.grow();
await gpu.device.queue.onSubmittedWorkDone();
const ms = performance.now() - t0;

const out = await seg.readLabelmap();
let inter = 0, a = 0, b = 0, unfilled = 0;
for (let i = 0; i < N; i++) {
  const seg1 = out[i] === 1 ? 1 : 0;
  if (out[i] === 0) unfilled++;
  inter += seg1 & truth[i]; a += seg1; b += truth[i];
}
const dice = (2 * inter) / (a + b);
console.log(`GrowCut ${n}³: ${iters} iterations, ${ms.toFixed(0)}ms  (${(ms / iters).toFixed(1)}ms/iter)`);
console.log(`label-1 vs true sphere: Dice=${dice.toFixed(4)}  unfilled voxels=${unfilled}`);
const ok = dice > 0.95 && unfilled === 0;
console.log(ok ? "PASS — GPU growcut fills both regions and recovers the sphere (Dice>0.95)" : "FAIL");
seg.destroy(); gc.destroy(); imageTex.destroy(); gpu.device.destroy();
if (!ok) Deno.exit(1);
