// Edge labels for a 2D view, derived from the view's own basis rather than from the name of the
// plane. Deriving them is what keeps them honest: an oblique or rotating view (a MIP spinning
// about S-I) has no fixed plane, and a label that says "L" while the camera has swung round to
// the patient's right is worse than no label at all.
//
// RAS, radiological convention: +x = Right, +y = Anterior, +z = Superior.

import type { Vec3 } from "../render/mat4.ts";

/** The six anatomical directions, as single letters. */
export type AnatomicalLabel = "R" | "L" | "A" | "P" | "S" | "I";

const POSITIVE: AnatomicalLabel[] = ["R", "A", "S"];
const NEGATIVE: AnatomicalLabel[] = ["L", "P", "I"];

export const OPPOSITE: Record<AnatomicalLabel, AnatomicalLabel> = {
  R: "L", L: "R", A: "P", P: "A", S: "I", I: "S",
};

/** The anatomical direction a vector mostly points along.
 *
 *  Returns null for a vector with no dominant axis — one pointing exactly between two of them,
 *  where any single letter would be a lie. Ties go to the earlier axis only when the vector is
 *  non-degenerate in it, so the 45-degree case is reported as ambiguous instead of guessed. */
export function labelOf(dir: Vec3, tolerance = 1e-6): AnatomicalLabel | null {
  const abs = [Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2])];
  const max = Math.max(abs[0], abs[1], abs[2]);
  if (max <= tolerance) return null;
  // More than one axis within tolerance of the maximum means there is no dominant direction.
  if (abs.filter((a) => max - a <= tolerance).length > 1) return null;
  const axis = abs.indexOf(max);
  return dir[axis] > 0 ? POSITIVE[axis] : NEGATIVE[axis];
}

export interface EdgeLabels {
  /** Screen edges. A null edge has no dominant anatomical direction and should render blank. */
  right: AnatomicalLabel | null;
  left: AnatomicalLabel | null;
  top: AnatomicalLabel | null;
  bottom: AnatomicalLabel | null;
}

/** Edge labels for a view whose screen-right is `uDir` and screen-up is `vDir`, both in RAS. */
export function edgeLabels(uDir: Vec3, vDir: Vec3, tolerance = 1e-6): EdgeLabels {
  const right = labelOf(uDir, tolerance);
  const top = labelOf(vDir, tolerance);
  return {
    right,
    left: right ? OPPOSITE[right] : null,
    top,
    bottom: top ? OPPOSITE[top] : null,
  };
}
