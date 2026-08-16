// Offline KiTS case IO + a dependency-free PNG writer, for headless (Deno) feature work.
// Cache dir: $KITS_DIR (absolute) if set, else ./kits-cache next to this file.
const _envDir = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("KITS_DIR");
const CACHE = _envDir ? new URL(`file://${_envDir.replace(/\/?$/, "/")}`) : new URL("./kits-cache/", import.meta.url);

export interface Case {
  pid: string;
  ct: Int16Array;              // HU, C-order (k slowest)
  lab: Uint8Array;             // 0 bg, 1 kidney, 2 mass
  dims: [number, number, number]; // [nx, ny, nz]
  ijkToRAS: number[];          // row-major 4x4
  win: number; lev: number;
  names: Record<number, string>;
}

export async function loadCase(pid: string): Promise<Case> {
  const meta = JSON.parse(await Deno.readTextFile(new URL(`${pid}.json`, CACHE)));
  const ctBuf = await Deno.readFile(new URL(`${pid}.ct.i16`, CACHE));
  const labBuf = await Deno.readFile(new URL(`${pid}.lab.u8`, CACHE));
  const ct = new Int16Array(ctBuf.buffer, ctBuf.byteOffset, ctBuf.byteLength / 2);
  const lab = new Uint8Array(labBuf.buffer, labBuf.byteOffset, labBuf.byteLength);
  return { pid, ct, lab, dims: meta.dims, ijkToRAS: meta.ijkToRAS, win: meta.win, lev: meta.lev, names: meta.names };
}

export function idx(dims: [number, number, number], x: number, y: number, z: number): number {
  return x + dims[0] * (y + dims[1] * z);
}

// Downsample in-plane by integer factor f (keep z): CT = block mean, label = block max
// (so mass(2) > kidney(1) > bg survive). Cuts memory/compute ~f^2. Scales ijkToRAS i,j cols.
export function downsampleXY(c: Case, f = 2): Case {
  const [nx, ny, nz] = c.dims; const mx = Math.ceil(nx / f), my = Math.ceil(ny / f);
  const ct = new Int16Array(mx * my * nz); const lab = new Uint8Array(mx * my * nz);
  for (let z = 0; z < nz; z++) for (let Y = 0; Y < my; Y++) for (let X = 0; X < mx; X++) {
    let s = 0, n = 0, ml = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const x = X * f + dx, y = Y * f + dy; if (x >= nx || y >= ny) continue;
      const i = x + nx * (y + ny * z); s += c.ct[i]; n++; const l = c.lab[i]; if (l > ml) ml = l;
    }
    const o = X + mx * (Y + my * z); ct[o] = Math.round(s / n); lab[o] = ml;
  }
  const M = c.ijkToRAS.slice(); for (let r = 0; r < 3; r++) { M[r * 4] *= f; M[r * 4 + 1] *= f; }
  return { ...c, ct, lab, dims: [mx, my, nz], ijkToRAS: M };
}

// ---- PNG (truecolor RGBA, filter 0, zlib via CompressionStream) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // RFC1950 zlib stream = PNG IDAT
  const w = cs.writable.getWriter(); w.write(raw); w.close();
  const parts: Uint8Array[] = []; const rd = cs.readable.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); }
  const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(t, 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
export async function writePNG(path: string, w: number, h: number, rgba: Uint8Array): Promise<void> {
  const stride = w * 4; const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = await deflate(raw);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  await Deno.writeFile(path, out);
}

// CT window → grayscale RGBA; optional label overlay (RAS-agnostic; caller picks the plane)
export function huToGray(hu: number, lev: number, win: number): number {
  const lo = lev - win / 2, v = Math.max(0, Math.min(1, (hu - lo) / win));
  return Math.round(v * 255);
}
