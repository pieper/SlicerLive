// Shared 3D-view camera interaction for ALL demos, so event handling is identical
// everywhere (no per-demo ad-hoc orbit math). Wires a canvas to a VtkCamera through the
// faithful vtkMRMLCameraWidget bindings (CameraInteractor): left=rotate, shift/middle=pan,
// right / left+shift+ctrl=zoom, left+ctrl=spin, wheel=dolly. Returns the interactor so a
// caller can inspect the current action.
import { VtkCamera } from "../vtk-camera.ts";
import { CameraInteractor } from "../vtk-interactor.ts";

export interface CameraControlOpts {
  onChange?: () => void;          // called after every camera change (redraw)
  onLog?: (kind: string, detail: Record<string, unknown>) => void; // optional event log hook
  /** Gate the whole interactor. Return false to hand the canvas to another controller — e.g.
   *  the endovascular flight, which owns left-drag as first-person LOOK. Suppressing only
   *  `onChange` is not enough: these handlers mutate the camera directly, so both controllers
   *  would move it and the trackball would win. */
  enabled?: () => boolean;
}

export function attachCameraControls(
  canvas: HTMLCanvasElement,
  camera: VtkCamera,
  opts: CameraControlOpts = {},
): CameraInteractor {
  const interactor = new CameraInteractor(camera, opts.onChange);
  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Touch: own all gestures on the canvas so a swipe orbits/zooms instead of the browser navigating
  // back/forward or pull-to-refreshing. touch-action:none stops the built-in pan/zoom; overscroll-
  // behavior:none stops pull-to-refresh; a non-passive touchmove preventDefault is the belt-and-braces
  // (pointer events still fire, so drag/pinch keep working).
  canvas.style.touchAction = "none";
  const docEl = (canvas.ownerDocument ?? document).documentElement;
  if (docEl) docEl.style.overscrollBehavior = "none";
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  // Multi-touch: 1 finger = orbit (via the interactor); 2 fingers = pinch-zoom + two-finger pan.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; mx: number; my: number } | null = null;
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const on = () => opts.enabled?.() ?? true;

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());  // right-drag = zoom
  canvas.addEventListener("pointerdown", (e) => {
    if (!on()) return;
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      interactor.start(e.button as 0 | 1 | 2, x, y, canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
      opts.onLog?.("cameraStart", { action: interactor.action, x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
    } else if (pointers.size === 2) {
      interactor.end();          // stop the 1-finger orbit; enter pinch
      pinch = pinchState();
    }
  });
  const endPointer = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (!on()) { interactor.end(); pinch = null; return; }
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {   // dropped from pinch back to one finger → resume orbit
      const p = [...pointers.values()][0];
      interactor.start(0, p.x, p.y, canvas.clientHeight, { shift: false, ctrl: false, alt: false });
    } else if (pointers.size === 0) {
      interactor.end();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointermove", (e) => {
    if (!on()) return;
    if (!pointers.has(e.pointerId)) return;
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    if (pointers.size >= 2) {
      const p = pinchState();
      if (pinch) {
        if (p.dist > 0 && pinch.dist > 0) camera.dolly(p.dist / pinch.dist);         // spread = zoom in
        // panByDisplayDelta wants a DISPLAY-space delta (y up), like the interactor's toDisplay path;
        // the midpoints are in CSS coords (y down), so negate dy — otherwise two-finger pan is flipped.
        camera.panByDisplayDelta(p.mx - pinch.mx, pinch.my - p.my, canvas.clientWidth, canvas.clientHeight);
        opts.onChange?.();
      }
      pinch = p;
    } else if (interactor.action !== "none") {
      interactor.move(x, y, canvas.clientWidth, canvas.clientHeight);
    }
  });
  canvas.addEventListener("wheel", (e) => {
    if (!on()) return;
    e.preventDefault();
    interactor.wheel(e.deltaY < 0);   // deltaY<0 = scroll away = VTK MouseWheelForward = zoom in
    opts.onLog?.("cameraWheel", { deltaY: e.deltaY, distance: camera.distance });
  }, { passive: false });

  return interactor;
}

/** Slicer's default 3D camera, framed on a scene's bounding sphere: focal point at the
 *  volume centre, positioned along +A (anterior toward viewer), viewUp +S, fovy 30. */
export function framedCamera(center: [number, number, number], radius: number, distMul = 2.6): VtkCamera {
  return new VtkCamera(
    [center[0], center[1] + radius * distMul, center[2]],
    [...center] as [number, number, number],
    [0, 0, 1],
    30,
  );
}
