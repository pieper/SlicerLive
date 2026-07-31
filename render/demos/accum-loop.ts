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
  idleGapMs?: number;                   // consider the view "settled" this long after the last kick (default 120)
  sync?: () => Promise<unknown>;        // await after each frame — pass queue.onSubmittedWorkDone for GPU pacing
}): AccumLoop {
  const target = opts.target ?? 32;
  const idleGap = opts.idleGapMs ?? 120;
  // GPU-PACED async loop (ported from the Python spike's producer). The first frame after a kick
  // renders SYNCHRONOUSLY (immediate response — no rAF wait), then each subsequent frame awaits the
  // GPU (opts.sync = onSubmittedWorkDone) so we NEVER submit faster than the GPU drains. That kills
  // the backlog that made the first drag frame appear a second late (moving frames were queued behind
  // a pile of full-res settle frames). Awaiting also yields to input, so a new kick preempts within
  // one GPU frame. A rAF is awaited too, capping cadence at display rate for light scenes.
  // Frame pacing: requestAnimationFrame caps at the display rate WHEN VISIBLE, but the browser
  // throttles rAF to ~0-1Hz when the window is backgrounded/occluded (even with
  // --disable-renderer-backgrounding on macOS) — which would FREEZE a mirror the moment you focus
  // the other app. So race rAF against a 30Hz timer fallback: rAF wins when foreground; the timer
  // keeps the loop alive (~30fps) when rAF is throttled (setTimeout is exempt under
  // --disable-background-timer-throttling). GPU `sync` still paces us to actual GPU completion.
  const paced = () => Promise.race([
    new Promise<void>((r) => requestAnimationFrame(() => r())),
    new Promise<void>((r) => setTimeout(r, 33)),
  ]);
  const sync = opts.sync ?? (() => Promise.resolve());
  let running = false, stopped = false, lastKick = -1e12, wasMoving = false;
  const step = () => {
    if (performance.now() - lastKick < idleGap) { opts.renderMoving(); wasMoving = true; return true; }
    if (wasMoving) { wasMoving = false; opts.renderSettled(true); return true; }
    if (opts.count() < target) { opts.renderSettled(false); return true; }
    return false;                          // converged + idle
  };
  const run = async () => {
    running = true; stopped = false;
    while (!stopped && step()) await Promise.all([sync(), paced()]);
    running = false;
  };
  return {
    kick() { lastKick = performance.now(); if (!running) run(); },   // run() renders the 1st frame synchronously
    stop() { stopped = true; },
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
  movingScaleCap?: number;                        // max resolution scale WHILE MOVING (default 1; <1 for heavy scenes)
  idleGapMs?: number;                             // stay in cheap MOVING mode this long after the last kick (default 120)
  onFrame?: () => void;                           // after each 3D frame (e.g. redraw a crosshair overlay)
}): Adaptive3d {
  const budget = new BudgetController({ targetMs: opts.targetMs ?? 16 });
  const DBG = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
  let dbgN = 0, dbgMoving = 0, dbgSettled = 0, dbgLast = 0;
  const dbgTick = (kind: "mov" | "set", ms: number, s: number) => {
    if (!DBG) return;
    dbgN++; if (kind === "mov") dbgMoving += ms; else dbgSettled += ms;
    const now = performance.now();
    if (now - dbgLast > 500) { console.log(`[perf] mov=${dbgMoving.toFixed(0)}ms/${dbgN}f settled=${dbgSettled.toFixed(0)}ms lastScale=${s.toFixed(2)} last=${ms.toFixed(1)}ms`); dbgLast = now; dbgMoving = dbgSettled = dbgN = 0; }
  };
  const movingCap = opts.movingScaleCap ?? 1;
  const renderMoving = () => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    // Cap moving resolution so a heavy DVR is interactive FROM FRAME ONE (no waiting for the budget
    // to adapt down over several frames). Moving frames are transient — the settle snaps to native.
    const s = Math.min(movingCap, budget.scale(vw, vh)), t0 = performance.now();
    if (s > 0.98) { opts.setCamera(sc, vw, vh); sc.renderToView(opts.view(), vw, vh); }
    else { const rw = Math.max(16, Math.round(vw * s)), rh = Math.max(16, Math.round(vh * s)); opts.setCamera(sc, rw, rh); sc.renderUpscaled(opts.view(), rw, rh, vw, vh); }
    opts.gpu.device.queue.onSubmittedWorkDone().then(() => { const ms = performance.now() - t0; budget.update(ms); dbgTick("mov", ms, s); });
    opts.onFrame?.();
  };
  const renderSettled = (reset: boolean) => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    const t0 = performance.now();
    opts.setCamera(sc, vw, vh); sc.renderAccum(opts.view(), vw, vh, reset);
    if (DBG) opts.gpu.device.queue.onSubmittedWorkDone().then(() => dbgTick("set", performance.now() - t0, 1));
    opts.onFrame?.();
  };
  const loop = mountAdaptiveLoop({
    renderMoving, renderSettled,
    count: () => opts.scene()?.accumCount() ?? 1e9,
    target: opts.target ?? 24,
    idleGapMs: opts.idleGapMs,
    sync: () => opts.gpu.device.queue.onSubmittedWorkDone(),   // GPU-paced: no backlog, input preempts
  });
  let kickN = 0, kickLast = 0;
  const draw = () => {
    if (DBG) { kickN++; const now = performance.now(); if (now - kickLast > 500) { console.log(`[perf] kicks=${kickN} in 500ms`); kickN = 0; kickLast = now; } }
    loop.kick();
  };
  return { draw, budget, renderSettled, renderMoving, loop };
}
