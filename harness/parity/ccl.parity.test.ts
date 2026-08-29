// T4 (W5): connected-components matches scipy.ndimage.label (the reference vtkITKIslandMath uses the same
// component definition). Slicer builds a deterministic 3D mask, labels it with 6- and 26-connectivity, and
// returns the mask + component count + sorted sizes; we must match count and sizes exactly. Needs Slicer MCP.
import { assertEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { connectedComponents } from "../../algorithms/kernels/ccl.ts";

const available = await slicerAvailable();

const ORACLE = `
import numpy as np, json
from scipy import ndimage
N = 20
# deterministic pseudo-mask: a few overlapping thresholded sinusoids -> several blobs (no RNG)
z, y, x = np.mgrid[0:N, 0:N, 0:N]
f = np.sin(x * 0.9) * np.cos(y * 0.7) + np.sin(z * 0.8) * np.cos(x * 0.6)
mask = (f > 0.6).astype(np.uint8)
s6 = ndimage.generate_binary_structure(3, 1)   # 6-conn (face)
s26 = ndimage.generate_binary_structure(3, 3)  # 26-conn
def stats(struct):
  lab, n = ndimage.label(mask, structure=struct)
  sizes = sorted(int(x) for x in ndimage.sum(mask, lab, range(1, n + 1)))
  return {'count': int(n), 'sizes': sizes}
result = {'data': mask.ravel(order='C').tolist(), 'dims': [N, N, N], 'c6': stats(s6), 'c26': stats(s26)}
`;

Deno.test({ name: "parity: connectedComponents == scipy.ndimage.label (6- and 26-conn)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ data: number[]; dims: [number, number, number]; c6: { count: number; sizes: number[] }; c26: { count: number; sizes: number[] } }>("result", "import json\n" + ORACLE);
  const mask = Uint8Array.from(o.data);
  const cc6 = connectedComponents(mask, o.dims, 6);
  const cc26 = connectedComponents(mask, o.dims, 26);
  console.log(`  6-conn: mine ${cc6.count} vs scipy ${o.c6.count}; 26-conn: mine ${cc26.count} vs scipy ${o.c26.count}`);
  assertEquals(cc6.count, o.c6.count, "6-conn component count");
  assertEquals(cc6.sizes.slice().sort((a, b) => a - b), o.c6.sizes, "6-conn sizes");
  assertEquals(cc26.count, o.c26.count, "26-conn component count");
  assertEquals(cc26.sizes.slice().sort((a, b) => a - b), o.c26.sizes, "26-conn sizes");
} });
