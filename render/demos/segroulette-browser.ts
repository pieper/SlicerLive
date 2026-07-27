// Browser entry for SlicerLive SEGRoulette: spin a random IDC series (CT/MR/PET +
// DICOM SEG), load it client-side with idc_tools (dcmjs in a worker, straight from the
// IDC public buckets), and render a 4-up — 3 MPR planes (grayscale + colored seg
// overlay) + a 3D view where the segmentation is the SegmentField `iso` band-shell
// (step-derived isosurface). The WebGPU-native replacement for the vtk.js roulette.
// Bundled to live/webgpu/segroulette.js (idc-worker.js sits next to it).
import { initDevice } from "../device.ts";
import { slicerDefaultOffset01 } from "../slice-renderer.ts";
import { SliceInteractor } from "../slice-interactor.ts";
import { buildSegrouletteScene, type SegrouletteScene } from "./segroulette-scene.ts";
import { type Crosshair4up, mountCrosshair } from "./crosshair.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { attachSliceControls } from "./slice-control.ts";
import { attachDoubleClick, attachViewGrid } from "./view-grid.ts";
import { installChrome, type VizControl } from "./sl-chrome.ts";
import { installIdcInfo } from "./idc-info.ts";
import { createMosaic } from "./mosaic.ts";
import { loadManifest, loadSeries, ohifViewerURL, spinRandom } from "../vendor/idc_tools/index.js";
import type { LoadResult, RouletteManifest, SeriesEntry } from "../vendor/idc_tools/types.js";
import type { Vec3 } from "../mat4.ts";

const MANIFEST = "../legacy/segroulette.json";   // reuse the existing roulette manifest (2MB, cache-busted)

// URL params for reproducible testing (reload the page to re-run a case, like the old SEGRoulette):
//   ?s=<segSeriesUUID>   load one specific SEG series (looked up in the manifest for its source+buckets)
//   ?col=<collection>    spin randomly but only within this IDC collection (e.g. ?col=nlst)
const PARAMS = new URLSearchParams(location.search);
const SEG_PARAM = PARAMS.get("s") || PARAMS.get("seg") || "";
const COL_PARAM = PARAMS.get("col") || "";
let cachedManifest: RouletteManifest | null = null;

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLElement;
const cvEl = (id: string) => document.getElementById(id) as HTMLCanvasElement;

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "coronal", "sagittal", "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = cvEl("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  const planes = [
    { cell: "axial", orient: "axial" },
    { cell: "coronal", orient: "coronal" },
    { cell: "sagittal", orient: "sagittal" },
  ] as const;

  let rs: SegrouletteScene | null = null;
  let sliceIx: SliceInteractor | null = null;   // Slicer-faithful voxel stepping, rebuilt per case
  const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };
  // Shared Slicer-faithful 3D camera (framedCamera + attachCameraControls), same as every other
  // demo — so the trackball direction and feel are identical everywhere. Reframed on each spin.
  const camera = framedCamera([0, 0, 0], 100);
  const drawSlice = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }) => {
    if (!rs || !cv[p.cell].width) return;
    rs.slice.setPlane(p.orient, off[p.cell]);
    rs.slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    if (!rs || !cv.threeD.width) return;
    rs.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
    rs.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  let xhair: Crosshair4up | null = null;
  const drawAll = () => { for (const p of planes) drawSlice(p); draw3d(); xhair?.redraw(); };

  // SHARED shift-move crosshair pick — same one-call mount every MPR demo uses. Getters keep it
  // valid across a spin (the scene/slice are rebuilt underneath while the canvases persist).
  const nAxisOf: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
  const jumpAll = (ras: Vec3) => {
    if (!rs) return;
    for (const p of planes) {
      const a = nAxisOf[p.orient];
      off[p.cell] = Math.max(0, Math.min(1, (ras[a] - rs.rasLo[a]) / (rs.rasHi[a] - rs.rasLo[a])));
    }
    drawAll();
  };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) { cv[n].width = Math.floor(cv[n].clientWidth * dpr); cv[n].height = Math.floor(cv[n].clientHeight * dpr); }   // hidden (maximized-away) cell -> 0, skipped by draw*
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  // shared double-click-to-maximize (view-grid): slice cells via attachSliceControls onDoubleClick,
  // the 3D cell via attachDoubleClick. Full-page 2x2 like the real demo.
  const grid = attachViewGrid(document.getElementById("grid")!, names, resize);
  attachDoubleClick(cv.threeD, () => grid.toggleMax("threeD"));

  // Shared chrome: SlicerLive logo popup with the two independent 3D layer toggles (modality volume
  // render + segmentation) + the "?" help cheat-sheet. Layer state persists across spins.
  const layers = { volume: true, seg: true };
  const applyLayers = () => { rs?.setLayers(layers.volume, layers.seg); draw3d(); xhair?.redraw(); };
  const controls: VizControl[] = [
    { label: "Volume render", get: () => layers.volume, set: (on) => { layers.volume = on; applyLayers(); } },
    { label: "Segmentation", get: () => layers.seg, set: (on) => { layers.seg = on; applyLayers(); }, disabled: () => !(rs?.hasSeg) },
  ];
  const chrome = installChrome({ controls });

  // IDC download mosaic (slice thumbnails fill in as the DICOM streams) + the "Details" dialog
  // (citation / license / OHIF + IDC-portal links / full segment list).
  const mosaic = createMosaic(document.querySelector("main")!);
  let lastEntry: (SeriesEntry & Record<string, unknown>) | undefined;
  installIdcInfo(el("details-host"), {
    getEntry: () => lastEntry,
    getSegments: () => rs?.segments ?? [],
    ohifURL: ohifViewerURL,
  });

  // Compact single-line metadata in the thin header (full segment list -> info dialog, later).
  const showMeta = (entry: SeriesEntry | undefined, sc: SegrouletteScene) => {
    const info = el("info");
    if (!info) return;
    const n = sc.segments.length;
    info.innerHTML =
      `<span class="col">${entry?.col ?? "IDC"}</span><span class="mod">${entry?.m ?? ""}</span>` +
      `<span class="sd">${entry?.sd ?? "segmentation"}</span>` +
      `<span class="n">· ${n} segment${n === 1 ? "" : "s"}${entry?.lic ? " · " + entry.lic : ""}</span>`;
  };

  const spinBtn = el("spin") as HTMLButtonElement;
  // Load handlers: status text + the download mosaic (per-slice thumbnails as they stream in).
  const handlers = {
    onProgress: (p: { msg: string; frac?: number }) => { status(`${p.msg}${p.frac ? ` — ${Math.round(p.frac * 100)}%` : ""}`); mosaic.status(p.msg); },
    onSliceCount: (n: number) => mosaic.setCount(n),
    onThumb: (n: number, w: number, h: number, rgba: ArrayBuffer) => mosaic.thumb(n, w, h, rgba),
  };

  // ?s= loads one specific SEG (looked up in the manifest); ?col= narrows the random pool; else all.
  async function pickAndLoad(): Promise<LoadResult> {
    if (SEG_PARAM) {
      cachedManifest ??= await loadManifest(MANIFEST);
      const entry = cachedManifest.rows.find((e) => e.s === SEG_PARAM || (e.s ?? "").startsWith(SEG_PARAM));
      if (!entry) throw new Error(`SEG series "${SEG_PARAM}" not found in the manifest`);
      return loadSeries(entry, handlers);
    }
    return spinRandom(handlers, { manifestUrl: MANIFEST, filter: COL_PARAM ? (e) => e.col === COL_PARAM : undefined });
  }

  async function spin() {
    spinBtn.disabled = true;
    mosaic.reset();
    status(SEG_PARAM ? "loading the requested SEG series…" : COL_PARAM ? `spinning within ${COL_PARAM}…` : "spinning… picking a random IDC series");
    try {
      const res: LoadResult = await pickAndLoad();
      lastEntry = res.entry as (SeriesEntry & Record<string, unknown>) | undefined;
      status("baking segmentation iso shells…");
      rs = buildSegrouletteScene(gpu, srgb, res.ct, res.seg);
      // frame: slices at the Slicer default voxel-centre plane; camera fit to the volume
      sliceIx = new SliceInteractor({ ijkToRAS: rs.ijkToRAS, rasLo: rs.rasLo, rasHi: rs.rasHi });
      for (const p of planes) off[p.cell] = slicerDefaultOffset01(p.orient, rs.dims, rs.ijkToRAS, rs.rasLo, rs.rasHi);
      const framed = framedCamera(rs.center, rs.radius);   // Slicer-default framing for this case
      camera.position = framed.position; camera.focalPoint = framed.focalPoint;
      camera.viewUp = framed.viewUp; camera.viewAngle = framed.viewAngle;
      layers.volume = true; layers.seg = rs.hasSeg; chrome.refresh();   // reset 3D layer toggles per case
      showMeta(res.entry, rs);
      const d3 = document.querySelector(".lab.d3");
      if (d3) d3.textContent = rs.mode === "colorized" ? "3D · colorized volume" : rs.mode === "iso" ? "3D · SegmentField iso" : "3D · volume";
      resize();
      mosaic.done();   // scene is up → fade out the download mosaic
      const modeNote = rs.mode === "colorized" ? ` (colorized — too many for per-segment iso)` : "";
      status(`${res.entry?.col ?? "IDC"} · ${res.entry?.m ?? ""} · ${rs.segments.length} segment${rs.segments.length === 1 ? "" : "s"}${modeNote} · scroll a slice, drag 3D to orbit · Spin for another`);
    } catch (e) {
      mosaic.status("load failed — try Spin again"); mosaic.done();
      status("load failed: " + ((e as Error)?.message ?? e) + " — try Spin again", true);
    } finally {
      spinBtn.disabled = false;
    }
  }
  spinBtn.addEventListener("click", spin);
  if (SEG_PARAM) spinBtn.textContent = "↻ Reload";
  else if (COL_PARAM) spinBtn.textContent = `🎲 ${COL_PARAM}`;

  // slice interaction = the SHARED attachSliceControls (scroll + pan/zoom + contextmenu suppression),
  // the same one the real demo will use — so right-drag zoom, two-finger/ctrl-wheel zoom and pan all
  // behave identically and no browser context menu hijacks the right-drag.
  for (const p of planes) {
    attachSliceControls(cv[p.cell], {
      orient: p.orient,
      getSlice: () => rs!.slice,
      step: (fwd) => { if (sliceIx) off[p.cell] = sliceIx.wheel(p.orient, off[p.cell], fwd); },
      redraw: () => { drawSlice(p); xhair?.redraw(); },
      hooks: { onDoubleClick: () => { grid.toggleMax(p.cell); return true; } },
    });
  }
  // 3D trackball = the SHARED Slicer-faithful camera controls (identical direction + feel as every
  // other demo): left=rotate, shift/middle=pan, right=zoom, wheel=dolly. Shift+move (no button)
  // falls through to the crosshair pick (mountCrosshair), since a pick needs no drag.
  attachCameraControls(cv.threeD, camera, { onChange: () => { draw3d(); xhair?.redraw(); } });

  xhair = mountCrosshair({
    cells: { axial: cv.axial, coronal: cv.coronal, sagittal: cv.sagittal, threeD: cv.threeD },
    getScene: () => rs!.scene,
    getSlice: () => rs!.slice,
    getCamera: () => camera,
    getOffset: (o) => off[o],
    onJump: jumpAll,
  });

  // introspection for automated tests
  (globalThis as unknown as { __segDbg: unknown }).__segDbg = {
    ready: () => !!rs,
    segments: () => rs?.segments ?? [],
    center: () => rs?.center ?? null,
    crosshair: () => xhair?.state.ras ?? null,
    pick3D: (u: number, v: number) => rs?.scene.pick(u, v) ?? null,
    camera: () => ({ position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp] }),
    mode: () => rs?.mode ?? null,
    params: () => ({ s: SEG_PARAM, col: COL_PARAM }),
    sliceZoom: (o: "axial" | "coronal" | "sagittal") => rs?.slice.zoom(o) ?? 1,
    hasSeg: () => rs?.hasSeg ?? false,
    setLayers: (v: boolean, s: boolean) => { rs?.setLayers(v, s); draw3d(); xhair?.redraw(); },
  };

  status("SlicerLive SEGRoulette — click Spin to load a random IDC segmentation");
  await spin();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
