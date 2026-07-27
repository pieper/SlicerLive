// Shared slice-view interaction for ALL MPR demos (DRY: the generic slice gestures live here, not
// hand-rolled per demo). Mirrors the real 4-up: wheel = slice scroll, ctrl/⌘+wheel = zoom about the
// cursor, left-drag = scroll, middle-drag or shift+left-drag = pan, right-drag = zoom (drag DOWN =
// in, matching the 3D view), and — crucially — `contextmenu` is suppressed so the right-drag zoom
// isn't hijacked by the browser menu (the exact page-config that was missing from SEGRoulette).
//
// Demo-specific behaviours (markup grab/drag/hover, double-click-to-maximize) are layered via hooks
// so the richer demos compose them on top instead of re-implementing the whole event block.
import type { SliceRenderer, Orientation } from "../slice-renderer.ts";

export interface SliceControlHooks {
  /** Double-click (left) — e.g. maximize/restore. Return true to consume (no drag starts). */
  onDoubleClick?: () => boolean;
  /** Left press: try to grab something (e.g. a markup). Return true → the demo owns the drag
   *  (onLeftDrag/onLeftDrop fire); false → the press falls through to slice scroll. */
  onLeftGrab?: (u: number, v: number, w: number, h: number) => boolean;
  onLeftDrag?: (u: number, v: number, w: number, h: number) => void;
  onLeftDrop?: (movedPx: number) => void;
  /** Idle hover (no button) — e.g. highlight the nearest markup + set the cursor. */
  onHover?: (u: number, v: number, w: number, h: number) => void;
  /** Optional telemetry. */
  onScroll?: (forward: boolean) => void;
  onZoom?: () => void;
}

export interface SliceControlCfg {
  orient: Orientation;
  getSlice: () => SliceRenderer;         // getter so it survives a demo rebuilding its renderer (SEGRoulette spin)
  step: (forward: boolean) => void;     // advance the slice one step (demo owns its offset model)
  redraw: () => void;                   // redraw this cell after scroll/pan/zoom
  scrollPx?: number;                    // px per slice step for left-drag scroll (default 7)
  hooks?: SliceControlHooks;
}

export interface SliceControls { resetView(): void; detach(): void }

export function attachSliceControls(canvas: HTMLCanvasElement, cfg: SliceControlCfg): SliceControls {
  const SCROLL_PX = cfg.scrollPx ?? 7;
  const h = cfg.hooks ?? {};
  const uv = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  };
  // double-click detection (left button), so a demo can maximize without its own timer
  let lastDown = 0, lastX = 0, lastY = 0;
  let view: { mode: "pan" | "zoom"; x: number; y: number; pu: number; pv: number } | null = null;
  let scroll: { x: number; y: number; acc: number } | null = null;
  let grabbed: { moved: number } | null = null;

  const onContext = (e: Event) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {                                  // pinch / ctrl-wheel = zoom about cursor
      const { u, v, w, h: hh } = uv(e);
      cfg.getSlice().zoomAbout(cfg.orient, Math.exp(-e.deltaY * 0.0015), u, v, w, hh);
      cfg.redraw(); h.onZoom?.();
      return;
    }
    cfg.step(e.deltaY < 0); cfg.redraw(); h.onScroll?.(e.deltaY < 0);   // deltaY<0 = MouseWheelForward
  };
  const onDown = (e: PointerEvent) => {
    if (e.button === 0) {                                          // double-click detection
      const now = e.timeStamp, dbl = now - lastDown < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 6;
      lastDown = dbl ? 0 : now; lastX = e.clientX; lastY = e.clientY;
      if (dbl && h.onDoubleClick?.()) { e.preventDefault(); return; }
    }
    const wantPan = e.button === 1 || (e.button === 0 && e.shiftKey);
    const wantZoom = e.button === 2;
    if (wantPan || wantZoom) {
      e.preventDefault();
      const { u, v } = uv(e);
      view = { mode: wantZoom ? "zoom" : "pan", x: e.clientX, y: e.clientY, pu: u, pv: v };
      canvas.style.cursor = wantZoom ? "ns-resize" : "grabbing";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const { u, v, w, h: hh } = uv(e);
    if (h.onLeftGrab?.(u, v, w, hh)) { grabbed = { moved: 0 }; }    // demo consumed it (e.g. markup)
    else scroll = { x: e.clientX, y: e.clientY, acc: 0 };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (view) {
      const dx = e.clientX - view.x, dy = e.clientY - view.y;
      const r = canvas.getBoundingClientRect();
      if (view.mode === "pan") cfg.getSlice().panByPixels(cfg.orient, dx, dy, r.width, r.height);
      else cfg.getSlice().zoomAbout(cfg.orient, Math.exp(dy * 0.006), view.pu, view.pv, r.width, r.height);  // drag DOWN = zoom in
      view.x = e.clientX; view.y = e.clientY; cfg.redraw();
      return;
    }
    if (grabbed) {
      grabbed.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      const { u, v, w, h: hh } = uv(e);
      h.onLeftDrag?.(u, v, w, hh);
      return;
    }
    if (scroll) {
      scroll.acc += (e.clientX - scroll.x) - (e.clientY - scroll.y);   // right/up = forward
      scroll.x = e.clientX; scroll.y = e.clientY;
      while (Math.abs(scroll.acc) >= SCROLL_PX) { const f = scroll.acc > 0; cfg.step(f); scroll.acc -= f ? SCROLL_PX : -SCROLL_PX; }
      cfg.redraw();
      return;
    }
    if (e.buttons === 0 && h.onHover) { const { u, v, w, h: hh } = uv(e); h.onHover(u, v, w, hh); }
  };
  const onUp = (e: PointerEvent) => {
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (view) { view = null; canvas.style.cursor = "default"; return; }
    if (grabbed) { const m = grabbed.moved; grabbed = null; h.onLeftDrop?.(m); return; }
    scroll = null;
  };

  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  return {
    resetView() { cfg.getSlice().resetView(cfg.orient); cfg.redraw(); },
    detach() {
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    },
  };
}
