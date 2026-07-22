// Minimal OME-Zarr volume loader — a TS port of the viewer's fetchZarrVolume.
// Pulls all chunks in parallel, gunzips each with DecompressionStream("deflate")
// (native in both Deno and browsers — no bundled zlib), and assembles them into
// one typed array in C-order (z,y,x). The rotated IJK->RAS geometry is carried
// separately in the scene json (attrs.ijkToRAS), not in the zarr.

export interface ZarrDesc {
  dir: string;                 // e.g. "vtkMRMLScalarVolumeNode1.zarr"
  dataset: string;             // e.g. "0"
  shape: [number, number, number];   // (nz, ny, nx)  C-order
  chunks: [number, number, number];  // (cz, cy, cx)
  chunkGrid: [number, number, number]; // (ncz, ncy, ncx)
  dtype: string;               // e.g. "<i2"
  bytes?: number;
}

type TypedArrayCtor =
  | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor
  | Int32ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor;

const ZDT: Record<string, TypedArrayCtor> = {
  "<f4": Float32Array, "<f8": Float64Array, "<i4": Int32Array, "<u4": Uint32Array,
  "<i2": Int16Array, "<u2": Uint16Array, "|i1": Int8Array, "|u1": Uint8Array, "<i1": Int8Array, "<u1": Uint8Array,
};

export interface ZarrVolume {
  data: Float32Array;                 // scalars as f32, ready for an r32float 3D texture
  dims: [number, number, number];     // (nx, ny, nz) — i,j,k extents (texture upload order)
  range: [number, number];            // observed [min, max] scalar value
}

async function inflateDeflate(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream("deflate");
  return await new Response(new Response(buf).body!.pipeThrough(ds)).arrayBuffer();
}

/** Fetch + assemble a zarr volume into an f32 array (C-order z,y,x). `blobBase`
 *  is the URL prefix that `dir` is relative to. onBytes(n) reports each chunk's
 *  compressed size for a progress bar. */
export async function fetchZarrVolume(
  blobBase: string,
  z: ZarrDesc,
  onBytes?: (n: number) => void,
  concurrency = 12,
): Promise<ZarrVolume> {
  const Ctor = ZDT[z.dtype] ?? Int16Array;
  const [nz, ny, nx] = z.shape, [cz, cy, cx] = z.chunks, [ncz, ncy, ncx] = z.chunkGrid;
  const base = blobBase + z.dir + "/" + z.dataset + "/";
  const out = new Float32Array(nz * ny * nx);
  let lo = Infinity, hi = -Infinity;

  const jobs: [number, number, number][] = [];
  for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) jobs.push([kk, jj, ii]);

  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const [kk, jj, ii] = jobs[idx++];
      const gz = await (await fetch(base + kk + "." + jj + "." + ii)).arrayBuffer();
      onBytes?.(gz.byteLength);
      const chunk = new Ctor(await inflateDeflate(gz));   // (cz,cy,cx) C-order, padded to full chunk shape
      const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
      const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
      for (let zz = 0; zz < zw; zz++) {
        for (let yy = 0; yy < yw; yy++) {
          const src = (zz * cy + yy) * cx;
          const dst = ((z0 + zz) * ny + (y0 + yy)) * nx + x0;
          for (let xx = 0; xx < xw; xx++) {
            const v = chunk[src + xx];
            out[dst + xx] = v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  return { data: out, dims: [nx, ny, nz], range: [lo, hi] };
}
