// ReMINDer compare viewer — the drilldown from the ReMINDer dashboard.
//
// COMPARE-CENTRIC. Looking at one series at a time answers almost nothing about an
// operation; the questions are all differences — is the tumour where the plan said, how far
// has the resection got, what does the post-resection MR show against the plan. So the unit
// of display is not a series, it is a PAIR: every row is A ⇄ B over the same anatomy, and
// you read it by toggling. A case opens on three such pairs' worth of intent (only the first
// is loaded):
//
//   1. pre-op T1+Gd  ⇄  pre-dura US     — plan vs first look
//   2. pre-dura US   ⇄  final US        — extent of resection
//   3. pre-op T1+Gd  ⇄  intra-op MR     — pre-op vs intra-op, matching sequence when it exists
//
// One set of compare controls (mode + blend) drives EVERY row and every column at once, so
// the whole grid flips together and differences across rows stay phase-locked. What is
// per-row is only the pair itself: each row carries its own A and B selectors over every
// series in the case.
//
// Rows are still expensive — pixels stream straight from IDC and one ultrasound object is up
// to 197 MB — so only the volumes some row actually references are resident, and dropping a
// row or re-pointing a selector frees whatever nothing else needs.
//
// Everything is linked in PATIENT SPACE (see remind-compare-scene.ts): scroll, pan or zoom
// any cell and every row follows to the same RAS plane and the same millimetres, whatever
// grid each volume happens to live on. That is what makes brain shift legible.
//
//   ?case=ReMIND-001            which case (default: the first in the index)
//   ?rows=1|2|3                 how many compare rows to open with (default 1)
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
  defaultPairs, loadIndex, rgbCss, seriesLabel, TIMEPOINTS,
  type CaseEntry, type ReMINDIndex, type SeriesEntry,
} from "./remind-data.ts";
import type { Vec3 } from "../../render/mat4.ts";

const ORIENTS = ["axial", "sagittal", "coronal"] as const;
const CELLS = [...ORIENTS, "threeD"] as const;
type CellKind = typeof CELLS[number];
type CmpMode = "fade" | "rock" | "toggle";
const PARAMS = new URLSearchParams(location.search);
const ROCK_MS = 1600;

const el = (id: string) => document.getElementById(id) as HTMLElement;
const status = (msg: string, err = false) => {
  const s = el("status");
  if (s) { s.textContent = msg; s.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const mb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

/** One comparison: two series keys, plus the question it was opened to answer. */
interface CmpRow {
  id: string;
  a: string | null;
  b: string | null;
  why: string;
  root: HTMLElement;
  label: HTMLElement;
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
    onRowChange: () => { syncRowLabels(); requestDraw(); },
    onRedraw: () => requestDraw(),
  });

  // ── state ──────────────────────────────────────────────────────────────────
  const rowsEl = el("rows");
  const cv = new Map<string, HTMLCanvasElement>();
  const cx = new Map<string, GPUCanvasContext>();
  const overlays = new Map<string, { c: HTMLCanvasElement; g: CanvasRenderingContext2D }>();
  const cmpRows: CmpRow[] = [];
  const PAIRS = defaultPairs(kase);
  let cmpMode: CmpMode = "fade";
  let blend = 0;                       // 0 = A, 1 = B — opens on A so the first frame is the plan
  let rowSeq = 0;

  let focus: Vec3 = [0, 0, 0];
  let viewCenter: Vec3 = [0, 0, 0];
  let fovMm = 200;
  let autoFrame = true;          // re-frame as volumes land, until the user moves something
  const camera = framedCamera([0, 0, 0], 100);
  const shown: Record<CellKind, boolean> = { axial: true, sagittal: true, coronal: true, threeD: true };

  const canvasKey = (r: CmpRow, c: CellKind, side: "a" | "b") => `${r.id}|${c}|${side}`;
  const overlayKey = (r: CmpRow, c: CellKind) => `${r.id}|${c}`;
  const rowOf = (key: string | null) => (key ? sc.row(key) : undefined);
  const rowReady = (key: string | null) => rowOf(key)?.state === "ready";

  // ── building a compare row ─────────────────────────────────────────────────
  const seriesOptions = (cur: string | null) => {
    let out = `<option value="">— none —</option>`;
    let group = "";
    for (const e of [...kase.series].sort((x, y) =>
      TIMEPOINTS[x.tp].rank - TIMEPOINTS[y.tp].rank || x.sn - y.sn)) {
      if (e.tp !== group) {
        if (group) out += `</optgroup>`;
        group = e.tp;
        out += `<optgroup label="${TIMEPOINTS[e.tp].short}">`;
      }
      const sel = e.u === cur ? " selected" : "";
      const segs = e.segs.length ? ` · ${e.segs.length} seg` : "";
      const nm = e.m === "US" ? TIMEPOINTS[e.tp].short : `${TIMEPOINTS[e.tp].short} · ${e.d}`;
      out += `<option value="${e.u}"${sel} title="${nm} · ${mb(e.b)}">${nm} · ${mb(e.b)}${segs}</option>`;
    }
    return out + (group ? `</optgroup>` : "");
  };

  function addRow(a?: SeriesEntry, b?: SeriesEntry, why = "custom") {
    const id = `r${++rowSeq}`;
    const root = document.createElement("div");
    root.className = "crow";
    root.dataset.row = id;
    const label = document.createElement("div");
    label.className = "clabel";
    root.appendChild(label);
    for (const c of CELLS) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.cell = c;
      for (const side of ["a", "b"] as const) {
        const canvas = document.createElement("canvas");
        canvas.className = side === "b" ? "bside" : "aside";
        canvas.id = `c-${id}|${c}|${side}`;
        cell.appendChild(canvas);
        cv.set(`${id}|${c}|${side}`, canvas);
      }
      const lab = document.createElement("div");
      lab.className = "lab";
      lab.textContent = c === "threeD" ? "3D" : c[0].toUpperCase() + c.slice(1);
      cell.appendChild(lab);
      const ov = document.createElement("canvas");
      ov.className = "xh";
      cell.appendChild(ov);
      overlays.set(`${id}|${c}`, { c: ov, g: ov.getContext("2d")! });
      root.appendChild(cell);
    }
    rowsEl.appendChild(root);
    const row: CmpRow = { id, a: a?.u ?? null, b: b?.u ?? null, why, root, label };
    cmpRows.push(row);
    attachRowInteraction(row);
    for (const c of CELLS) for (const s of ["a", "b"] as const) configureCanvas(canvasKey(row, c, s));
    syncRowLabels();
    reconcile();
    return row;
  }

  function removeRow(id: string) {
    const i = cmpRows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const [r] = cmpRows.splice(i, 1);
    r.root.remove();
    for (const c of CELLS) {
      overlays.delete(overlayKey(r, c));
      for (const s of ["a", "b"] as const) { cv.delete(canvasKey(r, c, s)); cx.delete(canvasKey(r, c, s)); }
    }
    syncRowLabels();
    reconcile();
  }

  const configureCanvas = (id: string) => {
    if (cx.has(id)) return;
    const c = cv.get(id);
    if (!c) return;
    const ctx = c.getContext("webgpu") as GPUCanvasContext;
    ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    cx.set(id, ctx);
  };

  /** Load what the rows reference, free what nothing references any more. */
  async function reconcile() {
    const needed = new Set<string>();
    for (const r of cmpRows) { if (r.a) needed.add(r.a); if (r.b) needed.add(r.b); }
    for (const row of sc.rows) {
      if (row.state === "ready" && !needed.has(row.key)) sc.releaseRow(row.key);
    }
    updateBar();
    resize();
    const pending = [...needed].filter((k) => sc.row(k)?.state === "idle");
    for (const k of pending) {
      const loaded = await sc.ensureRow(k);
      if (autoFrame && loaded.state === "ready") frameToBounds();
      applyFrames();
      syncRowLabels();
      renderTF();
      updateBar();
      resize();
    }
    status(statusLine());
  }

  const statusLine = () => {
    const res = sc.readyRows();
    const loading = sc.rows.filter((r) => r.state === "loading").length;
    const bytes = res.reduce((n, r) => n + r.entry.b, 0);
    return `${kase.pid} — ${cmpRows.length} comparison${cmpRows.length === 1 ? "" : "s"}, ` +
      `${res.length} volume${res.length === 1 ? "" : "s"} resident (${mb(bytes)})` +
      (loading ? `, ${loading} loading…` : "");
  };

  // ── row labels: the pair selectors, the question, and load progress ────────
  function syncRowLabels() {
    for (const r of cmpRows) {
      const ra = rowOf(r.a), rb = rowOf(r.b);
      const busy = [ra, rb].filter((x) => x?.state === "loading");
      const prog = busy.length
        ? `<div class="prog">${busy[0]!.progress.msg}<i style="width:${Math.round(busy[0]!.progress.frac * 100)}%"></i></div>`
        : "";
      const err = [ra, rb].find((x) => x?.state === "error");
      const accent = (row?: Row) => row ? rgbCss(TIMEPOINTS[row.entry.tp].color) : "#7d92b5";
      r.label.innerHTML =
        `<div class="why">${r.why}</div>` +
        `<div class="pick" style="--ac:${accent(ra)}"><span class="ab">A</span>` +
        `<select class="sel-a" data-row="${r.id}">${seriesOptions(r.a)}</select></div>` +
        `<div class="pick" style="--ac:${accent(rb)}"><span class="ab">B</span>` +
        `<select class="sel-b" data-row="${r.id}">${seriesOptions(r.b)}</select></div>` +
        (err ? `<div class="err">failed: ${err.error}</div>` : prog) +
        `<div class="rowbtns"><button class="mini swap" data-row="${r.id}" title="swap A and B">⇄</button>` +
        `<button class="mini rm" data-row="${r.id}" title="remove this comparison">×</button></div>`;
      r.root.classList.toggle("live", rowReady(r.a) && rowReady(r.b));
    }
    el("addrow").toggleAttribute("disabled", cmpRows.length >= 6);
  }

  rowsEl.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    if (!t.dataset.row || !t.classList.contains("sel-a") && !t.classList.contains("sel-b")) return;
    const r = cmpRows.find((x) => x.id === t.dataset.row);
    if (!r) return;
    if (t.classList.contains("sel-a")) r.a = t.value || null; else r.b = t.value || null;
    r.why = "custom";
    syncRowLabels();
    reconcile();
  });
  rowsEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("button.mini") as HTMLElement | null;
    if (!t) return;
    const r = cmpRows.find((x) => x.id === t.dataset.row);
    if (!r) return;
    if (t.classList.contains("rm")) removeRow(r.id);
    else { const s = r.a; r.a = r.b; r.b = s; syncRowLabels(); requestDraw(); }
  });

  // ── the global compare controls ────────────────────────────────────────────
  const applyBlend = () => {
    for (const r of cmpRows) {
      for (const c of CELLS) {
        const b = cv.get(canvasKey(r, c, "b"));
        if (b) b.style.opacity = String(rowReady(r.b) ? blend : 0);
      }
    }
    const f = el("cmp-fade") as HTMLInputElement;
    if (f && document.activeElement !== f) f.value = String(Math.round(blend * 100));
    el("cmp-note").textContent = `A ${Math.round((1 - blend) * 100)}% · B ${Math.round(blend * 100)}%`;
  };

  let animRaf = 0, animT0 = 0;
  const animate = (t: number) => {
    if (cmpMode === "fade") { animRaf = 0; return; }
    if (!animT0) animT0 = t;
    const phase = ((t - animT0) % ROCK_MS) / ROCK_MS;
    blend = cmpMode === "rock" ? (1 - Math.cos(phase * 2 * Math.PI)) / 2 : (phase < 0.5 ? 0 : 1);
    applyBlend();
    animRaf = requestAnimationFrame(animate);
  };
  const syncAnim = () => {
    const want = cmpMode !== "fade";
    if (want && !animRaf) { animT0 = 0; animRaf = requestAnimationFrame(animate); }
    if (!want && animRaf) { cancelAnimationFrame(animRaf); animRaf = 0; }
  };
  const setMode = (m: CmpMode) => {
    cmpMode = m;
    for (const b of el("cmpbar").querySelectorAll("[data-mode]")) {
      b.classList.toggle("on", (b as HTMLElement).dataset.mode === m);
    }
    syncAnim();
    applyBlend();
  };
  const updateBar = () => {
    el("cmp-count").textContent = `${cmpRows.length} row${cmpRows.length === 1 ? "" : "s"}`;
  };

  for (const b of el("cmpbar").querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => setMode((b as HTMLElement).dataset.mode as CmpMode));
  }
  (el("cmp-fade") as HTMLInputElement).addEventListener("input", (e) => {
    blend = Number((e.target as HTMLInputElement).value) / 100;
    if (cmpMode !== "fade") setMode("fade");
    applyBlend();
  });
  el("addrow").addEventListener("click", () => {
    const p = PAIRS[cmpRows.length] ?? PAIRS[PAIRS.length - 1];
    addRow(p?.a, p?.b, p?.why ?? "custom");
  });
  // space = snap between A and B. The classic toggle gesture; a click can't have it,
  // because left-drag on a slice is already scroll.
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
    if (e.code !== "Space") return;
    e.preventDefault();
    if (cmpMode !== "fade") setMode("fade");
    blend = blend > 0.5 ? 0 : 1;
    applyBlend();
  });

  // ── linked patient-space view state ────────────────────────────────────────
  // Frame on the SMALLEST resident volume — in a comparison that is the region someone
  // actually cares about (an ultrasound block is ~10 cm inside a 25 cm head), and every
  // other row zooms to the same patient-space window, which is the whole point. Uses the
  // longest EXTENT, not the bounding-sphere diagonal: the diagonal left the anatomy filling
  // about 40% of the cell. Re-frames as each new volume lands, and stops the moment the
  // user moves anything.
  const extentOf = (r: Row) => Math.max(
    r.rasHi![0] - r.rasLo![0], r.rasHi![1] - r.rasLo![1], r.rasHi![2] - r.rasLo![2]);
  const frameToBounds = () => {
    const b = sc.bounds();
    const ready = sc.readyRows();
    if (!b || !ready.length) return;
    let best = ready[0];
    for (const r of ready) if (extentOf(r) < extentOf(best)) best = r;
    focus = [...(best.center ?? b.center)] as Vec3;
    viewCenter = [...focus] as Vec3;
    fovMm = Math.max(40, extentOf(best) * 1.15);
    camera.focalPoint = [...viewCenter] as Vec3;
    const dist = fovMm / (2 * Math.tan((camera.viewAngle / 2) * Math.PI / 180));
    camera.position = [viewCenter[0], viewCenter[1] - dist, viewCenter[2]];
    camera.viewUp = [0, 0, 1];
  };
  /** Once the user drives the view, stop re-framing under them. */
  const userTookOver = () => { autoFrame = false; };
  const applyFrames = () => { for (const o of ORIENTS) sc.applyFrame(o, viewCenter, fovMm); };

  // slice ↔ 3D: two expressions of one centre and one span. Orbit is not coupled.
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
  const drawSliceTo = (row: Row, o: Orientation, id: string) => {
    const c = cv.get(id);
    if (!c || !c.width || row.state !== "ready" || !shown[o]) return;
    row.slice!.setPlane(o, sc.offset01(row, o, focus));
    row.slice!.renderToView(cx.get(id)!.getCurrentTexture().createView({ format: srgb }), c.width, c.height);
  };
  const draw3dTo = (row: Row, id: string) => {
    const c = cv.get(id);
    if (!c || !c.width || row.state !== "ready" || !shown.threeD) return;
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
    for (const r of cmpRows) {
      for (const [side, key] of [["a", r.a], ["b", r.b]] as const) {
        const row = rowOf(key);
        if (!row || row.state !== "ready") continue;
        for (const o of ORIENTS) drawSliceTo(row, o, canvasKey(r, o, side));
        draw3dTo(row, canvasKey(r, "threeD", side));
      }
    }
    applyBlend();
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

  // ── crosshair ──────────────────────────────────────────────────────────────
  const xhair = createCrosshair(false);
  const xhairRedraw = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const r of cmpRows) {
      // project through whichever side is showing, so the cross tracks what you can see
      const row = rowOf(blend > 0.5 && rowReady(r.b) ? r.b : r.a) ?? rowOf(r.b);
      for (const k of CELLS) {
        const o = overlays.get(overlayKey(r, k));
        const host = cv.get(canvasKey(r, k, "b")) ?? cv.get(canvasKey(r, k, "a"));
        if (!o || !host) continue;
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) continue;
        if (o.c.width !== Math.floor(w * dpr)) { o.c.width = Math.floor(w * dpr); o.c.height = Math.floor(h * dpr); }
        o.g.setTransform(o.c.width / w, 0, 0, o.c.height / h, 0, 0);
        o.g.clearRect(0, 0, w, h);
        if (!xhair.visible || !xhair.ras || row?.state !== "ready") continue;
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

  // ── interaction ────────────────────────────────────────────────────────────
  const uvOf = (c: HTMLCanvasElement, e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, aspect: r.width / r.height };
  };
  const isShiftHover = (e: PointerEvent) => e.shiftKey && e.buttons === 0;
  const aspectOf = (c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 1;
  };
  /** Adopt the frame the leader row was just dragged into as the shared frame — read back
   *  out of the renderer, never re-derived, so the plane basis stays single-sourced. */
  const adoptFrame = (row: Row, o: Orientation, canvas: HTMLCanvasElement) => {
    const aspect = aspectOf(canvas);
    userTookOver();
    viewCenter = row.slice!.viewToRas(o, sc.offset01(row, o, focus), 0.5, 0.5, aspect);
    fovMm = row.slice!.spanMmFor(o) / Math.max(1e-6, row.slice!.zoom(o));
    applyFrames();
    syncCameraToFov();
  };

  function attachRowInteraction(r: CmpRow) {
    // the leader is whichever side is currently visible; gestures drive it, everyone follows
    const leader = () => rowOf(blend > 0.5 && rowReady(r.b) ? r.b : r.a) ?? rowOf(r.b);
    for (const o of ORIENTS) {
      const canvas = cv.get(canvasKey(r, o, "b"))!;     // B sits on top → it takes the events
      attachSliceControls(canvas, {
        orient: o,
        getSlice: () => leader()!.slice!,
        step: (fwd) => {
          const row = leader();
          if (row?.state !== "ready") return;
          const axis = o === "axial" ? 2 : o === "coronal" ? 1 : 0;
          const f: Vec3 = [...focus] as Vec3;
          f[axis] = Math.max(row.rasLo![axis], Math.min(row.rasHi![axis],
            f[axis] + Math.max(0.2, row.vol!.vox) * (fwd ? 1 : -1)));
          focus = f;
        },
        redraw: () => {
          const row = leader();
          if (row?.state === "ready") adoptFrame(row, o, canvas);
          requestDraw();
        },
        hooks: { onDoubleClick: () => { toggleMax(canvasKey(r, o, "b")); return true; } },
      });
      canvas.addEventListener("pointermove", (e) => {
        const row = leader();
        if (!isShiftHover(e) || row?.state !== "ready") return;
        if (!xhair.visible) xhair.toggle(true);
        const { u, v, aspect } = uvOf(canvas, e);
        const ras = row.slice!.viewToRas(o, sc.offset01(row, o, focus), u, v, aspect);
        xhair.set(ras);
        jumpTo(ras);
      });
    }
    const c3 = cv.get(canvasKey(r, "threeD", "b"))!;
    attachCameraControls(c3, camera, { onChange: () => { userTookOver(); touch3d(); syncFovToCamera(); requestDraw(); } });
    attachDoubleClick(c3, () => toggleMax(canvasKey(r, "threeD", "b")));
    let inFlight = false, queued: { u: number; v: number } | null = null;
    const pick = async (u: number, v: number) => {
      const row = leader();
      if (row?.state !== "ready") return;
      inFlight = true;
      const ras = await row.scene!.pick(u, v);
      inFlight = false;
      if (ras) { xhair.set(ras); jumpTo(ras); }
      if (queued) { const q = queued; queued = null; pick(q.u, q.v); }
    };
    c3.addEventListener("pointermove", (e) => {
      if (!isShiftHover(e)) return;
      if (!xhair.visible) xhair.toggle(true);
      const { u, v } = uvOf(c3, e);
      if (inFlight) queued = { u, v }; else pick(u, v);
    });
  }

  // ── maximize one cell ──────────────────────────────────────────────────────
  let maxed: string | null = null;
  const toggleMax = (id: string) => {
    maxed = maxed === id ? null : id;
    rowsEl.classList.toggle("maxmode", !!maxed);
    const target = maxed ? cv.get(maxed)?.parentElement : null;
    for (const cell of rowsEl.querySelectorAll(".cell")) cell.classList.toggle("max", cell === target);
    for (const rr of rowsEl.querySelectorAll(".crow")) rr.classList.toggle("hasmax", !!target && rr.contains(target));
    resize();
  };

  // ── column chips ───────────────────────────────────────────────────────────
  const applyColumns = () => {
    for (const r of cmpRows) {
      for (const c of CELLS) {
        cv.get(canvasKey(r, c, "b"))!.parentElement!.classList.toggle("hidden", !shown[c]);
      }
    }
    resize();
  };
  for (const c of CELLS) {
    const b = el(`col-${c}`);
    b?.addEventListener("click", () => { shown[c] = !shown[c]; b.classList.toggle("on", shown[c]); applyColumns(); });
  }

  // ── header, case picker, IDC details ───────────────────────────────────────
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
      b.className = "crow-pick" + (c.pid === kase.pid ? " cur" : "");
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
      const top = globalThis as unknown as Window;
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

  let shellOp = 1;
  const controls: VizControl[] = [
    { label: "Volume (3D)", getOpacity: () => sc.volumeOpacity(), setOpacity: (o) => { sc.setVolumeOpacity(o); requestDraw(); }, color: [0.75, 0.78, 0.85] },
    { label: "Segment shells (3D)", getOpacity: () => shellOp, setOpacity: (o) => { shellOp = o; sc.setShellOpacity(o); requestDraw(); }, color: [0.95, 0.35, 0.4] },
    { label: "Segment fill (2D)", getOpacity: () => sc.overlayOpacity(), setOpacity: (o) => { sc.setOverlayOpacity(o); requestDraw(); }, color: [0.95, 0.55, 0.3] },
  ];
  installChrome({ controls });

  // ── transfer-function editor (per resident volume) ─────────────────────────
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
    tfg.fillStyle = "rgba(159,179,208,.28)";
    const bw = w / hist.length;
    for (let i = 0; i < hist.length; i++) tfg.fillRect(i * bw, h - hist[i] * h, Math.max(1, bw - 0.5), hist[i] * h);
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
    for (const [t, a] of pts) { tfg.beginPath(); tfg.arc(t * w, (1 - a) * h, 4, 0, Math.PI * 2); tfg.fill(); }
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
      el("tf-wl").textContent = `W ${row.win!.toFixed(0)} · L ${row.lev!.toFixed(0)}`;
    }
    drawTFCurve();
  };
  tfSel.addEventListener("change", () => { tfKey = tfSel.value || null; renderTF(); });
  tfRamp.addEventListener("change", () => {
    if (!tfKey) return;
    sc.setRowTF(tfKey, { ramp: tfRamp.value });
    drawTFCurve(); requestDraw();
  });
  const wlInput = () => {
    const row = tfRow();
    if (!row) return;
    const base = row.vol!;
    const win = base.win * Math.pow(4, Number(tfWin.value));
    const lev = base.lev + base.win * Number(tfLev.value);
    sc.setRowWindowLevel(row.key, win, lev);
    row.hist = undefined;
    el("tf-wl").textContent = `W ${win.toFixed(0)} · L ${lev.toFixed(0)}`;
    drawTFCurve(); requestDraw();
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
    renderTF(); requestDraw();
  });
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
    if (row?.state !== "ready") return;
    const { t, a, r } = tfAt(e);
    const hit = nearest(t, a, r);
    const pts = row.tf!.points;
    if ((e.button === 2 || e.altKey) && hit >= 0 && pts.length > 2) {
      pts.splice(hit, 1); sc.setRowTF(row.key, { points: pts }); drawTFCurve(); requestDraw(); return;
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
  document.addEventListener("click", (e) => {
    const p = el("tf-panel");
    if (!p.hidden && !p.contains(e.target as Node) && e.target !== tfBtn) p.hidden = true;
  });

  // ── jump chips for the segmented structures ────────────────────────────────
  const jumps = el("jumps");
  const renderJumps = () => {
    jumps.innerHTML = "";
    const seen = new Set<string>();
    for (const row of sc.readyRows()) {
      for (const s of row.segs) {
        const k = s.structure + row.key;
        if (!s.centroid || seen.has(k)) continue;
        seen.add(k);
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
    for (const [, canvas] of cv) {
      const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
    }
    renderJumps();
    requestDraw();
  };
  globalThis.addEventListener("resize", resize);

  // ── go ─────────────────────────────────────────────────────────────────────
  applyColumns();
  setMode("fade");
  el("col-link").addEventListener("click", () => {
    link3d = !link3d;
    el("col-link").classList.toggle("on", link3d);
    if (link3d) syncCameraToFov();
    requestDraw();
  });

  const want = Math.max(1, Math.min(PAIRS.length, Number(PARAMS.get("rows")) || 1));
  for (let i = 0; i < want; i++) addRow(PAIRS[i]?.a, PAIRS[i]?.b, PAIRS[i]?.why ?? "custom");
  status(`${kase.pid} — loading the first comparison from IDC…`);

  // introspection for the automated test driver
  (globalThis as unknown as { __remindDbg: unknown }).__remindDbg = {
    ready: () => sc.readyRows().length,
    pid: () => kase.pid,
    rows: () => sc.rows.map((r) => ({
      key: r.key, tp: r.entry.tp, desc: r.entry.d, m: r.entry.m, state: r.state, error: r.error,
      nSegs: r.entry.segs.length,
      dims: r.vol?.dims, vox: r.vol?.vox, win: r.vol?.win, lev: r.vol?.lev,
      ijkToRAS: r.vol?.ijkToRAS, rasLo: r.rasLo, rasHi: r.rasHi,
      segs: r.segs.map((s) => ({ structure: s.structure, voxels: s.voxels, centroid: s.centroid })),
    })),
    // the compare rows — the unit of display
    cmpRows: () => cmpRows.map((r) => ({
      id: r.id, why: r.why, a: r.a, b: r.b,
      aDesc: rowOf(r.a)?.entry.d, bDesc: rowOf(r.b)?.entry.d,
      aTp: rowOf(r.a)?.entry.tp, bTp: rowOf(r.b)?.entry.tp,
      live: rowReady(r.a) && rowReady(r.b),
    })),
    addRow: () => { const p = PAIRS[cmpRows.length] ?? PAIRS[PAIRS.length - 1]; addRow(p?.a, p?.b, p?.why ?? "custom"); return cmpRows.length; },
    removeRow: (id: string) => { removeRow(id); return cmpRows.length; },
    setPair: (id: string, a: string | null, b: string | null) => {
      const r = cmpRows.find((x) => x.id === id);
      if (!r) return null;
      r.a = a; r.b = b; r.why = "custom";
      syncRowLabels(); reconcile();
      return { a: r.a, b: r.b };
    },
    mode: () => cmpMode,
    setMode: (m: CmpMode) => { setMode(m); return cmpMode; },
    blend: () => blend,
    setBlend: (v: number) => { blend = v; applyBlend(); },
    residentKeys: () => sc.readyRows().map((r) => r.key),
    focus: () => [...focus],
    viewCenter: () => [...viewCenter],
    fov: () => fovMm,
    offsets: () => sc.readyRows().map((r) => ({
      key: r.key, off: Object.fromEntries(ORIENTS.map((o) => [o, sc.offset01(r, o, focus)])),
    })),
    camera: () => ({
      position: [...camera.position], focalPoint: [...camera.focalPoint],
      dist: camDist(), viewAngle: camera.viewAngle, fovAtFocus: fovAtDist(camDist()),
    }),
    jumpTo: (ras: Vec3) => jumpTo(ras, true),
    setColumn: (c: CellKind, on: boolean) => { shown[c] = on; el(`col-${c}`)?.classList.toggle("on", on); applyColumns(); },
    zoomSlice: (o: Orientation, factor: number) => {
      const r = sc.readyRows()[0];
      if (!r) return;
      const cr = cmpRows.find((x) => rowOf(x.a) === r || rowOf(x.b) === r) ?? cmpRows[0];
      const c = cv.get(canvasKey(cr, o, "b"))!;
      r.slice!.zoomAbout(o, factor, 0.5, 0.5, c.clientWidth, c.clientHeight);
      adoptFrame(r, o, c);
      requestDraw();
    },
    link3d: () => link3d,
    setLink3d: (on: boolean) => { link3d = on; el("col-link")?.classList.toggle("on", on); },
    tf: (k?: string) => {
      const r = k ? sc.row(k) : tfRow();
      return r?.state === "ready" ? { key: r.key, ramp: r.tf!.ramp, points: r.tf!.points, win: r.win, lev: r.lev } : null;
    },
    setTF: (k: string, patch: { ramp?: string; points?: [number, number][] }) => { sc.setRowTF(k, patch); requestDraw(); },
    setWindowLevel: (k: string, win: number, lev: number) => { sc.setRowWindowLevel(k, win, lev); requestDraw(); },
    lutAlphaAt: (k: string, t: number) => {
      const r = sc.row(k);
      if (r?.state !== "ready") return null;
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
