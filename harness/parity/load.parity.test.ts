// T4 (W1): MRHead loaded NATIVELY (Sample Data -> NRRD reader -> zarr ingest) must match Slicer's MRHead
// exactly: dims, ijkToRAS, and the voxel sum (the NRRD is the same file, byte for byte, in both apps).
// Needs Slicer (MRHead in its scene: harness/parity/setup.ts), headed Chrome, the demos served, and network.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "../cdp.ts";
import { waitReady } from "../ready.ts";
import { pyJson, slicerAvailable } from "../slicer.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
const available = await slicerAvailable();

Deno.test({ name: "parity: native MRHead == Slicer MRHead (dims, ijkToRAS 1e-4, voxel sum exact)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const ref = await pyJson<{ dims: number[]; m: number[]; sum: number; count: number }>(`(lambda v: {"dims": list(v.GetImageData().GetDimensions()), "m": [__import__("vtk").vtkMatrix4x4() and 0][0:0] or (lambda M: (v.GetIJKToRASMatrix(M), [M.GetElement(r, c) for r in range(4) for c in range(4)])[1])(__import__("vtk").vtkMatrix4x4()), "sum": float(slicer.util.arrayFromVolume(v).astype("float64").sum()), "count": int(slicer.util.arrayFromVolume(v).size)})(slicer.mrmlScene.GetFirstNodeByName("MRHead") or slicer.mrmlScene.GetFirstNodeByName("MRHead_1"))`);
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);
  try {
    await waitReady(cdp, 60000);
    const live = await cdp.eval<{ dims: number[]; ijkToRAS: number[]; sum: number; count: number; dtype: string }>(`
      await window.__loadSample("MRHead");
      const img = [...window.__live.nodes.values()].find(n => n.type === "image" && n.origin && n.origin.local && /MR-head/.test(n.name));
      return await window.__volumeStats(img.id);`);
    assertEquals(live.dims, ref.dims);
    assertEquals(live.count, ref.count);
    for (let i = 0; i < 16; i++) assert(Math.abs(live.ijkToRAS[i] - ref.m[i]) <= 1e-4, `ijkToRAS[${i}] ${live.ijkToRAS[i]} vs ${ref.m[i]}`);
    assertEquals(live.sum, ref.sum, "voxel sum");
    console.log(`  MRHead: ${live.dims.join("x")} voxels, sum ${live.sum}, dtype ${live.dtype}`);
  } finally { await cdp.closeTab(); }
} });
