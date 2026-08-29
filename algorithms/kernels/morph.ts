// Binary morphology + median (W5) — the kernels under the Segment Editor's Smoothing effect (Median /
// Opening / Closing) and Margin (grow/shrink). Replaces vtkImageOpenClose3D / vtkImageMedian3D /
// vtkImageDilateErode3D for labelmaps. Structuring element = a Euclidean ball of a given voxel radius
// (di^2+dj^2+dk^2 <= r^2), matching scipy.ndimage with the same footprint. C-order, dims [nx,ny,nz].
//
//   deno test -A --no-check algorithms/kernels/morph.test.ts
export type Mask = { length: number; [i: number]: number };

/** Offsets of a Euclidean ball of radius r (voxels). r=1 -> 6-neighborhood + center (a plus in 3D). */
export function ballOffsets(r: number): [number, number, number][] {
  const R = Math.floor(r), r2 = r * r, out: [number, number, number][] = [];
  for (let dk = -R; dk <= R; dk++) for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    if (di * di + dj * dj + dk * dk <= r2) out.push([di, dj, dk]);
  }
  return out;
}

function morph(mask: Mask, dims: [number, number, number], r: number, mode: "dilate" | "erode"): Uint8Array {
  const [nx, ny, nz] = dims, offs = ballOffsets(r);
  const out = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  const dilate = mode === "dilate";
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let v = dilate ? 0 : 1;
    for (const [di, dj, dk] of offs) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      // erosion treats out-of-bounds as background (0) -> shrinks at borders; dilation ignores them
      const inb = ii >= 0 && ii < nx && jj >= 0 && jj < ny && kk >= 0 && kk < nz;
      const s = inb ? (mask[idx(ii, jj, kk)] ? 1 : 0) : 0;
      if (dilate) { if (s) { v = 1; break; } } else { if (!s) { v = 0; break; } }
    }
    out[idx(i, j, k)] = v;
  }
  return out;
}

export const binaryDilate = (m: Mask, d: [number, number, number], r = 1): Uint8Array => morph(m, d, r, "dilate");
export const binaryErode = (m: Mask, d: [number, number, number], r = 1): Uint8Array => morph(m, d, r, "erode");
/** Opening = erode then dilate (removes small protrusions / thin bridges). */
export const binaryOpen = (m: Mask, d: [number, number, number], r = 1): Uint8Array => binaryDilate(binaryErode(m, d, r), d, r);
/** Closing = dilate then erode (fills small holes / gaps). */
export const binaryClose = (m: Mask, d: [number, number, number], r = 1): Uint8Array => binaryErode(binaryDilate(m, d, r), d, r);

/** Median (majority vote) over a Euclidean ball — Slicer's Median smoothing. Ties (exactly half) keep on. */
export function median3d(mask: Mask, dims: [number, number, number], r = 1): Uint8Array {
  const [nx, ny, nz] = dims, offs = ballOffsets(r);
  const out = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let on = 0, tot = 0;
    for (const [di, dj, dk] of offs) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      if (ii < 0 || ii >= nx || jj < 0 || jj >= ny || kk < 0 || kk >= nz) continue;
      tot++; if (mask[idx(ii, jj, kk)]) on++;
    }
    out[idx(i, j, k)] = on * 2 >= tot ? 1 : 0;
  }
  return out;
}
