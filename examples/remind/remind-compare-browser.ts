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
import { attachDoubleClick } from "../../render/demos/view-grid.ts";
import { createCrosshair, drawCross, rasToScreen3D } from "../../render/demos/crosshair.ts";
import { installChrome, type VizControl } from "../../render/demos/sl-chrome.ts";
import { installIdcInfo } from "../../render/demos/idc-info.ts";
import { ohifViewerURL } from "../../render/vendor/idc_tools/s3.js";
import { RemindScene, type Row } from "./remind-compare-scene.ts";
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

/** Which rows to load up front: the pre-op MR that carries the tumour, the ultrasound
 *  after the dura is opened, and the intra-op MR. Three rows tells the ReMIND story
 *  (before → open → after) for a fraction of the ~360 MB a whole case would cost. */
function defaultRows(kase: CaseEntry): string[] {
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

  const configure = (row: Row) => {
    for (const c of CELLS) {
      const id = cellId(row, c);
      if (cx.has(id)) continue;
      const ctx = cv.get(id)!.getContext("webgpu") as GPUCanvasContext;
      ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
      cx.set(id, ctx);
    }
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

  // ── drawing ────────────────────────────────────────────────────────────────
  let fast3d = false, settleTimer = 0;
  const drawSlice = (row: Row, o: Orientation) => {
    const id = cellId(row, o);
    const c = cv.get(id)!;
    if (!c.width || row.state !== "ready" || !shown[o]) return;
    row.slice!.setPlane(o, sc.offset01(row, o, focus));
    row.slice!.renderToView(cx.get(id)!.getCurrentTexture().createView({ format: srgb }), c.width, c.height);
  };
  const draw3d = (row: Row) => {
    const id = cellId(row, "threeD");
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
  const drawAll = () => {
    for (const row of sc.readyRows()) {
      for (const o of ORIENTS) drawSlice(row, o);
      draw3d(row);
    }
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
  const xhairRedraw = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const row of sc.rows) {
      for (const k of CELLS) {
        const id = cellId(row, k);
        const o = overlays.get(id)!;
        const host = cv.get(id)!;
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) continue;
        if (o.c.width !== Math.floor(w * dpr)) { o.c.width = Math.floor(w * dpr); o.c.height = Math.floor(h * dpr); }
        o.g.setTransform(o.c.width / w, 0, 0, o.c.height / h, 0, 0);
        o.g.clearRect(0, 0, w, h);
        if (!xhair.visible || !xhair.ras || row.state !== "ready") continue;
        if (k === "threeD") {
          const s = rasToScreen3D(camera, xhair.ras, w, h);
          if (s) drawCross(o.g, s.x * w, s.y * h);
        } else {
          const pr = row.slice!.rasToView(k, sc.offset01(row, k, focus), xhair.ras, w / h);
          if (pr.u >= 0 && pr.u <= 1 && pr.v >= 0 && pr.v <= 1) drawCross(o.g, pr.u * w, pr.v * h);
        }
      }
    }
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

  for (const row of sc.rows) {
    for (const o of ORIENTS) {
      const canvas = cv.get(cellId(row, o))!;
      // scroll = step the shared RAS focus along this plane's normal, by THIS row's voxel
      // (the row under the cursor sets the step; every other row follows to the same mm).
      canvas.addEventListener("wheel", (ev) => {
        const e = ev as WheelEvent;
        if (row.state !== "ready") return;
        e.preventDefault();
        const axis = o === "axial" ? 2 : o === "coronal" ? 1 : 0;
        const step = Math.max(0.2, row.vol!.vox) * (e.deltaY > 0 ? -1 : 1);
        const f: Vec3 = [...focus] as Vec3;
        f[axis] = Math.max(row.rasLo![axis], Math.min(row.rasHi![axis], f[axis] + step));
        jumpTo(f);
      }, { passive: false });

      // drag = pan the shared frame; the conversion goes through the renderer's own basis
      // (never a re-derived one — the radiological sign convention lives in SliceRenderer).
      let dragging = false, lx = 0, ly = 0;
      canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.shiftKey || row.state !== "ready") return;
        dragging = true; lx = e.clientX; ly = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener("pointerup", (e) => { dragging = false; canvas.releasePointerCapture?.(e.pointerId); });
      canvas.addEventListener("pointermove", (e) => {
        if (row.state !== "ready") return;
        if (isShiftHover(e)) {
          if (!xhair.visible) xhair.toggle(true);
          const { u, v, aspect } = uvOf(canvas, e);
          const ras = row.slice!.viewToRas(o, sc.offset01(row, o, focus), u, v, aspect);
          xhair.set(ras);
          jumpTo(ras);
          return;
        }
        if (!dragging) return;
        const r = canvas.getBoundingClientRect();
        const off = sc.offset01(row, o, focus);
        const a = row.slice!.viewToRas(o, off, 0.5, 0.5, r.width / r.height);
        const b = row.slice!.viewToRas(o, off,
          0.5 + (e.clientX - lx) / r.width, 0.5 + (e.clientY - ly) / r.height, r.width / r.height);
        viewCenter = [viewCenter[0] - (b[0] - a[0]), viewCenter[1] - (b[1] - a[1]), viewCenter[2] - (b[2] - a[2])];
        lx = e.clientX; ly = e.clientY;
        applyFrames();
        requestDraw();
      });
      canvas.addEventListener("dblclick", () => toggleMax(cellId(row, o)));
    }

    const c3 = cv.get(cellId(row, "threeD"))!;
    attachCameraControls(c3, camera, { onChange: () => { touch3d(); requestDraw(); } });
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

  // zoom: ctrl/cmd + wheel anywhere over the slice grid changes the SHARED field of view
  rowsEl.addEventListener("wheel", (ev) => {
    const e = ev as WheelEvent;
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    fovMm = Math.max(15, Math.min(600, fovMm * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
    applyFrames();
    requestDraw();
  }, { passive: false });

  // ── maximize one cell (double-click) ───────────────────────────────────────
  let maxed: string | null = null;
  const toggleMax = (id: string) => {
    maxed = maxed === id ? null : id;
    rowsEl.classList.toggle("maxmode", !!maxed);
    for (const row of sc.rows) {
      const re = rowEls.get(row.key)!;
      let has = false;
      for (const c of CELLS) {
        const on = maxed === cellId(row, c);
        cv.get(cellId(row, c))!.parentElement!.classList.toggle("max", on);
        has = has || on;
      }
      re.root.classList.toggle("hasmax", has);
    }
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
    const b = document.createElement("button");
    b.className = "chip series";
    b.dataset.key = row.key;
    b.style.setProperty("--accent", rgbCss(TIMEPOINTS[e.tp].color));
    b.innerHTML = `${seriesLabel(e)}<span>${mb(e.b)}</span>` +
      (e.segs.length ? `<em>${e.segs.length} seg</em>` : "");
    b.title = `${e.m} · ${e.d} · series ${e.sn} · ${e.n} instance(s) · ${mb(e.b)}` +
      (e.segs.length ? `\nsegmentations: ${e.segs.map((g) => g.s).join(", ")}` : "");
    b.addEventListener("click", () => toggleRow(row.key));
    strip.appendChild(b);
  }

  async function toggleRow(key: string) {
    const row = sc.row(key)!;
    if (row.state === "ready") {
      sc.releaseRow(key);
      syncRowChrome(row);
      resize();
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
    resize();
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
    for (const row of sc.rows) {
      rowEls.get(row.key)!.root.classList.toggle("empty", row.state === "idle");
      for (const c of CELLS) {
        const canvas = cv.get(cellId(row, c))!;
        const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
        if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
      }
    }
    renderJumps();
    requestDraw();
  };
  globalThis.addEventListener("resize", resize);

  // ── go ─────────────────────────────────────────────────────────────────────
  for (const row of sc.rows) syncRowChrome(row);
  applyColumns();
  const want = PARAMS.get("rows");
  const startKeys = want === "all"
    ? sc.rows.map((r) => r.key)
    : want === "none"
    ? []
    : want
    ? want.split(",").filter((k) => sc.row(k))
    : defaultRows(kase);
  status(startKeys.length ? `${kase.pid} — loading ${startKeys.length} series from IDC…` : `${kase.pid} — pick a series below`);
  for (const k of startKeys) toggleRow(k);          // concurrency-limited inside the loader

  // introspection for the automated test driver (numeric ground truth over screenshots)
  (globalThis as unknown as { __remindDbg: unknown }).__remindDbg = {
    ready: () => sc.readyRows().length,
    pid: () => kase.pid,
    rows: () => sc.rows.map((r) => ({
      key: r.key, tp: r.entry.tp, desc: r.entry.d, state: r.state, error: r.error,
      dims: r.vol?.dims, vox: r.vol?.vox, win: r.vol?.win, lev: r.vol?.lev,
      ijkToRAS: r.vol?.ijkToRAS, rasLo: r.rasLo, rasHi: r.rasHi,
      segs: r.segs.map((s) => ({ structure: s.structure, voxels: s.voxels, centroid: s.centroid })),
    })),
    focus: () => [...focus],
    viewCenter: () => [...viewCenter],
    fov: () => fovMm,
    offsets: () => sc.readyRows().map((r) => ({
      key: r.key,
      off: Object.fromEntries(ORIENTS.map((o) => [o, sc.offset01(r, o, focus)])),
    })),
    camera: () => ({ position: [...camera.position], focalPoint: [...camera.focalPoint] }),
    jumpTo: (ras: Vec3) => jumpTo(ras, true),
    toggleRow: (k: string) => toggleRow(k),
    setColumn: (c: CellKind, on: boolean) => { shown[c] = on; el(`col-${c}`)?.classList.toggle("on", on); applyColumns(); },
  };
}

main().catch((e) => status("error: " + ((e as Error)?.message ?? e), true));
