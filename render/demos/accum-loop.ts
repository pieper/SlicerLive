import type { SceneRenderer } from "../scene-renderer.ts";
import type { Gpu } from "../device.ts";
import { BudgetController } from "../budget-controller.ts";

// Shared idle-convergence driver for temporal AA (docs/UNIFIED-RENDERING-PLAN.md M2). While the
// view is still, keep re-rendering with sub-pixel camera jitter so SceneRenderer.renderAccum folds
// each frame into a running mean → a supersampled, time-averaged-AA image. Any interaction calls
// kick(), which resets the mean to the fresh frame and restarts the convergence loop. One rAF chain,
// self-cancelling at the target sample count; the human always sees frame 1 immediately (byte-
// identical to a plain render), then it sharpens over the next ~half-second while idle.
export interface AccumLoop {
  /** View changed (camera/scene/size): render a fresh frame now, then converge while idle. */
  kick(): void;
  /** Cancel any pending convergence frames (e.g. on teardown). */
  stop(): void;
}

export function mountAccumLoop(opts: {
  drawOnce: (reset: boolean) => void;   // setCamera + scene.renderAccum(view, w, h, reset)
  count: () => number;                  // scene.accumCount()
  target?: number;                      // samples to converge to (default 32)
}): AccumLoop {
  const target = opts.target ?? 32;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (opts.count() >= target) return;   // converged — stop until the next kick
    opts.drawOnce(false);                 // accumulate one more jittered sample
    raf = requestAnimationFrame(tick);
  };
  return {
    kick() {
      opts.drawOnce(true);                // reset: fresh frame (byte-identical, no jitter)
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

// ADAPTIVE driver (M2b): the full budget×AA loop. While interacting (kicks arriving), render fast
// budget-scaled MOVING frames (low-res trace + Catmull-Rom upsample). When kicks stop for idleGapMs,
// switch to SETTLED convergence (native + temporal accumulation). Any kick cancels the settle. This
// is the local half of the transport-driven adaptivity the remote path (M4) reuses with a different
// budget input. renderMoving owns the budget (measure ms → BudgetController.update); the driver just
// decides moving-vs-settled from interaction timing.
export function mountAdaptiveLoop(opts: {
  renderMoving: () => void;              // one budget-scaled frame; updates the budget from measured ms
  renderSettled: (reset: boolean) => void;  // one native accumulated frame
  count: () => number;                  // scene.accumCount()
  target?: number;                      // convergence target (default 32)
  idleGapMs?: number;                   // consider the view "settled" this long after the last kick (default 100)
}): AccumLoop {
  const target = opts.target ?? 32;
  const idleGap = opts.idleGapMs ?? 100;
  // rAF-COALESCED: a burst of kick()s (a pointermove storm can fire faster than the display) only
  // updates `lastKick`; the rAF tick renders AT MOST ONCE PER FRAME. This is the fix for "feels slow"
  // on a heavy scene — synchronous render-per-event saturated the main thread. While interacting we
  // render budget-scaled moving frames; once kicks stop for idleGap we render native and converge.
  let raf = 0;
  let lastKick = -1e12;
  let wasMoving = false;
  const tick = () => {
    if (performance.now() - lastKick < idleGap) {
      opts.renderMoving();                // coalesced: latest state, once per frame
      wasMoving = true;
      raf = requestAnimationFrame(tick);
    } else if (wasMoving) {
      wasMoving = false;
      opts.renderSettled(true);           // just settled: fresh native frame, then converge
      raf = requestAnimationFrame(tick);
    } else if (opts.count() < target) {
      opts.renderSettled(false);          // keep converging
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;                            // converged: idle until the next kick
    }
  };
  return {
    kick() { lastKick = performance.now(); if (!raf) raf = requestAnimationFrame(tick); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

// One-call adaptive 3D driver: wires a BudgetController + the moving/settled render pair + the
// coalesced loop for a demo's 3D view, so every demo gets budget-scaled interaction + temporal AA
// from a single call (DRY). Getters (scene/view/size) keep it valid across a scene rebuild. Returns
// `draw()` (call on any interaction/redraw) plus the pieces for optional debug hooks.
export interface Adaptive3d {
  draw(): void;                                  // kick the loop (interaction or redraw)
  budget: BudgetController;
  renderSettled(reset: boolean): void;           // native accumulate (for debug converge)
  renderMoving(): void;                           // one budget-scaled frame (for debug)
  loop: AccumLoop;
}
export function mountAdaptive3d(opts: {
  scene: () => SceneRenderer | null;             // getter (survives scene rebuilds)
  view: () => GPUTextureView;                     // swap-chain view to present into
  size: () => { w: number; h: number };          // 3D canvas drawing-buffer size
  setCamera: (sc: SceneRenderer, w: number, h: number) => void;
  gpu: Gpu;
  target?: number;                                // AA convergence target (default 24)
  targetMs?: number;                              // budget frame-time target (default 16)
  onFrame?: () => void;                           // after each 3D frame (e.g. redraw a crosshair overlay)
}): Adaptive3d {
  const budget = new BudgetController({ targetMs: opts.targetMs ?? 16 });
  const renderMoving = () => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    const s = budget.scale(vw, vh), t0 = performance.now();
    if (s > 0.98) { opts.setCamera(sc, vw, vh); sc.renderToView(opts.view(), vw, vh); }
    else { const rw = Math.max(16, Math.round(vw * s)), rh = Math.max(16, Math.round(vh * s)); opts.setCamera(sc, rw, rh); sc.renderUpscaled(opts.view(), rw, rh, vw, vh); }
    opts.gpu.device.queue.onSubmittedWorkDone().then(() => budget.update(performance.now() - t0));
    opts.onFrame?.();
  };
  const renderSettled = (reset: boolean) => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    opts.setCamera(sc, vw, vh); sc.renderAccum(opts.view(), vw, vh, reset);
    opts.onFrame?.();
  };
  const loop = mountAdaptiveLoop({ renderMoving, renderSettled, count: () => opts.scene()?.accumCount() ?? 1e9, target: opts.target ?? 24 });
  return { draw: () => loop.kick(), budget, renderSettled, renderMoving, loop };
}
