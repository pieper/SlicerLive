// T4 (W7): Slicer loads our written NRRD and gets the same dims, ijkToRAS, and voxel sum (round-trip into the
// real app). We write the .nrrd to a shared scratch path and load it with slicer.util.loadVolume. Needs Slicer
// MCP (same machine, shared filesystem).
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { writeNrrd } from "../../logic/writers/nrrd.ts";
import type { Volume } from "../../logic/readers/nifti.ts";

const available = await slicerAvailable();
const SCRATCH = Deno.env.get("SL_SCRATCH") ?? "/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/242396da-c290-41c8-b06d-39ea439c7e6f/scratchpad";

function ramp(): Volume {
  const dims: [number, number, number] = [7, 6, 5];
  const [nx, ny, nz] = dims; const data = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[k * nx * ny + j * nx + i] = i + 3 * j + 11 * k;
  return { dims, ijkToRAS: [0.8, 0, 0, -50, 0, 0.9, 0, -60, 0, 0, 1.3, -40, 0, 0, 0, 1], data, dtype: "<i2", name: "wtest" };
}

Deno.test({ name: "parity: Slicer loads our NRRD (dims, ijkToRAS, voxel sum)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const vol = ramp();
  const bytes = await writeNrrd(vol, { encoding: "raw" });
  const path = `${SCRATCH}/wtest.nrrd`;
  await Deno.writeFile(path, bytes);

  let sumIn = 0; for (const v of vol.data) sumIn += v;
  const o = await pyJson<{ dims: number[]; ijk: number[]; sum: number }>("result", `
import slicer, json, numpy as np
n = slicer.util.loadVolume(${JSON.stringify(path)})
import vtk
m = vtk.vtkMatrix4x4(); n.GetIJKToRASMatrix(m)
ijk = [m.GetElement(r,c) for r in range(4) for c in range(4)]
arr = slicer.util.arrayFromVolume(n)   # (k,j,i)
result = {'dims': list(n.GetImageData().GetDimensions()), 'ijk': ijk, 'sum': int(arr.sum())}
slicer.mrmlScene.RemoveNode(n)
`);
  console.log(`  Slicer read dims ${o.dims}, sum ${o.sum} (ours ${sumIn})`);
  assertEquals(o.dims, vol.dims, "dims match");
  assertEquals(o.sum, sumIn, "voxel sum matches");
  for (let i = 0; i < 16; i++) assertAlmostEquals(o.ijk[i], vol.ijkToRAS[i], 1e-4, `ijkToRAS[${i}]`);
} });
