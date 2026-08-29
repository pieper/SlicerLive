// T1: local ingest produces Slicer-compatible chunks and round-trips through the production zarr loader.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CHUNK_MAX, LocalBlobStore, percentileWindowLevel, volumeNodes, volumeToZarr } from "./ingest.ts";
import { fetchZarrVolumeNative, setBlobFetch } from "../render/zarr.ts";

function phantom(nx = 70, ny = 50, nz = 9): Int16Array {
  const d = new Int16Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) d[(z * ny + y) * nx + x] = x * 3 - y * 2 + z * 100 - 400;
  return d;
}

Deno.test("volumeToZarr: Slicer's chunk rule, sha256- names, zlib-deflated payloads", async () => {
  const data = phantom(300, 140, 70);
  const { desc, blobs } = await volumeToZarr(data, [300, 140, 70], "<i2");
  assertEquals(desc.shape, [70, 140, 300]);
  assertEquals(desc.chunks, [Math.min(CHUNK_MAX[0], 70), 128, 128]);
  assertEquals(desc.chunkGrid, [2, 2, 3]);
  assertEquals(Object.keys(desc.chunkHashes!).length, 12);
  for (const h of Object.values(desc.chunkHashes!)) { assert(/^sha256-[0-9a-f]{64}$/.test(h)); assert(blobs.has(h)); }
  const first = blobs.get(desc.chunkHashes!["0.0.0"])!;
  assertEquals(first[0] & 0x0f, 8, "zlib header (CM=8) — Python zlib.compress compatible");
});

Deno.test("round-trip: chunks served through the blob fetch reassemble byte-identically", async () => {
  const data = phantom();
  const { desc, blobs } = await volumeToZarr(data, [70, 50, 9], "<i2");
  const store = new LocalBlobStore();
  store.add(blobs);
  const zv = await fetchZarrVolumeNative("http://blobs/", desc);
  assertEquals(zv.dims, [70, 50, 9]);
  assert(zv.data instanceof Int16Array);
  assertEquals(Array.from(zv.data as Int16Array), Array.from(data));
  setBlobFetch(null);
});

Deno.test("percentileWindowLevel + volumeNodes: sensible defaults, Slicer node shapes", async () => {
  const data = phantom();
  const wl = percentileWindowLevel(data);
  assert(wl.window > 0 && wl.level > wl.range[0] && wl.level < wl.range[1]);
  const built = await volumeNodes({ dims: [70, 50, 9], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], data, dtype: "<i2", name: "P" });
  const img = built.nodes.find((n) => n.type === "image")!, disp = built.nodes.find((n) => n.type === "scalarVolumeDisplay")!;
  assertEquals(img.dims, [70, 50, 9]); assertEquals((img.refs as { display: string[] }).display, [disp.id]);
  assert(typeof disp.window === "number" && typeof disp.level === "number");
});
