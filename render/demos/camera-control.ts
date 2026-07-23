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

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());  // right-drag = zoom
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = local(e);
    interactor.start(e.button as 0 | 1 | 2, x, y, canvas.clientHeight, {
      shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
    });
    canvas.setPointerCapture(e.pointerId);
    opts.onLog?.("cameraStart", { action: interactor.action, x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
  });
  canvas.addEventListener("pointerup", (e) => { interactor.end(); canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (interactor.action === "none") return;
    const { x, y } = local(e);
    interactor.move(x, y, canvas.clientWidth, canvas.clientHeight);
  });
  canvas.addEventListener("wheel", (e) => {
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
