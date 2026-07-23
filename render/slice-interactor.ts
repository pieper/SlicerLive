// Faithful port of Slicer's slice-view SLICE STEPPING (vtkMRMLSliceIntersectionWidget),
// so SlicerLive's wheel and keyboard slice navigation matches native Slicer exactly.
//
// Bindings, from vtkMRMLSliceIntersectionWidget::vtkMRMLSliceIntersectionWidget():
//   MouseWheelForward            -> IncrementSlice
//   MouseWheelBackward           -> DecrementSlice
//   "f" / "Right" / "Up"         -> IncrementSlice
//   "b" / "Left"  / "Down"       -> DecrementSlice
//   Ctrl+MouseWheelForward       -> ZoomOutSlice   (note: inverted vs plain wheel)
//   Ctrl+MouseWheelBackward      -> ZoomInSlice
//
// Stepping, from MoveSlice(delta) / GetSliceSpacing():
//   delta   = +/- GetLowestVolumeSliceSpacing()[2]  (the background volume's spacing
//             measured ALONG THE SLICE NORMAL — for MRHead: axial/coronal 1.0,
//             sagittal 1.2999954 because that normal follows the 1.3mm k axis)
//   newOffset = offset + delta
//   the move is applied ONLY if newOffset is inside the slice bounds — out-of-range
//   steps are REJECTED, not clamped (verified against Slicer: at 116.8857 with a
//   117.2857 bound, a +1.0 step leaves the offset unchanged).
//
// OFFSET CONVENTION: Slicer's sliceOffset is measured along the slice NORMAL, which is
// +S (axial), +A (coronal) and -R (sagittal) per the default sliceToRAS presets. Our
// renderer stores offset01 along the positive RAS axis, so we convert with a per-
// orientation sign.

import type { Orientation } from "./slice-renderer.ts";
import type { Vec3 } from "./mat4.ts";

/** RAS axis the plane scrubs along, and the sign of Slicer's slice normal on that axis. */
const NORMAL: Record<Orientation, { axis: 0 | 1 | 2; sign: 1 | -1 }> = {
  axial: { axis: 2, sign: 1 },      // sliceToRAS col2 = +S
  coronal: { axis: 1, sign: 1 },    // sliceToRAS col2 = +A
  sagittal: { axis: 0, sign: -1 },  // sliceToRAS col2 = -R
};

/** Which IJK axis is most aligned with a RAS axis (column of the row-major ijkToRAS). */
function ijkAxisForRasAxis(ijkToRAS: ArrayLike<number>, rasAxis: 0 | 1 | 2): number {
  let best = 0, bestMag = -1;
  for (let c = 0; c < 3; c++) {
    const mag = Math.abs(ijkToRAS[rasAxis * 4 + c]);
    if (mag > bestMag) { bestMag = mag; best = c; }
  }
  return best;
}

/** Slicer's GetSliceSpacing(): the background volume's spacing along the slice normal. */
export function sliceSpacingFor(orient: Orientation, ijkToRAS: ArrayLike<number>): number {
  const n = NORMAL[orient].axis;
  const a = ijkAxisForRasAxis(ijkToRAS, n);
  return Math.hypot(ijkToRAS[a], ijkToRAS[4 + a], ijkToRAS[8 + a]);   // |column a|
}

/** Slicer's GetSliceBounds() along the normal, in Slicer's signed offset convention. */
export function sliceBoundsFor(orient: Orientation, rasLo: Vec3, rasHi: Vec3): [number, number] {
  const { axis, sign } = NORMAL[orient];
  return sign > 0 ? [rasLo[axis], rasHi[axis]] : [-rasHi[axis], -rasLo[axis]];
}

/** offset01 (our storage, along +RAS axis) -> Slicer's signed sliceOffset in mm. */
export function offset01ToMm(orient: Orientation, offset01: number, rasLo: Vec3, rasHi: Vec3): number {
  const { axis, sign } = NORMAL[orient];
  return sign * (rasLo[axis] + offset01 * (rasHi[axis] - rasLo[axis]));
}

/** Slicer's signed sliceOffset in mm -> offset01. */
export function mmToOffset01(orient: Orientation, mm: number, rasLo: Vec3, rasHi: Vec3): number {
  const { axis, sign } = NORMAL[orient];
  const ras = sign * mm;
  const span = rasHi[axis] - rasLo[axis];
  return span === 0 ? 0.5 : (ras - rasLo[axis]) / span;
}

export interface SliceGeometry { ijkToRAS: ArrayLike<number>; rasLo: Vec3; rasHi: Vec3 }

/** Slice-view stepping with Slicer's exact semantics. */
export class SliceInteractor {
  constructor(private geom: SliceGeometry) {}

  setGeometry(g: SliceGeometry) { this.geom = g; }

  spacing(orient: Orientation): number { return sliceSpacingFor(orient, this.geom.ijkToRAS); }
  bounds(orient: Orientation): [number, number] { return sliceBoundsFor(orient, this.geom.rasLo, this.geom.rasHi); }

  /** vtkMRMLSliceIntersectionWidget::MoveSlice — returns the NEW offset01, or the
   *  unchanged one if the step would leave the slice bounds (Slicer rejects, not clamps). */
  moveSlice(orient: Orientation, offset01: number, deltaMm: number): number {
    const { rasLo, rasHi } = this.geom;
    const cur = offset01ToMm(orient, offset01, rasLo, rasHi);
    const next = cur + deltaMm;
    const [lo, hi] = this.bounds(orient);
    if (next < lo || next > hi) return offset01;         // out of range -> no move
    return mmToOffset01(orient, next, rasLo, rasHi);
  }

  incrementSlice(orient: Orientation, offset01: number): number {
    return this.moveSlice(orient, offset01, this.spacing(orient));
  }
  decrementSlice(orient: Orientation, offset01: number): number {
    return this.moveSlice(orient, offset01, -this.spacing(orient));
  }

  /** Map a wheel event to a step. Returns the new offset01. */
  wheel(orient: Orientation, offset01: number, forward: boolean): number {
    return forward ? this.incrementSlice(orient, offset01) : this.decrementSlice(orient, offset01);
  }

  /** Slicer's slice-view keyboard bindings. Returns the new offset01 (unchanged if the
   *  key isn't a stepping key). `key` is a DOM KeyboardEvent.key value. */
  key(orient: Orientation, offset01: number, key: string): number {
    switch (key) {
      case "f": case "F": case "ArrowRight": case "ArrowUp":
        return this.incrementSlice(orient, offset01);
      case "b": case "B": case "ArrowLeft": case "ArrowDown":
        return this.decrementSlice(orient, offset01);
      default:
        return offset01;
    }
  }

  /** True if this key is one Slicer's slice view consumes for stepping. */
  static isStepKey(key: string): boolean {
    return ["f", "F", "b", "B", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(key);
  }
}
