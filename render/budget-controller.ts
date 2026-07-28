// Closed-loop render budget (docs/UNIFIED-RENDERING-PLAN.md §8). A direct TS port of the Python
// modal_spike `tune_budget`/`motion_scale`: steer a pixel budget so the MEASURED frame time tracks a
// target, then derive a resolution scale from it. The constraint is pluggable — locally the measured
// ms is GPU frame time (queue.onSubmittedWorkDone), remotely it will be render+encode+transport time —
// so the same controller governs "how many pixels to trace per frame" against GPU headroom OR
// bandwidth+latency. Only used WHILE INTERACTING; a settled view always renders native (scale 1) and
// converges via temporal accumulation.

export interface BudgetOpts {
  targetMs?: number;   // frame-time target the loop steers toward (default 16 ≈ one display refresh)
  minPx?: number;      // budget floor (default 0.15 MP)
  maxPx?: number;      // budget ceiling (default 8 MP)
  startPx?: number;    // initial budget (default 1.2 MP)
}

export class BudgetController {
  budgetPx: number;
  readonly targetMs: number;
  private minPx: number;
  private maxPx: number;

  constructor(opts: BudgetOpts = {}) {
    this.targetMs = opts.targetMs ?? 16;
    this.minPx = opts.minPx ?? 0.15e6;
    this.maxPx = opts.maxPx ?? 8e6;
    this.budgetPx = opts.startPx ?? 1.2e6;
  }

  /** Nudge the budget toward hitting targetMs. Multiplicative, clamped per step (0.8–1.25×) so the
   *  loop is stable, and bounded to [minPx, maxPx]. Faster-than-target grows it; slower shrinks it. */
  update(measuredMs: number): void {
    if (!(measuredMs > 0) || !Number.isFinite(measuredMs)) return;
    // Asymmetric: shrink faster than we grow, so a heavy scene drops to an interactive resolution
    // within a few frames (engagement latency), then eases back up gently when there's headroom.
    const adj = Math.max(0.6, Math.min(1.2, this.targetMs / measuredMs));
    this.budgetPx = Math.max(this.minPx, Math.min(this.maxPx, this.budgetPx * adj));
  }

  /** Resolution scale for a `w×h` view: sqrt(budget / area), clamped to [0.25, 1]. 1 when the view
   *  already fits the budget (small window); a fraction for a big/retina window under load. */
  scale(w: number, h: number): number {
    const area = Math.max(1, w * h);
    return Math.max(0.25, Math.min(1, Math.sqrt(this.budgetPx / area)));
  }
}
