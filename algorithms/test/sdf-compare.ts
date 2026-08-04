// A-1r verification: SDF render path vs Gaussian surface — crispness + bake timing.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/sdf-compare.ts
// Renders the same sphere both ways; writes PNGs; reports the soft-rim ratio (lower = crisper) and
// the SDF re-bake time (must be fast enough for live editing).
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../geom.ts";

const W = 512, H = 512;
const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

function sphere(): Uint8Array {
  const [nx, ny, nz] = dims, lab = new Uint8Array(nx * ny * nz), c = [48, 48, 48], rv = 20;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    if (dx * dx + dy * dy + dz * dz <= rv * rv) lab[(z * ny + y) * nx + x] = 1;
  }
  return lab;
}

// rim/green: fraction of coloured pixels in the soft partial-alpha band (lower = crisper edge).
function rimRatio(rgba: Uint8Array): number {
  let green = 0, rim = 0;
  for (let i = 0; i < W * H; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (g > 40 && g > r + 10 && g > b + 10) { green++; if (g < 150) rim++; }
  }
  return green ? rim / green : 0;
}

async function shot(mode: "surface" | "sdf", name: string): Promise<number> {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: mode, color: [0.30, 0.85, 0.55], opacity: 1.0, sigmaVoxels: 1.0 });
  seg.loadLabelmap(sphere());
  const scene = new SceneRenderer(gpu);
  scene.build([logic.field()]);
  scene.setBackground(0.05, 0.06, 0.09);
  scene.setCamera([90, -430, 150], [0, 0, 0], [0, 0, 1], 30, W, H);
  const rgba = await scene.renderToRGBA(W, H);
  await Deno.writeFile(new URL(`./sdf-cmp-${name}.png`, import.meta.url).pathname, await encodePNG(rgba, W, H));
  const ratio = rimRatio(rgba);

  // Re-bake timing (live-edit cost): trigger N in-place rebakes, await GPU, average.
  const N = 20, t0 = performance.now();
  for (let i = 0; i < N; i++) seg.markDirty();
  await gpu.device.queue.onSubmittedWorkDone();
  const dt = (performance.now() - t0) / N;
  console.log(`${name.padEnd(8)} rim/green=${ratio.toFixed(3)}  rebake≈${dt.toFixed(2)} ms`);
  seg.destroy(); logic.destroy();
  return ratio;
}

const surf = await shot("surface", "surface");
const sdf = await shot("sdf", "sdf");
console.log(`SDF crisper than Gaussian surface: ${sdf < surf ? "PASS" : "FAIL"} (${sdf.toFixed(3)} < ${surf.toFixed(3)})`);
gpu.device.destroy();
if (!(sdf < surf)) Deno.exit(1);
