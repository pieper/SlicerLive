// A faithful TypeScript port of the parts of vtkCamera that Slicer's 3D view
// interaction depends on. This replaces SlicerLive's ad-hoc azimuth/elevation/distance
// orbit so the camera follows Slicer's geometry logic exactly.
//
// Ported from VTK/Rendering/Core/vtkCamera.cxx (Azimuth, Elevation, OrthogonalizeViewUp,
// Dolly) and vtkTransform::SetupCamera. Conventions, straight from the source:
//
//   view transform rows (world -> camera basis), built from position/focalPoint/viewUp:
//     row2 "viewPlaneNormal" = normalize(position - focalPoint)      ("back")
//     row0 "viewSideways"    = normalize(cross(viewUp, back))        ("right")
//     row1 "orthoViewUp"     = cross(back, right)                    ("true up")
//
//   Azimuth(a)   : rotate position about the VIEW UP axis through the focal point.
//                  viewUp itself is NOT modified.
//   Elevation(a) : rotate position about axis = -row0 (i.e. -right) through the focal
//                  point. VTK temporarily rotates viewUp for the internal view-transform
//                  computation and then restores the member, so the *effective* up used
//                  downstream is the rotated one — which is why Slicer always follows
//                  Elevation with OrthogonalizeViewUp().
//   OrthogonalizeViewUp() : viewUp = row1 of the current view transform.
//   Dolly(f)     : d = distance / f ; position = focalPoint - d * directionOfProjection.
//                  (f > 1 moves the camera TOWARD the focal point.)

import type { Vec3 } from "./mat4.ts";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

/** Rotate vector v about unit axis k by `deg` degrees (Rodrigues) — vtkTransform::RotateWXYZ. */
function rotateAboutAxis(v: Vec3, axis: Vec3, deg: number): Vec3 {
  const k = normalize(axis);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

export interface CameraBasis { right: Vec3; up: Vec3; back: Vec3 }

export class VtkCamera {
  position: Vec3;
  focalPoint: Vec3;
  viewUp: Vec3;
  viewAngle: number;   // degrees (vtkCamera default 30)
  parallelProjection = false;
  parallelScale = 1;

  constructor(
    position: Vec3 = [0, 0, 1],
    focalPoint: Vec3 = [0, 0, 0],
    viewUp: Vec3 = [0, 1, 0],
    viewAngle = 30,
  ) {
    this.position = [...position] as Vec3;
    this.focalPoint = [...focalPoint] as Vec3;
    this.viewUp = [...viewUp] as Vec3;
    this.viewAngle = viewAngle;
  }

  /** Slicer's default 3D camera (vtkMRMLCameraNode): (0,500,0) -> origin, +S up, 30 deg. */
  static slicerDefault(): VtkCamera {
    return new VtkCamera([0, 500, 0], [0, 0, 0], [0, 0, 1], 30);
  }

  clone(): VtkCamera {
    const c = new VtkCamera(this.position, this.focalPoint, this.viewUp, this.viewAngle);
    c.parallelProjection = this.parallelProjection;
    c.parallelScale = this.parallelScale;
    return c;
  }

  get distance(): number { return norm(sub(this.focalPoint, this.position)); }
  /** normalize(focalPoint - position) — vtkCamera::DirectionOfProjection. */
  get directionOfProjection(): Vec3 { return normalize(sub(this.focalPoint, this.position)); }

  /** Rows of the view transform, per vtkTransform::SetupCamera. */
  basis(viewUp: Vec3 = this.viewUp): CameraBasis {
    const back = normalize(sub(this.position, this.focalPoint));
    const right = normalize(cross(viewUp, back));
    const up = cross(back, right);
    return { right, up, back };
  }

  /** vtkCamera::Azimuth — rotate position about viewUp through the focal point. */
  azimuth(deg: number) {
    const rel = sub(this.position, this.focalPoint);
    this.position = add(this.focalPoint, rotateAboutAxis(rel, this.viewUp, deg));
  }

  /** vtkCamera::Elevation — rotate position about -right through the focal point.
   *  Returns the rotated view-up VTK uses internally (see class comment); callers that
   *  mirror Slicer follow with orthogonalizeViewUp(rotatedUp). */
  elevation(deg: number): Vec3 {
    const axis = scale(this.basis().right, -1);      // axis = -row0
    const rotatedUp = rotateAboutAxis(this.viewUp, axis, deg);
    const rel = sub(this.position, this.focalPoint);
    this.position = add(this.focalPoint, rotateAboutAxis(rel, axis, deg));
    return rotatedUp;
  }

  /** vtkCamera::OrthogonalizeViewUp — viewUp = row1 of the view transform. */
  orthogonalizeViewUp(usingUp: Vec3 = this.viewUp) {
    this.viewUp = this.basis(usingUp).up;
  }

  /** vtkCamera::Dolly — factor > 1 moves the camera toward the focal point. */
  dolly(factor: number) {
    if (factor <= 0) return;
    if (this.parallelProjection) { this.parallelScale = this.parallelScale / factor; return; }
    const d = this.distance / factor;
    const dop = this.directionOfProjection;
    this.position = sub(this.focalPoint, scale(dop, d));
  }

  /** Translate both position and focal point (used by pan). */
  translate(v: Vec3) {
    this.position = add(this.position, v);
    this.focalPoint = add(this.focalPoint, v);
  }

  /** Half-height of the view plane at the focal point (perspective). */
  focalPlaneHalfHeight(): number {
    return this.parallelProjection ? this.parallelScale : this.distance * Math.tan((this.viewAngle * Math.PI) / 360);
  }

  /** Pan by a display-space delta, moving the world under the cursor 1:1 at focal depth.
   *  Equivalent to vtkMRMLCameraWidget::ProcessTranslate's focal-depth unprojection, but
   *  expressed directly in the camera basis (exact for a centred perspective view).
   *  dxDisplay/dyDisplay are in VTK display convention (y UP). */
  panByDisplayDelta(dxDisplay: number, dyDisplay: number, viewportWidth: number, viewportHeight: number) {
    const halfH = this.focalPlaneHalfHeight();
    const mmPerPixel = (2 * halfH) / viewportHeight;
    const { right, up } = this.basis();
    // camera motion is reversed relative to the cursor (the scene follows the cursor)
    const motion = add(scale(right, -dxDisplay * mmPerPixel), scale(up, -dyDisplay * mmPerPixel));
    this.translate(motion);
  }

  /** vtkCamera-comparable snapshot for the harness. */
  state() {
    return {
      position: [...this.position] as Vec3,
      focalPoint: [...this.focalPoint] as Vec3,
      viewUp: [...this.viewUp] as Vec3,
      viewAngle: this.viewAngle,
      distance: this.distance,
    };
  }
}
