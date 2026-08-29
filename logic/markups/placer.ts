// Markups placement (W4) — a pure state machine (events in, ops out), the model half of Slicer's
// interaction Place mode. A click at a RAS point either CREATES a new markup node (first point) or APPENDS a
// control point to the one being placed; placement COMPLETES when the type's point count is reached
// (fiducial 1, line 2, angle 3, plane 3, roi 2) or, for curves, only when the caller ends it (Enter/Esc/
// double-click). No side effects — the caller applies the returned ops to the LiveScene, so undo/sessions/
// sync see placement as ordinary put/patch. RAS in, mrson ops out.
import type { MrsonNode } from "../../render/mrson.ts";
import type { Op } from "../../render/liveops.ts";
import type { MarkupType } from "./measurements.ts";
import type { Vec3 } from "../../render/mat4.ts";

/** Control points a finished markup of each type holds (Infinity = open-ended, ended by the user). */
export const POINTS_NEEDED: Record<MarkupType, number> = {
  fiducial: 1, line: 2, angle: 3, plane: 3, roi: 2, curve: Infinity, closedCurve: Infinity,
};

const DEFAULT_COLOR = [1, 0.85, 0.2, 1];

export interface ControlPoint { position: Vec3; label?: string; id?: string; }
export interface PlaceResult { ops: Op[]; complete: boolean; nodeId: string; }

/** Build a fresh markup node (one control point) — the `put` op for the first click. */
export function newMarkupNode(id: string, markupType: MarkupType, first: Vec3, opts: { name?: string; color?: number[] } = {}): MrsonNode {
  const source = { mrmlClass: MRML_CLASS[markupType] };
  return {
    type: "markup", id, name: opts.name ?? defaultName(markupType), markupType, frame: "RAS",
    controlPoints: [{ position: first, label: pointLabel(markupType, 0) }],
    color: opts.color ?? DEFAULT_COLOR, glyphScale: 3, visible: true, locked: false,
    refs: {}, source, origin: { local: true },
  } as unknown as MrsonNode;
}

/**
 * Advance placement with a click at `ras`. If `node` is null a new markup is created (using `newId`), else a
 * control point is appended. Returns the ops to apply and whether placement is now complete.
 */
export function placeClick(markupType: MarkupType, node: MrsonNode | null, ras: Vec3, newId: string): PlaceResult {
  if (!node) {
    const complete = POINTS_NEEDED[markupType] <= 1;
    return { ops: [{ op: "put", id: newId, node: newMarkupNode(newId, markupType, ras) }], complete, nodeId: newId };
  }
  const cps = ((node.controlPoints as ControlPoint[] | undefined) ?? []).slice();
  const next = [...cps, { position: ras, label: pointLabel(markupType, cps.length) }];
  const complete = next.length >= POINTS_NEEDED[markupType];
  return { ops: [{ op: "patch", id: node.id as string, path: "#/controlPoints", value: next }], nodeId: node.id as string, complete };
}

/** Remove control point `index` from a markup (Slicer's delete-point). Returns the patch op, or null if
 *  removing would leave the markup below one point (caller should delete the node instead). */
export function removeControlPointOp(node: MrsonNode, index: number): Op | null {
  const cps = ((node.controlPoints as ControlPoint[] | undefined) ?? []).slice();
  if (index < 0 || index >= cps.length || cps.length <= 1) return null;
  cps.splice(index, 1);
  return { op: "patch", id: node.id as string, path: "#/controlPoints", value: cps };
}

function defaultName(t: MarkupType): string {
  return ({ fiducial: "F", line: "L", angle: "A", curve: "C", closedCurve: "CC", plane: "P", roi: "R" } as Record<MarkupType, string>)[t];
}
function pointLabel(t: MarkupType, i: number): string {
  return `${defaultName(t)}-${i + 1}`;
}
const MRML_CLASS: Record<MarkupType, string> = {
  fiducial: "vtkMRMLMarkupsFiducialNode", line: "vtkMRMLMarkupsLineNode", angle: "vtkMRMLMarkupsAngleNode",
  curve: "vtkMRMLMarkupsCurveNode", closedCurve: "vtkMRMLMarkupsClosedCurveNode", plane: "vtkMRMLMarkupsPlaneNode",
  roi: "vtkMRMLMarkupsROINode",
};
