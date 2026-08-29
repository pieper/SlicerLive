// resample3d kernel (W3): the data path of vtkImageReslice / vtkOrientedImageDataResample. Resample an input
// volume (its own ijkToRAS) onto an OUTPUT geometry (dims + ijkToRAS) with nearest or trilinear
// interpolation, direction-aware (works across arbitrary rotations/anisotropy because it goes through world
// RAS). Out-of-extent output voxels get `background`. CPU reference (exact, deno-testable); the WGSL path is
// added with its first heavy consumer (W5 masking / W6 harden). RAS is the shared frame; no LPS flips.
//
//   deno test -A --no-check algorithms/kernels/resample3d.test.ts
import { applyMat4, applyRowMajor, invert, transpose4, type Vec3 } from "../../render/mat4.ts";

export type Scalars = { length: number; [i: number]: number };
export interface Grid { data: Scalars; dims: [number, number, number]; ijkToRAS: number[]; } // dims [nx,ny,nz], row-major 4x4
export interface OutGrid { dims: [number, number, number]; ijkToRAS: number[]; }
export type Interp = "nearest" | "linear";

/** Allocate the output array with the same element type as the input (falls back to Float32Array). */
function likeArray(src: Scalars, n: number): Scalars {
  const Ctor = (src as { constructor?: unknown }).constructor as (new (n: number) => Scalars) | undefined;
  try { if (Ctor && Ctor !== Object) return new Ctor(n); } catch { /* not a typed array */ }
  return new Float32Array(n) as unknown as Scalars;
}

/**
 * Resample `input` onto `out` (dims + ijkToRAS). Returns the output scalar array in C-order (z,y,x),
 * matching Volume.data. `background` fills output voxels whose sample falls outside the input extent.
 */
export function resample3d(input: Grid, out: OutGrid, opts: { interp?: Interp; background?: number } = {}): Scalars {
  const interp = opts.interp ?? "linear";
  const bg = opts.background ?? 0;
  const [inx, iny, inz] = input.dims;
  const [onx, ony, onz] = out.dims;
  const data = input.data;
  // world -> input-ijk, as a column-major matrix so applyMat4 consumes it directly:
  //   invert(transpose(rowMajor)) == column-major inverse of the row-major ijkToRAS.
  const worldToInIjk = invert(transpose4(input.ijkToRAS));
  const inStride = inx, inSlice = inx * iny;
  const idx = (i: number, j: number, k: number) => k * inSlice + j * inStride + i;

  const sampleNearest = (p: Vec3): number => {
    const i = Math.round(p[0]), j = Math.round(p[1]), k = Math.round(p[2]);
    if (i < 0 || i >= inx || j < 0 || j >= iny || k < 0 || k >= inz) return bg;
    return data[idx(i, j, k)];
  };
  const sampleLinear = (p: Vec3): number => {
    const x = p[0], y = p[1], z = p[2];
    // outside the sampleable extent [0, dim-1] in any axis -> background (VTK default, no border)
    if (x < 0 || x > inx - 1 || y < 0 || y > iny - 1 || z < 0 || z > inz - 1) return bg;
    const i0 = Math.floor(x), j0 = Math.floor(y), k0 = Math.floor(z);
    const i1 = Math.min(i0 + 1, inx - 1), j1 = Math.min(j0 + 1, iny - 1), k1 = Math.min(k0 + 1, inz - 1);
    const fx = x - i0, fy = y - j0, fz = z - k0;
    const c000 = data[idx(i0, j0, k0)], c100 = data[idx(i1, j0, k0)];
    const c010 = data[idx(i0, j1, k0)], c110 = data[idx(i1, j1, k0)];
    const c001 = data[idx(i0, j0, k1)], c101 = data[idx(i1, j0, k1)];
    const c011 = data[idx(i0, j1, k1)], c111 = data[idx(i1, j1, k1)];
    const c00 = c000 + (c100 - c000) * fx, c10 = c010 + (c110 - c010) * fx;
    const c01 = c001 + (c101 - c001) * fx, c11 = c011 + (c111 - c011) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  };
  const sample = interp === "nearest" ? sampleNearest : sampleLinear;

  const outN = onx * ony * onz;
  const dst = likeArray(data, outN);
  const round = interp === "nearest" || isIntArray(data);   // integer input keeps integer output
  let o = 0;
  for (let k = 0; k < onz; k++) {
    for (let j = 0; j < ony; j++) {
      for (let i = 0; i < onx; i++) {
        const world = applyRowMajor(out.ijkToRAS, [i, j, k]);
        const inIjk = applyMat4(worldToInIjk, world);
        const v = sample(inIjk);
        dst[o++] = round ? Math.round(v) : v;
      }
    }
  }
  return dst;
}

function isIntArray(a: Scalars): boolean {
  const name = (a as { constructor?: { name?: string } }).constructor?.name ?? "";
  return /Int|Uint/.test(name) && !/Float/.test(name);
}

/** Convenience: build an output grid that matches an input's directions but a new voxel spacing (mm),
 *  covering the same RAS box. Used by "resample to isotropic" and downsampling. */
export function isotropicGrid(input: Grid, spacingMm: number): OutGrid {
  const [nx, ny, nz] = input.dims;
  // input voxel axes in RAS (columns of the 3x3 linear part, row-major)
  const m = input.ijkToRAS;
  const axisLen = (c: number) => Math.hypot(m[c], m[4 + c], m[8 + c]);
  const sx = axisLen(0), sy = axisLen(1), sz = axisLen(2);
  const onx = Math.max(1, Math.round((nx * sx) / spacingMm));
  const ony = Math.max(1, Math.round((ny * sy) / spacingMm));
  const onz = Math.max(1, Math.round((nz * sz) / spacingMm));
  // unit direction columns, scaled to the new spacing; keep the input origin
  const dir = (c: number): Vec3 => { const L = axisLen(c) || 1; return [m[c] / L, m[4 + c] / L, m[8 + c] / L]; };
  const dxv = dir(0), dyv = dir(1), dzv = dir(2);
  const ijkToRAS = [
    dxv[0] * spacingMm, dyv[0] * spacingMm, dzv[0] * spacingMm, m[3],
    dxv[1] * spacingMm, dyv[1] * spacingMm, dzv[1] * spacingMm, m[7],
    dxv[2] * spacingMm, dyv[2] * spacingMm, dzv[2] * spacingMm, m[11],
    0, 0, 0, 1,
  ];
  return { dims: [onx, ony, onz], ijkToRAS };
}
