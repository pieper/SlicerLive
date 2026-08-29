// T1 unit (W7): NRRD writer round-trips through the reader (geometry + voxels preserved).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { writeNrrd } from "./nrrd.ts";
import { parseNrrd } from "../../render/nrrd.ts";
import type { Volume } from "../readers/nifti.ts";

function ramp(dims: [number, number, number], ijkToRAS: number[]): Volume {
  const [nx, ny, nz] = dims; const data = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[k * nx * ny + j * nx + i] = i + 10 * j + 100 * k;
  return { dims, ijkToRAS, data, dtype: "<i2", name: "ramp" };
}

Deno.test("writeNrrd -> parseNrrd preserves dims, ijkToRAS, and voxels (raw)", async () => {
  const ijk = [0.8, 0, 0, -100, 0, 0.9, 0, -120, 0, 0, 1.2, -80, 0, 0, 0, 1];
  const vol = ramp([5, 4, 3], ijk);
  const nrrd = await parseNrrd(await writeNrrd(vol, { encoding: "raw" }));
  assertEquals(nrrd.dims, [5, 4, 3]);
  for (let i = 0; i < 16; i++) assertAlmostEquals(nrrd.ijkToRAS[i], ijk[i], 1e-4, `ijkToRAS[${i}]`);
  let sumIn = 0, sumOut = 0; for (let p = 0; p < vol.data.length; p++) { sumIn += vol.data[p]; sumOut += nrrd.data[p]; }
  assertEquals(sumOut, sumIn, "voxel sum preserved");
  assertEquals(nrrd.data[nrrd.dims[0] * nrrd.dims[1] + 1], vol.data[nrrd.dims[0] * nrrd.dims[1] + 1], "voxel order preserved");
});

Deno.test("writeNrrd gzip round-trips too", async () => {
  const vol = ramp([4, 4, 2], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const nrrd = await parseNrrd(await writeNrrd(vol, { encoding: "gzip" }));
  assertEquals(nrrd.dims, [4, 4, 2]);
  let s = 0; for (const v of nrrd.data) s += v; let e = 0; for (const v of vol.data) e += v;
  assertEquals(s, e, "gzip voxel sum preserved");
});

Deno.test("header advertises RAS space (no LPS flip)", async () => {
  const bytes = await writeNrrd(ramp([2, 2, 2], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const head = new TextDecoder().decode(bytes.slice(0, 400));
  assert(head.includes("space: right-anterior-superior"), "RAS space declared");
});
