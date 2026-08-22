// bir.ts — IHE Basic Image Review (BIR) toolbar, tools and hanging-protocol layouts.
//
// A general-purpose, application-level reader-chrome component built entirely on SlicerLive
// render/ primitives (slice/scene renderers, view mapping, crosshair). Consumed by SlicerRad
// and by the SlicerLive `bir` gallery demo (render/demos/bir-browser.ts).
//
// Implements the reader feature set of the IHE RAD BIR supplement (Rev 1.3, Section
// 4.16.4.2.2.5) on top of the SlicerLive MPR stack: the spec's Action Tools
// (Table 4.16.4.2.2.5.13-1), Modal Tools (-2) and Cine Tools (-3), with the suggested
// icon symbols redrawn as inline SVG, the spec's keyboard shortcuts (case-insensitive),
// mutually exclusive modal tools with pressed-state + cursor feedback, a FrameSet
// thumbnail strip, and display-size-adaptive hanging protocols (phone → single
// viewport, desktop → Four-Up, 4K → Four-Up + extra series tiles).
//
// Slice gestures, view mapping (viewToRas/rasToView) and camera behavior all come from
// SlicerLive (never re-rolled here); this module owns only BIR chrome + app-level tools
// (measurements, localizer lines, cine, layouts) drawn on overlay canvases.

import { drawCross } from "./crosshair.ts";
import type { Vec3 } from "../mat4.ts";

export type Plane = "axial" | "sagittal" | "coronal";
export type BirTool =
  | "scroll"
  | "wl"
  | "zoom"
  | "pan"
  | "select"
  | "distance"
  | "angle"
  | "crosshair";

/** Slicer view colors (axial red / sagittal yellow / coronal green) for localizer lines. */
const PLANE_COLOR: Record<Plane, string> = {
  axial: "#f05a5a",
  sagittal: "#f0d24a",
  coronal: "#5ad07a",
};

interface Measurement {
  kind: "distance" | "angle";
  plane: Plane;
  mm: number; // slice position (RAS mm along the plane normal) it was made on
  pts: Vec3[]; // 2 pts for distance, 4 for angle (two segments, no shared vertex — Cobb)
}

export interface StripItem {
  seriesUID: string;
  lines: string[]; // decoration: date · modality · description · count (spec 5.3)
  current: boolean;
  thumb: () => Promise<Blob | null>;
  open: () => void | Promise<void>;
}

export interface BirCfg {
  overlay: HTMLElement;
  bar: HTMLElement;
  grid: HTMLElement;
  planes: readonly Plane[];
  canvases: Record<string, HTMLCanvasElement>;
  cellOf: (name: string) => HTMLElement | null;
  // deno-lint-ignore no-explicit-any
  slice: () => any; // SliceRenderer (viewToRas / rasToView / resetView)
  off01: (p: Plane) => number;
  setOff01: (p: Plane, v: number) => void;
  offsetMm: (p: Plane) => number;
  spacing: (p: Plane) => number;
  step: (p: Plane, forward: boolean) => void;
  redraw: (p: Plane) => void;
  redrawAll: () => void;
  rasLo: Vec3;
  rasHi: Vec3;
  wl: { get: () => [number, number]; set: (w: number, l: number) => void; auto: [number, number] };
  presetsEl: HTMLSelectElement;
  resetViews: () => void;
  close: () => void;
  jumpAll: (ras: Vec3) => void;
  modality: string;
  onToolChange?: (tool: BirTool) => void;
  nav?: {
    prevStudy?: () => void | Promise<void>;
    nextStudy?: () => void | Promise<void>;
    prevSeries?: () => void | Promise<void>;
    nextSeries?: () => void | Promise<void>;
  };
  strip?: StripItem[];
  /** Requested initial layout (study-mode open uses "single" for a single axial view).
   *  Overridden to "single" on phones. Defaults to "fourUp". */
  initialLayout?: "single" | "twoUp" | "fourUp";
  /** Optional extra toolbar buttons (e.g. IDC Share / Download) — appended after Help. */
  extraTools?: { id: string; icon: string; title: string; run: () => void }[];
}

export interface BirApi {
  tool(): BirTool;
  setTool(t: BirTool): void;
  measureCount(): number;
  leftMode(): "scroll" | "wl" | "zoom" | "pan";
  hooks(p: Plane): { onLeftGrab: (u: number, v: number, w: number, h: number) => boolean };
  drawOverlay(p: Plane): void;
  resize(): void;
  selected(): Plane;
  setLayout(l: "single" | "twoUp" | "fourUp"): void;
  reset(): void;
  detachKeys(): void;
}

/** Physical-display class for the hanging-protocol choice: don't cram tiny windows onto a
 *  phone; use the real estate of a 4K monitor for extra visible series. */
export function displayClass(): "phone" | "desktop" | "large" {
  // PHYSICAL display size (screen.*), not the layout viewport: on mobile the layout
  // viewport shrink-to-fits wide content and lies about the device size.
  const sw = globalThis.screen?.width ?? globalThis.innerWidth;
  const sh = globalThis.screen?.height ?? globalThis.innerHeight;
  const devicePx = sw * (globalThis.devicePixelRatio || 1);
  if (Math.min(sw, sh) < 700) return "phone";
  if (devicePx >= 3400) return "large";
  return "desktop";
}

// ---- icons — redrawn from the BIR suggested symbols (Tables 13-1/2/3) -------------------

const I = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS: Record<string, string> = {
  // Action tools
  patient: I(`<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/>`),
  prevStudy: I(`<path d="M3 7h6l2-2h10v14H3z"/><path d="M14 11l-4 3 4 3" fill="currentColor"/>`),
  nextStudy: I(`<path d="M3 7h6l2-2h10v14H3z"/><path d="M11 11l4 3-4 3" fill="currentColor"/>`),
  prevFS: I(`<path d="M12 6l-7 6 7 6M19 6l-7 6 7 6"/>`), // «
  nextFS: I(`<path d="M5 6l7 6-7 6M12 6l7 6-7 6"/>`), // »
  prevFrame: I(`<path d="M15 5l-8 7 8 7"/>`), // ‹
  nextFrame: I(`<path d="M9 5l8 7-8 7"/>`), // ›
  layoutIn: I(
    `<rect x="3" y="4" width="14" height="14"/><path d="M10 4v14M3 11h14"/><path d="M19 15l2 3h-4z" fill="currentColor"/>`,
  ),
  layoutMulti: I(
    `<rect x="2" y="3" width="8" height="7"/><rect x="12" y="3" width="8" height="7"/>` +
      `<rect x="2" y="12" width="8" height="7"/><path d="M18 16l2 3h-4z" fill="currentColor"/>`,
  ),
  invert: I(`<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/>`), // IEC 5411
  localizer: I(
    `<rect x="3" y="4" width="18" height="16"/><circle cx="12" cy="10" r="2.5"/>` +
      `<path d="M8 14c1-1.5 7-1.5 8 0"/><path d="M3 12h3M8 12h3M13 12h3M18 12h3" stroke-dasharray="2 2"/>`,
  ),
  link: I(
    `<rect x="2" y="9" width="6" height="6" rx="3"/><rect x="9" y="9" width="6" height="6" rx="3"/>` +
      `<rect x="16" y="9" width="6" height="6" rx="3"/>`,
  ),
  wlMode: I(
    `<circle cx="7" cy="10" r="4.5"/><path d="M7 5.5a4.5 4.5 0 010 9z" fill="currentColor"/>` +
      `<circle cx="17" cy="10" r="1.2" fill="currentColor"/><ellipse cx="17" cy="10" rx="4" ry="1.6"/>` +
      `<path d="M3 19h18"/>`,
  ), // IEC 5435 + Bohr atom + line
  annotation: I(
    `<path d="M3 4h6M3 7h4M15 4h6M17 7h4M3 17h4M3 20h6M17 17h4M15 20h6"/>`,
  ),
  print: I(
    `<rect x="6" y="3" width="12" height="5"/><rect x="3" y="8" width="18" height="8" rx="1"/>` +
      `<rect x="6" y="14" width="12" height="7"/>`,
  ),
  reset: I(`<path d="M4 9V4h5"/><path d="M4 4l6 6"/><rect x="8" y="10" width="12" height="10"/>`), // IEC 5495
  report: I(`<path d="M4 4h16M4 7h16M4 10h10M4 15h16M4 18h12"/>`),
  rotate: I(`<path d="M19 12a7 7 0 11-2-4.9"/><path d="M17 3v4h4" fill="currentColor"/>`), // IEC 5772 one-way
  flip: I(`<path d="M12 3v18" stroke-dasharray="3 2"/><path d="M9 7L4 12l5 5zM15 7l5 5-5 5z" fill="currentColor"/>`), // IEC 5408
  cine: I(
    `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 8h18M6 5v3M10 5v3M14 5v3M18 5v3"/>` +
      `<path d="M10 11l5 3.5-5 3.5z" fill="currentColor"/>`,
  ), // IEC 1123
  presets: I(
    `<circle cx="10" cy="10" r="5.5"/><path d="M10 4.5a5.5 5.5 0 010 11z" fill="currentColor"/>` +
      `<path d="M17 15l2.5 4h-5z" fill="currentColor"/>`,
  ), // IEC 5435 + dropdown
  help: I(`<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.7-1.5 1.2-1.5 2.3"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>`), // IEC 5289
  advanced: I(`<path d="M2 9l10-4 10 4-10 4z" fill="currentColor"/><path d="M6 11v5c2 2.5 10 2.5 12 0v-5"/>`), // mortarboard
  // Modal tools
  zoom: I(`<circle cx="10" cy="10" r="6"/><path d="M15 15l6 6"/>`),
  pan: I(
    `<path d="M8 11V5.5a1.4 1.4 0 012.8 0V10m0-5.5V4a1.4 1.4 0 012.8 0v6m0-4.5a1.4 1.4 0 012.8 0V12m0-3a1.4 1.4 0 012.8 0v5c0 4-2.5 7-6.5 7S8.5 19 7 16l-2.4-4.2a1.3 1.3 0 012.2-1.3L8 12.5z"/>`,
  ),
  window: I(`<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/><path d="M12 4v16" stroke-width="1"/>`), // IEC 5435
  scroll: I(
    `<rect x="7" y="3" width="12" height="9"/><rect x="5" y="7" width="12" height="9" fill="#05060a"/>` +
      `<rect x="3" y="11" width="12" height="9" fill="#05060a"/>`,
  ), // stack of frames
  selectvp: I(`<path d="M5 3l7 16 2.2-6.2L20 10.5z" fill="currentColor"/>`), // up-left arrow
  distance: I(`<path d="M4 20L20 4"/><path d="M6 14l2 2M9 11l2 2M12 8l2 2M15 5l2 2"/>`), // IEC 5658 ruler
  angle: I(`<path d="M4 20h16L4 6z"/><path d="M10 20a8 8 0 00-2.5-5.5"/><path d="M9 12.5l-1.5 2M10 20l-2.4-.6" stroke-width="1.2"/>`),
  crosshair: I(
    `<circle cx="12" cy="12" r="8"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5" stroke-dasharray="3 2"/>`,
  ),
  // Cine controls
  play: I(`<path d="M7 5l12 7-12 7z" fill="currentColor"/>`),
  stop: I(`<rect x="6" y="6" width="12" height="12" fill="currentColor"/>`),
  pause: I(`<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>`),
  toStart: I(`<path d="M6 5v14M19 5l-10 7 10 7z" fill="currentColor"/>`),
  stepFwd: I(`<path d="M5 5l10 7-10 7z" fill="currentColor"/><rect x="17" y="5" width="2.5" height="14" fill="currentColor"/>`), // IEC 5471
  toEnd: I(`<path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor"/>`),
  thumbs: I(`<rect x="3" y="3" width="7" height="7"/><rect x="3" y="13" width="7" height="7"/><path d="M13 5h8M13 9h6M13 15h8M13 19h6"/>`),
  // IDC actions
  share: I(`<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.8l7.4-4.3M8.3 13.2l7.4 4.3"/>`),
  download: I(`<path d="M12 3v11m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>`),
};

const STYLE = `
#bir-toolbar { display:flex; align-items:center; gap:2px; padding:3px 8px; background:#0b0e16;
  border-bottom:1px solid #1b2740; flex-wrap:wrap; }
#bir-toolbar .sep { width:1px; height:28px; background:#1b2740; margin:0 6px; }
#bir-toolbar button { display:inline-flex; align-items:center; justify-content:center;
  width:38px; height:36px; color:#9fb3d0; background:none; border:1px solid transparent;
  border-radius:5px; cursor:pointer; padding:0; }
#bir-toolbar button:hover { background:#1b2740; color:#d6e2f2; }
#bir-toolbar button.active { background:#2b6cb0; color:#fff; border-color:#33507e; }
#bir-toolbar button:disabled { opacity:.3; cursor:default; background:none; }
#bir-cine-box { display:flex; align-items:center; gap:2px; margin-left:4px; padding:2px 6px;
  background:#11141d; border:1px solid #33507e; border-radius:5px; }
#bir-cine-box input { width:44px; font:600 11px -apple-system,system-ui,sans-serif; color:#d6e2f2;
  background:#0b0e16; border:1px solid #33507e; border-radius:3px; padding:1px 4px; }
#bir-strip { width:158px; overflow-y:auto; background:#0b0e16; border-right:1px solid #1b2740;
  flex:0 0 auto; }
#bir-strip .head { font:700 10px -apple-system,system-ui,sans-serif; letter-spacing:.6px;
  text-transform:uppercase; color:#5a6b85; padding:6px 8px 4px; }
#bir-strip .item { margin:0 6px 8px; border:1px solid #1b2740; border-radius:5px; cursor:pointer;
  overflow:hidden; background:#05060a; }
#bir-strip .item:hover { border-color:#33507e; }
#bir-strip .item.current { border-color:#2b6cb0; box-shadow:0 0 0 1px #2b6cb0; }
#bir-strip img { width:100%; aspect-ratio:1; object-fit:contain; background:#000; display:block; }
#bir-strip .cap { font:10px -apple-system,system-ui,sans-serif; color:#9fb3d0; padding:3px 6px;
  line-height:1.35; }
.bir-cell-selected { outline:1px solid #2b6cb0; outline-offset:-1px; }
.srv-grid.ann-none .srv-orient, .srv-grid.ann-none .srv-slice-readout,
.srv-grid.ann-min .srv-slice-readout { display:none; }
`;

export function mountBir(cfg: BirCfg): BirApi {
  if (!document.getElementById("bir-style")) {
    const st = document.createElement("style");
    st.id = "bir-style";
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  // ---- state ------------------------------------------------------------------------------
  let tool: BirTool = "scroll"; // spec: Scroll is the default modal tool
  let selectedPlane: Plane = cfg.planes[0]; // spec: upper-left viewport initially selected
  let localizerOn = false; // spec default Off
  let inverted = false;
  let clamped = /^(NM|PT)$/i.test(cfg.modality); // spec: Clamped default for NM/PET
  let annState = 0; // 0 full, 1 minimal, 2 none
  let crossRas: Vec3 | null = null;
  const measurements: Measurement[] = [];
  let pending: Measurement | null = null; // in-progress clicks
  let layout: "single" | "twoUp" | "fourUp" = "fourUp";

  // ---- overlay canvases (measurements / localizer / crosshair marks) ----------------------
  const overlays = new Map<Plane, HTMLCanvasElement>();
  for (const p of cfg.planes) {
    const cell = cfg.cellOf(p);
    if (!cell) continue;
    const c = document.createElement("canvas");
    c.className = "bir-overlay";
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
    cell.appendChild(c);
    overlays.set(p, c);
  }
  const resizeOverlays = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const [, c] of overlays) {
      c.width = Math.max(1, Math.floor(c.clientWidth * dpr));
      c.height = Math.max(1, Math.floor(c.clientHeight * dpr));
    }
  };

  const rasOfClick = (p: Plane, u: number, v: number, w: number, h: number): Vec3 =>
    cfg.slice().viewToRas(p, cfg.off01(p), u, v, w / h) as Vec3;
  const toPx = (p: Plane, ras: Vec3, w: number, h: number): { x: number; y: number } => {
    const r = cfg.slice().rasToView(p, cfg.off01(p), ras, w / h);
    return { x: r.u * w, y: r.v * h };
  };

  const drawOverlay = (p: Plane) => {
    const c = overlays.get(p);
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = c.width / dpr, h = c.height / dpr;
    ctx.clearRect(0, 0, w, h);
    if (!w || !h) return;

    // Localizer lines (BIR 5.7): intersection of the OTHER planes with this one, in the
    // other plane's Slicer color. Axis-aligned MPR → each is a straight line through the
    // two volume-corner points on the intersection.
    if (localizerOn) {
      const nAxis: Record<Plane, 0 | 1 | 2> = { sagittal: 0, coronal: 1, axial: 2 };
      for (const q of cfg.planes) {
        if (q === p) continue;
        const free = ([0, 1, 2] as const).find((a) => a !== nAxis[p] && a !== nAxis[q])!;
        const mk = (t: number): Vec3 => {
          const r: Vec3 = [0, 0, 0];
          r[nAxis[p]] = cfg.offsetMm(p);
          r[nAxis[q]] = cfg.offsetMm(q);
          r[free] = t;
          return r;
        };
        const a = toPx(p, mk(cfg.rasLo[free]), w, h);
        const b = toPx(p, mk(cfg.rasHi[free]), w, h);
        ctx.strokeStyle = PLANE_COLOR[q];
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Crosshair-tool mark (BIR 5.7): interrupted cross at the picked point.
    if (crossRas) {
      const pt = toPx(p, crossRas, w, h);
      if (pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h) {
        drawCross(ctx, pt.x, pt.y, { color: "#6cc4ff", size: 14, gap: 5 });
      }
    }

    // Measurements on this plane, shown while the viewport is on (or near) their slice.
    const near = (m: Measurement) => m.plane === p && Math.abs(m.mm - cfg.offsetMm(p)) <= cfg.spacing(p) / 2;
    // Larger, high-contrast measurement labels: a dark rounded halo behind the green text so the
    // readout stays legible over bright bone or dark air alike.
    ctx.font = "700 15px -apple-system,system-ui,sans-serif";
    ctx.lineJoin = "round";
    ctx.textBaseline = "alphabetic";
    const label = (text: string, x: number, y: number) => {
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(6,10,16,.92)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = "#8dffc4";
      ctx.fillText(text, x, y);
    };
    for (const m of [...measurements.filter(near), ...(pending && pending.plane === p ? [pending] : [])]) {
      const px = m.pts.map((r) => toPx(p, r, w, h));
      ctx.strokeStyle = "#6ce0a8";
      ctx.fillStyle = "#6ce0a8";
      ctx.lineWidth = 2;
      for (let i = 0; i + 1 < px.length; i += 2) {
        ctx.beginPath();
        ctx.moveTo(px[i].x, px[i].y);
        ctx.lineTo(px[i + 1].x, px[i + 1].y);
        ctx.stroke();
      }
      for (const q of px) {
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Label: mm for a complete distance, degrees for a complete angle (sub-pixel per spec).
      if (m.kind === "distance" && m.pts.length === 2) {
        const d = Math.hypot(
          m.pts[0][0] - m.pts[1][0],
          m.pts[0][1] - m.pts[1][1],
          m.pts[0][2] - m.pts[1][2],
        );
        label(`${d.toFixed(1)} mm`, (px[0].x + px[1].x) / 2 + 8, (px[0].y + px[1].y) / 2 - 8);
      } else if (m.kind === "angle" && m.pts.length === 4) {
        const v1 = [m.pts[1][0] - m.pts[0][0], m.pts[1][1] - m.pts[0][1], m.pts[1][2] - m.pts[0][2]];
        const v2 = [m.pts[3][0] - m.pts[2][0], m.pts[3][1] - m.pts[2][1], m.pts[3][2] - m.pts[2][2]];
        const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
        const deg = Math.acos(
          Math.min(1, Math.abs(dot) / (Math.hypot(...v1) * Math.hypot(...v2) || 1)),
        ) * 180 / Math.PI;
        label(`${deg.toFixed(1)}°`, px[3].x + 8, px[3].y - 8);
      }
    }
  };
  const redrawOverlays = () => { for (const p of cfg.planes) drawOverlay(p); };

  // ---- viewport selection (BIR 5.11): implicit on click, explicit via Select tool ---------
  const markSelected = () => {
    for (const p of cfg.planes) {
      cfg.cellOf(p)?.classList.toggle("bir-cell-selected", p === selectedPlane);
    }
  };
  for (const p of cfg.planes) {
    cfg.cellOf(p)?.addEventListener("pointerdown", () => {
      if (selectedPlane !== p) {
        selectedPlane = p;
        markSelected();
      }
    });
  }
  markSelected();

  // ---- toolbar ---------------------------------------------------------------------------
  const tb = document.createElement("div");
  tb.id = "bir-toolbar";
  cfg.bar.after(tb);

  const buttons = new Map<string, HTMLButtonElement>();
  const btn = (
    id: string,
    icon: string,
    tip: string,
    onClick?: () => void,
    opts: { disabled?: boolean; disabledTip?: string } = {},
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.id = "bir-" + id;
    b.innerHTML = ICONS[icon] ?? "?";
    b.title = opts.disabled && opts.disabledTip ? opts.disabledTip : tip;
    b.disabled = !!opts.disabled;
    if (onClick) b.addEventListener("click", onClick);
    tb.appendChild(b);
    buttons.set(id, b);
    return b;
  };
  const sep = () => {
    const s = document.createElement("div");
    s.className = "sep";
    tb.appendChild(s);
  };

  const stepSelected = (forward: boolean) => {
    cfg.step(selectedPlane, forward);
    cfg.redraw(selectedPlane);
  };

  // -- navigation (Action Tools) --
  btn("patient", "patient", "Select Patient — back to the patient/study/series browser", cfg.close);
  btn("prev-study", "prevStudy", "Previous Study", () => cfg.nav?.prevStudy?.(), {
    disabled: !cfg.nav?.prevStudy,
    disabledTip: "Previous Study — none earlier",
  });
  btn("next-study", "nextStudy", "Next Study", () => cfg.nav?.nextStudy?.(), {
    disabled: !cfg.nav?.nextStudy,
    disabledTip: "Next Study — none later",
  });
  btn("prev-fs", "prevFS", "Previous FrameSet (series) — Page Up", () => cfg.nav?.prevSeries?.(), {
    disabled: !cfg.nav?.prevSeries,
    disabledTip: "Previous FrameSet — none",
  });
  btn("next-fs", "nextFS", "Next FrameSet (series) — Page Down", () => cfg.nav?.nextSeries?.(), {
    disabled: !cfg.nav?.nextSeries,
    disabledTip: "Next FrameSet — none",
  });
  btn("prev-frame", "prevFrame", "Previous Frame — Left/Up arrow", () => stepSelected(false));
  btn("next-frame", "nextFrame", "Next Frame — Right/Down arrow", () => stepSelected(true));
  sep();

  // -- layout --
  const layoutSel = document.createElement("select");
  layoutSel.id = "bir-layout";
  layoutSel.title = "Layout Multiple Viewports — hanging protocol";
  layoutSel.style.cssText =
    "font:600 11px -apple-system,system-ui,sans-serif;color:#d6e2f2;background:#11141d;" +
    "border:1px solid #33507e;border-radius:4px;padding:2px 4px;cursor:pointer;";
  for (
    const [v, label] of [
      ["fourUp", "Four-Up (MPR + 3D)"],
      ["twoUp", "2 side-by-side"],
      ["single", "Single viewport"],
      ["browser", "Browser (patient/study/series)"],
    ] as const
  ) layoutSel.add(new Option(label, v));
  layoutSel.addEventListener("change", () => {
    if (layoutSel.value === "browser") cfg.close();
    else setLayout(layoutSel.value as typeof layout);
  });
  tb.appendChild(layoutSel);
  btn("layout-in", "layoutIn", "Layout Within Viewport", undefined, {
    disabled: true,
    disabledTip: "Layout Within Viewport — tiled stack layout not yet available (MPR planes shown instead)",
  });
  sep();

  // -- modal tools (mutually exclusive; cursor + pressed state per spec) --
  const CURSORS: Partial<Record<BirTool, string>> = {
    zoom: "ns-resize",
    pan: "grab",
    wl: "crosshair",
    distance: "crosshair",
    angle: "crosshair",
    crosshair: "crosshair",
    select: "pointer",
    scroll: "default",
  };
  const setTool = (t: BirTool) => {
    tool = t;
    pending = null;
    for (
      const [id, tl] of [
        ["tool-scroll", "scroll"],
        ["tool-window", "wl"],
        ["tool-zoom", "zoom"],
        ["tool-pan", "pan"],
        ["tool-select", "select"],
        ["tool-distance", "distance"],
        ["tool-angle", "angle"],
        ["tool-crosshair", "crosshair"],
      ] as const
    ) buttons.get(id)?.classList.toggle("active", tool === tl);
    for (const p of cfg.planes) cfg.canvases[p].style.cursor = CURSORS[tool] ?? "default";
    cfg.onToolChange?.(tool);
    redrawOverlays();
  };
  btn("tool-scroll", "scroll", "Scroll (stack) — S", () => setTool("scroll"));
  btn("tool-window", "window", "Window (adjust W/L by dragging) — W", () => setTool("wl"));
  btn("tool-zoom", "zoom", "Zoom (drag up = out, down = in) — Z", () => setTool("zoom"));
  btn("tool-pan", "pan", "Pan (translate) — T", () => setTool("pan"));
  btn("tool-select", "selectvp", "Select Viewport — V", () => setTool("select"));
  btn("tool-distance", "distance", "Distance measurement (click start, click end) — D", () => setTool("distance"));
  btn("tool-angle", "angle", "Angle measurement (two segments, four clicks — Cobb) — A", () => setTool("angle"));
  btn("tool-crosshair", "crosshair", "Cross-hair (click to localize in all viewports) — J", () => setTool("crosshair"));
  sep();

  // -- windowing group --
  // Window Presets popup: a hovered preset HOT-APPLIES to the live volume as a preview; the
  // clicked one sticks; leaving without a click reverts to the window at open time.
  let presetPop: HTMLElement | null = null;
  let presetOrigWL: [number, number] | null = null;
  let presetEsc: ((e: KeyboardEvent) => void) | null = null;
  const closePresetPop = (revertWL?: [number, number]) => {
    if (revertWL) cfg.wl.set(revertWL[0], revertWL[1]);
    presetPop?.remove();
    presetPop = null;
    document.removeEventListener("pointerdown", onPresetOutside, true);
    if (presetEsc) document.removeEventListener("keydown", presetEsc, true);
    presetEsc = null;
  };
  const onPresetOutside = (e: PointerEvent) => {
    if (presetPop && !presetPop.contains(e.target as Node) && (e.target as HTMLElement)?.id !== "bir-presets") {
      closePresetPop(presetOrigWL ?? undefined);
    }
  };
  const openPresetPop = () => {
    if (presetPop) {
      closePresetPop(presetOrigWL ?? undefined);
      return;
    }
    presetOrigWL = cfg.wl.get();
    const orig = presetOrigWL;
    const anchor = buttons.get("presets")!.getBoundingClientRect();
    presetPop = document.createElement("div");
    presetPop.id = "bir-preset-pop";
    presetPop.style.cssText =
      `position:fixed;top:${Math.round(anchor.bottom + 4)}px;left:${Math.round(anchor.left)}px;z-index:1200;` +
      "min-width:180px;background:#11141d;border:1px solid #33507e;border-radius:8px;padding:5px;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.6);font:12px -apple-system,system-ui,sans-serif;color:#d6e2f2;";
    const head = document.createElement("div");
    head.textContent = "Window presets — hover to preview";
    head.style.cssText = "font-size:10px;color:#5a6b85;padding:3px 8px 5px;text-transform:uppercase;letter-spacing:.5px;";
    presetPop.appendChild(head);
    // Options come from the host's preset <select> (skip the live "current" row).
    for (const opt of [...cfg.presetsEl.options].filter((o) => o.value !== "current")) {
      const item = document.createElement("div");
      item.className = "bir-preset-item";
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      item.style.cssText = "padding:6px 10px;border-radius:5px;cursor:pointer;white-space:nowrap;";
      item.addEventListener("pointerenter", () => {
        for (const el of presetPop!.querySelectorAll(".bir-preset-item")) {
          (el as HTMLElement).style.background = "transparent";
        }
        item.style.background = "#2b6cb0";
        cfg.presetsEl.value = opt.value; // preview: drive the host's preset handler live
        cfg.presetsEl.dispatchEvent(new Event("change"));
      });
      item.addEventListener("click", () => closePresetPop()); // no revert → the preview sticks
      presetPop.appendChild(item);
    }
    presetEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePresetPop(orig);
    };
    document.body.appendChild(presetPop);
    // Defer wiring the dismiss handlers so the opening click/keys don't immediately close it.
    setTimeout(() => {
      document.addEventListener("pointerdown", onPresetOutside, true);
      document.addEventListener("keydown", presetEsc!, true);
    }, 0);
  };
  btn("presets", "presets", "Window Presets — hover to preview on the volume, click to keep (CT: Soft Tissue / Lung / Bone / Brain + Auto)", openPresetPop);
  btn("wl-clamp", "wlMode", "Window mode — Center/Width vs Clamped (lower limit fixed at 0; default for NM/PET)", () => {
    clamped = !clamped;
    buttons.get("wl-clamp")!.classList.toggle("active", clamped);
    if (clamped) {
      const [w] = cfg.wl.get();
      cfg.wl.set(w, w / 2); // bottom of window → 0
    }
  });
  if (clamped) {
    // apply the NM/PET default on mount
    const [w] = cfg.wl.get();
    cfg.wl.set(w, w / 2);
  }
  buttons.get("wl-clamp")!.classList.toggle("active", clamped);
  btn("invert", "invert", "Invert grayscale", () => {
    inverted = !inverted;
    buttons.get("invert")!.classList.toggle("active", inverted);
    for (const p of cfg.planes) cfg.canvases[p].style.filter = inverted ? "invert(1)" : "";
  });
  sep();

  // -- display toggles --
  btn("localizer", "localizer", "Localizer lines — O", () => {
    localizerOn = !localizerOn;
    buttons.get("localizer")!.classList.toggle("active", localizerOn);
    redrawOverlays();
  });
  btn("linksync", "link", "Link/unlink synchronized scrolling — L/U", undefined, {
    disabled: true,
    disabledTip: "Link/unlink synchronization — MPR planes of one series are always linked; enabled with compare viewports",
  });
  btn("annotation", "annotation", "Annotation — cycle full / minimal / off — I", () => {
    annState = (annState + 1) % 3;
    cfg.grid.classList.toggle("ann-min", annState === 1);
    cfg.grid.classList.toggle("ann-none", annState === 2);
    buttons.get("annotation")!.classList.toggle("active", annState !== 0);
  });
  sep();

  // -- cine (group appears on demand; plays immediately per spec) --
  let cineBox: HTMLElement | null = null;
  let cineTimer: number | null = null;
  const cineStop = () => {
    if (cineTimer !== null) clearInterval(cineTimer);
    cineTimer = null;
  };
  const cineClose = () => {
    cineStop();
    cineBox?.remove();
    cineBox = null;
    buttons.get("cine")!.classList.remove("active");
  };
  const cinePlay = (fps: number) => {
    cineStop();
    cineTimer = setInterval(() => {
      const before = cfg.off01(selectedPlane);
      cfg.step(selectedPlane, true);
      if (cfg.off01(selectedPlane) === before) cfg.setOff01(selectedPlane, 0); // loop
      cfg.redraw(selectedPlane);
    }, 1000 / Math.max(1, fps)) as unknown as number;
  };
  const cineToggle = () => {
    if (cineBox) {
      cineClose();
      return;
    }
    buttons.get("cine")!.classList.add("active");
    cineBox = document.createElement("div");
    cineBox.id = "bir-cine-box";
    const fps = document.createElement("input");
    fps.type = "number";
    fps.value = "10";
    fps.title = "Frame rate (frames/second)";
    const cbtn = (icon: string, tip: string, fn: () => void) => {
      const b = document.createElement("button");
      b.innerHTML = ICONS[icon];
      b.title = tip;
      b.addEventListener("click", fn);
      cineBox!.appendChild(b);
      return b;
    };
    cbtn("play", "Cine Play (loop)", () => cinePlay(Number(fps.value) || 10));
    cbtn("pause", "Cine Pause", cineStop);
    cbtn("stop", "Cine Stop (back to first frame)", () => {
      cineStop();
      cfg.setOff01(selectedPlane, 0);
      cfg.redraw(selectedPlane);
    });
    cbtn("toStart", "Go to first frame", () => {
      cfg.setOff01(selectedPlane, 0);
      cfg.redraw(selectedPlane);
    });
    cbtn("stepFwd", "Step one frame", () => stepSelected(true));
    cbtn("toEnd", "Go to last frame", () => {
      cfg.setOff01(selectedPlane, 1);
      cfg.redraw(selectedPlane);
    });
    cineBox.appendChild(fps);
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "Close cine";
    close.addEventListener("click", cineClose);
    cineBox.appendChild(close);
    tb.appendChild(cineBox);
    fps.addEventListener("change", () => {
      if (cineTimer !== null) cinePlay(Number(fps.value) || 10);
    });
    cinePlay(10); // spec: play immediately on invoking the cine tools
  };
  btn("cine", "cine", "Cine (play through frames) — C", cineToggle);
  sep();

  // -- rotate/flip (spec: DX/CR only, inactive otherwise for safety) --
  const rotatable = /^(DX|CR)$/i.test(cfg.modality);
  btn("rotate", "rotate", "Rotate 90° clockwise", undefined, {
    disabled: !rotatable,
    disabledTip: "Rotate 90° — only active for DX/CR projection images (safety: BIR 4.16.4.2.2.5.2)",
  });
  btn("flip", "flip", "Flip horizontally", undefined, {
    disabled: !rotatable,
    disabledTip: "Flip — only active for DX/CR projection images (safety: BIR 4.16.4.2.2.5.2)",
  });
  sep();

  // -- actions --
  const reset = () => {
    // BIR Display Reset: default zoom/pan, default window, measurements removed —
    // the scroll position is intentionally NOT changed.
    cfg.resetViews();
    cfg.wl.set(...cfg.wl.auto);
    measurements.length = 0;
    pending = null;
    if (inverted) buttons.get("invert")!.click();
    cfg.redrawAll();
    redrawOverlays();
  };
  btn("reset", "reset", "Display Reset (zoom/pan/window/measurements; keeps scroll position) — Esc", reset);
  btn("print", "print", "Print selected viewport — P", () => printViewport());
  btn("report", "report", "Show Report — R", undefined, {
    disabled: true,
    disabledTip: "Show Report — no reports available for this patient",
  });
  btn("help", "help", "Help — tool guide and keyboard shortcuts — H / F1", () => showHelp());
  btn("advanced", "advanced", "Advanced Mode — toggle BIR basic (single stack) vs MPR Four-Up + 3D — F10", () => {
    setLayout(layout === "single" ? "fourUp" : "single");
  });

  // ---- caller-supplied extra tools (IDC Share / Download) --------------------------------
  if (cfg.extraTools?.length) {
    sep();
    for (const t of cfg.extraTools) btn(t.id, t.icon, t.title, t.run);
  }

  // ---- layouts (hanging protocols) --------------------------------------------------------
  const setLayout = (l: typeof layout) => {
    layout = l;
    const show: Record<string, boolean> = {};
    const names = [...cfg.planes, "threeD"];
    if (l === "single") for (const n of names) show[n] = n === selectedPlane;
    else if (l === "twoUp") for (const n of names) show[n] = n === "axial" || n === "sagittal";
    else for (const n of names) show[n] = true;
    for (const n of names) {
      const cell = cfg.cellOf(n);
      if (cell) cell.style.display = show[n] ? "" : "none";
    }
    cfg.grid.style.gridTemplateColumns = l === "single" ? "1fr" : "1fr 1fr";
    cfg.grid.style.gridTemplateRows = l === "fourUp" ? "1fr 1fr" : "1fr";
    layoutSel.value = l;
    buttons.get("advanced")!.classList.toggle("active", l === "fourUp");
    // canvases changed size → re-render (presentVolume's resize handler redraws all)
    globalThis.dispatchEvent(new Event("resize"));
  };

  // ---- thumbnail strip (BIR 5.3 Navigation) ----------------------------------------------
  let strip: HTMLElement | null = null;
  if (cfg.strip?.length) {
    strip = document.createElement("div");
    strip.id = "bir-strip";
    strip.innerHTML = `<div class="head">Series</div>`;
    for (const it of cfg.strip) {
      const item = document.createElement("div");
      item.className = "item" + (it.current ? " current" : "");
      item.title = it.lines.join(" · ") + " — double-click to load";
      const img = document.createElement("img");
      img.alt = "";
      it.thumb().then((b) => {
        if (b) img.src = URL.createObjectURL(b);
      }).catch(() => {});
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = it.lines.join(" · ");
      item.append(img, cap);
      item.addEventListener("dblclick", () => it.open());
      strip.appendChild(item);
    }
    // Insert as a left column: wrap the grid in a row container.
    const row = document.createElement("div");
    row.id = "bir-row";
    row.style.cssText = "flex:1;display:flex;min-height:0;";
    cfg.grid.parentElement!.insertBefore(row, cfg.grid);
    row.append(strip, cfg.grid);
  }
  const stripBtn = btn("thumbs", "thumbs", "Show/hide the series thumbnail strip", () => {
    if (!strip) return;
    strip.style.display = strip.style.display === "none" ? "" : "none";
    stripBtn.classList.toggle("active", strip.style.display !== "none");
    globalThis.dispatchEvent(new Event("resize"));
  });
  if (!strip) {
    stripBtn.disabled = true;
    stripBtn.title = "Series thumbnail strip — no sibling series available";
  } else stripBtn.classList.add("active");

  // ---- hanging protocol: caller's requested layout, then physical display ------------------
  // A caller (e.g. study-mode open) can request an initial layout; otherwise the display
  // class decides. Phone always collapses to a single viewport regardless.
  const dc = displayClass();
  if (dc === "phone") {
    if (strip) strip.style.display = "none";
    stripBtn.classList.remove("active");
    setLayout("single");
  } else {
    setLayout(cfg.initialLayout ?? "fourUp");
  }

  // ---- print (BIR: selected viewport, current state incl. annotations) --------------------
  const printViewport = () => {
    const p = selectedPlane;
    cfg.redraw(p); // fresh frame, then capture on the next paint
    requestAnimationFrame(() => {
      setTimeout(() => {
        const src = cfg.canvases[p];
        const ov = overlays.get(p);
        const out = document.createElement("canvas");
        out.width = src.width;
        out.height = src.height;
        const ctx = out.getContext("2d")!;
        try {
          ctx.drawImage(src, 0, 0);
          if (inverted) {
            ctx.globalCompositeOperation = "difference";
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, out.width, out.height);
            ctx.globalCompositeOperation = "source-over";
          }
          if (ov) ctx.drawImage(ov, 0, 0, out.width, out.height);
        } catch { /* capture best-effort */ }
        const [win, lev] = cfg.wl.get();
        const w = globalThis.open("", "_blank", "width=900,height=700");
        if (!w) return;
        w.document.write(
          `<title>SlicerRad print — ${p}</title>` +
            `<p style="font:12px sans-serif">For Investigational Use Only — Not for Diagnostic Use · ` +
            `${p} · W ${Math.round(win)} / L ${Math.round(lev)}</p>` +
            `<img style="max-width:100%" src="${out.toDataURL("image/png")}">`,
        );
        w.document.close();
        w.focus();
        setTimeout(() => w.print(), 200);
      }, 60);
    });
  };

  // ---- help overlay (the BIR "manual") ---------------------------------------------------
  const showHelp = () => {
    // NB: the overlay id must NOT collide with the "bir-help" toolbar button — that clash is
    // exactly why the Help button previously "did nothing" (the guard always found the button).
    if (document.getElementById("bir-help-overlay")) return;
    const h = document.createElement("div");
    h.id = "bir-help-overlay";
    h.style.cssText =
      "position:fixed;inset:0;z-index:2000;background:rgba(5,6,10,.85);display:flex;" +
      "align-items:center;justify-content:center;";
    h.innerHTML = `
      <div style="background:#11141d;border:1px solid #33507e;border-radius:10px;padding:20px 26px;
        max-width:560px;max-height:80vh;overflow:auto;font:13px -apple-system,system-ui,sans-serif;color:#d6e2f2;">
        <h3 style="margin:0 0 10px;color:#fff;">SlicerRad reader — IHE Basic Image Review tools</h3>
        <table style="border-collapse:collapse;width:100%;">
        ${
        [
          ["S", "Scroll through slices (default; wheel always scrolls)"],
          ["W", "Window — drag to adjust window/level"],
          ["Z / T", "Zoom / Pan (translate)"],
          ["V", "Select viewport (click also selects)"],
          ["D / A", "Distance (2 clicks) / Angle (4 clicks, Cobb) measurements"],
          ["J", "Cross-hair — click localizes in all viewports"],
          ["O", "Localizer lines on/off"],
          ["I", "Annotations — full / minimal / off"],
          ["C", "Cine — plays immediately; controls appear in the toolbar"],
          ["← ↑ / → ↓", "Previous / next frame"],
          ["PgUp / PgDn", "Previous / next series (FrameSet)"],
          ["Esc", "Display Reset — zoom/pan/window/measurements (keeps scroll position)"],
          ["P", "Print selected viewport"],
          ["F10", "Advanced Mode — Four-Up MPR + 3D vs single-stack"],
          ["H / F1", "This help"],
        ].map(([k, d]) =>
          `<tr><td style="padding:3px 14px 3px 0;color:#9fd0b3;white-space:nowrap;font-weight:600;">${k}</td>` +
          `<td style="padding:3px 0;color:#9fb3d0;">${d}</td></tr>`
        ).join("")
      }
        </table>
        <p style="color:#9fb3d0;margin:14px 0 4px;">This reader implements the IHE Radiology <b>Basic Image Review (BIR)</b> profile —
        its tool set, icons and shortcuts follow the supplement (Rev 1.3 §4.16.4.2.2.5.13).</p>
        <p style="margin:0 0 4px;"><a id="bir-docs-link" href="https://profiles.ihe.net/RAD/" target="_blank" rel="noopener"
          style="color:#6cc4ff;">IHE Radiology profiles (Basic Image Review) →</a></p>
        <p style="margin:0;"><a href="https://www.ihe.net/uploadedFiles/Documents/Radiology/IHE_RAD_Suppl_BIR_Rev1.3_TI_2016_09-09.pdf" target="_blank" rel="noopener"
          style="color:#6cc4ff;">BIR Technical Framework Supplement (PDF) →</a></p>
        <button id="bir-help-close" style="margin-top:14px;font:600 12px -apple-system,system-ui,sans-serif;
          color:#d6e2f2;background:#1b2740;border:1px solid #33507e;border-radius:4px;padding:5px 14px;cursor:pointer;">Close</button>
      </div>`;
    document.body.appendChild(h);
    h.querySelector("#bir-help-close")!.addEventListener("click", () => h.remove());
    h.addEventListener("click", (e) => {
      if (e.target === h) h.remove();
    });
  };

  // ---- keyboard shortcuts (case-insensitive per spec) -------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if (!document.body.contains(cfg.overlay)) return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(t?.tagName ?? "")) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map: Record<string, () => void> = {
      s: () => setTool("scroll"),
      w: () => setTool("wl"),
      z: () => setTool("zoom"),
      t: () => setTool("pan"),
      v: () => setTool("select"),
      d: () => setTool("distance"),
      a: () => setTool("angle"),
      j: () => setTool("crosshair"),
      o: () => buttons.get("localizer")!.click(),
      i: () => buttons.get("annotation")!.click(),
      c: () => cineToggle(),
      p: () => printViewport(),
      h: () => showHelp(),
      F1: () => showHelp(),
      F10: () => buttons.get("advanced")!.click(),
      Escape: () => reset(),
      ArrowLeft: () => stepSelected(false),
      ArrowUp: () => stepSelected(false),
      ArrowRight: () => stepSelected(true),
      ArrowDown: () => stepSelected(true),
      PageUp: () => cfg.nav?.prevSeries?.(),
      PageDown: () => cfg.nav?.nextSeries?.(),
    };
    const fn = map[k];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };
  document.addEventListener("keydown", onKey);

  // ---- modal-tool click capture (via SlicerLive slice-control hooks) ----------------------
  const hooks = (p: Plane) => ({
    onLeftGrab: (u: number, v: number, w: number, h: number): boolean => {
      if (tool === "select") return true; // selection happened on pointerdown; consume
      if (tool === "crosshair") {
        crossRas = rasOfClick(p, u, v, w, h);
        cfg.jumpAll(crossRas);
        redrawOverlays();
        return true;
      }
      if (tool === "distance" || tool === "angle") {
        const ras = rasOfClick(p, u, v, w, h);
        if (!pending || pending.plane !== p) {
          pending = { kind: tool, plane: p, mm: cfg.offsetMm(p), pts: [ras] };
        } else {
          pending.pts.push(ras);
          const needed = tool === "distance" ? 2 : 4;
          if (pending.pts.length >= needed) {
            measurements.push(pending);
            pending = null;
          }
        }
        drawOverlay(p);
        return true;
      }
      return false; // scroll/wl/zoom/pan → slice-control leftMode handles the drag
    },
  });

  resizeOverlays();

  return {
    tool: () => tool,
    setTool,
    measureCount: () => measurements.length,
    leftMode: () => (tool === "wl" || tool === "zoom" || tool === "pan" ? tool : "scroll"),
    hooks,
    drawOverlay,
    resize: () => {
      resizeOverlays();
      redrawOverlays();
    },
    selected: () => selectedPlane,
    setLayout,
    reset,
    detachKeys: () => {
      document.removeEventListener("keydown", onKey);
      cineStop();
    },
  };
}
