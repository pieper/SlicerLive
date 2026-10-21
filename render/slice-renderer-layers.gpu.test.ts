// T2: the slice composite's label layer and the foreground color LUT reach the screen.
//   deno test -A --unstable-webgpu --no-check render/slice-renderer-layers.gpu.test.ts
// All of them are set through the uniform buffer, so a write at the wrong float offset is silent: a field
// keeps a stale value and the layer draws wrong or not at all. These render a 4x4x4 volume placed off the
// origin (so the RAS->texture matrix has a translation, as a real volume's does) and read the pixels back.
import { assert } from "jsr:@std/assert@1";
import { initDevice } from "./device.ts";
import { SliceRenderer } from "./slice-renderer.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
const N = 4;
const LO: [number, number, number] = [-3, -3, -3], HI: [number, number, number] = [1, 1, 1];
// RAS [-3,1]^3 -> texture [0,1]^3: scale 1/N, translation 0.75 (column-major)
const p2t = new Float32Array([1 / N, 0, 0, 0, 0, 1 / N, 0, 0, 0, 0, 1 / N, 0, 0.75, 0.75, 0.75, 1]);

function volume(dev: GPUDevice, valueAt: (i: number, j: number, k: number) => number): GPUTexture {
  const data = new Float32Array(N * N * N);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) data[i + N * (j + N * k)] = valueAt(i, j, k);
  const tex = dev.createTexture({ size: [N, N, N], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  dev.queue.writeTexture({ texture: tex }, data, { bytesPerRow: N * 4, rowsPerImage: N }, [N, N, N]);
  return tex;
}
const filled = (dev: GPUDevice, v: number) => volume(dev, () => v);

async function renderer() {
  const gpu = await initDevice();
  const r = new SliceRenderer(gpu, "rgba8unorm");
  r.setVolume(p2t, LO, HI);
  r.setTextures(filled(gpu.device, 0));        // black background
  r.setWindowLevel(1, 0.5);
  r.setPlane("axial", 0.5);
  return { gpu, r };
}
const W = 16, H = 16;
const at = (px: Uint8Array, x: number, y: number) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
const is = (c: number[], r: boolean, g: boolean, b: boolean) =>
  (r ? c[0] > 200 : c[0] < 50) && (g ? c[1] > 200 : c[1] < 50) && (b ? c[2] > 200 : c[2] < 50);
const rgb = (c: number[]) => `rgb(${c.join(", ")})`;

Deno.test({ name: "slice composite: the label layer draws each label's color-table entry, where it is", ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false, async fn() {
  const { gpu, r } = await renderer();
  // label 1 in one half of the volume, label 2 in the other; table: 0 transparent, 1 red, 2 blue
  const labels = volume(gpu.device, (i) => (i < N / 2 ? 1 : 2));
  r.setLabelLayer(labels, p2t, new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255]), 1);
  const px = await r.renderToRGBA(W, H);
  const a = at(px, W / 4, H / 2), b = at(px, (3 * W) / 4, H / 2);
  const red = (c: number[]) => is(c, true, false, false), blue = (c: number[]) => is(c, false, false, true);
  assert((red(a) && blue(b)) || (blue(a) && red(b)), `expected one half red and the other blue, got ${rgb(a)} and ${rgb(b)}`);
  gpu.device.destroy();
} });

Deno.test({ name: "slice composite: the foreground is colored through its LUT (row 1), and back to gray when cleared", ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false, async fn() {
  const { gpu, r } = await renderer();
  r.setForeground(filled(gpu.device, 1), p2t, 1, 0.5, 1, 0);   // fully opaque, alpha compositing
  const green = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { green[i * 4 + 1] = i; green[i * 4 + 3] = 255; }
  r.setLayerLUTs(null, green);
  const c1 = at(await r.renderToRGBA(W, H), W / 2, H / 2);
  assert(is(c1, false, true, false), `expected the foreground LUT's green, got ${rgb(c1)}`);
  r.setLayerLUTs(null, null);                                   // cleared: the grayscale ramp again
  const c2 = at(await r.renderToRGBA(W, H), W / 2, H / 2);
  assert(is(c2, true, true, true), `expected the foreground's gray (white at the top of the window), got ${rgb(c2)}`);
  gpu.device.destroy();
} });

Deno.test({ name: "slice composite: a label layer does not change how the foreground is colored", ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false, async fn() {
  const { gpu, r } = await renderer();
  r.setForeground(filled(gpu.device, 1), p2t, 1, 0.5, 1, 0);   // a plain gray foreground, no LUT
  r.setLabelLayer(filled(gpu.device, 0), p2t, new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255]), 1);   // label 0: transparent
  const c = at(await r.renderToRGBA(W, H), W / 2, H / 2);
  assert(is(c, true, true, true), `expected the foreground's gray (white), got ${rgb(c)}`);
  gpu.device.destroy();
} });
