// SlicerLive livecodec scene: a download-speed RACE between two volume codecs on
// the SAME CT scan — "LiveCodec neural" (tiny FSQ latents decoded by a 2.5 MB ONNX
// model) vs HTJ2K (per-slice OpenJPH HT codestreams). Two codec ROWS × (axial /
// sagittal / coronal / 3D), spine-compare-style: ONE SliceRenderer shared by both
// rows (the scalar texture is swapped per draw, geometry is identical), one camera
// links the 3D cells, and each row hot-swaps coarse→fine content IN PLACE via
// writeSlab (a z-slab writeTexture into the row's existing r32float volume — same
// visible result as the spine `upgraded` field swap, without re-allocating a
// ~0.5 GB texture per update).
//
// Data (CORS-enabled public bucket):
//   scans.json                     — the case list with per-codec byte budgets
//   scans/<id>/meta.json           — FSQ levels, chunk_z, latent shapes
//   scans/<id>/coarse.gz|fine.gz   — gzip uint8 codes [chunks, C, D, H', W']
//   scans/<id>/dc.gz               — gzip int8 mean-error/4-HU grid [zb, yb, xb]
//   scans/<id>/index.json + slices.bin — HTJ2K per-slice codestreams (uint16 = HU+1024)
//   model/decoder.onnx + decoder.json  — the neural decoder + dequant constants
import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { SliceRenderer } from "../../render/slice-renderer.ts";
import { ImageField } from "../../render/fields.ts";
import type { Vec3 } from "../../render/mat4.ts";

export const BUCKET = "https://js2.jetstream-cloud.org:8001/livecodec-demo/";

export interface ScanEntry {
  id: string;
  heldout: boolean;
  shape: [number, number, number];       // [Z, Y, X]
  spacing: [number, number, number];     // [z, y, x] mm
  bytes: { raw: number; coarse: number; fine: number; dc: number; htj2k: number };
}

export interface ScanMeta {
  shape: [number, number, number];
  spacing: [number, number, number];
  levels: number[];                      // FSQ levels, length C
  chunk_z: number;                       // z-slices per neural chunk (32)
  latent: { fine: number[]; coarse: number[]; chunks: number }; // per-chunk [1,C,D,H',W']
  bytes: ScanEntry["bytes"];
}

export interface DecoderMeta {
  levels: number[];
  offset: number[];                      // per-channel dequant offset
  half: number[];                        // per-channel dequant half-range
  hu_min: number;
  hu_max: number;
}

export interface SliceIndexEntry { z: number; offset: number; bytes: number }

// ── streaming fetch + gzip ───────────────────────────────────────────────────

/** Fetch a URL with a body reader so onBytes(cumulativeTotal) reports progress
 *  DURING the download (the progress bars are the whole point of this demo). */
export async function streamFetch(url: string, onBytes?: (total: number) => void): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    onBytes?.(buf.byteLength);
    return buf;
  }
  const parts: Uint8Array[] = [];
  const rd = resp.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    onBytes?.(total);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return all;
}

/** Inflate a gzip stream with the native DecompressionStream (no bundled zlib). */
export async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const buf = await new Response(new Response(gz as BufferSource).body!.pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

// ── neural latent decode helpers (pure CPU, no DOM / no ort dependency) ──────

export interface LatentShapes {
  C: number;                             // latent channels (5)
  Dc: number; Hc: number; Wc: number;    // coarse per-chunk latent dims
  Df: number; Hf: number; Wf: number;    // fine per-chunk latent dims (= 2x coarse)
  chunks: number;
  chunkZ: number;                        // output z-slices per chunk (32)
  H: number; W: number;                  // output slice dims
}

export function latentShapes(meta: ScanMeta): LatentShapes {
  const f = meta.latent.fine, c = meta.latent.coarse;
  const s: LatentShapes = {
    C: f[1], Df: f[2], Hf: f[3], Wf: f[4], Dc: c[2], Hc: c[3], Wc: c[4],
    chunks: meta.latent.chunks, chunkZ: meta.chunk_z, H: f[3] * 8, W: f[4] * 8,
  };
  if (s.Df !== 2 * s.Dc || s.Hf !== 2 * s.Hc || s.Wf !== 2 * s.Wc) {
    throw new Error(`latent shapes not 2x: fine [${f}] vs coarse [${c}]`);
  }
  return s;
}

/** Dequantize ONE chunk's coarse codes and upsample 2x NEAREST to the fine grid:
 *  zc_up[c,z,y,x] = (code[c, z>>1, y>>1, x>>1] - offset[c]) / half[c].  Output is
 *  [C, Df, Hf, Wf] flat — ready for an ort tensor of dims [1, C, Df, Hf, Wf]. */
export function dequantCoarseUp(codes: Uint8Array, chunk: number, s: LatentShapes, dec: DecoderMeta): Float32Array {
  const { C, Dc, Hc, Wc, Df, Hf, Wf } = s;
  const src = chunk * C * Dc * Hc * Wc;
  const out = new Float32Array(C * Df * Hf * Wf);
  let o = 0;
  for (let c = 0; c < C; c++) {
    const off = dec.offset[c], inv = 1 / dec.half[c];
    const cb = src + c * Dc * Hc * Wc;
    for (let z = 0; z < Df; z++) {
      const zb = cb + (z >> 1) * Hc * Wc;
      for (let y = 0; y < Hf; y++) {
        const yb = zb + (y >> 1) * Wc;
        for (let x = 0; x < Wf; x++) out[o++] = (codes[yb + (x >> 1)] - off) * inv;
      }
    }
  }
  return out;
}

/** Dequantize ONE chunk's fine codes (no upsample): [C, Df, Hf, Wf] flat. */
export function dequantFine(codes: Uint8Array, chunk: number, s: LatentShapes, dec: DecoderMeta): Float32Array {
  const { C, Df, Hf, Wf } = s;
  const per = Df * Hf * Wf;
  const src = chunk * C * per;
  const out = new Float32Array(C * per);
  let o = 0;
  for (let c = 0; c < C; c++) {
    const off = dec.offset[c], inv = 1 / dec.half[c];
    const cb = src + c * per;
    for (let i = 0; i < per; i++) out[o++] = (codes[cb + i] - off) * inv;
  }
  return out;
}

/** Map one chunk's decoder output ([-1,1] units, [1,1,chunkZ,H,W]) to HU and write
 *  it into the full volume at z0, trimming the padded z tail past Z. */
export function mapOutputToHU(out: Float32Array, vol: Float32Array, z0: number, Z: number, s: LatentShapes, dec: DecoderMeta): void {
  const sliceSize = s.H * s.W;
  const zw = Math.min(s.chunkZ, Z - z0);
  const scale = (dec.hu_max - dec.hu_min) / 2;
  const n = zw * sliceSize, base = z0 * sliceSize;
  for (let i = 0; i < n; i++) vol[base + i] = (out[i] + 1) * scale + dec.hu_min;
}

/** The dc grid dims for a volume shape: zb = floor(Z/min(64,Z)), yb = floor(Y/64),
 *  xb = floor(X/64) (values are mean error / 4 HU, int8). */
export function dcGridDims(shape: [number, number, number]): [number, number, number] {
  const [Z, Y, X] = shape;
  return [Math.floor(Z / Math.min(64, Z)), Math.floor(Y / 64), Math.floor(X / 64)];
}

/** Trilinearly upsample the int8 dc grid (×4 → HU) to the volume shape and SUBTRACT
 *  it. Grid cells are stretched over the whole volume (cell centres at
 *  (i+0.5)/n of each axis). Returns false (no-op) if the grid size doesn't match. */
export function applyDcCorrection(vol: Float32Array, shape: [number, number, number], grid: Int8Array): boolean {
  const [Z, Y, X] = shape;
  const [zb, yb, xb] = dcGridDims(shape);
  if (zb < 1 || yb < 1 || xb < 1 || zb * yb * xb !== grid.length) return false;
  // per-axis resample indices/weights, then zb bilinear planes, then a z-lerp sweep
  const axis = (n: number, g: number) => {
    const i0 = new Int32Array(n), i1 = new Int32Array(n), w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = Math.min(Math.max((i + 0.5) * g / n - 0.5, 0), g - 1);
      i0[i] = Math.floor(f); i1[i] = Math.min(i0[i] + 1, g - 1); w[i] = f - i0[i];
    }
    return { i0, i1, w };
  };
  const ax = axis(X, xb), ay = axis(Y, yb), az = axis(Z, zb);
  const planes: Float32Array[] = [];
  for (let gz = 0; gz < zb; gz++) {
    const p = new Float32Array(Y * X);
    const zoff = gz * yb * xb;
    for (let y = 0; y < Y; y++) {
      const r0 = zoff + ay.i0[y] * xb, r1 = zoff + ay.i1[y] * xb, wy = ay.w[y];
      for (let x = 0; x < X; x++) {
        const wx = ax.w[x];
        const a = grid[r0 + ax.i0[x]] * (1 - wx) + grid[r0 + ax.i1[x]] * wx;
        const b = grid[r1 + ax.i0[x]] * (1 - wx) + grid[r1 + ax.i1[x]] * wx;
        p[y * X + x] = (a * (1 - wy) + b * wy) * 4;   // grid stores mean error / 4 HU
      }
    }
    planes.push(p);
  }
  const ss = Y * X;
  for (let z = 0; z < Z; z++) {
    const pa = planes[az.i0[z]], pb = planes[az.i1[z]], wz = az.w[z], base = z * ss;
    if (wz < 1e-6) { for (let i = 0; i < ss; i++) vol[base + i] -= pa[i]; }
    else { for (let i = 0; i < ss; i++) vol[base + i] -= pa[i] + (pb[i] - pa[i]) * wz; }
  }
  return true;
}

// ── rendering scene ──────────────────────────────────────────────────────────

const WIN = 400, LEV = 40;               // soft-tissue W/L, same for both rows
const VR_CLIM: [number, number] = [-1024, 2000];

/** Bone-ish grayscale VR LUT: opacity ramps in above ~250 HU (quadratic). */
function vrLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = Math.max(0, (t - 0.42) / 0.58); a *= a;
    lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = Math.round(t * 255);
    lut[i * 4 + 3] = Math.round(Math.min(0.85, a * 1.3) * 255);
  }
  return lut;
}

/** Axial identity scaled by spacing, volume centred at the origin (orientation
 *  niceties are out of scope — both rows share the exact same grid). Row-major. */
export function ijkToRASFromSpacing(shape: [number, number, number], spacing: [number, number, number]): number[] {
  const [Z, Y, X] = shape;
  const sx = spacing[2], sy = spacing[1], sz = spacing[0];
  return [
    sx, 0, 0, -sx * (X - 1) / 2,
    0, sy, 0, -sy * (Y - 1) / 2,
    0, 0, sz, -sz * (Z - 1) / 2,
    0, 0, 0, 1,
  ];
}

export type RowKey = "neural" | "htj2k";

export interface CodecRow {
  vol: Float32Array;                     // CPU volume, C-order (z,y,x), HU — pipelines write here
  field: ImageField;
  scene: SceneRenderer;
}

export interface LiveCodecScene {
  shape: [number, number, number];       // [Z, Y, X]
  dims: [number, number, number];        // [X, Y, Z] (texture order)
  ijkToRAS: number[];
  rasLo: Vec3;
  rasHi: Vec3;
  center: Vec3;
  radius: number;
  win: number;
  lev: number;
  /** ONE slice renderer shared by both rows — bindRowSlice swaps the scalar texture. */
  slice: SliceRenderer;
  rows: Record<RowKey, CodecRow>;
  bindRowSlice(key: RowKey): void;
  /** Upload row.vol's z-slab [z0, z1) into that row's existing volume texture (the
   *  in-place coarse→fine hot-swap: geometry is fixed, only content streams in). */
  writeSlab(key: RowKey, z0: number, z1: number): void;
  destroy(): void;
}

/** Both rows' fields/scenes are built UP FRONT on an air-filled (-1024 HU) volume —
 *  geometry is known from scans.json before a single codec byte arrives, so cameras,
 *  slice offsets and interaction are live from t=0 and every later update is a cheap
 *  in-place slab upload. */
export function makeLiveCodecScene(
  gpu: Gpu,
  format: GPUTextureFormat,
  shape: [number, number, number],
  spacing: [number, number, number],
): LiveCodecScene {
  const dev = gpu.device;
  const [Z, Y, X] = shape;
  const dims: [number, number, number] = [X, Y, Z];
  const ijkToRAS = ijkToRASFromSpacing(shape, spacing);
  const lut = vrLUT();

  const mkRow = (): CodecRow => {
    const vol = new Float32Array(X * Y * Z).fill(-1024);
    const field = new ImageField(dev, vol, dims, [1, 1, 1], lut, {
      clim: VR_CLIM, ijkToRAS, shade: [0.25, 0.7, 0.45, 20],
    });
    const scene = new SceneRenderer(gpu, format);
    scene.build([field]);
    scene.setBackground(0.05, 0.06, 0.09);
    return { vol, field, scene };
  };
  const rows: Record<RowKey, CodecRow> = { neural: mkRow(), htj2k: mkRow() };

  const [rasLo, rasHi] = rows.neural.field.aabb();
  const slice = new SliceRenderer(gpu, format);
  slice.setVolume(rows.neural.field.patientToTexture(), rasLo, rasHi);
  slice.setWindowLevel(WIN, LEV);

  return {
    shape, dims, ijkToRAS, rasLo, rasHi,
    center: [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2],
    radius: Math.hypot(rasHi[0] - rasLo[0], rasHi[1] - rasLo[1], rasHi[2] - rasLo[2]) / 2,
    win: WIN, lev: LEV,
    slice, rows,
    bindRowSlice(key) { slice.setTextures(rows[key].field.volumeTexture()); },
    writeSlab(key, z0, z1) {
      z0 = Math.max(0, z0); z1 = Math.min(Z, z1);
      if (z1 <= z0) return;
      const row = rows[key];
      dev.queue.writeTexture(
        { texture: row.field.volumeTexture(), origin: [0, 0, z0] },
        row.vol.subarray(z0 * X * Y, z1 * X * Y),
        { bytesPerRow: X * 4, rowsPerImage: Y },
        [X, Y, z1 - z0],
      );
    },
    destroy() { /* fields/scenes live for the page's lifetime; a scan switch reloads */ },
  };
}

/** Load the case list. */
export async function loadScans(): Promise<ScanEntry[]> {
  const r = await fetch(BUCKET + "scans.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`scans.json HTTP ${r.status}`);
  return await r.json() as ScanEntry[];
}

/** Load one scan's meta.json. */
export async function loadScanMeta(id: string): Promise<ScanMeta> {
  const r = await fetch(`${BUCKET}scans/${id}/meta.json`);
  if (!r.ok) throw new Error(`meta.json HTTP ${r.status} for scan ${id}`);
  return await r.json() as ScanMeta;
}

/** Load the neural decoder's dequant constants. */
export async function loadDecoderMeta(): Promise<DecoderMeta> {
  const r = await fetch(BUCKET + "model/decoder.json");
  if (!r.ok) throw new Error(`decoder.json HTTP ${r.status}`);
  return await r.json() as DecoderMeta;
}
