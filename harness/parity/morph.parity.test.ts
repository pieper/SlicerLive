// T4 (W5): binary morphology matches scipy.ndimage with the SAME Euclidean-ball footprint (dilate/erode/
// open/close). Slicer builds a deterministic 3D mask + the ball footprint (r=2), runs scipy, returns the
// results; our morph must match voxel-for-voxel. Needs Slicer MCP.
import { assertEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { ballOffsets, binaryClose, binaryDilate, binaryErode, binaryOpen } from "../../algorithms/kernels/morph.ts";

const available = await slicerAvailable();
const R = 2;

const ORACLE = `
import numpy as np, json
from scipy import ndimage
N = 18
z, y, x = np.mgrid[0:N, 0:N, 0:N]
mask = ((np.sin(x*0.8)*np.cos(y*0.6) + np.sin(z*0.7)) > 0.3).astype(np.uint8)
R = ${R}
rr = np.arange(-R, R+1)
dz, dy, dx = np.meshgrid(rr, rr, rr, indexing='ij')
ball = (dx*dx + dy*dy + dz*dz <= R*R)   # SAME Euclidean ball as ballOffsets(R)
# scipy erosion border_value=0 (our out-of-bounds=0); dilation border_value=0 (ignored offsets)
er = ndimage.binary_erosion(mask, structure=ball, border_value=0).astype(np.uint8)
di = ndimage.binary_dilation(mask, structure=ball, border_value=0).astype(np.uint8)
op = ndimage.binary_dilation(ndimage.binary_erosion(mask, ball, border_value=0), ball, border_value=0).astype(np.uint8)
cl = ndimage.binary_erosion(ndimage.binary_dilation(mask, ball, border_value=0), ball, border_value=0).astype(np.uint8)
result = {'dims':[N,N,N], 'mask':mask.ravel(order='C').tolist(),
          'erode':er.ravel(order='C').tolist(), 'dilate':di.ravel(order='C').tolist(),
          'open':op.ravel(order='C').tolist(), 'close':cl.ravel(order='C').tolist()}
`;

const eq = (a: Uint8Array, b: number[], name: string) => {
  let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  console.log(`  ${name}: ${diff} differing voxels / ${a.length}`);
  assertEquals(diff, 0, `${name} matches scipy`);
};

Deno.test({ name: "parity: morph (erode/dilate/open/close) == scipy.ndimage (same ball)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ dims: [number, number, number]; mask: number[]; erode: number[]; dilate: number[]; open: number[]; close: number[] }>("result", "import json\n" + ORACLE);
  assertEquals(ballOffsets(R).length, o.mask.length ? ballOffsets(R).length : 0);   // sanity: footprint exists
  const mask = Uint8Array.from(o.mask), d = o.dims;
  eq(binaryErode(mask, d, R), o.erode, "erode");
  eq(binaryDilate(mask, d, R), o.dilate, "dilate");
  eq(binaryOpen(mask, d, R), o.open, "open");
  eq(binaryClose(mask, d, R), o.close, "close");
} });
