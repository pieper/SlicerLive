// T4 (W7): Slicer loads our written NIfTI-1 (.nii) with matching dims, sform ijkToRAS, and voxel sum.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { writeNifti } from "../../logic/writers/nifti.ts";
import type { Volume } from "../../logic/readers/nifti.ts";

const available = await slicerAvailable();
const SCRATCH = Deno.env.get("SL_SCRATCH") ?? "/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/242396da-c290-41c8-b06d-39ea439c7e6f/scratchpad";

Deno.test({ name: "parity: Slicer loads our NIfTI (dims, ijkToRAS, voxel sum)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const dims: [number, number, number] = [6, 5, 4];
  const [nx, ny, nz] = dims; const data = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[k * nx * ny + j * nx + i] = i + 2 * j + 7 * k;
  const ijk = [0.9, 0, 0, -30, 0, 1.1, 0, -40, 0, 0, 1.5, -20, 0, 0, 0, 1];
  const vol: Volume = { dims, ijkToRAS: ijk, data, dtype: "<i2", name: "nif" };
  const path = `${SCRATCH}/wtest.nii`;
  await Deno.writeFile(path, writeNifti(vol));
  let sumIn = 0; for (const v of data) sumIn += v;

  const o = await pyJson<{ dims: number[]; ijk: number[]; sum: number }>("result", `
import slicer, json, vtk
n = slicer.util.loadVolume(${JSON.stringify(path)})
m = vtk.vtkMatrix4x4(); n.GetIJKToRASMatrix(m)
ijk = [m.GetElement(r,c) for r in range(4) for c in range(4)]
result = {'dims': list(n.GetImageData().GetDimensions()), 'ijk': ijk, 'sum': int(slicer.util.arrayFromVolume(n).sum())}
slicer.mrmlScene.RemoveNode(n)
`);
  console.log(`  Slicer read NIfTI dims ${o.dims}, sum ${o.sum} (ours ${sumIn})`);
  assertEquals(o.dims, dims);
  assertEquals(o.sum, sumIn);
  for (let i = 0; i < 12; i++) assertAlmostEquals(o.ijk[i], ijk[i], 1e-3, `ijkToRAS[${i}]`);
} });
