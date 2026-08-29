// Slice linking (W2) — a faithful port of vtkMRMLSliceLinkLogic::BroadcastSliceNodeEvent. When a slice view's
// sliceComposite has linkedControl on, an interaction in it broadcasts to the OTHER slice views in the same
// view group. The rules (from Libs/MRML/Logic/vtkMRMLSliceLinkLogic.cxx):
//   - SliceToRAS (slice plane incl. offset) is copied ONLY to views whose orientation matches (all three
//     normalized SliceToRAS axes within tol 0.001). So scrolling one axial view scrolls other axial views,
//     but not the sagittal/coronal ones.
//   - FieldOfView (zoom) is copied to ALL linked views regardless of orientation (x from source, y aspect-
//     corrected to the target, z kept) — "review a volume at one zoom across views".
//   - Orientation change copies SliceToRAS to ALL linked views regardless of match (they realign).
// hotLinkedControl only decides live-during-drag vs at-drag-end for the reformat rotation; the WHAT is the same.
// Pure: row-major sliceToRAS (matches the native `view`/kind:slice node), no side effects.

export type SliceLinkFlag = "SliceToRAS" | "FieldOfView" | "Orientation";
export interface LinkSliceState {
  name: string;
  sliceToRAS: number[];              // row-major 16
  fieldOfView: [number, number, number];
  viewGroup?: number;                // default 0
}
export interface SliceUpdate { sliceToRAS?: number[]; fieldOfView?: [number, number, number]; }

const axis = (m: number[], i: number): [number, number, number] => {
  const v: [number, number, number] = [m[i], m[4 + i], m[8 + i]];
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
};

/** vtkMRMLSliceLinkLogic::IsOrientationMatching — all three normalized SliceToRAS axes agree within tol. */
export function isOrientationMatching(a: number[], b: number[], tol = 0.001): boolean {
  for (let i = 0; i < 3; i++) {
    const va = axis(a, i), vb = axis(b, i);
    if (Math.abs(va[0] - vb[0]) > tol || Math.abs(va[1] - vb[1]) > tol || Math.abs(va[2] - vb[2]) > tol) return false;
  }
  return true;
}

/**
 * Given a change in `source` (with `flags` describing what changed), return the updates to apply to each of
 * `others` in the same view group. Mirrors BroadcastSliceNodeEvent exactly.
 */
export function broadcastSlice(source: LinkSliceState, others: LinkSliceState[], flags: Iterable<SliceLinkFlag>): Map<string, SliceUpdate> {
  const set = new Set(flags);
  const vg = source.viewGroup ?? 0;
  const out = new Map<string, SliceUpdate>();
  for (const o of others) {
    if (o.name === source.name || (o.viewGroup ?? 0) !== vg) continue;
    const u: SliceUpdate = {};
    // SliceToRAS: only when orientation matches
    if (set.has("SliceToRAS") && isOrientationMatching(source.sliceToRAS, o.sliceToRAS)) u.sliceToRAS = source.sliceToRAS.slice();
    // Orientation change: copy SliceToRAS regardless of match (realigns the target)
    if (set.has("Orientation")) u.sliceToRAS = source.sliceToRAS.slice();
    // FieldOfView: copy x, aspect-correct y to the target, keep the target z (regardless of orientation)
    if (set.has("FieldOfView")) u.fieldOfView = [source.fieldOfView[0], source.fieldOfView[0] * o.fieldOfView[1] / o.fieldOfView[0], o.fieldOfView[2]];
    if (u.sliceToRAS || u.fieldOfView) out.set(o.name, u);
  }
  return out;
}
