// Shared 4-up view-grid behaviour for ALL MPR demos (DRY): double-click a cell to MAXIMIZE it
// (fill the grid), double-click again to restore. The layout is a CSS grid of separate cells; a
// maximized cell gets `.max` and the grid gets `.has-max` (the demo's stylesheet does the rest),
// then a resize re-sizes the drawing buffers. Slice cells detect the double-click via
// attachSliceControls' onDoubleClick hook (drags preventDefault, killing native dblclick); the 3D
// cell uses attachDoubleClick below (same manual detection). This replaces the maximize logic that
// was hand-rolled inline in real-browser.

export interface ViewGrid {
  toggleMax(cell: string): void;
  isMax(cell: string): boolean;
  maxCell(): string | null;
}

export function attachViewGrid(grid: HTMLElement, cells: readonly string[], onResize: () => void): ViewGrid {
  let maxed: string | null = null;
  const cellDiv = (cell: string) => grid.querySelector<HTMLElement>(`.cell[data-cell="${cell}"]`)!;
  return {
    toggleMax(cell) {
      maxed = maxed === cell ? null : cell;
      for (const n of cells) cellDiv(n).classList.toggle("max", n === maxed);
      grid.classList.toggle("has-max", maxed !== null);
      requestAnimationFrame(onResize);   // let the grid re-layout, then re-size the buffers
    },
    isMax(cell) { return maxed === cell; },
    maxCell: () => maxed,
  };
}

/** Manual double-click detection (native dblclick is suppressed by drag preventDefault). Calls
 *  `onDbl` on a quick same-spot second press. Used for the 3D cell (slice cells go through
 *  attachSliceControls' onDoubleClick hook instead). */
export function attachDoubleClick(canvas: HTMLElement, onDbl: () => void): void {
  let last = 0, lx = 0, ly = 0;
  canvas.addEventListener("pointerdown", (e) => {
    const dbl = e.timeStamp - last < 350 && Math.hypot(e.clientX - lx, e.clientY - ly) < 6;
    last = dbl ? 0 : e.timeStamp; lx = e.clientX; ly = e.clientY;
    if (dbl) { e.preventDefault(); onDbl(); }
  });
}
