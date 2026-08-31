// T2 (gpu): SliceRenderer.renderUpscaled — the adaptive 2D downsample path. A downsampled+blit frame
// must reproduce the native reslice's structure (not black, not garbage): same bright/dark regions,
// close mean brightness. Renders a synthetic volume natively and at 1/4 linear resolution and compares.
//   deno test --unstable-webgpu -A render/slice-renderer-upscale.gpu.test.ts
import { assert } from "jsr:@std/assert@1";
import { initDevice } from "./device.ts";
import { SliceRenderer } from "./slice-renderer.ts";
import { ImageField } from "./fields.ts";

let gpu: Awaited<ReturnType<typeof initDevice>> | null = null;
try { gpu = await initDevice(); } catch { /* no adapter → skip */ }

// Read back a renderUpscaled result: render into an offscreen COPY_SRC target, then map it.
async function upscaledRGBA(s: SliceRenderer, dev: GPUDevice, fmt: GPUTextureFormat, rw: number, rh: number, vw: number, vh: number): Promise<Uint8Array> {
  const target = dev.createTexture({ size: [vw, vh], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
  s.renderUpscaled(target.createView(), rw, rh, vw, vh);
  const bpr = Math.ceil((vw * 4) / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * vh, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: vh }, [vw, vh]);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(vw * vh * 4);
  for (let y = 0; y < vh; y++) out.set(padded.subarray(y * bpr, y * bpr + vw * 4), y * vw * 4);
  buf.unmap(); target.destroy(); buf.destroy();
  return out;
}

const meanLuma = (px: Uint8Array) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i]; return s / (px.length / 4); };

Deno.test({ name: "renderUpscaled reproduces the native reslice (downsampled, not black)", ignore: !gpu, async fn() {
  const dev = gpu!.device;
  const fmt: GPUTextureFormat = "rgba8unorm-srgb";
  // Synthetic 48^3 volume: a bright ball in the middle so the axial mid-slice has clear structure.
  const N = 48, data = new Float32Array(N * N * N);
  const c = (N - 1) / 2;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const d = Math.hypot(i - c, j - c, k - c);
    data[i + j * N + k * N * N] = d < N * 0.35 ? 200 : 10;
  }
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) lut.set([i, i, i, 255], i * 4);
  const f = new ImageField(dev, data, [N, N, N], [1, 1, 1], lut, { clim: [0, 255], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], shade: [1, 0, 0, 1] });
  const s = new SliceRenderer(gpu!, fmt);
  const [lo, hi] = f.aabb();
  s.setVolume(f.patientToTexture(), lo, hi);
  s.setTextures(f.volumeTexture());
  s.setWindowLevel(220, 110);
  s.setOverlayOpacity(0);
  s.setPlane("axial", 0.5);

  const V = 128;
  const native = await s.renderToRGBA(V, V);
  const moving = await upscaledRGBA(s, dev, fmt, 32, 32, V, V);   // 1/4 linear res → blit up

  const mNative = meanLuma(native), mMoving = meanLuma(moving);
  assert(mMoving > 5, `downsampled frame is not black (mean=${mMoving.toFixed(1)})`);
  assert(Math.abs(mMoving - mNative) < mNative * 0.25 + 8, `downsampled mean ${mMoving.toFixed(1)} tracks native ${mNative.toFixed(1)}`);

  // Structural agreement: per-pixel bright/dark classification agrees for the large majority. A blit of
  // garbage or a wrong transform would disagree widely.
  let agree = 0, total = V * V;
  for (let p = 0; p < total; p++) { const bn = native[p * 4] > 110, bm = moving[p * 4] > 110; if (bn === bm) agree++; }
  assert(agree / total > 0.9, `bright/dark agreement ${(agree / total * 100).toFixed(1)}% > 90%`);

  // Native pass-through (rw==vw): guard path must equal a plain renderToView within rounding.
  const passthru = await upscaledRGBA(s, dev, fmt, V, V, V, V);
  let same = 0; for (let p = 0; p < total; p++) if (Math.abs(passthru[p * 4] - native[p * 4]) <= 1) same++;
  assert(same / total > 0.99, `pass-through (rw==vw) equals native (${(same / total * 100).toFixed(1)}%)`);
} });
