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
  idleGapMs?: number;                   // settle this long after the last kick (default 90)
}): AccumLoop {
  const target = opts.target ?? 32;
  const idleGap = opts.idleGapMs ?? 90;
  let settleRaf = 0;
  let idleTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const stopSettle = () => { if (settleRaf) cancelAnimationFrame(settleRaf); settleRaf = 0; };
  const settleTick = () => {
    settleRaf = 0;
    if (opts.count() >= target) return;
    opts.renderSettled(false);
    settleRaf = requestAnimationFrame(settleTick);
  };
  const startSettle = () => {
    idleTimer = 0;
    opts.renderSettled(true);             // fresh native frame, then converge
    if (!settleRaf) settleRaf = requestAnimationFrame(settleTick);
  };
  return {
    kick() {
      stopSettle();
      if (idleTimer) clearTimeout(idleTimer);
      opts.renderMoving();                // immediate low-res frame — display-rate under load
      idleTimer = setTimeout(startSettle, idleGap);
    },
    stop() { stopSettle(); if (idleTimer) clearTimeout(idleTimer); idleTimer = 0; },
  };
}
