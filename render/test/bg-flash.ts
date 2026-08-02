// Headless deterministic reproduction of the "background flashes across progressive tiers" bug.
// With build([]) (no fields) EVERY ray misses, so every pixel is the zero-opacity background — it
// must be byte-identical across all three progressive tiers (renderToView / renderUpscaled /
// renderAccum). Reads back the top-left pixel from each and prints them. Any difference = the flash.
//   deno run -A --unstable-webgpu render/test/bg-flash.ts

import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";

const gpu = await initDevice();
const W = 64, H = 64;
const FMT: GPUTextureFormat = "rgba8unorm-srgb";
const sr = new SceneRenderer(gpu, FMT);
sr.build([]);                               // empty scene -> all background

const cam = () => sr.setCamera([0, 0, 500], [0, 0, 0], [0, 1, 0], 30, W, H);

async function readTier(fn: (v: GPUTextureView) => void): Promise<number[]> {
  const tex = gpu.device.createTexture({ size: [W, H], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  fn(tex.createView());
  const bpr = 256;                          // W*4 = 256, already aligned
  const buf = gpu.device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [W, H, 1]);
  gpu.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const b = new Uint8Array(buf.getMappedRange().slice(0, 4));
  const px = [b[0], b[1], b[2], b[3]];
  buf.unmap();
  return px;
}

cam();
const toView = await readTier((v) => sr.renderToView(v, W, H));
sr.setCamera([0, 0, 500], [0, 0, 0], [0, 1, 0], 30, W / 2, H / 2);
const upscaled = await readTier((v) => sr.renderUpscaled(v, W / 2, H / 2, W, H));
cam();
const accum1 = await readTier((v) => sr.renderAccum(v, W, H, true));
const accum2 = await readTier((v) => sr.renderAccum(v, W, H, false));
const accum3 = await readTier((v) => sr.renderAccum(v, W, H, false));

const rows: [string, number[]][] = [
  ["renderToView   (moving, full-res)", toView],
  ["renderUpscaled (moving, low-res) ", upscaled],
  ["renderAccum #1 (settle reset)    ", accum1],
  ["renderAccum #2 (settle)          ", accum2],
  ["renderAccum #3 (settle)          ", accum3],
];
console.log("\n  background pixel (top-left, should be identical across tiers):");
for (const [name, px] of rows) console.log("  " + name + "  rgba(" + px.join(", ") + ")");
const ref = JSON.stringify(toView);
const differ = rows.filter(([, px]) => JSON.stringify(px) !== ref).map(([n]) => n.trim());
console.log(differ.length ? "\n  ❌ FLASH — these differ from renderToView: " + differ.join("; ") + "\n" : "\n  ✅ consistent — no flash\n");
Deno.exit(differ.length ? 1 : 0);
