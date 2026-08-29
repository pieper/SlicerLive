// Transforms (W6) — the pure math of Slicer's transform hierarchy (vtkMRMLTransformNode). A `transform` node
// holds a linear `matrix` (row-major 4x4) and an optional parent (`refs.transform`); a transformable node
// (image / markup / segmentation) references a transform via `refs.transform`. worldMatrix composes the chain
// to world (GetMatrixTransformToWorld); harden bakes it into the node's own geometry and clears the ref.
// RAS internal, row-major matrices matching the wire. No side effects.
import { applyRowMajor, invert, transpose4, type Vec3 } from "../render/mat4.ts";
import type { MrsonNode } from "../render/mrson.ts";

export const IDENTITY4: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Row-major 4x4 multiply: (A·B). */
export function rowMul(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    out[r * 4 + c] = s;
  }
  return out;
}

/** Inverse of a row-major 4x4 (via the column-major invert: invert(transpose) == transpose of the inverse). */
export function invertRowMajor(m: number[]): number[] {
  return transpose4(invert(transpose4(m)) as unknown as number[]) as unknown as number[];
}

const parentTransformId = (n: MrsonNode | undefined): string | undefined =>
  ((n?.refs as Record<string, string[]> | undefined)?.transform ?? [])[0];

/**
 * Matrix that maps a transform node's local space to WORLD (GetMatrixTransformToWorld):
 * worldMatrix(T) = worldMatrix(parent) · T.matrix. Returns identity for a missing/rootless transform.
 * Detects cycles (returns identity, never loops).
 */
export function worldMatrix(transformId: string | undefined, nodes: Map<string, MrsonNode>, _seen = new Set<string>()): number[] {
  if (!transformId) return IDENTITY4.slice();
  if (_seen.has(transformId)) return IDENTITY4.slice();               // cycle guard
  _seen.add(transformId);
  const t = nodes.get(transformId);
  if (!t || t.type !== "transform") return IDENTITY4.slice();
  const local = (t.matrix as number[] | undefined) ?? IDENTITY4;
  const parent = parentTransformId(t);
  return parent ? rowMul(worldMatrix(parent, nodes, _seen), local) : local.slice();
}

/** The world matrix applied to a TRANSFORMABLE node (its refs.transform chain), identity if untransformed. */
export function worldForNode(node: MrsonNode, nodes: Map<string, MrsonNode>): number[] {
  return worldMatrix(parentTransformId(node), nodes);
}

/** Would setting `node`.refs.transform = `transformId` create a cycle in the transform graph? */
export function wouldCycle(nodeIsTransform: string | undefined, transformId: string, nodes: Map<string, MrsonNode>): boolean {
  if (!nodeIsTransform) return false;
  let cur: string | undefined = transformId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === nodeIsTransform) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = parentTransformId(nodes.get(cur));
  }
  return false;
}

/** Harden a linear transform into an image's geometry: newIjkToRAS = world · ijkToRAS (voxels don't move). */
export function hardenImageIjkToRAS(ijkToRAS: number[], world: number[]): number[] {
  return rowMul(world, ijkToRAS);
}

/** Harden into markup control points: each world point p -> world·p. */
export function hardenPoints(points: Vec3[], world: number[]): Vec3[] {
  return points.map((p) => applyRowMajor(world, p));
}

/** Compose a translation (mm) into a linear transform matrix (post-multiply in world = left-multiply). */
export function withTranslation(matrix: number[], t: Vec3): number[] {
  const m = matrix.slice(); m[3] += t[0]; m[7] += t[1]; m[11] += t[2]; return m;
}
