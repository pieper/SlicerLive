// Headless reproduction WITH a volume: a smooth 32^3 field + a faint uniform-alpha TF, so every ray
// through the box accumulates a small, SHADED contribution (the "near-zero-opacity ray path"). Reads
// a through-volume pixel across the progressive tiers + accum frames. If it varies -> the flash.
//   deno run -A --unstable-webgpu render/test/bg-flash-vol.ts

import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ImageField } from "../fields.ts";

const gpu = await initDevice();
const W = 64, H = 64;
const FMT: GPUTextureFormat = "rgba8unorm-srgb";
const sr = new SceneRenderer(gpu, FMT);

const dims: [number, number, number] = [32, 32, 32];
const data = new Float32Array(32 * 32 * 32);
for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const dx = x - 15.5, dy = y - 15.5, dz = z - 15.5;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  data[x + 32 * (y + 32 * z)] = r < 8 ? 1.0 : 0.0;          // opaque ball at center, AIR (0) elsewhere
}
const lut = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {                             // HARD cutoff: air (low) = EXACTLY 0 opacity
  lut[i * 4] = 255; lut[i * 4 + 1] = 220; lut[i * 4 + 2] = 180;
  lut[i * 4 + 3] = i < 128 ? 0 : 255;
}
const field = new ImageField(gpu.device, data, dims, [1, 1, 1], lut, { clim: [0, 1] });
sr.build([field]);

const setCam = (w: number, h: number) => sr.setCamera([0, 0, 90], [0, 0, 0], [0, 1, 0], 30, w, h);

async function readPixels(fn: (v: GPUTextureView) => void, pts: [number, number][]): Promise<string[]> {
  const tex = gpu.device.createTexture({ size: [W, H], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  fn(tex.createView());
  const bpr = 256;
  const buf = gpu.device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [W, H, 1]);
  gpu.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const all = new Uint8Array(buf.getMappedRange().slice(0));
  const out = pts.map(([x, y]) => { const o = y * bpr + x * 4; return `${all[o]},${all[o + 1]},${all[o + 2]}`; });
  buf.unmap();
  return out;
}

// vertical scan through x=32: some rays miss the box, some traverse AIR inside the box, one hits the ball
const pts: [number, number][] = [[32, 6], [32, 12], [32, 18], [32, 24], [32, 32], [2, 2]];
setCam(W, H);
const rows: [string, string[]][] = [];
rows.push(["renderToView   ", await readPixels((v) => sr.renderToView(v, W, H), pts)]);
setCam(W / 2, H / 2);
rows.push(["renderUpscaled ", await readPixels((v) => sr.renderUpscaled(v, W / 2, H / 2, W, H), pts)]);
setCam(W, H);
for (let n = 1; n <= 5; n++) rows.push([`renderAccum #${n}  `, await readPixels((v) => sr.renderAccum(v, W, H, n === 1), pts)]);

console.log("\n  tier            " + pts.map((p) => `(${p[0]},${p[1]})`.padEnd(13)).join(""));
for (const [name, px] of rows) console.log("  " + name + " " + px.map((v) => v.padEnd(13)).join(""));
console.log();
for (let p = 0; p < pts.length; p++) {
  const vals = new Set(rows.map(([, px]) => px[p]));
  console.log(`  ray at ${JSON.stringify(pts[p])}: ${vals.size} distinct value(s)` + (vals.size > 1 ? "  <-- FLASHES" : ""));
}
console.log("\n  (18,20,31 = pure background; a through-AIR ray inside the box should equal it)\n");
