// Coalesced adaptive scheduler for the 2D slice cells — the slice-view analogue of mountAdaptive3d
// (render/demos/accum-loop.ts). Instead of ~20 scattered synchronous renderSlice() calls, the
// DisplayableManagers / interaction handlers MARK a cell dirty; one requestAnimationFrame loop then
// renders every dirty cell at most once per frame (coalescing), aiming for the display rate while
// changes keep arriving and going DORMANT (no rAF scheduled) the instant nothing is dirty.
//
// Graceful degradation, like the 3D view: while interaction is in flight (marks arriving within
// idleGapMs) each dirty cell renders in MOVING mode — the caller downsamples the reslice and blits it
// up (SliceRenderer.renderUpscaled) to hold latency low. When the marks stop, every cell that was
// moved gets ONE native SETTLED pass so the final image is crisp. A pure state machine (injectable
// clock + scheduler) drives it, so the moving/settled/coalesce logic is unit-testable without a GPU.

export interface SliceScheduler {
  /** The cell's reslice content changed (W/L, plane, layers, overlay): full re-render + overlay. */
  markSlice(cell: string): void;
  /** Only the 2D overlay changed (markups, crosshair, intersections): redraw the canvas overlay. */
  markOverlay(cell: string): void;
  /** Re-render every known cell (layout/volume/scene change). */
  markAll(): void;
  /** Nudge: render every cell NATIVE now (bypassing moving) so the settle point / idle() sees the
   *  crisp final image. Used by the introspection render() hook the tests wait on. */
  render(): void;
  /** True while in MOVING mode (marks arriving) — the caller downsamples the reslice this tick. */
  moving(): boolean;
  /** Pending work? (dirty or a settle owed) — for tests/introspection. */
  busy(): boolean;
  stop(): void;
}

export function mountSliceScheduler(opts: {
  listCells: () => string[];
  /** Render one cell's reslice. `moving` → caller downsamples + blits (renderUpscaled); else native. */
  drawSlice: (cell: string, moving: boolean) => void;
  /** Redraw one cell's 2D canvas overlay (cheap, CPU). */
  drawOverlay: (cell: string) => void;
  idleGapMs?: number;                        // stay in MOVING this long after the last mark (default 120)
  now?: () => number;                        // injectable clock (default performance.now)
  schedule?: (fn: () => void) => void;       // injectable frame scheduler (default requestAnimationFrame)
}): SliceScheduler {
  const idleGap = opts.idleGapMs ?? 120;
  const now = opts.now ?? (() => performance.now());
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  const schedule = opts.schedule ?? ((fn) => { if (raf) raf(() => fn()); else setTimeout(fn, 16); });

  const dirtySlices = new Set<string>();     // need a full reslice + overlay
  const dirtyOverlays = new Set<string>();   // need only an overlay redraw
  const moved = new Set<string>();           // rendered in MOVING mode → owe a native settle pass
  let lastMark = -1e12;
  let scheduled = false;
  let stopped = false;
  let forceNative = false;                    // the render() nudge: this cycle renders native, not moving

  const wake = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    schedule(tick);
  };
  const interacting = () => now() - lastMark < idleGap;
  const busy = () => dirtySlices.size > 0 || dirtyOverlays.size > 0 || moved.size > 0;

  const tick = () => {
    scheduled = false;
    if (stopped) return;
    const moving = !forceNative && interacting();

    if (dirtySlices.size) {
      // Coalesce: snapshot + clear so marks arriving DURING this frame schedule the next one rather
      // than being lost or double-rendered. A slice render also repaints that cell's overlay.
      const cells = [...dirtySlices];
      dirtySlices.clear();
      for (const c of cells) {
        dirtyOverlays.delete(c);
        opts.drawSlice(c, moving);
        if (moving) moved.add(c); else moved.delete(c);
      }
    } else if (!moving && moved.size) {
      // Interaction stopped (or forced native): repaint every moved cell once at native resolution
      // — the crisp settle that ends the burst.
      const cells = [...moved];
      moved.clear();
      for (const c of cells) opts.drawSlice(c, false);
    }

    if (dirtyOverlays.size) {
      const cells = [...dirtyOverlays];
      dirtyOverlays.clear();
      for (const c of cells) opts.drawOverlay(c);
    }

    forceNative = false;
    // Stay awake while there is dirty work OR a native settle is still owed (moved cells, which we
    // repaint once interaction quiesces). Otherwise go dormant — the next mark re-arms the loop. The
    // only idle cost is up to ~idleGap of near-empty ticks after a drag ends, before the settle fires.
    if (busy() || interacting()) wake();
  };

  return {
    markSlice(cell) { lastMark = now(); dirtySlices.add(cell); wake(); },
    markOverlay(cell) { dirtyOverlays.add(cell); wake(); },
    markAll() { lastMark = now(); for (const c of opts.listCells()) dirtySlices.add(c); wake(); },
    render() { forceNative = true; for (const c of opts.listCells()) dirtySlices.add(c); moved.clear(); wake(); },
    moving: interacting,
    busy,
    stop() { stopped = true; },
  };
}
