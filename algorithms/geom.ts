// Minimal voxel-geometry helpers for the algorithms layer, kept local so `algorithms/` imports
// NOTHING from `render/` (the two engines stay independent; the logic layer glues them). These are
// the domain primitives editing effects need — deliberately duplicated from render/mat4.ts rather
// than shared, to avoid a cross-module dependency (they're ~10 trivial lines).

export type Vec3 = [number, number, number];

/** Transpose a row-major 4x4 (16 floats) → column-major, for upload to a WGSL mat4x4<f32>. */
export function transpose4(m: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}

/** True if two DIFFERENT non-zero labels are ever 6-adjacent — segments touch or embed (islands within
 *  islands), which needs the multi-material "all" boundary mode. False when every segment is separated
 *  by background, where the crisp "outer" shell renders identically and is cheaper. */
export function labelmapHasInternalBoundary(lab: ArrayLike<number>, dims: Vec3): boolean {
  const [nx, ny, nz] = dims;
  const at = (x: number, y: number, z: number) => lab[(z * ny + y) * nx + x];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const v = at(x, y, z); if (v === 0) continue;
    if (x + 1 < nx) { const n = at(x + 1, y, z); if (n !== 0 && n !== v) return true; }
    if (y + 1 < ny) { const n = at(x, y + 1, z); if (n !== 0 && n !== v) return true; }
    if (z + 1 < nz) { const n = at(x, y, z + 1); if (n !== 0 && n !== v) return true; }
  }
  return false;
}

/** Voxel spacing (mm) = the column norms of a row-major voxel-center→RAS matrix. */
export function spacingFromIjkToRAS(ijkToRAS: ArrayLike<number>): Vec3 {
  const col = (c: number): number => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}
