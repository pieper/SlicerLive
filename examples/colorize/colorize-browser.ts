// Colorize-volume demo — browser entry.
//
// One NLST chest/abdomen CT plus its 86-structure TotalSegmentator label volume, rendered as a
// single ColorizeField. The RGBA is composed per sample in the shader rather than baked, which
// is what makes the popup's group sliders live: fading "all vertebrae" is a 1 KB palette write,
// not a re-bake of a 55-million-voxel volume.
//
// The popup carries three kinds of control, in the order you reach for them:
//   - CT transfer function (combobox) — how the UNLABELLED body is drawn, and how much the CT
//     modulates each segment's brightness
//   - Volume rendering + crop — the two switches Slicer's Volume Rendering module has
//   - Organ groups — one opacity slider per group, covering all 86 segments between them

import { initDevice } from "../../render/device.ts";
import { buildColorizeScene, type ColorizeScene } from "./colorize-scene.ts";
import { slicerDefaultOffset01 } from "../../render/slice-renderer.ts";
import { SliceInteractor } from "../../render/slice-interactor.ts";
import { VtkCamera } from "../../render/vtk-camera.ts";
import { attachCameraControls } from "../../render/demos/camera-control.ts";
import { attachSliceControls } from "../../render/demos/slice-control.ts";
import { attachViewGrid, attachDoubleClick } from "../../render/demos/view-grid.ts";
import { mountAdaptive3d } from "../../render/demos/accum-loop.ts";
import { mountCrosshair } from "../../render/demos/crosshair.ts";
import { attachWidgetControls, type Handle } from "../../render/demos/widget-control.ts";
import { installChrome, type VizControl } from "../../render/demos/sl-chrome.ts";
import type { Box, HandleMeta } from "../../render/demos/roi-widget.ts";
import { CT_PRESET_NAMES } from "./ct-presets.ts";
import type { Vec3 } from "../../render/mat4.ts";

type Cell = "axial" | "coronal" | "sagittal" | "threeD";
const NAMES: readonly Cell[] = ["axial", "coronal", "sagittal", "threeD"];
const SLICES = ["axial", "coronal", "sagittal"] as const;
const $ = (id: string) => document.getElementById(id)!;
const status = (s: string) => { $("status").textContent = s; };

const gpu = await initDevice();
const preferred = navigator.gpu.getPreferredCanvasFormat();
const srgb = (preferred.endsWith("-srgb") ? preferred : preferred + "-srgb") as GPUTextureFormat;
const cv = {} as Record<Cell, HTMLCanvasElement>;
const cx = {} as Record<Cell, GPUCanvasContext>;
for (const n of NAMES) {
  cv[n] = $("c-" + n) as HTMLCanvasElement;
  cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
  cx[n].configure({
    device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
}

// `?data=data/` runs against a local prep.py output; the published page streams from the
// public CORS-enabled JS2 container so the gallery repo carries no imaging data.
const DATA_BASE = new URLSearchParams(location.search).get("data") ??
  "https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive/colorize/";

// Download progress. Two streams: the segmentation (~0.6 MB, first, so it can render while you
// wait) then the CT (~61 MB). Both get the bar, because a bar that only starts moving after the
// first stream finishes reads as a hang.
//
// LoadProgress.bytes is cumulative (colorize-scene sums fetchZarrVolume's per-chunk deltas), and
// the totals come from the manifest, which records the compressed size prep.py actually wrote —
// so the percentage is against real bytes rather than a guess.
const barFill = $("barfill"), loadPct = $("loadpct"), loadWrap = $("loadwrap");
const loadTitle = $("loadtitle"), loadSub = $("loadsub");
let ctStart = 0;
const fmt = (b: number) => (b / 1048576).toFixed(1);
const onProgress = (p: { bytes: number; total: number; what: "ct" | "labels"; done?: boolean }) => {
  const frac = p.total ? Math.min(1, p.bytes / p.total) : 0;
  barFill.style.width = `${Math.max(2, frac * 100).toFixed(1)}%`;
  if (p.what === "labels") {
    loadPct.textContent = p.done
      ? "segmentation ready — fetching the CT…"
      : `segmentation  ${fmt(p.bytes)} / ${fmt(p.total)} MB`;
    return;
  }
  // Time the CT from its FIRST byte, not from page load: the segmentation fetch happens first,
  // and including it would understate the rate and inflate the estimate.
  if (!ctStart) ctStart = performance.now();
  const secs = (performance.now() - ctStart) / 1000;
  const rate = secs > 0.25 ? p.bytes / secs / 1048576 : 0;
  const left = rate > 0.05 ? (p.total - p.bytes) / 1048576 / rate : NaN;
  // The `done` event fires after the volume is decoded and uploaded to the GPU, so elapsed time
  // has grown while bytes have not — recomputing the rate there reports a fraction of the real
  // download speed. Drop the rate and the estimate once there is nothing left to wait for.
  const settling = p.done || frac >= 0.995;
  loadPct.textContent =
    `${fmt(p.bytes)} / ${fmt(p.total)} MB  ·  ${(frac * 100).toFixed(0)}%` +
    (rate > 0 && !settling ? `  ·  ${rate.toFixed(1)} MB/s` : "") +
    (Number.isFinite(left) && !settling ? `  ·  ${left < 1 ? "<1" : left.toFixed(0)}s left` : "") +
    (p.done ? "  ·  decoding" : "");
};

status("loading segmentation…");
const sc: ColorizeScene = await buildColorizeScene(gpu, DATA_BASE, srgb, onProgress);

// The scene resolves as soon as the LABELS are in: the segmentation renders as flat coloured
// surfaces straight away and the CT fills in underneath it.
loadTitle.textContent = "Streaming the CT…";
loadSub.textContent = "86 structures are already rendered as surfaces — the CT adds the anatomy behind them";
sc.ctReady.then(() => {
  loadWrap.classList.add("done");
  setTimeout(() => { loadWrap.style.display = "none"; }, 600);
  status(readyMsg());
  drawSlices();
  draw3d();
});

// ---- slice planes ---------------------------------------------------------------------
let rasLo: Vec3, rasHi: Vec3, sliceIx: SliceInteractor;
const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };
{
  [rasLo, rasHi] = sc.field.aabb();
  const ijk = sc.manifest.ijkToRAS;
  for (const o of SLICES) off[o] = slicerDefaultOffset01(o, sc.dims, ijk, rasLo, rasHi);
  sliceIx = new SliceInteractor({ ijkToRAS: ijk, rasLo, rasHi });
}

const shown = (n: Cell) => cv[n].width > 0 && cv[n].height > 0;
const drawPlane = (o: typeof SLICES[number]) => {
  if (!shown(o)) return;
  sc.slice.setPlane(o, off[o]);
  sc.slice.renderToView(cx[o].getCurrentTexture().createView({ format: srgb }), cv[o].width, cv[o].height);
};
const drawSlices = () => { for (const o of SLICES) drawPlane(o); };

// ---- 3D ---------------------------------------------------------------------------------
const camera = VtkCamera.slicerDefault();
camera.focalPoint = [...sc.center] as Vec3;
// +y is anterior in RAS, so this looks at the front of the patient — heart, liver and the
// front of the rib cage. From -y you get the spine and scapulae, which reads as the back of a
// skeleton rather than a body.
camera.position = [sc.center[0], sc.center[1] + sc.radius * 2.4, sc.center[2]] as Vec3;
camera.viewUp = [0, 0, 1];
camera.viewAngle = 30;

const a3d = mountAdaptive3d({
  scene: () => sc.scene,
  view: () => cx.threeD.getCurrentTexture().createView({ format: srgb }),
  size: () => ({ w: shown("threeD") ? cv.threeD.width : 0, h: cv.threeD.height }),
  setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
  gpu,
  movingScaleCap: 0.7,        // 55 M voxels with two texture fetches per sample
  onFrame: () => cross.redraw(),
});
const draw3d = () => a3d.draw();
const draw3dNow = () => a3d.renderSettled(true);
const converge = (n = 32) => { for (let i = 0; i < n; i++) a3d.renderSettled(i === 0); };

// ---- crosshair -----------------------------------------------------------------------------
const SLICE_AXIS: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
function scrollSlicesTo(ras: Vec3) {
  for (const o of SLICES) {
    const a = SLICE_AXIS[o];
    off[o] = Math.max(0, Math.min(1, (ras[a] - rasLo[a]) / (rasHi[a] - rasLo[a])));
  }
  drawSlices();
}
const cross = mountCrosshair({
  cells: cv,
  getScene: () => sc.scene,
  getSlice: () => sc.slice,
  getCamera: () => camera,
  getOffset: (o) => off[o],
  onJump: (ras) => { scrollSlicesTo(ras); cross.state.set([...ras] as Vec3); reportStructure(ras); draw3d(); },
});

/** Name whatever structure the picked point lands in — the label volume already knows, so a
 *  shift-move doubles as "what am I looking at?" without any extra machinery. */
const labelAt = (ras: Vec3): number => {
  const m = sc.manifest.ijkToRAS;
  // invert the 3x4 affine by solving with the transpose of the rotation (columns are orthogonal
  // but not unit, so divide by each column's squared length)
  const col = (c: number): Vec3 => [m[c], m[4 + c], m[8 + c]];
  const t: Vec3 = [ras[0] - m[3], ras[1] - m[7], ras[2] - m[11]];
  const idx: number[] = [];
  for (let c = 0; c < 3; c++) {
    const v = col(c);
    const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    idx.push(Math.round((t[0] * v[0] + t[1] * v[1] + t[2] * v[2]) / len2));
  }
  return sc.labelValue(idx[0], idx[1], idx[2]);
};
function reportStructure(ras: Vec3) {
  const n = labelAt(ras);
  const s = sc.segments.find((x) => x.num === n);
  $("hover").innerHTML = s
    ? `<b>${s.name}</b> · ${ras.map((v) => v.toFixed(0)).join(", ")} mm`
    : `unlabelled · ${ras.map((v) => v.toFixed(0)).join(", ")} mm`;
}

const resize = () => {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  for (const n of NAMES) {
    cv[n].width = Math.floor(cv[n].clientWidth * dpr);
    cv[n].height = Math.floor(cv[n].clientHeight * dpr);
  }
  drawSlices();
  draw3d();
};
globalThis.addEventListener("resize", resize);
// A window resize event is not the only way a cell changes size: maximising a pane, a devtools
// split, or a viewport override all resize the element without one. Observing the cells keeps
// the drawing buffer matched to the layout whatever moved it, so the view can never come up at
// the wrong size. Guarded against the resize->observer->resize loop by only acting on a real
// pixel-size change.
const lastPx = new Map<Cell, string>();
if ("ResizeObserver" in globalThis) {
  const ro = new ResizeObserver(() => {
    let changed = false;
    for (const n of NAMES) {
      const k = `${cv[n].clientWidth}x${cv[n].clientHeight}`;
      if (lastPx.get(n) !== k) { lastPx.set(n, k); changed = true; }
    }
    if (changed) resize();
  });
  for (const n of NAMES) ro.observe(cv[n]);
}
const grid = attachViewGrid($("grid"), NAMES, resize);
attachDoubleClick(cv.threeD, () => grid.toggleMax("threeD"));
for (const o of SLICES) {
  attachSliceControls(cv[o], {
    orient: o,
    getSlice: () => sc.slice,
    step: (fwd) => { off[o] = sliceIx.wheel(o, off[o], fwd); },
    redraw: () => { drawPlane(o); cross.redraw(); },
    hooks: { onDoubleClick: () => { grid.toggleMax(o); return true; } },
  });
}
attachCameraControls(cv.threeD, camera, { onChange: draw3d });

// ---- header preset picker (mirrors the popup combobox) --------------------------------------
const presetSel = $("preset") as HTMLSelectElement;
for (const n of CT_PRESET_NAMES) {
  const o = document.createElement("option");
  o.value = n; o.textContent = n;
  presetSel.appendChild(o);
}
const applyPreset = (name: string) => {
  presetSel.value = name;
  sc.setPreset(name);
  $("blurb").textContent = `${name} — drives the unlabelled body and modulates segment brightness`;
  drawSlices();
  draw3d();
  chrome.refresh();
};
presetSel.onchange = () => applyPreset(presetSel.value);

// ---- ROI crop widget ------------------------------------------------------------------------
let box0: Box = sc.roi.snapshot();
attachWidgetControls(cv.threeD, camera, {
  getHandles: (): Handle[] =>
    sc.roiVisible() ? sc.roi.handleList().map((h) => ({ id: h.id, world: h.world, data: h.data, cursor: h.cursor })) : [],
  getSize: () => ({ w: cv.threeD.width, h: cv.threeD.height }),
  onDragStart: () => { box0 = sc.roi.snapshot(); },
  onDrag: (h, world) => {
    const d: Vec3 = [world[0] - h.world[0], world[1] - h.world[1], world[2] - h.world[2]];
    sc.roi.applyDrag(h.data as HandleMeta, box0, d);
    if (sc.cropEnabled()) sc.scene.setClipBox(sc.roi.lo(), sc.roi.hi());
    sc.scene.syncUniforms();
  },
  onHover: (h) => { sc.roi.setHover(h ? h.id : null); sc.scene.syncUniforms(); },
  onChange: draw3d,
});

// ---- the SlicerLive popup ---------------------------------------------------------------------
// Group sliders come from the manifest, so the popup always matches the data rather than a
// hand-written list that can drift out of sync with what was segmented.
const groupControls: VizControl[] = sc.groups.map((g) => ({
  label: g.name,
  section: "Organ groups",
  getOpacity: () => sc.groupOpacity(g.name),
  setOpacity: (o) => { sc.setGroupOpacity(g.name, o); draw3d(); },
  // tint the chip with the group's first segment so the row reads at a glance
  color: sc.segments.find((s) => s.num === g.segments[0])?.color ?? [0.62, 0.9, 1.0],
}));

const chrome = installChrome({
  anchor: cv.threeD.parentElement ?? undefined,
  selects: [{
    label: "CT transfer function",
    section: "Volume rendering",
    options: CT_PRESET_NAMES.map((n) => ({ value: n, label: n })),
    get: () => sc.presetName(),
    set: (v) => applyPreset(v),
  }],
  controls: [
    {
      label: "Unlabelled body",
      section: "Volume rendering",
      getOpacity: () => sc.contextOpacity(),
      setOpacity: (o) => { sc.setContextOpacity(o); draw3d(); },
      color: [0.8, 0.8, 0.85],
    },
    {
      label: "Enable cropping",
      section: "Crop",
      get: () => sc.cropEnabled(),
      set: (on) => { sc.setCropEnabled(on); draw3d(); },
    },
    {
      label: "Display ROI",
      section: "Crop",
      get: () => sc.roiVisible(),
      set: (on) => { sc.setRoiVisible(on); draw3d(); },
    },
    ...groupControls,
  ],
  onChange: () => { drawSlices(); draw3d(); },
});

applyPreset("CT-Soft-Tissue");
requestAnimationFrame(() => {
  resize();
  converge(8);
  status(`${sc.segments.length} structures as surfaces · CT streaming…`);
});

function readyMsg() {
  const s = sc.manifest.source;
  return `NLST ${s.patientID} · ${sc.dims[0]}×${sc.dims[1]}×${sc.dims[2]} · ` +
    `${sc.segments.length} TotalSegmentator structures in ${sc.groups.length} groups`;
}

// Dev hook — a CDP driver asserts on real state instead of eyeballing screenshots.
(globalThis as unknown as { colorize: unknown }).colorize = {
  state: () => ({
    preset: sc.presetName(),
    groups: Object.fromEntries(sc.groups.map((g) => [g.name, sc.groupOpacity(g.name)])),
    context: sc.contextOpacity(),
    crop: sc.cropEnabled(), roiVisible: sc.roiVisible(),
    ctLoaded: sc.ctLoaded(),
    segments: sc.segments.length,
    dims: sc.dims,
    accumN: sc.scene.accumCount(),
    cameraPos: [...camera.position], focal: [...camera.focalPoint], viewAngle: camera.viewAngle,
    center: [...sc.center], radius: sc.radius, aabb: sc.field.aabb(),
    sampleStep: sc.field.sampleStep(),
    off: { ...off },
    sizes: Object.fromEntries(NAMES.map((n) => [n, [cv[n].width, cv[n].height]])),
  }),
  setPreset: applyPreset,
  setGroupOpacity: (g: string, o: number) => { sc.setGroupOpacity(g, o); draw3d(); },
  setContextOpacity: (o: number) => { sc.setContextOpacity(o); draw3d(); },
  setCrop: (on: boolean) => { sc.setCropEnabled(on); chrome.refresh(); draw3dNow(); },
  setRoi: (on: boolean) => { sc.setRoiVisible(on); chrome.refresh(); draw3dNow(); },
  labelAt,
  setOverlayOpacity: (o: number) => { sc.slice.setOverlayOpacity(o); drawSlices(); },
  setOutlineOpacity: (o: number) => { (sc.slice as unknown as { u: Float32Array }).u[31] = o; drawSlices(); },
  drawSlices, draw3dNow, converge, resize,
  scene: () => sc.scene,
};
