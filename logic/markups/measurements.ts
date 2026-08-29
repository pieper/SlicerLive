// Markups measurements (W4) — the vtkMRMLMeasurement* computations, pure and RAS-based. Length (line/curve),
// Angle (at the middle control point), Area (closed curve, planar polygon), Volume (ROI box). Matches Slicer's
// definitions: length in mm, angle in degrees [0,180], area in mm^2 (or cm^2 when converted upstream), volume in
// mm^3. No display/coordinate side effects — callers pass RAS control points.
import type { Vec3 } from "../../render/mat4.ts";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Distance between two RAS points (mm). */
export function distance(a: Vec3, b: Vec3): number { return norm(sub(a, b)); }

/** Polyline length: sum of consecutive segment lengths. `closed` wraps the last point to the first. */
export function polylineLength(points: Vec3[], closed = false): number {
  if (points.length < 2) return 0;
  let L = 0;
  for (let i = 1; i < points.length; i++) L += distance(points[i], points[i - 1]);
  if (closed && points.length > 2) L += distance(points[0], points[points.length - 1]);
  return L;
}

/** Angle (degrees, 0..180) at the middle point p1 of the ray p1->p0 and p1->p2. */
export function angleDeg(p0: Vec3, p1: Vec3, p2: Vec3): number {
  const a = sub(p0, p1), b = sub(p2, p1);
  const la = norm(a), lb = norm(b);
  if (la === 0 || lb === 0) return 0;
  const c = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Area (mm^2) of a planar (or near-planar) polygon in 3D via Newell's method — order-independent, robust to
 *  the polygon's orientation in space (Slicer's ClosedCurve area). */
export function polygonArea(points: Vec3[]): number {
  if (points.length < 3) return 0;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm([nx, ny, nz]) / 2;
}

/** ROI box volume (mm^3) from its size (extent) in mm. */
export function boxVolume(size: Vec3): number { return Math.abs(size[0] * size[1] * size[2]); }

export type MarkupType = "fiducial" | "line" | "angle" | "curve" | "closedCurve" | "plane" | "roi";
export interface Measurement { name: string; value: number; units: string; }

/** The measurement(s) Slicer shows for a markups node of a given type. */
export function measurementsFor(type: MarkupType, controlPoints: Vec3[], roiSize?: Vec3): Measurement[] {
  switch (type) {
    case "line": return controlPoints.length >= 2 ? [{ name: "length", value: distance(controlPoints[0], controlPoints[1]), units: "mm" }] : [];
    case "angle": return controlPoints.length >= 3 ? [{ name: "angle", value: angleDeg(controlPoints[0], controlPoints[1], controlPoints[2]), units: "deg" }] : [];
    case "curve": return [{ name: "length", value: polylineLength(controlPoints, false), units: "mm" }];
    case "closedCurve": return [
      { name: "length", value: polylineLength(controlPoints, true), units: "mm" },
      { name: "area", value: polygonArea(controlPoints), units: "mm2" },
    ];
    case "roi": return roiSize ? [{ name: "volume", value: boxVolume(roiSize), units: "mm3" }] : [];
    default: return [];
  }
}
