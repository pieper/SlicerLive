// Bidimensional lesion size from a segmentation, the way RECIST 1.1 asks for it.
//
// Two rules from the criteria that a naive bounding box gets wrong:
//
//  * Measurements are made IN ONE PLANE, on the slice where the lesion is largest -- not as a 3D
//    diameter. A 3D caliper across an obliquely oriented node reports a number no reader can
//    reproduce with on-screen calipers.
//  * For a pathological LYMPH NODE it is the SHORT axis that counts ("short axis... measured and
//    followed"), where for a non-nodal lesion it is the long axis. Both are returned, and
//    `recistDiameterMm` applies the rule, so a caller cannot accidentally follow the wrong one.
//
// The axes themselves: on the chosen slice, the long axis is the longest chord between any two
// in-plane voxel centres of the mask, and the short axis is the longest chord ACROSS the lesion
// perpendicular to it -- the "greatest perpendicular diameter". That is a chord, not a bounding
// extent: for a 9 x 4 mm rectangle the perpendicular chord is 4.4 mm, while the total spread of
// the shape along the same direction is 7.3 mm. The chord is what a reader measures with on-screen
// calipers, and it is what "2.5 x 1.8 cm" means.

import type { VoxelMask } from "./indices.ts";

/** Which in-plane axes a reslice plane spans, and which index it steps along. */
export type MeasurePlane = "axial" | "coronal" | "sagittal";

/** The two in-plane voxel axes (0=i, 1=j, 2=k) and the stepping axis, for each plane.
 *  Matches an LPS/RAS-aligned acquisition: axial slices step along k, coronal along j, sagittal
 *  along i. An oblique acquisition would need the volume's own direction cosines; a caller with
 *  one should reslice first rather than measure through this. */
const PLANE_AXES: Record<MeasurePlane, { u: 0 | 1 | 2; v: 0 | 1 | 2; n: 0 | 1 | 2 }> = {
  axial: { u: 0, v: 1, n: 2 },
  coronal: { u: 0, v: 2, n: 1 },
  sagittal: { u: 1, v: 2, n: 0 },
};

export interface BidimensionalAxes {
  /** Longest in-plane chord, mm. */
  longAxisMm: number;
  /** Largest extent perpendicular to the long axis, in the same plane, mm. */
  shortAxisMm: number;
  /** Index along the plane normal of the slice the measurement was taken on. */
  sliceIndex: number;
  /** Voxels of the mask on that slice — how big the cross-section was. */
  sliceVoxels: number;
  /** In-plane endpoints of the long axis, as [i,j,k] voxel indices, for drawing it. */
  longAxisEnds: [[number, number, number], [number, number, number]] | null;
  plane: MeasurePlane;
}

/** Measure a mask bidimensionally on its largest cross-section.
 *
 *  `spacing` is the voxel edge length in mm along i, j, k. Returns zero-sized axes for an empty
 *  mask rather than throwing, so a caller measuring a region that thresholded away still gets a
 *  record it can store. */
export function bidimensionalAxes(
  mask: VoxelMask,
  dims: [number, number, number],
  spacing: [number, number, number],
  plane: MeasurePlane = "axial",
): BidimensionalAxes {
  const { u, v, n } = PLANE_AXES[plane];
  const [nx, ny] = dims;
  const empty: BidimensionalAxes = {
    longAxisMm: 0,
    shortAxisMm: 0,
    sliceIndex: -1,
    sliceVoxels: 0,
    longAxisEnds: null,
    plane,
  };

  // Which slice is the lesion largest on? That is where RECIST measures.
  const perSlice = new Int32Array(dims[n]);
  const idxOf = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        if (!mask[idxOf(i, j, k)]) continue;
        perSlice[[i, j, k][n]]++;
      }
    }
  }
  let best = -1, bestCount = 0;
  for (let s = 0; s < perSlice.length; s++) {
    if (perSlice[s] > bestCount) { bestCount = perSlice[s]; best = s; }
  }
  if (best < 0) return empty;

  // Collect that slice's voxels as in-plane millimetre points. Only BOUNDARY voxels can be an
  // endpoint of the longest chord, and for the perpendicular extent the extremes are on the
  // boundary too, so the interior is dropped -- which is what keeps this near-linear on a node.
  const pts: { x: number; y: number; ijk: [number, number, number] }[] = [];
  const at = (i: number, j: number, k: number) =>
    i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2] ? 0 : mask[idxOf(i, j, k)];
  const loop = (fn: (a: number, b: number) => void) => {
    const au = dims[u], av = dims[v];
    for (let b = 0; b < av; b++) for (let a = 0; a < au; a++) fn(a, b);
  };
  loop((a, b) => {
    const ijk: [number, number, number] = [0, 0, 0];
    ijk[u] = a; ijk[v] = b; ijk[n] = best;
    if (!at(ijk[0], ijk[1], ijk[2])) return;
    // 4-neighbourhood IN PLANE: a voxel with a neighbour outside the mask is on the boundary.
    const nb: [number, number][] = [[a - 1, b], [a + 1, b], [a, b - 1], [a, b + 1]];
    const isBoundary = nb.some(([na, nb2]) => {
      const q: [number, number, number] = [0, 0, 0];
      q[u] = na; q[v] = nb2; q[n] = best;
      return !at(q[0], q[1], q[2]);
    });
    if (isBoundary) pts.push({ x: a * spacing[u], y: b * spacing[v], ijk });
  });
  if (pts.length === 0) return { ...empty, sliceIndex: best, sliceVoxels: bestCount };
  if (pts.length === 1) {
    // A single voxel: its size is one voxel across, not zero.
    return {
      longAxisMm: spacing[u],
      shortAxisMm: spacing[v],
      sliceIndex: best,
      sliceVoxels: bestCount,
      longAxisEnds: [pts[0].ijk, pts[0].ijk],
      plane,
    };
  }

  // Longest chord between boundary points.
  let d2 = -1, ia = 0, ib = 1;
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y;
      const q = dx * dx + dy * dy;
      if (q > d2) { d2 = q; ia = a; ib = b; }
    }
  }
  const longAxisMm = Math.sqrt(d2);

  // Greatest perpendicular DIAMETER: the longest chord across the lesion at right angles to the
  // long axis. Found over boundary pairs whose separation along the long axis is within one voxel
  // of zero -- and reported as the leg perpendicular to it, sqrt(L^2 - ds^2), so the answer does
  // not depend on how loose that tolerance is.
  const ux = (pts[ib].x - pts[ia].x) / (longAxisMm || 1);
  const uy = (pts[ib].y - pts[ia].y) / (longAxisMm || 1);
  const tol = Math.max(spacing[u], spacing[v]);
  let perp2 = 0;
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
      const ds = dx * ux + dy * uy;
      if (Math.abs(ds) > tol) continue;
      const q = dx * dx + dy * dy - ds * ds;
      if (q > perp2) perp2 = q;
    }
  }
  // A cross-section one voxel thick still has one voxel of width.
  const thin = Math.min(spacing[u], spacing[v]);
  const shortAxisMm = Math.max(Math.sqrt(perp2), thin);

  return {
    longAxisMm,
    shortAxisMm,
    sliceIndex: best,
    sliceVoxels: bestCount,
    longAxisEnds: [pts[ia].ijk, pts[ib].ijk],
    plane,
  };
}

/** The single diameter RECIST 1.1 follows for this lesion.
 *
 *  Short axis for a pathological lymph node, long axis otherwise. Getting this backwards changes
 *  the response category, so it is a function rather than a note in a comment. */
export function recistDiameterMm(axes: BidimensionalAxes, isLymphNode: boolean): number {
  return isLymphNode ? axes.shortAxisMm : axes.longAxisMm;
}

/** RECIST 1.1 measurability by size. `sliceThicknessMm` matters because the criteria require a
 *  lesion to be at least twice the slice thickness to be measurable at all.
 *
 *  Non-nodal: long axis >= 10 mm and >= 2x slice thickness.
 *  Nodal: short axis >= 15 mm to be a target; 10-15 mm is pathological but non-target. */
export function recistMeasurable(
  axes: BidimensionalAxes,
  isLymphNode: boolean,
  sliceThicknessMm: number,
): { measurable: boolean; target: boolean; reason: string } {
  const d = recistDiameterMm(axes, isLymphNode);
  const floor = Math.max(isLymphNode ? 15 : 10, 2 * sliceThicknessMm);
  if (isLymphNode) {
    if (d >= floor) return { measurable: true, target: true, reason: `short axis ${d.toFixed(1)} mm >= ${floor.toFixed(1)} mm` };
    if (d >= 10) return { measurable: false, target: false, reason: `short axis ${d.toFixed(1)} mm: pathological but non-target (needs 15 mm)` };
    return { measurable: false, target: false, reason: `short axis ${d.toFixed(1)} mm: normal-sized node` };
  }
  if (d >= floor) return { measurable: true, target: true, reason: `long axis ${d.toFixed(1)} mm >= ${floor.toFixed(1)} mm` };
  return { measurable: false, target: false, reason: `long axis ${d.toFixed(1)} mm < ${floor.toFixed(1)} mm` };
}
