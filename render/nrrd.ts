// Minimal NRRD reader for MorphoDepot specimen volumes — enough of the format
// (http://teem.sourceforge.net/nrrd/format.html) for the single-scalar-volume scans MorphoDepot
// ships: a text header, then one data block (raw or gzip). Returns a Float32 volume + the
// ijk→RAS matrix so it drops straight into ImageField. Runs in Deno (server) and the browser.
import type { Vec3 } from "./mat4.ts";

export interface Nrrd {
  data: Float32Array;              // scalars, (z,y,x) C-order — matches ImageField/SceneVolume
  dims: [number, number, number];  // nx, ny, nz (fastest → slowest)
  ijkToRAS: number[];              // row-major 4×4
  range: [number, number];         // observed [min, max]
}

const TYPE_BYTES: Record<string, number> = {
  "signed char": 1, "int8": 1, "int8_t": 1, "uchar": 1, "unsigned char": 1, "uint8": 1, "uint8_t": 1,
  "short": 2, "short int": 2, "signed short": 2, "signed short int": 2, "int16": 2, "int16_t": 2,
  "ushort": 2, "unsigned short": 2, "unsigned short int": 2, "uint16": 2, "uint16_t": 2,
  "int": 4, "signed int": 4, "int32": 4, "int32_t": 4, "uint": 4, "unsigned int": 4, "uint32": 4, "uint32_t": 4,
  "float": 4, "double": 8,
};

/** Parse NRRD bytes (header already de-gzipped is NOT required — the data block is decoded here). */
export async function parseNrrd(buf: Uint8Array): Promise<Nrrd> {
  // header ends at the first blank line (\n\n)
  let end = -1;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) { end = i + 2; break; }
  }
  if (end < 0) throw new Error("NRRD: no header terminator");
  const header = new TextDecoder("latin1").decode(buf.subarray(0, end));
  const lines = header.split("\n");
  if (!lines[0].startsWith("NRRD")) throw new Error("NRRD: bad magic");

  const f: Record<string, string> = {};
  for (const ln of lines.slice(1)) {
    if (!ln || ln.startsWith("#")) continue;
    const m = ln.match(/^([^:]+):[=]?\s*(.*)$/);
    if (m) f[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const type = (f["type"] ?? "").toLowerCase();
  const bpp = TYPE_BYTES[type];
  if (!bpp) throw new Error(`NRRD: unsupported type "${type}"`);
  const sizes = (f["sizes"] ?? "").split(/\s+/).map(Number);
  if (sizes.length !== 3) throw new Error(`NRRD: need dimension 3, got sizes [${sizes}]`);
  const [nx, ny, nz] = sizes as [number, number, number];
  const nvox = nx * ny * nz;
  const encoding = (f["encoding"] ?? "raw").toLowerCase();
  const little = (f["endian"] ?? "little").toLowerCase() !== "big";

  // ---- decode the data block ----
  let raw = buf.subarray(end);
  if (encoding === "gzip" || encoding === "gz") {
    raw = new Uint8Array(await new Response(new Response(raw).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  } else if (encoding !== "raw") {
    throw new Error(`NRRD: unsupported encoding "${encoding}" (raw/gzip only)`);
  }
  if (raw.length < nvox * bpp) throw new Error(`NRRD: short data (${raw.length} < ${nvox * bpp})`);

  const out = new Float32Array(nvox);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let lo = Infinity, hi = -Infinity;
  const read: (i: number) => number =
    type.includes("uchar") || type.includes("uint8") || type === "unsigned char" ? (i) => raw[i]
    : type.includes("char") || type === "int8" ? (i) => (raw[i] << 24) >> 24
    : type.includes("ushort") || type.includes("uint16") || type === "unsigned short" || type === "unsigned short int" ? (i) => dv.getUint16(i, little)
    : type.includes("short") ? (i) => dv.getInt16(i, little)
    : type.includes("uint") ? (i) => dv.getUint32(i, little)
    : type === "float" ? (i) => dv.getFloat32(i, little)
    : type === "double" ? (i) => dv.getFloat64(i, little)
    : (i) => dv.getInt32(i, little);
  for (let i = 0; i < nvox; i++) {
    const v = read(i * bpp);
    out[i] = v;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }

  // ---- ijk→RAS from space directions + origin (NRRD "space" is usually LPS → negate x,y) ----
  const dir = parseVectors(f["space directions"]);        // 3 column vectors (ijk axes in space mm)
  const org = parseVectors(f["space origin"] ?? "(0,0,0)")[0] ?? [0, 0, 0];
  const space = (f["space"] ?? "left-posterior-superior").toLowerCase();
  const toRAS = space.startsWith("right") ? [1, 1, 1] : [-1, -1, 1];   // LPS→RAS flips X,Y
  const c: number[][] = dir.length === 3 ? dir : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // row-major 4×4: columns are the i/j/k axis vectors, translation = origin
  const ijkToRAS = [
    toRAS[0] * c[0][0], toRAS[0] * c[1][0], toRAS[0] * c[2][0], toRAS[0] * org[0],
    toRAS[1] * c[0][1], toRAS[1] * c[1][1], toRAS[1] * c[2][1], toRAS[1] * org[1],
    toRAS[2] * c[0][2], toRAS[2] * c[1][2], toRAS[2] * c[2][2], toRAS[2] * org[2],
    0, 0, 0, 1,
  ];
  return { data: out, dims: [nx, ny, nz], ijkToRAS, range: [lo, hi] };
}

/** Fetch + parse an NRRD, reporting downloaded bytes. */
export async function loadNrrd(url: string, onBytes?: (n: number) => void): Promise<Nrrd> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`NRRD fetch ${res.status}`);
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes?.(value.length);
  }
  let total = 0; for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return parseNrrd(buf);
}

function parseVectors(s?: string): number[][] {
  if (!s) return [];
  const out: number[][] = [];
  const re = /\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1].split(",").map(Number));
  return out;
}

export const _vec3 = null as unknown as Vec3;   // keep the Vec3 import meaningful for tree-shakers
