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

/** Voxel spacing (mm) = the column norms of a row-major voxel-center→RAS matrix. */
export function spacingFromIjkToRAS(ijkToRAS: ArrayLike<number>): Vec3 {
  const col = (c: number): number => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}
