// Faithful port of Slicer's 3D-view camera interaction (vtkMRMLCameraWidget), so
// SlicerLive's mouse bindings and camera math match native Slicer exactly.
//
// Bindings, straight from vtkMRMLCameraWidget::vtkMRMLCameraWidget():
//   Left                      -> Rotate
//   Left + Alt                -> Rotate
//   Left + Shift              -> Translate (pan)
//   Middle                    -> Translate
//   Middle + Alt              -> Translate
//   Left + Alt + Shift        -> Translate
//   Left + Ctrl               -> Spin
//   Left + Shift + Ctrl       -> Scale (dolly)
//   Right                     -> Scale (dolly)
//   Right + Alt               -> Scale
//   Wheel forward/backward    -> Dolly(1.1^(+/-0.2 * MotionFactor * MouseWheelMotionFactor))
//
// Constants: MotionFactor = 10.0, MouseWheelMotionFactor = 1.0.
//
// Math:
//   Rotate  : delta_azimuth = -20/width ; delta_elevation = -20/height
//             rxf = dx * delta_azimuth   * MotionFactor
//             ryf = dy * delta_elevation * MotionFactor
//             camera.Azimuth(rxf); camera.Elevation(ryf); camera.OrthogonalizeViewUp();
//   Scale   : dyf = MotionFactor * dy / center[1]   (center[1] = height/2)
//             Dolly(pow(1.1, -dyf))   <- Slicer negates vs VTK ("pull mouse towards you
//                                        to bring models closer")
//   Spin    : rotate about the view plane normal by the angle swept around the viewport centre.
//
// COORDINATES: VTK display coords have the origin at the BOTTOM-left (y up); browser
// pointer coords have it at the TOP-left (y down). We convert on the way in, so all the
// math below is in VTK convention and can be compared to Slicer 1:1.

import { VtkCamera } from "./vtk-camera.ts";
import type { Vec3 } from "./mat4.ts";

export const MOTION_FACTOR = 10.0;
export const MOUSE_WHEEL_MOTION_FACTOR = 1.0;

export type CameraAction = "rotate" | "translate" | "scale" | "spin" | "none";

export interface Modifiers { shift?: boolean; ctrl?: boolean; alt?: boolean }

/** vtkMRMLCameraWidget's event translation table: (button, modifiers) -> action. */
export function actionForButton(button: 0 | 1 | 2, m: Modifiers = {}): CameraAction {
  const shift = !!m.shift, ctrl = !!m.ctrl, alt = !!m.alt;
  if (button === 0) {                        // left
    if (shift && ctrl) return "scale";
    if (ctrl) return "spin";
    if (shift) return "translate";           // covers Left+Shift and Left+Alt+Shift
    return "rotate";                         // covers Left and Left+Alt
  }
  if (button === 1) return "translate";      // middle (with or without Alt)
  if (button === 2) return "scale";          // right (with or without Alt)
  return "none";
}

/** Drives a VtkCamera from browser pointer events using Slicer's bindings + math. */
export class CameraInteractor {
  camera: VtkCamera;
  action: CameraAction = "none";
  private prev: [number, number] | null = null;   // previous position, VTK display coords
  onChange?: () => void;

  constructor(camera: VtkCamera, onChange?: () => void) {
    this.camera = camera;
    this.onChange = onChange;
  }

  /** Convert browser (cssX, cssY within the view) to VTK display coords (y up). */
  static toDisplay(cssX: number, cssY: number, height: number): [number, number] {
    return [cssX, height - cssY];
  }

  start(button: 0 | 1 | 2, cssX: number, cssY: number, height: number, m: Modifiers = {}) {
    this.action = actionForButton(button, m);
    this.prev = CameraInteractor.toDisplay(cssX, cssY, height);
  }

  end() { this.action = "none"; this.prev = null; }

  /** Mouse move while dragging. width/height are the view size in CSS pixels. */
  move(cssX: number, cssY: number, width: number, height: number) {
    if (this.action === "none" || !this.prev) return;
    const [x, y] = CameraInteractor.toDisplay(cssX, cssY, height);
    const dx = x - this.prev[0];
    const dy = y - this.prev[1];
    if (dx === 0 && dy === 0) return;

    switch (this.action) {
      case "rotate": this.rotate(dx, dy, width, height); break;
      case "translate": this.camera.panByDisplayDelta(dx, dy, width, height); break;
      case "scale": this.scale(dy, height); break;
      case "spin": this.spin(x, y, this.prev[0], this.prev[1], width, height); break;
    }
    this.prev = [x, y];
    this.onChange?.();
  }

  /** vtkMRMLCameraWidget::ProcessRotate */
  rotate(dx: number, dy: number, width: number, height: number) {
    const deltaAzimuth = -20.0 / width;
    const deltaElevation = -20.0 / height;
    const rxf = dx * deltaAzimuth * MOTION_FACTOR;
    const ryf = dy * deltaElevation * MOTION_FACTOR;
    this.camera.azimuth(rxf);
    const rotatedUp = this.camera.elevation(ryf);
    this.camera.orthogonalizeViewUp(rotatedUp);
  }

  /** vtkMRMLCameraWidget::ProcessScale — note the sign flip vs plain VTK. */
  scale(dy: number, height: number) {
    const centerY = height / 2;
    const dyf = MOTION_FACTOR * dy / centerY;
    this.camera.dolly(Math.pow(1.1, -dyf));
  }

  /** vtkMRMLCameraWidget::ProcessSpin — roll about the view plane normal. */
  spin(x: number, y: number, px: number, py: number, width: number, height: number) {
    const cx = width / 2, cy = height / 2;
    const newAngle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
    const oldAngle = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
    this.roll(newAngle - oldAngle);
  }

  /** vtkCamera::Roll — rotate viewUp about the direction of projection. */
  roll(deg: number) {
    const cam = this.camera;
    const axis = cam.directionOfProjection;      // view plane normal (toward focal point)
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const v = cam.viewUp;
    const k = axis;
    const kv: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    cam.viewUp = [
      v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
      v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
      v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
    ];
    cam.orthogonalizeViewUp();
    this.onChange?.();
  }

  /** Mouse wheel. `forward` = wheel away from the user = zoom in. */
  wheel(forward: boolean) {
    const e = 0.2 * MOTION_FACTOR * MOUSE_WHEEL_MOTION_FACTOR;
    this.camera.dolly(Math.pow(1.1, forward ? e : -e));
    this.onChange?.();
  }
}
