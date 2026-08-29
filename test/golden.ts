// Golden-image + readback helpers for GPU tests (tier T2). Deno and the browser share navigator.gpu, so a
// *.gpu.test.ts renders headless in Deno, reads pixels back, and compares against a checked-in PNG in
// render/test/golden/. Regenerate ONLY via `deno run -A test/run.ts --gpu --update-golden` (SL_UPDATE_GOLDEN=1)
// and review the diff. Comparison is tolerance-based (per-channel maxDiff, fraction of differing pixels)
// because different adapters round differently; byte-identical checks stay for same-process A/B diffs.
import { encodePNG } from "../render/png.ts";

export interface Image { width: number; height: number; data: Uint8Array }   // RGBA8, row-major, no padding

/** Copy a texture (rgba8*, RENDER_ATTACHMENT|COPY_SRC) into an unpadded RGBA8 array. */
export async function readbackRGBA(device: GPUDevice, texture: GPUTexture, width: number, height: number): Promise<Image> {
  const bpr = Math.ceil(width * 4 / 256) * 256;
  const buf = device.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture }, { buffer: buf, bytesPerRow: bpr }, [width, height, 1]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(src.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
  buf.unmap(); buf.destroy();
  return { width, height, data };
}

/** Render into a fresh texture of the given size via `draw(view)` and read it back. */
export async function renderToImage(device: GPUDevice, format: GPUTextureFormat, width: number, height: number, draw: (view: GPUTextureView) => void): Promise<Image> {
  const tex = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  draw(tex.createView());
  const img = await readbackRGBA(device, tex, width, height);
  tex.destroy();
  return img;
}

export interface ImageDiff { maxDiff: number; diffFraction: number; differing: number; total: number }
export function diffImages(a: Image, b: Image, perChannelTol = 0): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) return { maxDiff: 255, diffFraction: 1, differing: a.width * a.height, total: a.width * a.height };
  let maxDiff = 0, differing = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
    if (d > perChannelTol) differing++;
    if (d > maxDiff) maxDiff = d;
  }
  return { maxDiff, diffFraction: differing / n, differing, total: n };
}

/** Assert two same-process images are byte-identical (the strict A/B form). */
export function assertIdentical(a: Image, b: Image, what = "images"): void {
  const d = diffImages(a, b);
  if (d.differing) throw new Error(`${what} differ: ${d.differing}/${d.total} px, max channel diff ${d.maxDiff}`);
}

// --- goldens ---------------------------------------------------------------------------
const GOLDEN_DIR = "render/test/golden";
const updating = () => !!Deno.env.get("SL_UPDATE_GOLDEN");

/** Minimal PNG decode (8-bit RGB/RGBA, non-interlaced) — enough to read back what encodePNG writes. */
export async function decodePNG(bytes: Uint8Array): Promise<Image> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8, width = 0, height = 0, colorType = 6;
  const idat: Uint8Array[] = [];
  while (p < bytes.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { width = dv.getUint32(p + 8); height = dv.getUint32(p + 12); colorType = bytes[p + 8 + 9]; if (bytes[p + 8 + 8] !== 8) throw new Error("golden PNG must be 8-bit"); }
    else if (type === "IDAT") idat.push(body);
    p += 12 + len;
  }
  const z = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(z).arrayBuffer());
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error(`unsupported PNG color type ${colorType}`);
  const stride = width * ch, out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) { const o = (y * width + x) * 4; if (ch === 4) out.set(cur.subarray(x * 4, x * 4 + 4), o); else if (ch === 3) { out.set(cur.subarray(x * 3, x * 3 + 3), o); out[o + 3] = 255; } else { out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255; } }
    prev.set(cur);
  }
  return { width, height, data: out };
}

/** Compare `img` to render/test/golden/<name>.png. Missing golden or SL_UPDATE_GOLDEN=1 writes it (and passes). */
export async function assertGolden(img: Image, name: string, opts: { maxDiff?: number; maxFraction?: number } = {}): Promise<void> {
  const path = `${GOLDEN_DIR}/${name}.png`;
  const png = await encodePNG(img.data, img.width, img.height);
  let golden: Image | null = null;
  try { golden = await decodePNG(await Deno.readFile(path)); } catch { /* none yet */ }
  if (!golden || updating()) {
    await Deno.mkdir(GOLDEN_DIR, { recursive: true });
    await Deno.writeFile(path, png);
    console.log(`  golden ${golden ? "updated" : "created"}: ${path}`);
    return;
  }
  const d = diffImages(img, golden, opts.maxDiff ?? 2);
  const maxFraction = opts.maxFraction ?? 0.002;
  if (d.diffFraction > maxFraction) {
    await Deno.writeFile(`${GOLDEN_DIR}/${name}.actual.png`, png);
    throw new Error(`golden ${name}: ${d.differing}/${d.total} px differ by > ${opts.maxDiff ?? 2} (max ${d.maxDiff}); wrote ${name}.actual.png — run with --update-golden if intended`);
  }
}
