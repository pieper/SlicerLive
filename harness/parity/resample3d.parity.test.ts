// T4 (W3): resample3d matches vtkImageReslice. The oracle runs entirely in Slicer: a 10^3 ramp with identity
// IJKToRAS is resliced onto an interior output grid (translation + anisotropic scale, no rotation so every
// sample stays inside the input extent -> no background/edge-policy divergence) at nearest and linear. With
// input ijkToRAS = identity, vtkImageReslice's ResliceAxes == our output ijkToRAS, so the two compute the
// identical world-sampling. Nearest must be exact; linear within 1e-3. Needs Slicer MCP.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { resample3d, type Grid } from "../../algorithms/kernels/resample3d.ts";

const available = await slicerAvailable();

const ORACLE = `
import numpy as np, vtk
from vtk.util import numpy_support as ns
N = 10
# ramp value = i + 10*j + 100*k, C-order (z,y,x)
arr = np.zeros((N,N,N), dtype=np.float32)
for k in range(N):
  for j in range(N):
    for i in range(N):
      arr[k,j,i] = i + 10*j + 100*k
img = vtk.vtkImageData(); img.SetDimensions(N,N,N); img.SetOrigin(0,0,0); img.SetSpacing(1,1,1)
va = ns.numpy_to_vtk(arr.ravel(order='C'), deep=1, array_type=vtk.VTK_FLOAT); va.SetName('s')
img.GetPointData().SetScalars(va)
# output grid: translation (1.5,1.2,0.8) + anisotropic scale (1.3,0.9,1.1), no rotation -> interior samples
M = [1.3,0,0,1.5, 0,0.9,0,1.2, 0,0,1.1,0.8, 0,0,0,1]
ax = vtk.vtkMatrix4x4()
for r in range(4):
  for c in range(4):
    ax.SetElement(r,c,M[r*4+c])
ONX,ONY,ONZ = 6,6,6
def reslice(mode):
  rs = vtk.vtkImageReslice(); rs.SetInputData(img); rs.SetResliceAxes(ax)
  rs.SetOutputExtent(0,ONX-1,0,ONY-1,0,ONZ-1); rs.SetOutputOrigin(0,0,0); rs.SetOutputSpacing(1,1,1)
  rs.SetInterpolationMode(0 if mode=='nearest' else 1); rs.SetBackgroundLevel(-999)
  rs.Update()
  return ns.vtk_to_numpy(rs.GetOutput().GetPointData().GetScalars()).astype(float).tolist()
result = {"inDims":[N,N,N], "inData": arr.ravel(order='C').tolist(), "outMatrix": M,
          "outDims":[ONX,ONY,ONZ], "nearest": reslice('nearest'), "linear": reslice('linear')}
`;

Deno.test({ name: "parity: resample3d == vtkImageReslice (nearest exact, linear <=1e-3)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ inDims: [number, number, number]; inData: number[]; outMatrix: number[]; outDims: [number, number, number]; nearest: number[]; linear: number[] }>("result", "import slicer, json, numpy as np, vtk\nfrom vtk.util import numpy_support as ns\n" + ORACLE);
  const input: Grid = { data: Float32Array.from(o.inData), dims: o.inDims, ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const out = { dims: o.outDims, ijkToRAS: o.outMatrix };

  const near = resample3d(input, out, { interp: "nearest", background: -999 }) as Float32Array;
  assertEquals(Array.from(near), o.nearest, "nearest exact vs vtkImageReslice");

  const lin = resample3d(input, out, { interp: "linear", background: -999 }) as Float32Array;
  let maxAbs = 0; for (let i = 0; i < lin.length; i++) maxAbs = Math.max(maxAbs, Math.abs(lin[i] - o.linear[i]));
  console.log(`  resample3d linear max|Δ| vs vtkImageReslice = ${maxAbs.toExponential(2)} over ${lin.length} voxels`);
  assert(maxAbs <= 1e-3, `linear within 1e-3, got ${maxAbs}`);
} });
