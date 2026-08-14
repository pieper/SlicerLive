// ReMINDer compare viewer — the drilldown from the ReMINDer dashboard.
//
// One ROW per acquisition in a ReMIND case, ordered along the surgical timeline, x
// selectable {axial, sagittal, coronal, 3D} COLUMNS. Rows are toggleable because they
// are expensive: the pixels come straight from IDC's public bucket (a single ultrasound
// object is up to 197 MB), so a row loads on demand and frees its GPU objects when
// switched off. The timeline strip along the bottom is the row switchboard.
//
// Everything is linked in PATIENT SPACE, not in voxels — see remind-compare-scene.ts.
// Scroll any slice and every row follows to the same RAS plane; pan/zoom moves all rows
// through one shared field of view; one camera drives every 3D cell; shift+move puts the
// crosshair at the same anatomical point in all of them. That is what makes brain shift
// legible: the same coordinate, before the dura opens and after the resection.
//
//   ?case=ReMIND-001            which case (default: the first in the index)
//   ?rows=all|none|<uuid,…>     which rows start loaded (default: a small representative set)
//   ?maxdim=224&maxvox=8000000  resample caps for the delivered volumes
import { initDevice } from "../../render/device.ts";
import type { Orientation } from "../../render/slice-renderer.ts";
import { attachCameraControls, framedCamera } from "../../render/demos/camera-control.ts";
import { attachSliceControls } from "../../render/demos/slice-control.ts";
import { attachDoubleClick } from "../../render/demos/view-grid.ts";
import { createCrosshair, drawCross, rasToScreen3D } from "../../render/demos/crosshair.ts";
import { installChrome, type VizControl } from "../../render/demos/sl-chrome.ts";
import { installIdcInfo } from "../../render/demos/idc-info.ts";
import { ohifViewerURL } from "../../render/vendor/idc_tools/s3.js";
import { DEFAULT_TF_POINTS, RAMP_NAMES, RAMPS, RemindScene, type Row } from "./remind-compare-scene.ts";
import {
  loadIndex, rgbCss, seriesLabel, TIMEPOINTS, type CaseEntry, type ReMINDIndex, type SeriesEntry,
} from "./remind-data.ts";
import type { Vec3 } from "../../render/mat4.ts";

const ORIENTS = ["axial", "sagittal", "coronal"] as const;
const CELLS = [...ORIENTS, "threeD"] as const;
type CellKind = typeof CELLS[number];
const PARAMS = new URLSearchParams(location.search);

const el = (id: string) => document.getElementById(id) as HTMLElement;
const status = (msg: string, err = false) => {
  const s = el("status");
  if (s) { s.textContent = msg; s.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const mb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

/** Rows the viewer SUGGESTS but never fetches on its own: the pre-op MR that carries the
 *  tumour, the ultrasound after the dura is opened, and the intra-op MR — the before →
 *  open → after story. They are marked in the strip; downloading is always a click.
 *  (`?rows=suggested` loads exactly these; `?rows=all` the whole case.) */
function suggestedRows(kase: CaseEntry): string[] {
  const pick: string[] = [];
  const tumorMR = kase.series.find((e) => e.tp === "preop" && e.segs.some((g) => g.s === "tumor"))
    ?? kase.series.find((e) => e.tp === "preop");
  const us = kase.series.find((e) => e.tp === "post_dura") ?? kase.series.find((e) => e.m === "US");
  const intra = kase.series.find((e) => e.tp === "intraop" && e.segs.length)
    ?? kase.series.find((e) => e.tp === "intraop");
  for (const e of [tumorMR, us, intra]) if (e) pick.push(e.u);
  return pick;
}

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) {
    status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true);
    return;
  }
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  status("loading collection index…");
  const index: ReMINDIndex = await loadIndex(PARAMS.get("index") ?? "remind-index.json");
  const pid = PARAMS.get("case") ?? index.cases[0].pid;
  const kase = index.cases.find((c) => c.pid === pid);
  if (!kase) { status(`case ${pid} is not in the index`, true); return; }

  const sc = new RemindScene(gpu, srgb, kase, {
    maxDim: Number(PARAMS.get("maxdim")) || undefined,
    maxVoxels: Number(PARAMS.get("maxvox")) || undefined,
    onRowChange: (row) => { syncRowChrome(row); requestDraw(); },
    onRedraw: () => requestDraw(),
  });

  // ── per-row DOM (built once for every series; cells appear when the row loads) ──
  const rowsEl = el("rows");
  const cv = new Map<string, HTMLCanvasElement>();
  const cx = new Map<string, GPUCanvasContext>();
  const overlays = new Map<string, { c: HTMLCanvasElement; g: CanvasRenderingContext2D }>();
  const rowEls = new Map<string, { root: HTMLElement; label: HTMLElement }>();
  const cellId = (row: Row, c: CellKind) => `${row.key}|${c}`;

  for (const row of sc.rows) {
    const root = document.createElement("div");
    root.className = "mrow";
    root.dataset.key = row.key;
    const tp = TIMEPOINTS[row.entry.tp];
    root.style.setProperty("--accent", rgbCss(tp.color));

    const label = document.createElement("div");
    label.className = "mlabel";
    label.title = "click to load / unload this series";
    label.addEventListener("click", () => toggleRow(row.key));
    root.appendChild(label);

    for (const c of CELLS) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.cell = c;
      const canvas = document.createElement("canvas");
      const id = cellId(row, c);
      canvas.id = "c-" + id;
      cell.appendChild(canvas);
      const lab = document.createElement("div");
      lab.className = "lab";
      lab.textContent = c === "threeD" ? "3D" : c[0].toUpperCase() + c.slice(1);
      cell.appendChild(lab);
      const ov = document.createElement("canvas");
      ov.className = "xh";
      cell.appendChild(ov);
      root.appendChild(cell);
      cv.set(id, canvas);
      overlays.set(id, { c: ov, g: ov.getContext("2d")! });
    }
    rowsEl.appendChild(root);
    rowEls.set(row.key, { root, label });
  }

  const configureCanvas = (id: string) => {
    if (cx.has(id)) return;
    const ctx = cv.get(id)!.getContext("webgpu") as GPUCanvasContext;
    ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    cx.set(id, ctx);
  };
  const configure = (row: Row) => { for (const c of CELLS) configureCanvas(cellId(row, c)); };

  // ── the COMPARE row: two loaded series stacked in one cell ─────────────────
  // CompareVolumes' rock / fade / toggle, done the honest cheap way: A and B are drawn to
  // two STACKED canvases (both already render the same patient-space frame, so they are
  // pixel-registered by construction) and the blend is B's alpha. Nothing in the slice or
  // volume shaders has to learn about a second volume, and — because both canvases keep
  // their last render — rocking animates by touching one opacity per frame, with no
  // re-render and no GPU work at all between view changes.
  const CMP = "cmp";
  const cmpRoot = document.createElement("div");
  cmpRoot.className = "mrow compare";
  cmpRoot.hidden = true;
  const cmpLabel = document.createElement("div");
  cmpLabel.className = "mlabel";
  cmpRoot.appendChild(cmpLabel);
  for (const c of CELLS) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.cell = c;
    for (const side of ["a", "b"] as const) {
      const canvas = document.createElement("canvas");
      canvas.id = `c-${CMP}|${c}|${side}`;
      canvas.className = side === "b" ? "bside" : "aside";
      cell.appendChild(canvas);
      cv.set(`${CMP}|${c}|${side}`, canvas);
    }
    const lab = document.createElement("div");
    lab.className = "lab";
    lab.textContent = c === "threeD" ? "3D" : c[0].toUpperCase() + c.slice(1);
    cell.appendChild(lab);
    const ov = document.createElement("canvas");
    ov.className = "xh";
    cell.appendChild(ov);
    overlays.set(`${CMP}|${c}`, { c: ov, g: ov.getContext("2d")! });
    cmpRoot.appendChild(cell);
  }
  rowsEl.appendChild(cmpRoot);

  type CmpMode = "off" | "fade" | "rock" | "toggle";
  let cmpA: string | null = null, cmpB: string | null = null;
  let cmpMode: CmpMode = "off";
  let blend = 0.5;                       // 0 = A, 1 = B
  const ROCK_MS = 1600;
  const rowA = () => (cmpA ? sc.row(cmpA) : undefined);
  const rowB = () => (cmpB ? sc.row(cmpB) : undefined);
  const cmpLive = () => cmpMode !== "off" && rowA()?.state === "ready" && rowB()?.state === "ready";

  /** The blend is pure CSS alpha on the B canvases — no GPU work, so rock is free. */
  const applyBlend = () => {
    for (const c of CELLS) {
      const b = cv.get(`${CMP}|${c}|b`);
      if (b) b.style.opacity = String(blend);
    }
    const fade = el("cmp-fade") as HTMLInputElement | null;
    if (fade && document.activeElement !== fade) fade.value = String(Math.round(blend * 100));
    const a = rowA(), bb = rowB();
    if (a && bb) {
      cmpLabel.innerHTML =
        `<div class="tp">COMPARE</div>` +
        `<div class="seq">${seriesLabel(a.entry)}</div>` +
        `<div class="det" style="color:${rgbCss(TIMEPOINTS[a.entry.tp].color)}">${TIMEPOINTS[a.entry.tp].short}</div>` +
        `<div class="cmpbar"><i style="width:${Math.round(blend * 100)}%"></i></div>` +
        `<div class="det" style="color:${rgbCss(TIMEPOINTS[bb.entry.tp].color)}">${TIMEPOINTS[bb.entry.tp].short}</div>` +
        `<div class="seq">${seriesLabel(bb.entry)}</div>`;
    }
  };

  // rock/toggle animate the blend only; the two canvases keep their last render.
  let animRaf = 0, animT0 = 0;
  const animate = (t: number) => {
    if (!cmpLive() || (cmpMode !== "rock" && cmpMode !== "toggle")) { animRaf = 0; return; }
    if (!animT0) animT0 = t;
    const phase = ((t - animT0) % ROCK_MS) / ROCK_MS;
    blend = cmpMode === "rock" ? (1 - Math.cos(phase * 2 * Math.PI)) / 2 : (phase < 0.5 ? 0 : 1);
    applyBlend();
    animRaf = requestAnimationFrame(animate);
  };
  const syncAnim = () => {
    const want = cmpLive() && (cmpMode === "rock" || cmpMode === "toggle");
    if (want && !animRaf) { animT0 = 0; animRaf = requestAnimationFrame(animate); }
    if (!want && animRaf) { cancelAnimationFrame(animRaf); animRaf = 0; }
  };

  // ── linked patient-space view state ────────────────────────────────────────
  let focus: Vec3 = [0, 0, 0];          // the RAS point every row's slices pass through
  let viewCenter: Vec3 = [0, 0, 0];     // in-plane centre of the shared frame
  let fovMm = 200;                      // shared field of view (zoom)
  let framed = false;                   // set once the first row lands
  const camera = framedCamera([0, 0, 0], 100);
  const shown: Record<CellKind, boolean> = { axial: true, sagittal: true, coronal: true, threeD: true };

  const frameToBounds = () => {
    const b = sc.bounds();
    if (!b) return;
    // Frame on the SMALLEST loaded row (an ultrasound block, when one is loaded): the
    // interesting anatomy is where the surgeon was looking, not the whole head.
    const ready = sc.readyRows();
    let best = ready[0];
    for (const r of ready) if ((r.radius ?? Infinity) < (best.radius ?? Infinity)) best = r;
    focus = [...(best.center ?? b.center)] as Vec3;
    viewCenter = [...focus] as Vec3;
    fovMm = Math.max(40, (best.radius ?? b.radius) * 2.4);
    camera.focalPoint = [...b.center] as Vec3;
    const dist = b.radius * 2.6;
    camera.position = [b.center[0], b.center[1] - dist, b.center[2]];
    camera.viewUp = [0, 0, 1];
    framed = true;
  };

  const applyFrames = () => {
    for (const o of ORIENTS) sc.applyFrame(o, viewCenter, fovMm);
  };

  // ── slice ↔ 3D coupling ────────────────────────────────────────────────────
  // The slice frame and the 3D camera describe the same thing in different units: a centre
  // in RAS and how many millimetres of patient fill the view. Keep the two expressions of
  // that in step, so zooming a slice dollies the 3D and dollying the 3D zooms the slices.
  // Orbiting is deliberately NOT coupled — it changes direction, not extent.
  let link3d = true;
  const camDist = () => Math.hypot(
    camera.focalPoint[0] - camera.position[0],
    camera.focalPoint[1] - camera.position[1],
    camera.focalPoint[2] - camera.position[2],
  );
  const fovAtDist = (d: number) => 2 * d * Math.tan((camera.viewAngle / 2) * Math.PI / 180);
  const syncCameraToFov = () => {
    if (!link3d) return;
    const d = camDist() || 1;
    const want = fovMm / (2 * Math.tan((camera.viewAngle / 2) * Math.PI / 180));
    const dir: Vec3 = [
      (camera.position[0] - camera.focalPoint[0]) / d,
      (camera.position[1] - camera.focalPoint[1]) / d,
      (camera.position[2] - camera.focalPoint[2]) / d,
    ];
    camera.focalPoint = [...viewCenter] as Vec3;
    camera.position = [
      viewCenter[0] + dir[0] * want, viewCenter[1] + dir[1] * want, viewCenter[2] + dir[2] * want,
    ];
  };
  const syncFovToCamera = () => {
    if (!link3d) return;
    viewCenter = [...camera.focalPoint] as Vec3;
    fovMm = Math.max(10, Math.min(900, fovAtDist(camDist())));
    applyFrames();
  };

  // ── drawing ────────────────────────────────────────────────────────────────
  let fast3d = false, settleTimer = 0;
  // A row's renderers can draw into ANY target — its own cell, or a compare-row canvas.
  const drawSliceTo = (row: Row, o: Orientation, id: string) => {
    const c = cv.get(id)!;
    if (!c.width || row.state !== "ready" || !shown[o]) return;
    row.slice!.setPlane(o, sc.offset01(row, o, focus));
    row.slice!.renderToView(cx.get(id)!.getCurrentTexture().createView({ format: srgb }), c.width, c.height);
  };
  const draw3dTo = (row: Row, id: string) => {
    const c = cv.get(id)!;
    if (!c.width || row.state !== "ready" || !shown.threeD) return;
    const view = cx.get(id)!.getCurrentTexture().createView({ format: srgb });
    const scene = row.scene!;
    if (fast3d) {
      const rw = Math.max(16, Math.round(c.width * 0.5)), rh = Math.max(16, Math.round(c.height * 0.5));
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, rw, rh);
      scene.renderUpscaled(view, rw, rh, c.width, c.height);
    } else {
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, c.width, c.height);
      scene.renderToView(view, c.width, c.height);
    }
  };
  const drawCompare = () => {
    if (!cmpLive()) return;
    for (const [side, row] of [["a", rowA()!], ["b", rowB()!]] as const) {
      for (const o of ORIENTS) drawSliceTo(row, o, `${CMP}|${o}|${side}`);
      draw3dTo(row, `${CMP}|threeD|${side}`);
    }
    applyBlend();
  };
  const drawAll = () => {
    for (const row of sc.readyRows()) {
      for (const o of ORIENTS) drawSliceTo(row, o, cellId(row, o));
      draw3dTo(row, cellId(row, "threeD"));
    }
    drawCompare();
    xhairRedraw();
  };
  const touch3d = () => {
    fast3d = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { fast3d = false; drawAll(); }, 350) as unknown as number;
  };
  let drawRaf = 0;
  const requestDraw = () => {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => { drawRaf = 0; drawAll(); });
  };

  // ── crosshair (shift+move, shared across every cell) ───────────────────────
  const xhair = createCrosshair(false);
  /** Draw the crosshair into one cell's 2D overlay, projected through `row`'s geometry. */
  const xhairCell = (overlayKey: string, canvasKey: string, row: Row | undefined, k: CellKind) => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const o = overlays.get(overlayKey);
    const host = cv.get(canvasKey);
    if (!o || !host) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    if (o.c.width !== Math.floor(w * dpr)) { o.c.width = Math.floor(w * dpr); o.c.height = Math.floor(h * dpr); }
    o.g.setTransform(o.c.width / w, 0, 0, o.c.height / h, 0, 0);
    o.g.clearRect(0, 0, w, h);
    if (!xhair.visible || !xhair.ras || row?.state !== "ready") return;
    if (k === "threeD") {
      const s = rasToScreen3D(camera, xhair.ras, w, h);
      if (s) drawCross(o.g, s.x * w, s.y * h);
    } else {
      const pr = row.slice!.rasToView(k, sc.offset01(row, k, focus), xhair.ras, w / h);
      if (pr.u >= 0 && pr.u <= 1 && pr.v >= 0 && pr.v <= 1) drawCross(o.g, pr.u * w, pr.v * h);
    }
  };
  const xhairRedraw = () => {
    for (const row of sc.rows) {
      for (const k of CELLS) xhairCell(cellId(row, k), cellId(row, k), row, k);
    }
    for (const k of CELLS) xhairCell(`${CMP}|${k}`, `${CMP}|${k}|b`, rowA(), k);
  };
  const hideXhair = () => { if (xhair.visible) { xhair.toggle(false); xhairRedraw(); } };
  globalThis.addEventListener("keyup", (e) => { if ((e as KeyboardEvent).key === "Shift") hideXhair(); });
  globalThis.addEventListener("blur", hideXhair);

  const jumpTo = (ras: Vec3, recenter = false) => {
    focus = [...ras] as Vec3;
    if (recenter) viewCenter = [...ras] as Vec3;
    applyFrames();
    requestDraw();
  };

  // ── interaction on every cell (attached once; inert until the row is ready) ─
  const uvOf = (c: HTMLCanvasElement, e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, aspect: r.width / r.height };
  };
  const isShiftHover = (e: PointerEvent) => e.shiftKey && e.buttons === 0;

  // The gestures themselves are the shared SlicerLive ones (wheel = scroll, left-drag =
  // scroll, middle/shift+left = pan, right-drag = zoom, ctrl/⌘+wheel = zoom about the
  // cursor) — attachSliceControls owns them for every MPR demo in the repo, so ReMINDer
  // must not hand-roll a second dialect. The only thing added here is the LINKING: a
  // gesture drives the row under the cursor, and the resulting frame is then read back OUT
  // of that renderer in patient space and pushed to every other row. Read-back rather than
  // re-derivation means the plane basis and the radiological sign convention stay
  // single-sourced in SliceRenderer, and rows on different grids stay registered.
  const aspectOf = (c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 1;
  };
  /** Adopt the frame `row` was just dragged/zoomed into as the shared frame. */
  const adoptFrame = (row: Row, o: Orientation, canvas: HTMLCanvasElement) => {
    const aspect = aspectOf(canvas);
    const off = sc.offset01(row, o, focus);
    viewCenter = row.slice!.viewToRas(o, off, 0.5, 0.5, aspect);       // pan folded in
    fovMm = row.slice!.spanMmFor(o) / Math.max(1e-6, row.slice!.zoom(o));
    applyFrames();                                                     // …and everyone follows
    syncCameraToFov();
  };

  for (const row of sc.rows) {
    for (const o of ORIENTS) {
      const canvas = cv.get(cellId(row, o))!;
      attachSliceControls(canvas, {
        orient: o,
        getSlice: () => row.slice!,
        step: (fwd) => {
          if (row.state !== "ready") return;
          // step by THIS row's voxel — the row under the cursor sets the increment, and
          // every other row follows to the same millimetre, not to the same slice index
          const axis = o === "axial" ? 2 : o === "coronal" ? 1 : 0;
          const f: Vec3 = [...focus] as Vec3;
          f[axis] = Math.max(row.rasLo![axis], Math.min(row.rasHi![axis], f[axis] + Math.max(0.2, row.vol!.vox) * (fwd ? 1 : -1)));
          focus = f;
        },
        redraw: () => {
          if (row.state !== "ready") return;
          adoptFrame(row, o, canvas);
          requestDraw();
        },
        hooks: { onDoubleClick: () => { toggleMax(cellId(row, o)); return true; } },
      });
      // shift+move = crosshair (grab-or-bubble: it takes precedence over the drag gestures)
      canvas.addEventListener("pointermove", (e) => {
        if (!isShiftHover(e) || row.state !== "ready") return;
        if (!xhair.visible) xhair.toggle(true);
        const { u, v, aspect } = uvOf(canvas, e);
        const ras = row.slice!.viewToRas(o, sc.offset01(row, o, focus), u, v, aspect);
        xhair.set(ras);
        jumpTo(ras);
      });
    }

    const c3 = cv.get(cellId(row, "threeD"))!;
    attachCameraControls(c3, camera, { onChange: () => { touch3d(); syncFovToCamera(); requestDraw(); } });
    attachDoubleClick(c3, () => toggleMax(cellId(row, "threeD")));
    let inFlight = false, queued: { u: number; v: number } | null = null;
    const pick = async (u: number, v: number) => {
      inFlight = true;
      const ras = await row.scene!.pick(u, v);
      inFlight = false;
      if (ras) { xhair.set(ras); jumpTo(ras); }
      if (queued) { const q = queued; queued = null; pick(q.u, q.v); }
    };
    c3.addEventListener("pointermove", (e) => {
      if (!isShiftHover(e) || row.state !== "ready") return;
      if (!xhair.visible) xhair.toggle(true);
      const { u, v } = uvOf(c3, e);
      if (inFlight) queued = { u, v }; else pick(u, v);
    });
  }


  // ── maximize one cell (double-click) ───────────────────────────────────────
  // Keyed by canvas id so it works for a series row and for the compare row alike.
  let maxed: string | null = null;
  const toggleMax = (id: string) => {
    maxed = maxed === id ? null : id;
    rowsEl.classList.toggle("maxmode", !!maxed);
    const target = maxed ? cv.get(maxed)?.parentElement : null;
    for (const cell of rowsEl.querySelectorAll(".cell")) cell.classList.toggle("max", cell === target);
    for (const r of rowsEl.querySelectorAll(".mrow")) r.classList.toggle("hasmax", !!target && r.contains(target));
    resize();
  };

  // ── row chrome: label, progress, toggle state ──────────────────────────────
  function syncRowChrome(row: Row) {
    const re = rowEls.get(row.key);
    if (!re) return;
    const e = row.entry;
    const tp = TIMEPOINTS[e.tp];
    re.root.classList.toggle("on", row.state === "ready");
    re.root.classList.toggle("loading", row.state === "loading");
    re.root.classList.toggle("failed", row.state === "error");
    const segNames = e.segs.map((g) => g.s).join(", ");
    const detail = row.state === "loading"
      ? `${row.progress.msg}`
      : row.state === "error"
      ? `failed: ${row.error}`
      : row.state === "ready"
      ? `${row.vol!.dims.join("×")} @ ${row.vol!.vox.toFixed(2)} mm`
      : `${mb(e.b)} · ${e.n} inst`;
    re.label.innerHTML =
      `<div class="tp">${tp.short}</div>` +
      `<div class="seq">${seriesLabel(e)}</div>` +
      `<div class="det">${detail}</div>` +
      (segNames ? `<div class="segs">${segNames}</div>` : "") +
      `<div class="mbar"><i style="width:${Math.round((row.state === "ready" ? 1 : row.progress.frac) * 100)}%"></i></div>`;
    // the chip in the bottom strip mirrors the same state
    const chip = el("strip").querySelector(`[data-key="${row.key}"]`);
    if (chip) {
      chip.classList.toggle("on", row.state === "ready");
      chip.classList.toggle("busy", row.state === "loading");
      chip.classList.toggle("failed", row.state === "error");
    }
  }

  // ── the timeline strip = the row switchboard ───────────────────────────────
  // Each chip states what the click will COST before it is clicked; the three chips the
  // viewer would have picked for you are marked "suggested" rather than auto-fetched.
  const suggested = suggestedRows(kase);
  const strip = el("series");
  let stripGroup = "";
  for (const row of sc.rows) {
    const e = row.entry;
    if (e.tp !== stripGroup) {
      stripGroup = e.tp;
      const g = document.createElement("div");
      g.className = "tpgroup";
      g.style.color = rgbCss(TIMEPOINTS[e.tp].color);
      g.textContent = TIMEPOINTS[e.tp].short;
      strip.appendChild(g);
    }
    const isSugg = suggested.includes(row.key);
    const b = document.createElement("button");
    b.className = "chip series" + (isSugg ? " sugg" : "");
    b.dataset.key = row.key;
    b.style.setProperty("--accent", rgbCss(TIMEPOINTS[e.tp].color));
    b.innerHTML = `${seriesLabel(e)}<span>${mb(e.b)}</span>` +
      (e.segs.length ? `<em>${e.segs.length} seg</em>` : "");
    b.title = `${e.m} · ${e.d} · series ${e.sn} · ${e.n} instance(s)\n` +
      `click to download ${mb(e.b)} from IDC` +
      (isSugg ? " (suggested)" : "") +
      (e.segs.length ? `\nsegmentations: ${e.segs.map((g) => g.s).join(", ")}` : "");
    b.addEventListener("click", () => toggleRow(row.key));
    strip.appendChild(b);
  }

  // Empty state: say plainly that nothing has been fetched, and offer the suggested set
  // as ONE explicit click (with its price attached) rather than as a default.
  const hint = document.createElement("div");
  hint.id = "hint";
  const suggBytes = suggested.reduce((n, k) => n + (sc.row(k)?.entry.b ?? 0), 0);
  hint.innerHTML =
    `<div class="h1">Nothing downloaded yet</div>` +
    `<div class="h2">This case is ${mb(kase.bytes)} in IDC. Pick a series from the timeline below and it ` +
    `streams straight from the public bucket — one row at a time, only what you ask for.</div>` +
    `<button id="hint-sugg" class="chip">Load the suggested three · ${mb(suggBytes)}</button>`;
  rowsEl.appendChild(hint);
  el("hint-sugg").addEventListener("click", () => { for (const k of suggested) toggleRow(k); });
  const syncHint = () => {
    hint.style.display = sc.rows.some((r) => r.state !== "idle") ? "none" : "";
  };

  // ── compare controls (A ⇄ B, fade / rock / toggle) ─────────────────────────
  const selA = el("cmp-a") as HTMLSelectElement;
  const selB = el("cmp-b") as HTMLSelectElement;
  const fadeEl = el("cmp-fade") as HTMLInputElement;
  const fillSel = (sel: HTMLSelectElement, cur: string | null) => {
    const ready = sc.readyRows();
    sel.innerHTML = `<option value="">—</option>` + ready.map((r) =>
      `<option value="${r.key}"${r.key === cur ? " selected" : ""}>${TIMEPOINTS[r.entry.tp].short} · ${seriesLabel(r.entry)}</option>`).join("");
    sel.disabled = ready.length < 2;
  };
  const setMode = (m: CmpMode) => {
    cmpMode = m;
    for (const b of el("cmpbar").querySelectorAll("[data-mode]")) {
      b.classList.toggle("on", (b as HTMLElement).dataset.mode === m);
    }
    syncCompare();
  };
  function syncCompare() {
    const ready = sc.readyRows();
    // default the pair to the first two loaded rows, so turning compare on just works
    if (ready.length >= 2) {
      if (!rowA() || rowA()!.state !== "ready") cmpA = ready[0].key;
      if (!rowB() || rowB()!.state !== "ready" || cmpB === cmpA) {
        cmpB = (ready.find((r) => r.key !== cmpA) ?? ready[1]).key;
      }
    } else { cmpA = cmpA && sc.row(cmpA)?.state === "ready" ? cmpA : null; cmpB = null; }
    fillSel(selA, cmpA);
    fillSel(selB, cmpB);
    const live = cmpLive();
    cmpRoot.hidden = !live;
    el("cmpbar").classList.toggle("dim", ready.length < 2);
    el("cmp-note").textContent = ready.length < 2
      ? "load two series to compare them"
      : cmpMode === "off" ? "" : `${Math.round((1 - blend) * 100)}% / ${Math.round(blend * 100)}%`;
    if (live) for (const c of CELLS) for (const s of ["a", "b"]) configureCanvas(`${CMP}|${c}|${s}`);
    syncAnim();
    resize();
  }
  selA.addEventListener("change", () => { cmpA = selA.value || null; syncCompare(); });
  selB.addEventListener("change", () => { cmpB = selB.value || null; syncCompare(); });
  fadeEl.addEventListener("input", () => {
    blend = Number(fadeEl.value) / 100;
    if (cmpMode === "off") setMode("fade"); else if (cmpMode !== "fade") setMode("fade");
    applyBlend();
    el("cmp-note").textContent = `${Math.round((1 - blend) * 100)}% / ${Math.round(blend * 100)}%`;
  });
  for (const b of el("cmpbar").querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => setMode((b as HTMLElement).dataset.mode as CmpMode));
  }
  // swap A/B — the fastest way to answer "which one am I looking at?"
  el("cmp-swap").addEventListener("click", () => {
    const t = cmpA; cmpA = cmpB; cmpB = t;
    blend = 1 - blend;
    syncCompare();
    requestDraw();
  });

  // the compare cells take the same gestures, with A as the leader
  for (const o of ORIENTS) {
    const canvas = cv.get(`${CMP}|${o}|b`)!;      // B sits on top → it receives the events
    attachSliceControls(canvas, {
      orient: o,
      getSlice: () => (rowA() ?? sc.readyRows()[0])!.slice!,
      step: (fwd) => {
        const r = rowA();
        if (!r || r.state !== "ready") return;
        const axis = o === "axial" ? 2 : o === "coronal" ? 1 : 0;
        const f: Vec3 = [...focus] as Vec3;
        f[axis] = Math.max(r.rasLo![axis], Math.min(r.rasHi![axis], f[axis] + Math.max(0.2, r.vol!.vox) * (fwd ? 1 : -1)));
        focus = f;
      },
      redraw: () => {
        const r = rowA();
        if (r?.state === "ready") adoptFrame(r, o, canvas);
        requestDraw();
      },
      hooks: { onDoubleClick: () => { toggleMax(`${CMP}|${o}|b`); return true; } },
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = rowA();
      if (!isShiftHover(e) || r?.state !== "ready") return;
      if (!xhair.visible) xhair.toggle(true);
      const { u, v, aspect } = uvOf(canvas, e);
      const ras = r.slice!.viewToRas(o, sc.offset01(r, o, focus), u, v, aspect);
      xhair.set(ras);
      jumpTo(ras);
    });
  }
  attachCameraControls(cv.get(`${CMP}|threeD|b`)!, camera, {
    onChange: () => { touch3d(); syncFovToCamera(); requestDraw(); },
  });
  attachDoubleClick(cv.get(`${CMP}|threeD|b`)!, () => toggleMax(`${CMP}|threeD|b`));

  async function toggleRow(key: string) {
    const row = sc.row(key)!;
    if (row.state === "ready") {
      sc.releaseRow(key);
      syncRowChrome(row);
      syncCompare();                 // a released row must not stay selected as A or B
      return;
    }
    if (row.state === "loading") return;
    configure(row);
    syncRowChrome(row);
    resize();
    const loaded = await sc.ensureRow(key);
    if (!framed && loaded.state === "ready") frameToBounds();
    applyFrames();
    syncRowChrome(row);
    syncCompare();
    renderTF();
    status(statusLine());
  }

  const statusLine = () => {
    const ready = sc.readyRows().length;
    const loading = sc.rows.filter((r) => r.state === "loading").length;
    return `${kase.pid} — ${ready}/${sc.rows.length} series loaded` + (loading ? `, ${loading} loading…` : "");
  };

  // ── column chips ───────────────────────────────────────────────────────────
  const applyColumns = () => {
    for (const row of sc.rows) {
      for (const c of CELLS) cv.get(cellId(row, c))!.parentElement!.classList.toggle("hidden", !shown[c]);
    }
    for (const c of CELLS) cv.get(`${CMP}|${c}|b`)!.parentElement!.classList.toggle("hidden", !shown[c]);
    resize();
  };
  for (const c of CELLS) {
    const b = el(`col-${c}`);
    b?.addEventListener("click", () => { shown[c] = !shown[c]; b.classList.toggle("on", shown[c]); applyColumns(); });
  }

  // ── header info, case picker, IDC details ──────────────────────────────────
  const tpCount = new Map<string, number>();
  for (const e of kase.series) tpCount.set(e.tp, (tpCount.get(e.tp) ?? 0) + 1);
  el("info").innerHTML =
    `<b>${kase.pid}</b> · ${kase.series.length} series · ` +
    `${kase.series.reduce((n, e) => n + e.segs.length, 0)} segmentations · ${mb(kase.bytes)} in IDC`;

  const caseBtn = el("case-btn") as HTMLButtonElement;
  caseBtn.textContent = `${kase.pid} ▾`;
  const panel = el("case-panel"), listEl = el("case-list");
  const search = el("case-search") as HTMLInputElement;
  const renderList = (filter = "") => {
    const f = filter.trim().toLowerCase();
    listEl.innerHTML = "";
    for (const c of index.cases) {
      if (f && !c.pid.toLowerCase().includes(f)) continue;
      const segs = c.series.reduce((n, e) => n + e.segs.length, 0);
      const us = c.series.filter((e) => e.m === "US").length;
      const b = document.createElement("button");
      b.className = "crow" + (c.pid === kase.pid ? " cur" : "");
      b.innerHTML = `<span class="pid">${c.pid}</span>` +
        `<span class="st">${c.series.length} ser · ${us} US · ${segs} seg · ${mb(c.bytes)}</span>`;
      b.addEventListener("click", () => { location.search = `?case=${c.pid}`; });
      listEl.appendChild(b);
    }
  };
  const togglePanel = (show?: boolean) => {
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on) { renderList(search.value); search.focus(); }
  };
  caseBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });
  search.addEventListener("input", () => renderList(search.value));
  document.addEventListener("click", (e) => { if (!panel.hidden && !panel.contains(e.target as Node)) togglePanel(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      togglePanel(false);
      const top = globalThis as unknown as Window;         // embedded in the dashboard's drilldown modal
      if (top.parent !== top) top.parent.postMessage({ type: "closeDrill" }, "*");
    }
  });

  installIdcInfo(el("hdr-right"), {
    getEntry: () => {
      const first = sc.readyRows()[0]?.entry ?? kase.series[0];
      return {
        c: first.u, m: first.m, col: index.collection, st: first.st, sd: first.d,
        pid: kase.pid, idoi: index.source.doi, lic: "CC BY 4.0",
      } as never;
    },
    getSegments: () => sc.readyRows().flatMap((r) => r.segs.map((s) => ({ name: s.structure, color: s.color }))),
    ohifURL: (st: string) => ohifViewerURL(st) ?? "",
  });

  const controls: VizControl[] = [
    { label: "Volume (3D)", getOpacity: () => sc.volumeOpacity(), setOpacity: (o) => { sc.setVolumeOpacity(o); requestDraw(); }, color: [0.75, 0.78, 0.85] },
    { label: "Segment shells (3D)", getOpacity: () => shellOp, setOpacity: (o) => { shellOp = o; sc.setShellOpacity(o); requestDraw(); }, color: [0.95, 0.35, 0.4] },
    { label: "Segment fill (2D)", getOpacity: () => sc.overlayOpacity(), setOpacity: (o) => { sc.setOverlayOpacity(o); requestDraw(); }, color: [0.95, 0.55, 0.3] },
  ];
  let shellOp = 1;
  installChrome({ controls });

  // ── transfer-function editor ───────────────────────────────────────────────
  // Per row, because the rows are not comparable in scalar units (raw MR next to 8-bit US).
  // The histogram is the row's own; the curve is the row's opacity control points; dragging
  // a handle rewrites 256 LUT entries in place, so it is interactive with no rebuild.
  const tfSel = el("tf-row") as HTMLSelectElement;
  const tfRamp = el("tf-ramp") as HTMLSelectElement;
  const tfCanvas = el("tf-curve") as HTMLCanvasElement;
  const tfWin = el("tf-win") as HTMLInputElement;
  const tfLev = el("tf-lev") as HTMLInputElement;
  const tfg = tfCanvas.getContext("2d")!;
  let tfKey: string | null = null;
  const tfRow = () => (tfKey ? sc.row(tfKey) : undefined);

  tfRamp.innerHTML = RAMP_NAMES.map((n) => `<option value="${n}">${n}</option>`).join("");

  const drawTFCurve = () => {
    const row = tfRow();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = tfCanvas.clientWidth || 260, h = tfCanvas.clientHeight || 96;
    if (tfCanvas.width !== Math.floor(w * dpr)) { tfCanvas.width = Math.floor(w * dpr); tfCanvas.height = Math.floor(h * dpr); }
    tfg.setTransform(tfCanvas.width / w, 0, 0, tfCanvas.height / h, 0, 0);
    tfg.clearRect(0, 0, w, h);
    if (!row || row.state !== "ready") return;
    const hist = sc.histogram(row.key)!;
    // histogram first, recessive — it is context for the curve, not the subject
    tfg.fillStyle = "rgba(159,179,208,.28)";
    const bw = w / hist.length;
    for (let i = 0; i < hist.length; i++) tfg.fillRect(i * bw, h - hist[i] * h, Math.max(1, bw - 0.5), hist[i] * h);
    // the ramp itself, as a strip along the bottom
    const ramp = RAMPS[row.tf!.ramp] ?? RAMPS.grey;
    for (let x = 0; x < w; x++) {
      const t = x / w;
      let c = ramp[0];
      for (let i = 1; i < ramp.length; i++) {
        if (t <= ramp[i][0]) {
          const a = ramp[i - 1], b = ramp[i], u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
          c = [t, a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2]), a[3] + u * (b[3] - a[3])];
          break;
        }
        c = ramp[i];
      }
      tfg.fillStyle = `rgb(${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.round(c[3] * 255)})`;
      tfg.fillRect(x, h - 6, 1, 6);
    }
    const pts = row.tf!.points;
    tfg.strokeStyle = "#f0d24a";
    tfg.lineWidth = 2;
    tfg.beginPath();
    pts.forEach(([t, a], i) => (i ? tfg.lineTo(t * w, (1 - a) * h) : tfg.moveTo(t * w, (1 - a) * h)));
    tfg.stroke();
    tfg.fillStyle = "#f0d24a";
    for (const [t, a] of pts) {
      tfg.beginPath();
      tfg.arc(t * w, (1 - a) * h, 4, 0, Math.PI * 2);
      tfg.fill();
    }
  };

  const renderTF = () => {
    const ready = sc.readyRows();
    tfSel.innerHTML = ready.map((r) =>
      `<option value="${r.key}"${r.key === tfKey ? " selected" : ""}>${TIMEPOINTS[r.entry.tp].short} · ${seriesLabel(r.entry)}</option>`).join("");
    if (!tfRow() || tfRow()!.state !== "ready") tfKey = ready[0]?.key ?? null;
    tfSel.value = tfKey ?? "";
    const row = tfRow();
    el("tf-panel").classList.toggle("dim", !row);
    if (row?.state === "ready") {
      tfRamp.value = row.tf!.ramp;
      tfWin.value = String(row.win!.toFixed(3));
      tfLev.value = String(row.lev!.toFixed(3));
      el("tf-wl").textContent = `W ${row.win!.toFixed(0)} · L ${row.lev!.toFixed(0)}`;
    }
    drawTFCurve();
  };

  tfSel.addEventListener("change", () => { tfKey = tfSel.value || null; renderTF(); });
  tfRamp.addEventListener("change", () => {
    if (!tfKey) return;
    sc.setRowTF(tfKey, { ramp: tfRamp.value });
    drawTFCurve();
    requestDraw();
  });
  const wlInput = () => {
    const row = tfRow();
    if (!row) return;
    // sliders are relative to the AUTO window the loader derived, so one control works for
    // raw MR units and 8-bit ultrasound alike
    const base = row.vol!;
    const win = base.win * Math.pow(4, Number(tfWin.value));      // ×1/4 … ×4
    const lev = base.lev + base.win * Number(tfLev.value);        // ±1 window
    sc.setRowWindowLevel(row.key, win, lev);
    row.hist = undefined;                                          // window moved → rebin
    el("tf-wl").textContent = `W ${win.toFixed(0)} · L ${lev.toFixed(0)}`;
    drawTFCurve();
    requestDraw();
  };
  tfWin.addEventListener("input", wlInput);
  tfLev.addEventListener("input", wlInput);
  el("tf-reset").addEventListener("click", () => {
    const row = tfRow();
    if (!row) return;
    tfWin.value = "0"; tfLev.value = "0";
    sc.setRowWindowLevel(row.key, row.vol!.win, row.vol!.lev);
    row.hist = undefined;
    sc.setRowTF(row.key, { points: [...DEFAULT_TF_POINTS], ramp: row.entry.m === "US" ? "amber" : "grey" });
    renderTF();
    requestDraw();
  });

  // drag a control point; click empty space to add one; alt/right-click a point to remove it
  let dragPt = -1;
  const tfAt = (e: PointerEvent) => {
    const r = tfCanvas.getBoundingClientRect();
    return { t: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), a: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)), r };
  };
  const nearest = (t: number, a: number, r: DOMRect) => {
    const pts = tfRow()?.tf?.points ?? [];
    let best = -1, bd = 1e9;
    pts.forEach(([pt, pa], i) => {
      const d = Math.hypot((pt - t) * r.width, (pa - a) * r.height);
      if (d < bd) { bd = d; best = i; }
    });
    return bd < 12 ? best : -1;
  };
  tfCanvas.addEventListener("contextmenu", (e) => e.preventDefault());
  tfCanvas.addEventListener("pointerdown", (e) => {
    const row = tfRow();
    if (!row || row.state !== "ready") return;
    const { t, a, r } = tfAt(e);
    const hit = nearest(t, a, r);
    const pts = row.tf!.points;
    if ((e.button === 2 || e.altKey) && hit >= 0 && pts.length > 2) {
      pts.splice(hit, 1);
      sc.setRowTF(row.key, { points: pts });
      drawTFCurve(); requestDraw();
      return;
    }
    if (hit >= 0) dragPt = hit;
    else {
      const i = pts.findIndex(([pt]) => pt > t);
      const at = i < 0 ? pts.length : i;
      pts.splice(at, 0, [t, a]);
      dragPt = at;
      sc.setRowTF(row.key, { points: pts });
    }
    tfCanvas.setPointerCapture(e.pointerId);
    drawTFCurve(); requestDraw();
  });
  tfCanvas.addEventListener("pointermove", (e) => {
    const row = tfRow();
    if (dragPt < 0 || !row) return;
    const { t, a } = tfAt(e);
    const pts = row.tf!.points;
    const lo = dragPt > 0 ? pts[dragPt - 1][0] : 0, hi = dragPt < pts.length - 1 ? pts[dragPt + 1][0] : 1;
    pts[dragPt] = [Math.max(lo, Math.min(hi, t)), a];
    sc.setRowTF(row.key, { points: pts });
    drawTFCurve(); requestDraw();
  });
  const endDrag = () => { dragPt = -1; };
  tfCanvas.addEventListener("pointerup", endDrag);
  tfCanvas.addEventListener("pointercancel", endDrag);

  const tfBtn = el("tf-btn");
  tfBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const p = el("tf-panel");
    p.hidden = !p.hidden;
    if (!p.hidden) renderTF();
  });

  // ── "jump to" buttons for the segmented structures ─────────────────────────
  const jumps = el("jumps");
  const renderJumps = () => {
    jumps.innerHTML = "";
    const seen = new Set<string>();
    for (const row of sc.readyRows()) {
      for (const s of row.segs) {
        if (!s.centroid || seen.has(s.structure + row.key)) continue;
        seen.add(s.structure + row.key);
        const b = document.createElement("button");
        b.className = "chip jump";
        b.style.setProperty("--accent", rgbCss(s.color));
        b.textContent = `${s.structure} · ${TIMEPOINTS[row.entry.tp].short}`;
        b.title = `${s.voxels.toLocaleString()} voxels — centre every view on it`;
        b.addEventListener("click", () => jumpTo(s.centroid!, true));
        jumps.appendChild(b);
      }
    }
  };

  // ── resize ─────────────────────────────────────────────────────────────────
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const fit = (canvas: HTMLCanvasElement) => {
      const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
    };
    for (const row of sc.rows) {
      rowEls.get(row.key)!.root.classList.toggle("empty", row.state === "idle");
      for (const c of CELLS) fit(cv.get(cellId(row, c))!);
    }
    for (const c of CELLS) for (const s of ["a", "b"]) fit(cv.get(`${CMP}|${c}|${s}`)!);
    syncHint();
    renderJumps();
    requestDraw();
  };
  globalThis.addEventListener("resize", resize);

  // ── go ─────────────────────────────────────────────────────────────────────
  for (const row of sc.rows) syncRowChrome(row);
  applyColumns();
  syncCompare();
  renderTF();
  el("col-link").addEventListener("click", () => {
    link3d = !link3d;
    el("col-link").classList.toggle("on", link3d);
    if (link3d) syncCameraToFov();
    requestDraw();
  });
  document.addEventListener("click", (e) => {
    const p = el("tf-panel");
    if (!p.hidden && !p.contains(e.target as Node) && e.target !== tfBtn) p.hidden = true;
  });
  // NOTHING is fetched until the user asks for it. A ReMIND case is 200–780 MB in IDC and
  // every row is a separate multi-hundred-megabyte download, so opening the page must cost
  // the index and nothing else. The strip below is the switchboard; ?rows= overrides it.
  const want = PARAMS.get("rows");
  const startKeys = want === "all"
    ? sc.rows.map((r) => r.key)
    : want === "suggested"
    ? suggested
    : want && want !== "none"
    ? want.split(",").filter((k) => sc.row(k))
    : [];
  status(startKeys.length
    ? `${kase.pid} — loading ${startKeys.length} series from IDC…`
    : `${kase.pid} — nothing downloaded yet`);
  for (const k of startKeys) toggleRow(k);          // concurrency-limited inside the loader

  // introspection for the automated test driver (numeric ground truth over screenshots)
  (globalThis as unknown as { __remindDbg: unknown }).__remindDbg = {
    ready: () => sc.readyRows().length,
    pid: () => kase.pid,
    rows: () => sc.rows.map((r) => ({
      key: r.key, tp: r.entry.tp, desc: r.entry.d, m: r.entry.m, state: r.state, error: r.error,
      dims: r.vol?.dims, vox: r.vol?.vox, win: r.vol?.win, lev: r.vol?.lev,
      ijkToRAS: r.vol?.ijkToRAS, rasLo: r.rasLo, rasHi: r.rasHi,
      nSegs: r.entry.segs.length,                    // SEG series in the index (known before loading)
      segs: r.segs.map((s) => ({ structure: s.structure, voxels: s.voxels, centroid: s.centroid })),
    })),
    focus: () => [...focus],
    viewCenter: () => [...viewCenter],
    fov: () => fovMm,
    offsets: () => sc.readyRows().map((r) => ({
      key: r.key,
      off: Object.fromEntries(ORIENTS.map((o) => [o, sc.offset01(r, o, focus)])),
    })),
    camera: () => ({
      position: [...camera.position], focalPoint: [...camera.focalPoint],
      dist: camDist(), viewAngle: camera.viewAngle, fovAtFocus: fovAtDist(camDist()),
    }),
    jumpTo: (ras: Vec3) => jumpTo(ras, true),
    toggleRow: (k: string) => toggleRow(k),
    setColumn: (c: CellKind, on: boolean) => { shown[c] = on; el(`col-${c}`)?.classList.toggle("on", on); applyColumns(); },
    // linked navigation + compare + TF, for the driver to exercise without synthetic input
    zoomSlice: (o: Orientation, factor: number) => {
      const r = sc.readyRows()[0];
      if (!r) return;
      const c = cv.get(cellId(r, o))!;
      r.slice!.zoomAbout(o, factor, 0.5, 0.5, c.clientWidth, c.clientHeight);
      adoptFrame(r, o, c);
      requestDraw();
    },
    link3d: () => link3d,
    setLink3d: (on: boolean) => { link3d = on; el("col-link")?.classList.toggle("on", on); },
    compare: () => ({ mode: cmpMode, a: cmpA, b: cmpB, blend, live: cmpLive(), hidden: cmpRoot.hidden }),
    setCompare: (a: string | null, b: string | null, mode: CmpMode) => {
      cmpA = a; cmpB = b; setMode(mode); return { a: cmpA, b: cmpB, mode: cmpMode, live: cmpLive() };
    },
    setBlend: (v: number) => { blend = v; applyBlend(); },
    tf: (k?: string) => {
      const r = k ? sc.row(k) : tfRow();
      return r?.state === "ready" ? { key: r.key, ramp: r.tf!.ramp, points: r.tf!.points, win: r.win, lev: r.lev } : null;
    },
    setTF: (k: string, patch: { ramp?: string; points?: [number, number][] }) => { sc.setRowTF(k, patch); requestDraw(); },
    setWindowLevel: (k: string, win: number, lev: number) => { sc.setRowWindowLevel(k, win, lev); requestDraw(); },
    lutAlphaAt: (k: string, t: number) => {
      const r = sc.row(k);
      if (r?.state !== "ready") return null;
      // read the TF the way the LUT builder does, so a test can assert the curve took effect
      const pts = r.tf!.points;
      if (t <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const [t0, a0] = pts[i - 1], [t1, a1] = pts[i];
          return a0 + (a1 - a0) * (t - t0) / Math.max(1e-9, t1 - t0);
        }
      }
      return pts[pts.length - 1][1];
    },
  };
}

main().catch((e) => status("error: " + ((e as Error)?.message ?? e), true));
