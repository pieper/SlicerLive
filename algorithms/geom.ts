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

/** Resample a labelmap (nearest) to an ISOTROPIC grid, so thick-slice anisotropy doesn't leave gaps
 *  the SDF shell can't bridge (a near-slice-parallel surface falling BETWEEN two far-apart slices is
 *  missed → holes). The largest PHYSICAL axis gets `maxDim` voxels (per-axis cap); the isotropic voxel
 *  is then coarsened if needed so the total stays ≤ `maxVoxels` (memory cap → graceful fallback on a
 *  weaker device, capacity-gated like the rest of the pipeline). Isotropic input comes out identical to
 *  a plain uniform cap (no visual change). Returns a Uint32Array (for the r32uint master) + the grid's
 *  dims and an ijkToRAS whose columns are rescaled to span the SAME RAS box. `resampled` flags whether
 *  the memory cap forced a coarser-than-requested grid (a caller may surface "consider remote render"). */
export function resampleIsotropic(
  lab: ArrayLike<number>, dims: Vec3, ijkToRAS: number[], maxDim: number, maxVoxels = Infinity,
): { lab: Uint32Array; dims: Vec3; ijkToRAS: number[]; vox: number; coarsened: boolean } {
  const sp = spacingFromIjkToRAS(ijkToRAS);
  const ext: Vec3 = [dims[0] * sp[0], dims[1] * sp[1], dims[2] * sp[2]];
  let vox = Math.max(...ext) / maxDim;                              // per-axis cap: longest extent → maxDim
  const count = (v: number) => Math.max(1, Math.round(ext[0] / v)) * Math.max(1, Math.round(ext[1] / v)) * Math.max(1, Math.round(ext[2] / v));
  let coarsened = false;
  if (count(vox) > maxVoxels) { vox = Math.cbrt((ext[0] * ext[1] * ext[2]) / maxVoxels); coarsened = true; }  // memory cap: total ≤ maxVoxels
  const cd: Vec3 = [Math.max(1, Math.round(ext[0] / vox)), Math.max(1, Math.round(ext[1] / vox)), Math.max(1, Math.round(ext[2] / vox))];
  const [nx, ny, nz] = dims, [cx, cy, cz] = cd;
  const out = new Uint32Array(cx * cy * cz);
  if (cx === nx && cy === ny && cz === nz) {
    for (let i = 0; i < out.length; i++) out[i] = lab[i];
    return { lab: out, dims, ijkToRAS, vox, coarsened };
  }
  for (let z = 0; z < cz; z++) {
    const sz = Math.min(nz - 1, Math.floor((z + 0.5) * nz / cz));
    for (let y = 0; y < cy; y++) {
      const sy = Math.min(ny - 1, Math.floor((y + 0.5) * ny / cy));
      for (let x = 0; x < cx; x++) {
        const sx = Math.min(nx - 1, Math.floor((x + 0.5) * nx / cx));
        out[(z * cy + y) * cx + x] = lab[(sz * ny + sy) * nx + sx];
      }
    }
  }
  // Rescale the 3 direction columns by dims/cappedDims so the resampled grid spans the SAME RAS box.
  const r = [nx / cx, ny / cy, nz / cz], m = ijkToRAS.slice();
  for (let row = 0; row < 3; row++) { m[row * 4] *= r[0]; m[row * 4 + 1] *= r[1]; m[row * 4 + 2] *= r[2]; }
  return { lab: out, dims: cd, ijkToRAS: m, vox, coarsened };
}

/** Voxel spacing (mm) = the column norms of a row-major voxel-center→RAS matrix. */
export function spacingFromIjkToRAS(ijkToRAS: ArrayLike<number>): Vec3 {
  const col = (c: number): number => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}
