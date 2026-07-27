// Shared shift-move pick + crosshair for ALL demos (DRY: written once, wired into each scenario).
// Mirrors Slicer's crosshair: SHIFT + mouse-move (hover, no button) sets a RAS crosshair and jumps
// the other views to it. On a slice the RAS is the in-plane point under the cursor; in the 3D view
// it's the SceneRenderer.pick() ray-cast to the >=50% accumulated-opacity sample — so segmentations,
// volumes, everything the renderer composites can be traced. The crosshair is drawn as a small 2D
// overlay in every view (its own projector per view). `visible` is a toggle hook for a future UI.
import type { SceneRenderer } from "../scene-renderer.ts";
import type { SliceRenderer, Orientation } from "../slice-renderer.ts";
import { lookAt, multiply, perspectiveZO, type Vec3 } from "../mat4.ts";

export interface CrosshairState {
  ras: Vec3 | null;
  visible: boolean;                 // default on; flip for a future "show crosshair" UI toggle
  set(ras: Vec3 | null): void;      // update + notify listeners
  toggle(on?: boolean): void;
  onChange(cb: () => void): () => void;   // subscribe; returns an unsubscribe
}

export function createCrosshair(visible = true): CrosshairState {
  const listeners = new Set<() => void>();
  const notify = () => { for (const cb of listeners) cb(); };
  const st: CrosshairState = {
    ras: null,
    visible,
    set(ras) { this.ras = ras; notify(); },
    toggle(on) { this.visible = on ?? !this.visible; notify(); },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
  return st;
}

/** Draw a small crosshair glyph at screen px (x,y) on a 2D overlay context (CSS-px space). */
export function drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, opts: { color?: string; size?: number; gap?: number } = {}) {
  const size = opts.size ?? 11, gap = opts.gap ?? 3;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = opts.color ?? "rgba(120,220,255,0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 2;
  ctx.beginPath();
  ctx.moveTo(x - size, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size); ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap); ctx.lineTo(x, y + size);
  ctx.stroke();
  ctx.restore();
}

/** Project a RAS point to 3D-view screen px via the SAME view·proj the SceneRenderer draws with
 *  (lookAt + perspectiveZO). Returns null if behind the camera. */
export function rasToScreen3D(cam: { position: Vec3; focalPoint: Vec3; viewUp: Vec3; viewAngle: number }, ras: Vec3, w: number, h: number): { x: number; y: number } | null {
  const vp = multiply(perspectiveZO((cam.viewAngle * Math.PI) / 180, w / h, 1, 100000), lookAt(cam.position, cam.focalPoint, cam.viewUp));
  const cw = vp[3] * ras[0] + vp[7] * ras[1] + vp[11] * ras[2] + vp[15];
  if (cw <= 0) return null;
  return {
    x: (vp[0] * ras[0] + vp[4] * ras[1] + vp[8] * ras[2] + vp[12]) / cw * 0.5 + 0.5,
    y: 1 - ((vp[1] * ras[0] + vp[5] * ras[1] + vp[9] * ras[2] + vp[13]) / cw * 0.5 + 0.5),
  } as { x: number; y: number };   // normalized [0,1]; caller scales to px
}

const uvOf = (canvas: HTMLElement, e: PointerEvent) => {
  const r = canvas.getBoundingClientRect();
  return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, aspect: r.width / r.height };
};
const isShiftHover = (e: PointerEvent) => e.shiftKey && e.buttons === 0;   // Slicer crosshair = shift + move

/** SHIFT+move on a 3D canvas → SceneRenderer.pick() → set crosshair + jump. GPU readback is async,
 *  so a single pick is kept in flight at a time (the latest cursor wins the next slot). */
export function attachScenePick(canvas: HTMLCanvasElement, scene: SceneRenderer, state: CrosshairState, onJump: (ras: Vec3) => void) {
  let inFlight = false, queued: { u: number; v: number } | null = null;
  const run = async (u: number, v: number) => {
    inFlight = true;
    const ras = await scene.pick(u, v);
    inFlight = false;
    if (ras) { state.set(ras); onJump(ras); }
    if (queued) { const q = queued; queued = null; run(q.u, q.v); }
  };
  canvas.addEventListener("pointermove", (e) => {
    if (!isShiftHover(e)) return;
    const { u, v } = uvOf(canvas, e);
    if (inFlight) queued = { u, v }; else run(u, v);
  });
}

/** SHIFT+move on a slice canvas → viewToRas (in-plane point under the cursor) → set crosshair + jump. */
export function attachSlicePick(
  canvas: HTMLCanvasElement,
  slice: SliceRenderer,
  cfg: { orient: Orientation; offset: () => number },
  state: CrosshairState,
  onJump: (ras: Vec3) => void,
) {
  canvas.addEventListener("pointermove", (e) => {
    if (!isShiftHover(e)) return;
    const { u, v, aspect } = uvOf(canvas, e);
    const ras = slice.viewToRas(cfg.orient, cfg.offset(), u, v, aspect);
    state.set(ras);
    onJump(ras);
  });
}
