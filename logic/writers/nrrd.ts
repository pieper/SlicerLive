// NRRD writer (W7) — serialize a Volume to a .nrrd (detached header + inline raw/gzip data block). Writes in
// right-anterior-superior (RAS) space so no LPS flip is needed (coordinate discipline: RAS internal), with
// `space directions` = the ijkToRAS 3x3 columns and `space origin` = its translation. Slicer's NRRD reader
// honors the space field, so a written volume round-trips to the same ijkToRAS + voxels. Pure (bytes out).
import type { Volume } from "../readers/nifti.ts";

// zarr dtype -> NRRD type + bytes/sample + is-little-endian
const NRRD_TYPE: Record<string, { type: string; bytes: number; le: boolean }> = {
  "|u1": { type: "uchar", bytes: 1, le: true }, "|i1": { type: "signed char", bytes: 1, le: true },
  "<u1": { type: "uchar", bytes: 1, le: true }, "<i1": { type: "signed char", bytes: 1, le: true },
  "<u2": { type: "ushort", bytes: 2, le: true }, "<i2": { type: "short", bytes: 2, le: true },
  "<u4": { type: "uint", bytes: 4, le: true }, "<i4": { type: "int", bytes: 4, le: true },
  "<f4": { type: "float", bytes: 4, le: true }, "<f8": { type: "double", bytes: 8, le: true },
};

function rasVectors(ijkToRAS: number[]): { dirs: [number, number, number][]; origin: [number, number, number] } {
  const col = (c: number): [number, number, number] => [ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]];
  return { dirs: [col(0), col(1), col(2)], origin: [ijkToRAS[3], ijkToRAS[7], ijkToRAS[11]] };
}

const v3 = (v: [number, number, number]) => `(${v.map((x) => (Number.isInteger(x) ? x.toFixed(4) : x.toString())).join(",")})`;

/** Serialize a Volume to NRRD bytes. `encoding` "raw" (default) or "gzip". */
export async function writeNrrd(vol: Volume, opts: { encoding?: "raw" | "gzip"; segmentation?: { segments: { labelValue: number; name: string; color: number[] }[] } } = {}): Promise<Uint8Array> {
  const t = NRRD_TYPE[vol.dtype]; if (!t) throw new Error(`NRRD writer: unsupported dtype ${vol.dtype}`);
  const [nx, ny, nz] = vol.dims;
  const { dirs, origin } = rasVectors(vol.ijkToRAS);
  const encoding = opts.encoding ?? "raw";

  const lines = [
    "NRRD0004",
    "# Complete NRRD file format specification at:",
    "# http://teem.sourceforge.net/nrrd/format.html",
    `type: ${t.type}`,
    "dimension: 3",
    "space: right-anterior-superior",
    `sizes: ${nx} ${ny} ${nz}`,
    `space directions: ${dirs.map(v3).join(" ")}`,
    "kinds: domain domain domain",
    `endian: ${t.le ? "little" : "big"}`,
    `encoding: ${encoding}`,
    `space origin: ${v3(origin)}`,
  ];
  // Slicer segmentation keys (so a .seg.nrrd round-trips segment identity/colours)
  if (opts.segmentation) {
    for (const s of opts.segmentation.segments) {
      const p = `Segment${s.labelValue - 1}`;
      lines.push(`${p}_ID:=${s.name}`, `${p}_Name:=${s.name}`, `${p}_LabelValue:=${s.labelValue}`,
        `${p}_Color:=${s.color.slice(0, 3).map((c) => c.toFixed(6)).join(" ")}`);
    }
  }
  const header = new TextEncoder().encode(lines.join("\n") + "\n\n");

  // raw voxel bytes (data is already C-order z,y,x = i fastest, matching NRRD sizes order)
  let raw = new Uint8Array(vol.data.buffer, vol.data.byteOffset, vol.data.byteLength);
  if (encoding === "gzip") raw = await gzip(raw);

  const out = new Uint8Array(header.byteLength + raw.byteLength);
  out.set(header, 0); out.set(raw, header.byteLength);
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Response(bytes).body!.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
