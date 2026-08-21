// Convert a single-file NRRD specimen into a MULTISCALE, deflate-compressed chunked zarr laid out
// for render/zarr.ts's fetchZarrVolume: positional chunks "<name>.zarr/<level>/k.j.i", C-order
// (cz,cy,cx), dtype <u1/<u2/<f4. Level 0 = full res; each higher level is a 2x box-downsample, down
// to a coarse proxy (max dim <= ~192). meta.json lists every level (ZarrDesc + per-level ijkToRAS)
// plus range/preset/credit — so the server can render the coarse level instantly and stream the
// fine one in the background.
//
//   deno run --allow-net --allow-read --allow-write tools/zarr_convert.ts <name> <nrrd-url> <preset> "<credit>"
import { loadNrrd } from "../render/nrrd.ts";

const [name, url, preset, credit] = Deno.args;
if (!name || !url) { console.error("usage: zarr_convert <name> <nrrd-url> <preset> <credit>"); Deno.exit(1); }
const OUT = `/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/62f9fa2c-b0b6-4416-8e46-0eb7748e23fc/scratchpad/zarr/${name}`;
const CHUNK: [number, number, number] = [128, 256, 256]; // (cz,cy,cx)
const COARSE_MAX = 192;   // stop pyramiding once the largest dim is this small

console.log(`[zarr] loading ${name} …`);
const t0 = performance.now();
let seen = 0;
const nrrd = await loadNrrd(url, (n) => { seen += n; });
const [nx, ny, nz] = nrrd.dims;             // texture upload order (x fastest)
const [lo, hi] = nrrd.range;
const dtype = hi <= 255 ? "<u1" : hi <= 65535 ? "<u2" : "<f4";
const Ctor = dtype === "<u1" ? Uint8Array : dtype === "<u2" ? Uint16Array : Float32Array;
console.log(`[zarr] ${name} ${nx}×${ny}×${nz} range [${lo},${hi}] -> ${dtype} in ${((performance.now()-t0)/1000).toFixed(1)}s`);

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Response(bytes).body!.pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// A level's scalar grid, C-order (z,y,x) with x fastest — matches nrrd.data and the texture layout.
interface Level { data: Float32Array; dx: number; dy: number; dz: number; }
// 2x box-downsample (mean of each 2x2x2 block), producing floor(dim/2) extents (min 1).
function halve(L: Level): Level {
  const { data, dx, dy, dz } = L;
  const ox = Math.max(1, dx >> 1), oy = Math.max(1, dy >> 1), oz = Math.max(1, dz >> 1);
  const out = new Float32Array(ox * oy * oz);
  for (let z = 0; z < oz; z++) for (let y = 0; y < oy; y++) for (let x = 0; x < ox; x++) {
    let s = 0, n = 0;
    for (let zz = 0; zz < 2; zz++) { const sz = z*2+zz; if (sz >= dz) continue;
      for (let yy = 0; yy < 2; yy++) { const sy = y*2+yy; if (sy >= dy) continue;
        for (let xx = 0; xx < 2; xx++) { const sx = x*2+xx; if (sx >= dx) continue;
          s += data[(sz*dy + sy)*dx + sx]; n++;
        } } }
    out[(z*oy + y)*ox + x] = n ? s / n : 0;
  }
  return { data: out, dx: ox, dy: oy, dz: oz };
}

// Build the pyramid.
const levels: Level[] = [{ data: nrrd.data, dx: nx, dy: ny, dz: nz }];
while (Math.max(levels[levels.length-1].dx, levels[levels.length-1].dy, levels[levels.length-1].dz) > COARSE_MAX) {
  levels.push(halve(levels[levels.length-1]));
}
console.log(`[zarr] ${levels.length} levels: ${levels.map(l=>`${l.dx}×${l.dy}×${l.dz}`).join(" → ")}`);

const [cz, cy, cx] = CHUNK;
// Per-level ijkToRAS: same physical box, so the 3 direction columns scale by 2^level (origin fixed).
// ijkToRAS is a 16-array (row-major 4x4): columns 0,1,2 are the i,j,k step vectors (rows 0..2).
function scaledIjk(base: number[], f: number): number[] {
  const m = [...base];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r*4 + c] *= f;
  return m;
}

const metaLevels: unknown[] = [];
for (let lev = 0; lev < levels.length; lev++) {
  const { data, dx, dy, dz } = levels[lev];
  const shape: [number, number, number] = [dz, dy, dx];
  const ncz = Math.ceil(dz / cz), ncy = Math.ceil(dy / cy), ncx = Math.ceil(dx / cx);
  await Deno.mkdir(`${OUT}/${name}.zarr/${lev}`, { recursive: true });
  let cbytes = 0, nchunks = 0;
  for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) {
    const z0 = kk*cz, y0 = jj*cy, x0 = ii*cx;
    const zw = Math.min(cz, dz - z0), yw = Math.min(cy, dy - y0), xw = Math.min(cx, dx - x0);
    const buf = new Ctor(cz * cy * cx);
    for (let zz = 0; zz < zw; zz++) for (let yy = 0; yy < yw; yy++) {
      const src = (((z0+zz)*dy) + (y0+yy))*dx + x0;
      const dst = ((zz*cy) + yy)*cx;
      for (let xx = 0; xx < xw; xx++) buf[dst + xx] = data[src + xx];
    }
    const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const gz = await deflate(raw);
    await Deno.writeFile(`${OUT}/${name}.zarr/${lev}/${kk}.${jj}.${ii}`, gz);
    cbytes += gz.length; nchunks++;
  }
  metaLevels.push({ level: lev, dataset: String(lev), dir: `${name}.zarr`, shape, chunks: CHUNK,
    chunkGrid: [ncz, ncy, ncx], dtype, bytes: cbytes, ijkToRAS: scaledIjk(nrrd.ijkToRAS, 2 ** lev), dims: [dx, dy, dz] });
  console.log(`[zarr]   L${lev} ${dx}×${dy}×${dz} · ${nchunks} chunks · ${(cbytes/1e6).toFixed(1)}MB`);
}

const meta = { name, levels: metaLevels, range: [lo, hi], preset: preset ?? "", credit: credit ?? "",
  ijkToRAS: nrrd.ijkToRAS, dims: nrrd.dims,
  // back-compat: `zarr` + `bytes` describe level 0 for older single-scale readers
  zarr: (metaLevels[0] as { dir: string; dataset: string; shape: number[]; chunks: number[]; chunkGrid: number[]; dtype: string }),
  bytes: (metaLevels[0] as { bytes: number }).bytes };
await Deno.writeTextFile(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
console.log(`[zarr] wrote ${OUT}/meta.json (${levels.length} levels, ${nrrd.dims.join("×")})`);
