// Convert a single-file NRRD specimen into a chunked, deflate-compressed Zarr store laid out for
// render/zarr.ts's fetchZarrVolume (positional chunks "<name>.zarr/0/kk.jj.ii", C-order (cz,cy,cx),
// dtype <u1/<u2/<f4). Writes a staging tree + meta.json (ZarrDesc + ijkToRAS + range + preset + credit)
// under OUT/<name>/, ready to `openstack object create` into the slicerlive bucket under zarr/<name>/.
//
//   deno run --allow-net --allow-read --allow-write tools/zarr_convert.ts <name> <nrrd-url> <preset> "<credit>"
import { loadNrrd } from "../render/nrrd.ts";

const [name, url, preset, credit] = Deno.args;
if (!name || !url) { console.error("usage: zarr_convert <name> <nrrd-url> <preset> <credit>"); Deno.exit(1); }
const OUT = `/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/62f9fa2c-b0b6-4416-8e46-0eb7748e23fc/scratchpad/zarr/${name}`;
const CHUNK: [number, number, number] = [64, 128, 128]; // (cz,cy,cx)

console.log(`[zarr] loading ${name} …`);
const t0 = performance.now();
let seen = 0;
const nrrd = await loadNrrd(url, (n) => { seen += n; });
const [nx, ny, nz] = nrrd.dims;
const [lo, hi] = nrrd.range;
const dtype = hi <= 255 ? "<u1" : hi <= 65535 ? "<u2" : "<f4";
const Ctor = dtype === "<u1" ? Uint8Array : dtype === "<u2" ? Uint16Array : Float32Array;
console.log(`[zarr] ${name} ${nx}×${ny}×${nz} range [${lo},${hi}] -> dtype ${dtype} in ${((performance.now()-t0)/1000).toFixed(1)}s`);

const [cz, cy, cx] = CHUNK;
const shape: [number, number, number] = [nz, ny, nx];
const ncz = Math.ceil(nz / cz), ncy = Math.ceil(ny / cy), ncx = Math.ceil(nx / cx);
const data = nrrd.data;  // Float32, C-order (nz,ny,nx), x fastest

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Response(bytes).body!.pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

await Deno.mkdir(`${OUT}/${name}.zarr/0`, { recursive: true });
let nchunks = 0, cbytes = 0;
for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) {
  const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
  const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
  const buf = new Ctor(cz * cy * cx);   // full chunk, zero-padded at edges
  for (let zz = 0; zz < zw; zz++) for (let yy = 0; yy < yw; yy++) {
    const src = (((z0 + zz) * ny) + (y0 + yy)) * nx + x0;
    const dst = ((zz * cy) + yy) * cx;
    for (let xx = 0; xx < xw; xx++) buf[dst + xx] = data[src + xx];
  }
  const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const gz = await deflate(raw);
  await Deno.writeFile(`${OUT}/${name}.zarr/0/${kk}.${jj}.${ii}`, gz);
  nchunks++; cbytes += gz.length;
}

const desc = { dir: `${name}.zarr`, dataset: "0", shape, chunks: CHUNK, chunkGrid: [ncz, ncy, ncx], dtype };
const meta = { zarr: desc, ijkToRAS: nrrd.ijkToRAS, range: [lo, hi], preset: preset ?? "", credit: credit ?? "", dims: nrrd.dims };
await Deno.writeTextFile(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
console.log(`[zarr] wrote ${nchunks} chunks · ${(cbytes/1e6).toFixed(1)} MB compressed · grid ${ncz}×${ncy}×${ncx} · ${OUT}`);
