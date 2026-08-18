/** The byte-matched snapshot viewer.
 *
 *  Split out from the race page because it is pure DOM and canvas 2D — no
 *  WebGPU — so unlike the race itself it can be rendered head-less and checked.
 *  Its two failure modes (panes drawn at voxel pitch instead of physical size,
 *  and a transform that does not stay centred under scale) are invisible in
 *  code review and obvious in a screenshot.
 */
export type SnapKey = "neural" | "htj2k";

export interface SnapPlanes {
  budget: number;
  bytes: number;
  ms: number;
  ax: Int16Array;  // (Y, X)
  co: Int16Array;  // (Z, X)
  sa: Int16Array;  // (Z, Y)
}

export interface ViewerConfig {
  shape: [number, number, number];      // Z, Y, X
  spacing: [number, number, number];    // mm per voxel, same order
  win: number;
  lev: number;
  budgets: number[];
  snaps: Record<SnapKey, SnapPlanes[]>;
  keys: readonly SnapKey[];
  el: (id: string) => HTMLElement;
}

export function makeSnapshotViewer(cfg: ViewerConfig): void {
  const { shape: sc_shape, spacing, win, lev, budgets, snaps, keys } = cfg;
  const grids: Record<RowKey, HTMLElement> = {
    neural: cfg.el("cmp-neural"), htj2k: cfg.el("cmp-htj2k"),
  };
  const [Z, Y, X] = sc_shape;
  const [sz, sy, sx] = spacing;
  // Physical extent, not voxel counts: the slice axis is several times coarser
  // than the in-plane one, so drawing a coronal at its native pixel pitch
  // squashes the patient. CSS sizing in millimetres makes every pane
  // anatomically proportioned and lets zoom stay a single uniform factor.
  const planes: { name: string; w: number; h: number; mmW: number; mmH: number }[] = [
    { name: "axial",    w: X, h: Y, mmW: X * sx, mmH: Y * sy },
    { name: "coronal",  w: X, h: Z, mmW: X * sx, mmH: Z * sz },
    { name: "sagittal", w: Y, h: Z, mmW: Y * sy, mmH: Z * sz },
  ];
  const canvases: Record<RowKey, HTMLCanvasElement[]> = { neural: [], htj2k: [] };
  const cells: HTMLElement[] = [];
  for (const k of keys) {
    grids[k].replaceChildren();
    for (const pl of planes) {
      const cell = document.createElement("div");
      cell.className = "cmpcell";
      const cv = document.createElement("canvas");
      cv.width = pl.w; cv.height = pl.h;
      cv.style.width = `${pl.mmW}px`;
      cv.style.height = `${pl.mmH}px`;
      const tag = document.createElement("span");
      tag.textContent = pl.name;
      cell.append(cv, tag);
      grids[k].append(cell);
      canvases[k].push(cv);
      cells.push(cell);
    }
  }

  // One zoom/pan for every pane, in normalised units, so the two arms are
  // always on the same anatomy — a fine-detail comparison of two different
  // places is worthless.
  let zoom = 1, panX = 0, panY = 0;
  const applyView = () => {
    for (const k of keys) {
      canvases[k].forEach((cv, pi) => {
        const cell = cv.parentElement as HTMLElement;
        const pl = planes[pi];
        const fit = Math.min((cell.clientWidth || 1) / pl.mmW, (cell.clientHeight || 1) / pl.mmH);
        const s = fit * zoom;
        const offX = (cell.clientWidth - pl.mmW * s) / 2 + panX * fit;
        const offY = (cell.clientHeight - pl.mmH * s) / 2 + panY * fit;
        cv.style.transform = `translate(${offX}px, ${offY}px) scale(${s})`;
      });
    }
  };

  const draw = (i: number) => {
    const lo = lev - win / 2, span = Math.max(1, win);
    for (const k of keys) {
      const s = snaps[k][i];
      canvases[k].forEach((cv, pi) => {
        const ctx = cv.getContext("2d")!;
        if (!s) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
        const src = pi === 0 ? s.ax : pi === 1 ? s.co : s.sa;
        const img = ctx.createImageData(cv.width, cv.height);
        const d = img.data;
        for (let j = 0; j < src.length; j++) {
          const g = Math.max(0, Math.min(255, ((src[j] - lo) / span) * 255)) | 0;
          const o = j * 4;
          d[o] = d[o + 1] = d[o + 2] = g;
          d[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      });
    }
    const n = snaps.neural[i], hj = snaps.htj2k[i];
    const kb = (b?: number) => b == null ? "\u2014"
      : b < 1e6 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1e6).toFixed(1)} MB`;
    cfg.el("cmplabel").textContent =
      `budget ${kb(budgets[i])}  \u00b7  neural ${kb(n?.bytes)} @ ${n ? (n.ms / 1000).toFixed(1) : "\u2014"} s`
      + `  \u00b7  HTJ2K ${kb(hj?.bytes)} @ ${hj ? (hj.ms / 1000).toFixed(1) : "\u2014"} s`;
    applyView();
  };

  const slider = cfg.el("cmpslider") as HTMLInputElement;
  const n = Math.max(snaps.neural.length, snaps.htj2k.length);
  slider.max = String(Math.max(0, n - 1));
  slider.value = String(Math.max(0, n - 1));
  slider.oninput = () => draw(+slider.value);

  const grid = cfg.el("cmpgrid");
  grid.onwheel = (e: WheelEvent) => {
    e.preventDefault();
    // Zoom about the cursor: anchor the point under the pointer so detail
    // stays put instead of sliding out of frame as you magnify.
    const cell = (e.target as HTMLElement).closest(".cmpcell") as HTMLElement | null;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(1, Math.min(40, zoom * f));
    if (cell) {
      const r = cell.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      const pi = [...cell.parentElement!.children].indexOf(cell);
      const pl = planes[pi] ?? planes[0];
      const fit = Math.min(r.width / pl.mmW, r.height / pl.mmH) || 1;
      panX += (cx / fit) * (1 - next / zoom);
      panY += (cy / fit) * (1 - next / zoom);
    }
    zoom = next;
    applyView();
  };
  let drag: { x: number; y: number; px: number; py: number; fit: number } | null = null;
  grid.onpointerdown = (e: PointerEvent) => {
    const cell = (e.target as HTMLElement).closest(".cmpcell") as HTMLElement | null;
    const pi = cell ? [...cell.parentElement!.children].indexOf(cell) : 0;
    const pl = planes[pi] ?? planes[0];
    const r = cell?.getBoundingClientRect();
    const fit = r ? Math.min(r.width / pl.mmW, r.height / pl.mmH) || 1 : 1;
    drag = { x: e.clientX, y: e.clientY, px: panX, py: panY, fit };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  grid.onpointermove = (e: PointerEvent) => {
    if (!drag) return;
    panX = drag.px + (e.clientX - drag.x) / drag.fit;
    panY = drag.py + (e.clientY - drag.y) / drag.fit;
    applyView();
  };
  grid.onpointerup = () => { drag = null; };
  grid.onpointercancel = () => { drag = null; };
  addEventListener("keydown", (e) => {
    if (!cfg.el("cmp").classList.contains("on")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      slider.value = String(Math.max(0, Math.min(+slider.max,
        +slider.value + (e.key === "ArrowRight" ? 1 : -1))));
      draw(+slider.value);
    } else if (e.key === "0") { zoom = 1; panX = panY = 0; applyView(); }
    else if (e.key === "Escape") cfg.el("cmp").classList.remove("on");
  });
  addEventListener("resize", applyView);
  draw(+slider.value);
}
