// T4 (W6): the transform hierarchy math matches Slicer. Build A->B->C linear transforms in Slicer, read
// GetMatrixTransformToWorld for C, and harden a transform on a volume (compare the resulting IJKToRAS).
// Compare against logic/transforms.ts. Needs Slicer MCP.
import { assertAlmostEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { hardenImageIjkToRAS, rowMul, worldMatrix } from "../../logic/transforms.ts";
import type { MrsonNode } from "../../render/mrson.ts";

const available = await slicerAvailable();

// three linear matrices (row-major), a chain A(parent) -> B -> C
const A = [1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const B = [0, -1, 0, 0, 1, 0, 0, 5, 0, 0, 1, 0, 0, 0, 0, 1];        // 90° about S + translate A=5
const C = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 7, 0, 0, 0, 1];        // translate S=7
const IJK = [0.8, 0, 0, -100, 0, 0.8, 0, -120, 0, 0, 1.2, -80, 0, 0, 0, 1];

const ORACLE = `
import slicer, json, vtk
def mk(M, parentNode=None):
  n = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLLinearTransformNode')
  m = vtk.vtkMatrix4x4()
  for r in range(4):
    for c in range(4): m.SetElement(r, c, M[r*4+c])
  n.SetMatrixTransformToParent(m)
  if parentNode is not None: n.SetAndObserveTransformNodeID(parentNode.GetID())
  return n
a = mk(${JSON.stringify(A)})
b = mk(${JSON.stringify(B)}, a)
c = mk(${JSON.stringify(C)}, b)
wm = vtk.vtkMatrix4x4(); c.GetMatrixTransformToWorld(wm)
world = [wm.GetElement(r, cc) for r in range(4) for cc in range(4)]
# harden a transform on a volume: create a volume with a known IJKToRAS under transform 'a', harden, read IJKToRAS
import numpy as np
vol = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLScalarVolumeNode')
img = vtk.vtkImageData(); img.SetDimensions(2,2,2); img.AllocateScalars(vtk.VTK_SHORT, 1)
vol.SetAndObserveImageData(img)
ijk = vtk.vtkMatrix4x4()
IJK = ${JSON.stringify(IJK)}
for r in range(4):
  for cc in range(4): ijk.SetElement(r, cc, IJK[r*4+cc])
vol.SetIJKToRASMatrix(ijk)
vol.SetAndObserveTransformNodeID(a.GetID())
slicer.vtkSlicerTransformLogic().hardenTransform(vol)
hijk = vtk.vtkMatrix4x4(); vol.GetIJKToRASMatrix(hijk)
hardened = [hijk.GetElement(r, cc) for r in range(4) for cc in range(4)]
for n in (c,b,a,vol): slicer.mrmlScene.RemoveNode(n)
result = {'world': world, 'hardened': hardened}
`;

Deno.test({ name: "parity: worldMatrix + harden == vtkMRMLTransformNode / vtkSlicerTransformLogic", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ world: number[]; hardened: number[] }>("result", "import slicer, json\n" + ORACLE);
  const nodes = new Map<string, MrsonNode>();
  nodes.set("A", { type: "transform", id: "A", matrix: A, refs: {} } as unknown as MrsonNode);
  nodes.set("B", { type: "transform", id: "B", matrix: B, refs: { transform: ["A"] } } as unknown as MrsonNode);
  nodes.set("C", { type: "transform", id: "C", matrix: C, refs: { transform: ["B"] } } as unknown as MrsonNode);
  const world = worldMatrix("C", nodes);
  let maxW = 0; for (let i = 0; i < 16; i++) maxW = Math.max(maxW, Math.abs(world[i] - o.world[i]));
  console.log(`  worldMatrix max|Δ| = ${maxW.toExponential(2)}`);
  for (let i = 0; i < 16; i++) assertAlmostEquals(world[i], o.world[i], 1e-6, `world[${i}]`);

  // harden: volume under transform A -> newIjkToRAS = A · IJK
  const hardened = hardenImageIjkToRAS(IJK, rowMul(worldMatrix("A", nodes), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  for (let i = 0; i < 16; i++) assertAlmostEquals(hardened[i], o.hardened[i], 1e-4, `hardened[${i}]`);
} });
