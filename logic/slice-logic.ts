// Slice-view geometry math ported from vtkMRMLSliceLogic (pure TS, RAS internal). Two functions W2 needs:
//   fitFovToVolume  — vtkMRMLSliceLogic::FitSliceToVolumes: the field of view that frames a volume in a
//                     viewport, fitting the volume to the SMALLER window dimension (the other axis fills by
//                     aspect ratio). Validated against the live-Slicer fixture (harness/fixtures/slicer-startup).
//   offsetRangeResolution — vtkMRMLSliceLogic::GetSliceOffsetRangeResolution: the slider [min,max] + step,
//                     in Slicer's signed slice-offset convention (bounds along the normal, step = spacing).
import type { Orientation } from "../render/slice-renderer.ts";
import { sliceBoundsFor, sliceSpacingFor } from "../render/slice-interactor.ts";
import type { Vec3 } from "../render/mat4.ts";

// The two in-plane RAS axes (row, col) for each orientation — Slicer's slice-view axes.
const IN_PLANE: Record<Orientation, [0 | 1 | 2, 0 | 1 | 2]> = {
  axial: [0, 1],     // R (horizontal), A (vertical)
  coronal: [0, 2],   // R, S
  sagittal: [1, 2],  // A, S
};

/** Fitted [fovX, fovY, slabZ] mm for `orient` framing the RAS box [rasLo,rasHi] in a viewport of viewW×viewH px. */
export function fitFovToVolume(orient: Orientation, rasLo: Vec3, rasHi: Vec3, ijkToRAS: ArrayLike<number>, viewW: number, viewH: number): [number, number, number] {
  const [rx, cy] = IN_PLANE[orient];
  const ex = Math.abs(rasHi[rx] - rasLo[rx]);          // volume extent along the slice row axis
  const ey = Math.abs(rasHi[cy] - rasLo[cy]);          // along the slice col axis
  const slab = sliceSpacingFor(orient, ijkToRAS);
  let fovX: number, fovY: number;
  if (viewH > viewW) { const px = ex / viewW; fovX = ex; fovY = px * viewH; }
  else { const px = ey / viewH; fovY = ey; fovX = px * viewW; }
  return [fovX, fovY, slab];
}

export interface OffsetRange { min: number; max: number; step: number }

/** Slider range + step for a slice, Slicer's signed offset convention (mm along the normal). */
export function offsetRangeResolution(orient: Orientation, ijkToRAS: ArrayLike<number>, rasLo: Vec3, rasHi: Vec3): OffsetRange {
  const [lo, hi] = sliceBoundsFor(orient, rasLo, rasHi);
  const step = sliceSpacingFor(orient, ijkToRAS) || 1;
  if (hi - lo < step) { const c = (lo + hi) / 2; return { min: c - step, max: c + step, step }; }  // single-slice
  return { min: lo, max: hi, step };
}
