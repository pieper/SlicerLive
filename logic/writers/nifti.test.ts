// T1 unit (W7): NIfTI-1 writer round-trips through the reader (sform RAS + voxels).
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { writeNifti } from "./nifti.ts";
import { parseNifti } from "../readers/nifti.ts";
import type { Volume } from "../readers/nifti.ts";

Deno.test("writeNifti -> parseNifti preserves dims, sform ijkToRAS, voxels", async () => {
  const dims: [number, number, number] = [6, 5, 4];
  const [nx, ny, nz] = dims; const data = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[k * nx * ny + j * nx + i] = i + 2 * j + 7 * k;
  const ijk = [0.9, 0, 0, -30, 0, 1.1, 0, -40, 0, 0, 1.5, -20, 0, 0, 0, 1];
  const vol: Volume = { dims, ijkToRAS: ijk, data, dtype: "<i2", name: "n" };
  const back = await parseNifti(writeNifti(vol), "n");
  assertEquals(back.dims, dims);
  for (let i = 0; i < 12; i++) assertAlmostEquals(back.ijkToRAS[i], ijk[i], 1e-4, `ijkToRAS[${i}]`);
  let a = 0, b = 0; for (let p = 0; p < data.length; p++) { a += data[p]; b += back.data[p]; }
  assertEquals(b, a, "voxel sum preserved");
});
