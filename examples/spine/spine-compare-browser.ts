// Browser entry for SlicerLive spine-compare: vertebra-by-vertebra comparison of
// SPINEPS vs the IDC reference segmentation for one spine-review case.
// CompareVolumes-style: two method ROWS × selectable {axial, sagittal, coronal, 3D}
// columns. ONE shared SliceRenderer draws both rows (overlay swapped per draw), so
// scroll/pan/zoom are identical across rows by construction; one camera links every
// 3D cell. The vertebra buttons FOCUS the whole viewer: crosshair + slices jump to
// the level, slice views zoom to its bbox, and the 3D scenes clip + frame to the
// extent mode (1 vert / ±1 / ±3 / full spine).
//   ?case=<pid>&coll=<mets|myeloma>     (defaults to the first zarr-ready case)
// Bundled to live/webgpu/spine-compare.js
import { initDevice } from "../../render/device.ts";
import { budgetWasReduced, reduceBudget } from "../../render/gpu-budget.ts";
import { slicerDefaultOffset01, type Orientation } from "../../render/slice-renderer.ts";
import { SliceInteractor } from "../../render/slice-interactor.ts";
import { attachSliceControls } from "../../render/demos/slice-control.ts";
import { attachCameraControls, framedCamera } from "../../render/demos/camera-control.ts";
import { attachDoubleClick } from "../../render/demos/view-grid.ts";
import { createCrosshair, drawCross, rasToScreen3D } from "../../render/demos/crosshair.ts";
import { installChrome, type VizControl } from "../../render/demos/sl-chrome.ts";
import {
  BUCKET, buildSpineCompareScene, DISC_COLOR, isDisc, loadCaseMeta, LEVEL_NAME, METHOD_COLORS,
  type SpineCompareScene,
} from "./spine-compare-scene.ts";
import type { Vec3 } from "../../render/mat4.ts";

type MethodKey = "spineps" | "ref";
const ORIENTS = ["axial", "sagittal", "coronal"] as const;
const PARAMS = new URLSearchParams(location.search);

const el = (id: string) => document.getElementById(id) as HTMLElement;
const status = (msg: string, err = false) => {
  const s = el("status");
  if (s) { s.textContent = msg; s.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

interface CaseEntry {
  pid: string;
  collection: string;
  compare?: { mean_dice_same?: number; n_agree?: number; n_ref_labels?: number; n_shifted?: number };
  levels?: Record<string, { d: number; b: string; s: number; v: number; db?: number }>;
}

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const gpu = await initDevice();
  // The budget this load is running on. Captured in a mutable so the device-lost handler below can
  // halve it even if the loss happens DURING scene construction, when `sc` is still in its TDZ.
  let budgetInUse = 0.75e9;
  // A LOST DEVICE IS WHAT "the viewers went black, then white" ACTUALLY IS. The browser drops the
  // GPU out from under the page — usually out of memory with several large volumes resident — and
  // every canvas stops updating with nothing in the console a user can act on. Say so, and say what
  // to do about it, instead of leaving blank boxes on screen.
  gpu.device.lost.then((info) => {
    if (info.reason === "destroyed") return;        // our own teardown, not a failure
    status(`GPU device lost (${info.reason}) — the views stopped updating.`, true);
    const warn = document.createElement("div");
    warn.style.cssText = "position:fixed;inset:auto 0 0 0;padding:10px 14px;background:#3a1216;color:#ffd7da;" +
      "font:13px/1.4 system-ui;z-index:9999;border-top:1px solid #6b2630;display:flex;gap:12px;align-items:center";
    const txt = document.createElement("span");
    txt.textContent = "The GPU dropped this page" + (info.message ? ` (${info.message})` : "") +
      ". Running out of GPU memory is the usual cause.";
    const btn = document.createElement("button");
    btn.textContent = "Reload at lower resolution";
    btn.style.cssText = "padding:5px 10px;border-radius:6px;border:1px solid #8a3340;background:#5a1d24;color:#ffd7da;cursor:pointer";
    // A lost device cannot be revived, so the only way to act on this is to come back smaller. The
    // reduced budget is remembered for the session, so the reload does not walk into it again.
    btn.addEventListener("click", () => { reduceBudget(budgetInUse); location.reload(); });
    warn.append(txt, btn);
    document.body.appendChild(warn);
  });
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  status("loading case list…");
  const casesDoc = await (await fetch(BUCKET + "cases.json", { cache: "no-cache" })).json() as { cases: CaseEntry[] };   // revalidate — the index gains fields over time
  let pid = PARAMS.get("case") ?? "";
  let coll = PARAMS.get("coll") ?? "";
  if (!pid) {
    for (const c of casesDoc.cases) {
      const r = await fetch(`${BUCKET}${c.collection}/${c.pid}/zarr/meta.json`, { method: "HEAD" });
      if (r.ok) { pid = c.pid; coll = c.collection; break; }
    }
    if (!pid) { status("no zarr-ready cases in the bucket yet — the worker is still running", true); return; }
  }
  const entry = casesDoc.cases.find((c) => c.pid === pid && (!coll || c.collection === coll));
  coll = entry?.collection ?? coll;
  (el("case-btn") as HTMLButtonElement).textContent = `${coll}/${pid} ▾`;   // label up front — the build takes seconds

  status(`loading ${coll}/${pid}…`);
  const { meta, base } = await loadCaseMeta(coll, pid);
  let bytes = 0;
  const sc: SpineCompareScene = await buildSpineCompareScene(gpu, srgb, meta, base, (msg, n) => {
    bytes += n;
    status(`${coll}/${pid}: ${msg} — ${(bytes / 1e6).toFixed(1)} MB`);
  }, {
    // ?shell=all restores the soft multi-material interface shell; ?band=<voxels> overrides the band.
    shell: PARAMS.get("shell") === "all" ? "all" : "outer",
    bandVox: PARAMS.get("band") ? Number(PARAMS.get("band")) : undefined,
  });
  // Say what this view sized itself to. When the grid was coarsened to fit the device, the surfaces
  // being compared are lower-resolution than the data — a reviewer has to know that, not discover it.
  {
    const m = sc.memory();
    budgetInUse = m.budgetBytes;
    console.info(`spine-compare GPU budget: ${(m.budgetBytes / 1e9).toFixed(2)} GB (${m.why})\n  ` + m.rows.join("\n  "));
  }
  sc.upgraded.then(() => { drawAll(); status(`${coll}/${pid} — full-res CT loaded`); })
    .catch(() => status(`${coll}/${pid} — full-res CT failed to load (showing preview res)`, true));

  // ── canvases: rows × cells ─────────────────────────────────────────────────
  const keys: MethodKey[] = ["spineps", "ref"];
  const cellNames = [...ORIENTS, "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {};
  const cx: Record<string, GPUCanvasContext> = {};
  for (const k of keys) {
    for (const c of cellNames) {
      const id = `c-${k}-${c}`;
      cv[id] = document.getElementById(id) as HTMLCanvasElement;
      cx[id] = cv[id].getContext("webgpu") as GPUCanvasContext;
      cx[id].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    }
  }
  const rowOf = (k: MethodKey) => sc.rows[k === "spineps" ? 0 : 1];

  // ── linked navigation state ────────────────────────────────────────────────
  const off: Record<Orientation, number> = {
    axial: slicerDefaultOffset01("axial", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    coronal: slicerDefaultOffset01("coronal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    sagittal: slicerDefaultOffset01("sagittal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
  };
  const sliceIx = new SliceInteractor({ ijkToRAS: sc.ijkToRAS, rasLo: sc.rasLo, rasHi: sc.rasHi });
  const camera = framedCamera(sc.center, sc.radius);   // ONE camera → every 3D cell linked

  const drawSlice = (k: MethodKey, o: Orientation) => {
    const c = cv[`c-${k}-${o}`];
    if (!c || !c.width) return;
    sc.bindRowSlice(k);                        // shared renderer, this row's overlay
    sc.slice.setPlane(o, off[o]);
    sc.slice.renderToView(cx[`c-${k}-${o}`].getCurrentTexture().createView({ format: srgb }), c.width, c.height);
  };
  // Interactive 3D renders at a reduced scale (Catmull-Rom upscaled), then a debounced
  // native-res settle render — same idea as the shared adaptive loop, sized for 2 cells.
  let fast3d = false;
  let settle3dTimer = 0;
  const draw3dCell = (k: MethodKey) => {
    const c = cv[`c-${k}-threeD`];
    if (!c || !c.width) return;
    const scene = rowOf(k).scene;
    const view = cx[`c-${k}-threeD`].getCurrentTexture().createView({ format: srgb });
    if (fast3d) {
      const rw = Math.max(16, Math.round(c.width * 0.5)), rh = Math.max(16, Math.round(c.height * 0.5));
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, rw, rh);
      scene.renderUpscaled(view, rw, rh, c.width, c.height);
    } else {
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, c.width, c.height);
      scene.renderToView(view, c.width, c.height);
    }
  };
  const touch3d = () => {
    fast3d = true;
    clearTimeout(settle3dTimer);
    settle3dTimer = setTimeout(() => { fast3d = false; drawAll3d(); }, 350) as unknown as number;
  };
  const drawAll3d = () => { for (const k of keys) draw3dCell(k); xhairRedraw(); };
  const drawSlices = () => { for (const k of keys) for (const o of ORIENTS) drawSlice(k, o); xhairRedraw(); };
  const drawAll = () => { drawSlices(); drawAll3d(); };
  // COALESCED redraw: a level step triggers redraws from jumpAll, applyFocus, and BOTH
  // rows' rebake callbacks — natively that was 3-4 full-res 3D ray-marches per keypress.
  // Route them all here: one rAF, one drawAll.
  let drawRaf = 0;
  const requestDraw = () => {
    touch3d();                       // interactive burst → half-res 3D until it settles
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => { drawRaf = 0; drawAll(); });
  };
  for (const k of keys) rowOf(k).logic.onRedraw(requestDraw);

  // ── shared crosshair across all 8 cells ────────────────────────────────────
  // Visible ONLY while the shift-hover gesture is live: it appears with the first
  // shift+move and vanishes when shift is released (or the window loses focus).
  const xhair = createCrosshair(false);
  const overlays: Record<string, { c: HTMLCanvasElement; g: CanvasRenderingContext2D }> = {};
  for (const id of keys.flatMap((k) => cellNames.map((c) => `c-${k}-${c}`))) {
    const o = document.createElement("canvas");
    o.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;background:transparent;";
    cv[id].parentElement!.appendChild(o);
    overlays[id] = { c: o, g: o.getContext("2d")! };
  }
  const xhairRedraw = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const [id, { c, g }] of Object.entries(overlays)) {
      const w = cv[id].clientWidth, h = cv[id].clientHeight;
      if (!w || !h) continue;
      if (c.width !== Math.floor(w * dpr)) { c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr); }
      g.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!xhair.visible || !xhair.ras) continue;
      if (id.endsWith("threeD")) {
        const s = rasToScreen3D(camera, xhair.ras, w, h);
        if (s) drawCross(g, s.x * w, s.y * h);
      } else {
        const o = id.split("-").pop() as Orientation;
        const pr = sc.slice.rasToView(o, off[o], xhair.ras, w / h);
        if (pr.u >= 0 && pr.u <= 1 && pr.v >= 0 && pr.v <= 1) drawCross(g, pr.u * w, pr.v * h);
      }
    }
  };
  const jumpAll = (ras: Vec3) => {
    for (const o of ORIENTS) {
      const a = o === "axial" ? 2 : o === "coronal" ? 1 : 0;
      off[o] = Math.max(0, Math.min(1, (ras[a] - sc.rasLo[a]) / (sc.rasHi[a] - sc.rasLo[a])));
    }
    requestDraw();
  };
  const isShiftHover = (e: PointerEvent) => e.shiftKey && e.buttons === 0;
  const uvOf = (c: HTMLCanvasElement, e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, aspect: r.width / r.height };
  };
  const hideXhair = () => { if (xhair.visible) { xhair.toggle(false); xhairRedraw(); } };
  globalThis.addEventListener("keyup", (e) => { if ((e as KeyboardEvent).key === "Shift") hideXhair(); });
  globalThis.addEventListener("blur", hideXhair);
  for (const k of keys) {
    for (const o of ORIENTS) {
      cv[`c-${k}-${o}`].addEventListener("pointermove", (e) => {
        if (!isShiftHover(e)) return;
        if (!xhair.visible) xhair.toggle(true);
        const { u, v, aspect } = uvOf(cv[`c-${k}-${o}`], e);
        const ras = sc.slice.viewToRas(o, off[o], u, v, aspect);
        xhair.set(ras); jumpAll(ras);
      });
    }
  }
  for (const k of keys) {
    let inFlight = false, queued: { u: number; v: number } | null = null;
    const pick = async (u: number, v: number) => {
      inFlight = true;
      const ras = await rowOf(k).scene.pick(u, v);
      inFlight = false;
      if (ras) { xhair.set(ras); jumpAll(ras); }
      if (queued) { const q = queued; queued = null; pick(q.u, q.v); }
    };
    cv[`c-${k}-threeD`].addEventListener("pointermove", (e) => {
      if (!isShiftHover(e)) return;
      if (!xhair.visible) xhair.toggle(true);
      const { u, v } = uvOf(cv[`c-${k}-threeD`], e);
      if (inFlight) queued = { u, v }; else pick(u, v);
    });
  }

  // ── interaction: slices (scroll/pan/zoom — one shared state, both rows repaint) ─
  for (const k of keys) {
    for (const o of ORIENTS) {
      attachSliceControls(cv[`c-${k}-${o}`], {
        orient: o,
        getSlice: () => sc.slice,
        step: (fwd) => { off[o] = sliceIx.wheel(o, off[o], fwd); },
        redraw: () => { for (const kk of keys) drawSlice(kk, o); xhairRedraw(); },
        hooks: { onDoubleClick: () => { toggleMax(`c-${k}-${o}`); return true; } },
      });
    }
  }
  for (const k of keys) attachCameraControls(cv[`c-${k}-threeD`], camera, { onChange: () => { touch3d(); drawAll3d(); } });

  // ── double-click any cell to maximize it (again to restore) ────────────────
  let maxed: string | null = null;
  const toggleMax = (id: string) => {
    maxed = maxed === id ? null : id;
    const rowsEl = el("rows");
    rowsEl.classList.toggle("maxmode", !!maxed);
    for (const k of keys) {
      for (const c of cellNames) {
        const cell = cv[`c-${k}-${c}`].parentElement!;
        cell.classList.toggle("max", maxed === `c-${k}-${c}`);
      }
    }
    for (const r of rowsEl.querySelectorAll(".mrow")) {
      r.classList.toggle("hasmax", !!maxed && !!r.querySelector(".cell.max"));
    }
    resize();
  };
  for (const k of keys) attachDoubleClick(cv[`c-${k}-threeD`], () => toggleMax(`c-${k}-threeD`));

  // ── orientation column chips ───────────────────────────────────────────────
  const shown: Record<string, boolean> = { axial: true, sagittal: true, coronal: true, threeD: true };
  const applyColumns = () => {
    for (const k of keys) for (const c of cellNames) cv[`c-${k}-${c}`].parentElement!.classList.toggle("hidden", !shown[c]);
    resize();
  };
  for (const c of cellNames) {
    const b = el(`col-${c}`);
    b?.addEventListener("click", () => { shown[c] = !shown[c]; b.classList.toggle("on", shown[c]); applyColumns(); });
  }

  // ── FOCUS: level buttons + extent mode drive crosshair, slice zoom, 3D clip + framing ─
  let currentLevel: number | null = null;
  let extent = 99;
  const extents = [["ext-one", 0], ["ext-pm1", 1], ["ext-pm3", 3], ["ext-full", 99]] as const;
  const SLICE_MARGIN = 1.5;                     // in-plane context around the level bbox
  /** Point the camera at `center`, keeping the current viewing DIRECTION. `keepDistance` keeps the
   *  current dolly too, so the move is a pure pan: stepping from one vertebra to the next holds the
   *  zoom you set instead of refitting to each bone's bounding sphere. Refitting is right when the
   *  extent MODE changes (you asked for a different amount of spine), not when the target moves. */
  const frameCamera = (center: Vec3, radius: number, keepDistance = false) => {
    const d: Vec3 = [
      camera.focalPoint[0] - camera.position[0],
      camera.focalPoint[1] - camera.position[1],
      camera.focalPoint[2] - camera.position[2],
    ];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const dist = keepDistance ? len : radius / Math.tan(((camera.viewAngle / 2) * Math.PI) / 180);
    camera.focalPoint = [...center] as Vec3;
    camera.position = [center[0] - d[0] / len * dist, center[1] - d[1] / len * dist, center[2] - d[2] / len * dist];
  };
  // An EMPTY 3D cell is almost always real: this method has no label at the focused level (SPINEPS
  // and the reference disagree about which bone is which — that is the whole point of the view), or
  // its labels stop short of the reference's range. An unexplained black box reads as a broken
  // renderer, so each 3D cell carries a note that says which.
  const emptyNote: Record<MethodKey, HTMLElement> = {} as Record<MethodKey, HTMLElement>;
  for (const k of keys) {
    const d = document.createElement("div");
    d.className = "empty";
    cv[`c-${k}-threeD`].parentElement!.appendChild(d);
    emptyNote[k] = d;
  }
  const updateEmptyNotes = () => {
    for (const k of keys) {
      const none = sc.visibleLevels(k).length === 0;
      emptyNote[k].classList.toggle("on", none);
      if (none) {
        const lvl = currentLevel == null ? "" : ` at ${LEVEL_NAME[currentLevel] ?? currentLevel}`;
        const span = extent === 0 ? "" : ` ±${extent}`;
        emptyNote[k].textContent = `${k === "spineps" ? "SPINEPS" : "Reference"} has no label${lvl}${span}`;
      }
    }
  };

  /** `refit` reframes the views to the focus box; without it they keep the zoom they have and only
   *  move to the new target. Mode changes refit, level changes do not. */
  const applyFocus = (refit = false) => {
    const box = sc.setExtent(extent >= 99 ? null : currentLevel, extent);
    for (const [id, n] of extents) el(id)?.classList.toggle("on", extent === n);
    updateEmptyNotes();
    if (box) {
      const c: Vec3 = [(box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2, (box.lo[2] + box.hi[2]) / 2];
      const ext: Vec3 = [box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]];
      // slices: zoom each orientation to the bbox's in-plane extents (u/v axes per orientation)
      if (refit) {
        const fov = (a: number, b: number) => [Math.max(30, ext[a] * SLICE_MARGIN), Math.max(30, ext[b] * SLICE_MARGIN)] as const;
        const [axU, axV] = fov(0, 1); sc.slice.setMirrorFrame("axial", c, axU, axV);
        const [coU, coV] = fov(0, 2); sc.slice.setMirrorFrame("coronal", c, coU, coV);
        const [saU, saV] = fov(1, 2); sc.slice.setMirrorFrame("sagittal", c, saU, saV);
      } else {
        for (const o of ORIENTS) sc.slice.recenter(o, c);
      }
      frameCamera(c, Math.hypot(ext[0], ext[1], ext[2]) / 2 * 1.15, !refit);
    } else if (refit) {
      for (const o of ORIENTS) sc.slice.resetView(o);
      frameCamera(sc.center, sc.radius);
    }
    requestDraw();
  };
  /** The vertebra whose centroid is nearest `p`, across both methods. */
  const nearestLevel = (p: Vec3): number | null => {
    let best: number | null = null, bd = Infinity;
    for (const row of sc.rows) {
      for (const [l, g] of row.levels) {
        if (isDisc(l)) continue;
        const d = Math.hypot(g.centroid[0] - p[0], g.centroid[1] - p[1], g.centroid[2] - p[2]);
        if (d < bd) { bd = d; best = l; }
      }
    }
    return best;
  };
  for (const [id, n] of extents) {
    el(id)?.addEventListener("click", () => {
      extent = n;
      // A scoped extent needs a level to scope AROUND. With none chosen the chip used to light up
      // and nothing else happened — the view only switched once an arrow key happened to select
      // one. Fall back to the level nearest the crosshair (the volume centre on a fresh load).
      if (n < 99 && currentLevel == null) {
        const l = nearestLevel(xhair.ras ?? sc.center);
        if (l != null) { selectLevel(l, true); return; }
      }
      applyFocus(true);          // the MODE changed — reframe to the new amount of spine
    });
  }

  const nameToLabel = Object.fromEntries(Object.entries(LEVEL_NAME).map(([n, s]) => [s, Number(n)]));
  const strip = el("levels");
  /** Move the focus to `label`. The views FOLLOW it at the zoom they already have — stepping down
   *  the spine should not keep refitting under you. They reframe only when the extent mode changes,
   *  including the implicit full-spine -> one-vertebra that a level click means. */
  const selectLevel = (label: number, refit = false) => {
    currentLevel = label;
    const modeChanged = extent >= 99;
    if (modeChanged) extent = 0;                // a level click means "show me this bone"
    const g = sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label);
    if (g) { xhair.set(g.centroid); jumpAll(g.centroid); }
    applyFocus(refit || modeChanged);
    for (const bb of strip.querySelectorAll("button")) {
      bb.classList.toggle("sel", (bb as HTMLElement).dataset.label === String(label));
    }
  };
  const detail = entry?.levels ?? {};
  const order = Object.keys(LEVEL_NAME).map(Number).sort((a, b) => {
    const rank = (l: number) => l === 28 ? 19.5 : l;   // T13 sits after T12
    return rank(a) - rank(b);
  });
  const levelSeq: number[] = [];   // strip order — drives ◀ ▶ and arrow keys
  const stepLevel = (delta: number) => {
    if (!levelSeq.length) return;
    const i = currentLevel == null ? (delta > 0 ? 0 : levelSeq.length - 1)
      : Math.max(0, Math.min(levelSeq.length - 1, levelSeq.indexOf(currentLevel) + delta));
    if (levelSeq[i] !== currentLevel) selectLevel(levelSeq[i]);
  };
  const navBtn = (txt: string, delta: number, title: string) => {
    const b = document.createElement("button");
    b.className = "lvlnav";
    b.textContent = txt;
    b.title = title;
    b.addEventListener("click", () => stepLevel(delta));
    strip.appendChild(b);
    return b;
  };
  navBtn("◀", -1, "previous level (←)");
  for (const label of order) {
    const name = LEVEL_NAME[label];
    const d = detail[name];
    const g = sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label);
    if (!d && !g) continue;
    const b = document.createElement("button");
    const dice = d?.d;   // payload detail stores Dice vs the SAME-named reference level
    b.className = "lvl " + (dice == null ? "nodata" : dice >= 0.7 ? "good" : dice >= 0.3 ? "warn" : "bad");
    b.dataset.label = String(label);
    const best = d && d.b !== name && d.db != null ? ` ${d.db.toFixed(2)}` : "";
    b.innerHTML = `${name}${dice != null ? `<span>${dice.toFixed(2)}</span>` : ""}${d && d.b !== name ? `<em>→${d.b}${best}</em>` : ""}`;
    b.title = d
      ? (d.b !== name
        ? `Dice ${dice?.toFixed(3)} vs same-named reference — but as ${d.b} it matches with Dice ${d.db?.toFixed(3) ?? "?"} (label shift)`
        : `Dice ${dice?.toFixed(3)} vs the same-named reference level`)
      : "no reference at this level";
    b.addEventListener("click", () => selectLevel(label));
    strip.appendChild(b);
    levelSeq.push(label);
  }
  navBtn("▶", 1, "next level (→)");
  // deep-link: ?level=T8 opens already focused on that vertebra (the dashboard drilldown
  // passes the axis column the user clicked, so an outlier is one click away)
  const startLevel = PARAMS.get("level");
  if (startLevel != null && nameToLabel[startLevel] != null) {
    const l = nameToLabel[startLevel];
    if (sc.rows[0].levels.get(l) ?? sc.rows[1].levels.get(l)) selectLevel(l);
  }
  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;   // don't hijack the case filter
    if (e.key === "ArrowLeft") { e.preventDefault(); stepLevel(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepLevel(1); }
    // embedded in the dashboard's drilldown: Esc lands here when the scene has focus —
    // forward it so the modal can close
    else if (e.key === "Escape" && globalThis.parent !== globalThis) {
      globalThis.parent.postMessage({ type: "closeDrill" }, "*");
    }
  });

  // ── chrome: layer toggles (tri-state opacity, SEGRoulette-style) on the rows ─
  const controls: VizControl[] = [
    { label: "SPINEPS segmentation", getOpacity: () => sc.methodOpacity("spineps"), setOpacity: (o) => { sc.setMethodOpacity("spineps", o); requestDraw(); }, color: METHOD_COLORS.spineps },
    { label: "Reference segmentation", getOpacity: () => sc.methodOpacity("ref"), setOpacity: (o) => { sc.setMethodOpacity("ref", o); requestDraw(); }, color: METHOD_COLORS.ref },
    { label: "CT volume (3D)", getOpacity: () => sc.volumeOpacity(), setOpacity: (o) => { sc.setVolumeOpacity(o); drawAll3d(); }, color: [0.75, 0.78, 0.85] },
    { label: "Discs (SPINEPS)", getOpacity: () => sc.discOpacity(), setOpacity: (o) => { sc.setDiscOpacity(o); requestDraw(); }, color: DISC_COLOR },
    // Surface smoothing — the reconstruction width of the band-limited label field the surface is
    // the 0.5 level set of. This is a REVIEW tool, so the bottom of the range matters as much as the
    // top: at σ=0 the surface follows the labelmap voxel for voxel, which is what you need to see
    // when judging whether SPINEPS and the reference disagree about actual voxels; smoothing it
    // up turns the same labels into a modelled surface, which is what you need when several
    // vertebrae are on screen and the question is which bone is which.
    {
      label: "Surface smoothing",
      slider: {
        min: 0,
        max: 2,
        step: 0.25,
        get: () => sc.segSmoothing(),
        set: (v) => { sc.setSegSmoothing(v); drawAll3d(); },
        format: (v) => (v > 0 ? `σ ${v.toFixed(2)} vox` : "voxels"),
      },
    },
  ];
  installChrome({ controls, anchor: cv["c-ref-threeD"].parentElement ?? undefined });

  // ── header info + case selector ────────────────────────────────────────────
  const cmp = entry?.compare;
  const mem = sc.memory();
  // When the 3D grid was coarsened to fit the GPU, the surfaces being compared are lower-resolution
  // than the data. A reviewer has to be told that in the view, not left to infer it.
  const memNote = budgetWasReduced()
    ? ` · reduced GPU budget after a device loss — 3D surfaces at ${mem.rows[0]?.match(/@ ([\d.]+mm)/)?.[1] ?? "lower res"}`
    : mem.coarsened
    ? ` · 3D surfaces coarsened to ${mem.rows[0]?.match(/@ ([\d.]+mm)/)?.[1] ?? "fit"} to fit GPU memory`
    : "";
  el("info").textContent =
    `${coll}/${pid} · ${cmp ? `${cmp.n_agree}/${cmp.n_ref_labels} agree · ${cmp.n_shifted} shifted · mean Dice ${cmp.mean_dice_same?.toFixed(3)}` : "no compare record"}${memNote}`;

  // Case button (upper right) → dropdown selector over all 121 cases, worst
  // agreement first. Picking one navigates (?case=…) — a case load rebuilds
  // the whole scene anyway, so a clean reload is the honest implementation.
  const caseBtn = el("case-btn") as HTMLButtonElement;
  const panel = el("case-panel");
  const listEl = el("case-list");
  const search = el("case-search") as HTMLInputElement;
  caseBtn.textContent = `${coll}/${pid} ▾`;
  const sorted = [...casesDoc.cases].sort((a, b) =>
    (a.compare?.mean_dice_same ?? 2) - (b.compare?.mean_dice_same ?? 2));   // worst agreement first
  const renderList = (filter = "") => {
    const f = filter.trim().toLowerCase();
    listEl.innerHTML = "";
    for (const c of sorted) {
      if (f && !c.pid.toLowerCase().includes(f) && !c.collection.includes(f)) continue;
      const m = c.compare;
      const dice = m?.mean_dice_same;
      const cls = dice == null ? "" : dice < 0.3 ? "bad" : dice < 0.7 ? "warn" : "good";
      const b = document.createElement("button");
      b.className = "crow" + (c.pid === pid && c.collection === coll ? " cur" : "");
      b.innerHTML = `<span class="pid">${c.pid}</span><span class="pill ${c.collection}">${c.collection}</span>` +
        `<span class="st ${cls}">${m ? `${m.n_agree}/${m.n_ref_labels} · ${m.n_shifted}⇅ · ${dice?.toFixed(2)}` : "—"}</span>`;
      b.title = m ? `${m.n_agree}/${m.n_ref_labels} levels agree · ${m.n_shifted} shifted · mean Dice ${dice?.toFixed(3)}` : "no compare record";
      b.addEventListener("click", () => { location.search = `?case=${c.pid}&coll=${c.collection}`; });
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
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) togglePanel(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") togglePanel(false); });

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const c of Object.values(cv)) {
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
    }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  resize();
  status(`${coll}/${pid} ready — click a vertebra to focus it, scroll a slice, drag any 3D to orbit (linked), shift+move to crosshair`);

  // Embedded-in-dashboard integration: level chips postMessage {type:"jumpLevel", name}.
  globalThis.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { type?: string; name?: string; delta?: number } | null;
    if (d?.type === "stepLevel" && typeof d.delta === "number") { stepLevel(d.delta); return; }
    if (d?.type !== "jumpLevel" || !d.name) return;
    const label = nameToLabel[d.name];
    if (label != null && (sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label))) selectLevel(label);
  });

  // introspection for automated tests (numeric ground truth over screenshots)
  (globalThis as unknown as { __cmpDbg: unknown }).__cmpDbg = {
    ready: () => true,
    dims: () => sc.dims,
    center: () => sc.center,
    offsets: () => ({ ...off }),
    crosshair: () => xhair.ras,
    camera: () => ({ position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp], viewAngle: camera.viewAngle }),
    setCamera: (p: number[], f: number[], up?: number[], va?: number[] | number) => {
      camera.position = [p[0], p[1], p[2]];
      camera.focalPoint = [f[0], f[1], f[2]];
      if (up) camera.viewUp = [up[0], up[1], up[2]];
      if (typeof va === "number") camera.viewAngle = va;
      drawAll3d();
    },
    // Raw scene handles, for bisecting a render artifact from the console/CDP without going
    // through the UI (which refits the camera every time the extent changes).
    scenes: () => sc.rows.map((r) => r.scene),
    redraw: () => drawAll3d(),
    levels: (k: MethodKey) => [...rowOf(k).levels.values()].filter((g) => g.label < 100).map((g) => ({ label: g.label, name: g.name, voxels: g.voxels, centroid: g.centroid })),
    jumpLevel: (name: string) => {
      const label = nameToLabel[name];
      if (label == null) return null;
      const g = sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label);
      if (g) selectLevel(label);
      return g?.centroid ?? null;
    },
    zoom: (o: Orientation) => sc.slice.zoom(o),
    zoomAbout: (o: Orientation, f: number) => {
      const c = cv[`c-ref-${o}`];
      sc.slice.zoomAbout(o, f, 0.5, 0.5, c.width || 1, c.height || 1);
      requestDraw();
    },
    visibleLevels: (k: MethodKey) => sc.visibleLevels(k),
    currentLevel: () => currentLevel,
    stepLevel: (d: number) => stepLevel(d),
    extent: () => extent,
    setExtent: (n: number) => { extent = n; applyFocus(true); },   // matches the chip: a mode change reframes
    methodOpacity: (k: MethodKey) => sc.methodOpacity(k),
    setMethodOpacity: (k: MethodKey, o: number) => { sc.setMethodOpacity(k, o); requestDraw(); },
    smoothing: () => sc.segSmoothing(),
    setSmoothing: (v: number) => { sc.setSegSmoothing(v); drawAll3d(); },
    discOpacity: () => sc.discOpacity(),
    mem: () => sc.memory(),
    setDiscOpacity: (v: number) => { sc.setDiscOpacity(v); requestDraw(); },
  };
}

main().catch((e) => status("error: " + ((e as Error)?.message ?? e), true));
