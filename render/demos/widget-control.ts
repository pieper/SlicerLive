// Shared handle-drag interaction for 3D-view widgets — the render-local (Tier-A) half of
// the interaction architecture (ARCHITECTURE-2026-07-24 §3). Screen-space picking + a
// camera-plane drag, wired so widgets and the camera obey the WEB-BROWSER GRAB-OR-BUBBLE
// model: a pointerdown is offered to the handles FIRST (capture phase); if one is grabbed
// we stopPropagation so the bubble-phase camera controls never see it (the widget "captures
// the pointer" until pointer-up), and if nothing is grabbed the event bubbles to the camera
// as the root interactor. This is the same trick the vtk.js viewer used
// (viewer/slicerlive.js:1586), generalized and reusable.
//
// Everything here is Tier-A: hover highlight and drag are local, per-frame, no transport.
// Snap-suggestion providers (wishlist) would hook onDrag to offer candidate targets.
import type { VtkCamera } from "../vtk-camera.ts";
import { applyMat4, invert, lookAt, type Mat4, multiply, perspectiveZO, type Vec3 } from "../mat4.ts";

export interface Handle {
  id: number;            // caller's index; passed back to onDrag/onHover
  world: Vec3;           // current world (RAS) position
  pickPx?: number;       // pick radius in CSS px (default 16)
  cursor?: string;       // CSS cursor while hovered/grabbed (default "grab"/"grabbing")
}

export interface WidgetControlOpts {
  /** Fresh handle list each query (handles move as the scene rebuilds). */
  getHandles: () => Handle[];
  /** Canvas DRAWING-BUFFER size (canvas.width/height), used for the projection aspect. */
  getSize: () => { w: number; h: number };
  onDragStart?: (h: Handle) => void;
  onDrag: (h: Handle, world: Vec3) => void;   // new world pos, constrained to the camera plane
  onDragEnd?: (h: Handle) => void;
  onHover?: (h: Handle | null) => void;       // hovered handle changed (for highlight)
  onChange?: () => void;                        // request a redraw after a drag step
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Same view·proj the SceneRenderer builds (lookAt + perspectiveZO, near 1 / far 100000),
 *  so picking projects to exactly the pixels the ray-march drew. */
function camMatrices(cam: VtkCamera, w: number, h: number): { vp: Mat4; invVp: Mat4 } {
  const view = lookAt(cam.position, cam.focalPoint, cam.viewUp);
  const proj = perspectiveZO((cam.viewAngle * Math.PI) / 180, w / h, 1, 100000);
  const vp = multiply(proj, view);
  return { vp, invVp: invert(vp) };
}

/** World → homogeneous clip (column-major mat·vec4), keeping w for the perspective divide. */
function worldToClip(vp: Mat4, p: Vec3): [number, number, number, number] {
  return [
    vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12],
    vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13],
    vp[2] * p[0] + vp[6] * p[1] + vp[10] * p[2] + vp[14],
    vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15],
  ];
}

export interface WidgetControls { detach(): void }

export function attachWidgetControls(
  canvas: HTMLCanvasElement,
  camera: VtkCamera,
  opts: WidgetControlOpts,
): WidgetControls {
  // CSS-pixel cursor position relative to the canvas.
  const cursorCss = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, rw: r.width, rh: r.height };
  };
  // World point → CSS px (top-left origin). Returns null if behind the camera.
  const project = (vp: Mat4, world: Vec3, rw: number, rh: number) => {
    const c = worldToClip(vp, world);
    if (c[3] <= 0) return null;
    const ndcx = c[0] / c[3], ndcy = c[1] / c[3];
    return { x: (ndcx * 0.5 + 0.5) * rw, y: (1 - (ndcy * 0.5 + 0.5)) * rh };
  };
  // CSS px → world point on the camera-facing plane through `planePt`.
  const unprojectToPlane = (invVp: Mat4, px: number, py: number, rw: number, rh: number, planePt: Vec3): Vec3 => {
    const ndcx = (px / rw) * 2 - 1, ndcy = 1 - (py / rh) * 2;
    const near = applyMat4(invVp, [ndcx, ndcy, 0]);   // applyMat4 does the perspective divide
    const far = applyMat4(invVp, [ndcx, ndcy, 1]);
    const ro = near, rd = sub(far, near);
    const n = sub(camera.position, camera.focalPoint);   // camera-facing plane normal (unnormalized ok)
    const denom = dot(rd, n);
    if (Math.abs(denom) < 1e-9) return [...planePt] as Vec3;
    const t = dot(sub(planePt, ro), n) / denom;
    return [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
  };

  const pick = (e: PointerEvent): Handle | null => {
    const { x, y, rw, rh } = cursorCss(e);
    const { w, h } = opts.getSize();
    const { vp } = camMatrices(camera, w, h);
    let best: Handle | null = null, bestD = Infinity;
    for (const hnd of opts.getHandles()) {
      const s = project(vp, hnd.world, rw, rh);
      if (!s) continue;
      const d = Math.hypot(s.x - x, s.y - y), r = hnd.pickPx ?? 16;
      if (d < r && d < bestD) { bestD = d; best = hnd; }
    }
    return best;
  };

  let grabbed: Handle | null = null, hovered: Handle | null = null;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;                 // left button only; others bubble to camera
    const h = pick(e);
    if (!h) return;                             // BUBBLE: camera (root interactor) handles it
    e.stopPropagation(); e.preventDefault();    // GRAB: camera never sees this gesture
    grabbed = h;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = h.cursor ? h.cursor : "grabbing";
    opts.onDragStart?.(h);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  };

  const onMove = (e: PointerEvent) => {
    if (!grabbed) return;
    e.stopPropagation();
    const { x, y, rw, rh } = cursorCss(e);
    const { w, h } = opts.getSize();
    const { invVp } = camMatrices(camera, w, h);
    const world = unprojectToPlane(invVp, x, y, rw, rh, grabbed.world);
    opts.onDrag(grabbed, world);
    opts.onChange?.();
  };

  const onUp = (e: PointerEvent) => {
    if (!grabbed) return;
    e.stopPropagation();
    const g = grabbed; grabbed = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    opts.onDragEnd?.(g);
  };

  // Hover: cheap, non-authoritative — highlight the grabbable handle + set the cursor.
  const onHoverMove = (e: PointerEvent) => {
    if (grabbed) return;
    const h = pick(e);
    if (h !== hovered) {
      hovered = h;
      canvas.style.cursor = h ? (h.cursor ?? "grab") : "";
      opts.onHover?.(h);
      opts.onChange?.();
    }
  };

  canvas.addEventListener("pointerdown", onDown, true);   // CAPTURE phase: before camera
  canvas.addEventListener("pointermove", onHoverMove);    // bubble phase: hover only
  return {
    detach() {
      canvas.removeEventListener("pointerdown", onDown, true);
      canvas.removeEventListener("pointermove", onHoverMove);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
    },
  };
}
