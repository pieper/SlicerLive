// Cardiac example — browser entry. Wires the scene into the shared SlicerLive chrome:
// 4-up MPR + 3D, Slicer-faithful trackball and default slice planes, shared shift-move
// crosshair, adaptive budget-scaled interaction with temporal-AA convergence on idle.
//
// Two pieces are specific to this example:
//   - the preset picker, which rewrites the 256-entry LUT in place (no pipeline rebuild)
//   - the cine transport, whose frame advance is just a kick() into the existing
//     moving/settled loop, so playback gets cheap frames and a pause converges
//     (docs/SEQUENCES-CINE.md §4.2)

import { initDevice } from "../../render/device.ts";
import { buildCardiacScene, type CardiacScene } from "./cardiac-scene.ts";
import { slicerDefaultOffset01 } from "../../render/slice-renderer.ts";
import { SliceInteractor } from "../../render/slice-interactor.ts";
import { VtkCamera } from "../../render/vtk-camera.ts";
import { attachCameraControls } from "../../render/demos/camera-control.ts";
import { attachSliceControls } from "../../render/demos/slice-control.ts";
import { attachViewGrid, attachDoubleClick } from "../../render/demos/view-grid.ts";
import { mountAdaptive3d } from "../../render/demos/accum-loop.ts";
import { mountCrosshair } from "../../render/demos/crosshair.ts";
import { attachWidgetControls, type Handle } from "../../render/demos/widget-control.ts";
import { installChrome } from "../../render/demos/sl-chrome.ts";
import { CineFilmstrip } from "../../render/cine-filmstrip.ts";
import type { Box, HandleMeta } from "../../render/demos/roi-widget.ts";
import { CARDIAC_PRESETS, PRESET_NAMES } from "./presets.ts";
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
    // COPY_DST lets CineFilmstrip copy a fully converged frame in without a blit pass.
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
}

let mb = 0;
status("loading cardiac data…");
const sc: CardiacScene = await buildCardiacScene(gpu, "data/", srgb, (n) => {
  mb += n;
  status(`loading… ${(mb / 1e6).toFixed(1)} MB`);
});

// The chamber-interior seed point, computed during prep by eroding the contrast pool.
const seedRAS: Vec3 = await (async () => {
  const s = await (await fetch("data/cta.json")).json();
  const v = Object.values(s.nodes as Record<string, { class: string; attrs?: Record<string, unknown> }>)
    .find((n) => n.class === "vtkMRMLScalarVolumeNode");
  return (v?.attrs?.endovascularSeedRAS as Vec3) ?? sc.center;
})();

// ---- slice planes ---------------------------------------------------------------------
let rasLo: Vec3, rasHi: Vec3, sliceIx: SliceInteractor;
const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };
function resetPlanes() {
  const dims = sc.mode() === "cta" ? sc.ctaDims : sc.cineDims;
  const ijk = sc.mode() === "cta" ? sc.ctaIjkToRAS : sc.cineIjkToRAS;
  [rasLo, rasHi] = (sc.mode() === "cta" ? sc.cta : sc.cine).aabb();
  for (const o of SLICES) off[o] = slicerDefaultOffset01(o, dims, ijk, rasLo, rasHi);
  sliceIx = new SliceInteractor({ ijkToRAS: ijk, rasLo, rasHi });
}
resetPlanes();

const shown = (n: Cell) => cv[n].width > 0 && cv[n].height > 0;

// Converged-frame cache for the cine (declared early: resize/setMode/applyPreset drop it).
const strip = new CineFilmstrip(gpu, preferred, srgb, sc.cine.frameCount, 24);
let lastShown = -1;
const drawPlane = (o: typeof SLICES[number]) => {
  if (!shown(o)) return;
  sc.slice.setPlane(o, off[o]);
  sc.slice.renderToView(cx[o].getCurrentTexture().createView({ format: srgb }), cv[o].width, cv[o].height);
};
const drawSlices = () => { for (const o of SLICES) drawPlane(o); };

// ---- 3D ---------------------------------------------------------------------------------
const camera = VtkCamera.slicerDefault();
const frameCamera = () => {
  camera.focalPoint = [...sc.center] as Vec3;
  camera.position = [sc.center[0], sc.center[1] + sc.radius * 2.6, sc.center[2]] as Vec3;
  camera.viewUp = [0, 0, 1];
  camera.viewAngle = 30;
};
frameCamera();

const a3d = mountAdaptive3d({
  scene: () => sc.scene,
  view: () => cx.threeD.getCurrentTexture().createView({ format: srgb }),
  size: () => ({ w: shown("threeD") ? cv.threeD.width : 0, h: cv.threeD.height }),
  setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
  gpu,
  movingScaleCap: 0.75,        // 512^3 DVR: interactive from the first drag frame
  onFrame: () => cross.redraw(),
});
const draw3d = () => a3d.draw();
const draw3dNow = () => a3d.renderSettled(true);
// (camera controls are attached further down, once invalidateStrip exists)

// ---- crosshair + grid --------------------------------------------------------------------
const cross = mountCrosshair({
  cells: cv,
  getScene: () => sc.scene,
  getSlice: () => sc.slice,
  getCamera: () => camera,
  getOffset: (o) => off[o],
  onJump: (ras) => {
    const axis: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
    for (const o of SLICES) {
      const a = axis[o];
      off[o] = Math.max(0, Math.min(1, (ras[a] - rasLo[a]) / (rasHi[a] - rasLo[a])));
    }
    drawSlices();
    draw3d();
  },
});

const resize = () => {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  for (const n of NAMES) {
    cv[n].width = Math.floor(cv[n].clientWidth * dpr);
    cv[n].height = Math.floor(cv[n].clientHeight * dpr);
  }
  strip?.invalidate();
  drawSlices();
  draw3dNow();
};
globalThis.addEventListener("resize", resize);
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

// ---- preset picker -------------------------------------------------------------------------
const presetSel = $("preset") as HTMLSelectElement;
for (const n of PRESET_NAMES) {
  if (n === "MR-Default") continue;                 // CT data only in this example
  const o = document.createElement("option");
  o.value = n; o.textContent = n;
  presetSel.appendChild(o);
}
const applyPreset = (name: string) => {
  presetSel.value = name;
  sc.setPreset(name);
  strip?.invalidate();
  $("blurb").textContent = CARDIAC_PRESETS[name].blurb;
  drawSlices();
  draw3dNow();
};
presetSel.onchange = () => applyPreset(presetSel.value);

// ---- mode: static CTA vs 4D cine ------------------------------------------------------------
const setMode = (m: "cta" | "cine") => {
  sc.setMode(m);
  resetPlanes();
  frameCamera();
  strip?.invalidate();
  lastShown = -1;
  for (const o of ["cta", "cine"]) $(`mode-${o}`).classList.toggle("on", o === m);
  $("transport").style.display = m === "cine" ? "flex" : "none";
  ($("flyBtn") as HTMLElement).style.display = m === "cta" ? "inline-block" : "none";
  // In motion the standard cardiac preset (blood pool opaque) reads better than the
  // endovascular inversion, which is meant for a camera parked inside a chamber.
  applyPreset(m === "cine" ? "CT-Cardiac3" : "CT-EndoVascular");
  status(m === "cine"
    ? "4D cine · 10 cardiac phases · press play"
    : "static CTA 512×512×321 · try “fly inside”");
};
for (const m of ["cta", "cine"] as const) ($(`mode-${m}`) as HTMLButtonElement).onclick = () => setMode(m);

// ---- "fly inside" — the JACC paper's endovascular view ----------------------------------------
($("flyBtn") as HTMLButtonElement).onclick = () => {
  applyPreset("CT-EndoVascular");
  camera.position = [...seedRAS] as Vec3;
  camera.focalPoint = [seedRAS[0], seedRAS[1] - 50, seedRAS[2]] as Vec3;   // look posterior
  camera.viewUp = [0, 0, 1];
  camera.viewAngle = 80;                                                    // wide, endoscope-like
  draw3dNow();
  status("inside the blood pool — contrast is transparent, so you are looking at endocardium. Drag to look around.");
};

// ---- cine transport ---------------------------------------------------------------------------
const scrub = $("scrub") as HTMLInputElement;
const fps = $("fps") as HTMLInputElement;
const playBtn = $("playBtn") as HTMLButtonElement;
scrub.max = String(sc.cine.frameCount - 1);

// Every animated frame must be FULLY CONVERGED before it is shown. The temporal accumulator
// averages successive traces of the same view, so letting it run across a frame change
// blends phase N into N+1 and the heart smears; resetting per frame instead leaves each
// frame at one jittered sample, which is visibly speckled. So each phase is converged once
// offscreen into a filmstrip and playback presents finished stills.

// Integer phase only: a fractional blend would need its own cache entry, and stepping
// through converged phases reads better than smooth-but-noisy interpolation.
const selectFrame = (i: number) => {
  sc.cine.setFrame(i, sc.browser.playbackLooped);
  sc.scene.refreshBindings();   // frames all resident — this only re-points the bind group
  sc.scene.syncUniforms();
};
const invalidateStrip = () => strip.invalidate();

const setFrameUi = (i: number) => {
  scrub.value = String(i);
  $("frameLbl").textContent = `${i + 1}/${sc.cine.frameCount}`;
};
const showFrameSlices = (i: number) => {
  selectFrame(i);
  sc.slice.setTextures(sc.cine.volumeTexture());
  drawSlices();
  setFrameUi(i);
};
scrub.oninput = () => {
  sc.browser.playbackActive = false;
  playBtn.textContent = "▶ play";
  sc.browser.setSelectedItemNumber(Number(scrub.value));
  showFrameSlices(sc.browser.selectedItemNumber);
};
fps.oninput = () => {
  sc.browser.playbackRateFps = Number(fps.value);
  $("fpsLbl").textContent = `${fps.value} fps`;
};
playBtn.onclick = () => {
  sc.browser.playbackActive = !sc.browser.playbackActive;
  playBtn.textContent = sc.browser.playbackActive ? "❚❚ pause" : "▶ play";
};

// One driver for cine mode: build the strip while idle, then play converged frames from it.
// Camera drags invalidate the strip (via onChange below) and fall through to the live
// adaptive loop, so interaction stays immediate and re-converges when you let go.
let acc = 0, lastT = 0;
const tickCine = (msNow: number) => {
  requestAnimationFrame(tickCine);
  if (sc.mode() !== "cine" || !shown("threeD")) { lastT = msNow; return; }
  strip.ensureSize(cv.threeD.width, cv.threeD.height);

  if (!strip.complete) {
    // Converge the next phase. setCamera first: the strip renders at the 3D view's size.
    sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
    const done = strip.step(sc.scene, selectFrame, 4);
    if (done >= 0) { strip.present(done, cx.threeD.getCurrentTexture()); lastShown = done; }
    const p = strip.progress();
    status(p.done
      ? `4D cine · ${p.total} phases, each fully converged · press play`
      : `converging phase ${p.building + 1} of ${p.total} — every animated frame is converged before it is shown (${p.ready} ready)`);
    lastT = msNow;
    return;
  }

  if (sc.browser.playbackActive) {
    // Wall-clock advance with frame dropping — the arithmetic vtkSlicerSequencesLogic uses.
    const dt = lastT ? (msNow - lastT) / 1000 : 0;
    lastT = msNow;
    acc += dt * sc.browser.playbackRateFps;
    const inc = Math.floor(acc);
    if (inc > 0) {
      acc -= inc;
      sc.browser.selectNextItem(sc.browser.playbackItemSkippingEnabled ? inc : 1);
    }
  } else lastT = msNow;

  const i = sc.browser.selectedItemNumber;
  if (i !== lastShown) {
    if (strip.present(i, cx.threeD.getCurrentTexture())) {
      lastShown = i;
      showFrameSlices(i);
      cross.redraw();
    }
  }
};
requestAnimationFrame(tickCine);

// ---- ROI crop box: drag handles, and the SlicerLive badge that switches it on -----------------
// Slicer's Volume Rendering module has exactly these two switches, so they carry the same names.
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
    invalidateStrip();
  },
  onHover: (h) => { sc.roi.setHover(h ? h.id : null); sc.scene.syncUniforms(); },
  onChange: draw3d,
});

const chrome = installChrome({
  anchor: cv.threeD.parentElement ?? undefined,
  controls: [
    {
      label: "Enable cropping",
      get: () => sc.cropEnabled(),
      set: (on) => { sc.setCropEnabled(on); invalidateStrip(); draw3dNow(); },
    },
    {
      label: "Display ROI",
      get: () => sc.roiVisible(),
      set: (on) => { sc.setRoiVisible(on); invalidateStrip(); draw3dNow(); },
    },
  ],
  onChange: () => { drawSlices(); draw3dNow(); },
});

// Anything that changes what a converged frame looks like must drop the filmstrip.
attachCameraControls(cv.threeD, camera, { onChange: () => { invalidateStrip(); draw3d(); } });

// Dev hook, in the style of seged's window.seged — lets a CDP driver assert on real state
// instead of eyeballing screenshots, and makes bugs like "the slice plane is out of range"
// diagnosable without a rebuild.
(globalThis as unknown as { cardiac: unknown }).cardiac = {
  state: () => ({
    mode: sc.mode(), preset: sc.presetName(),
    off: { ...off }, rasLo, rasHi,
    frame: sc.browser.selectedItemNumber, frames: sc.cine.frameCount,
    playing: sc.browser.playbackActive, fps: sc.browser.playbackRateFps,
    crop: sc.cropEnabled(), roiVisible: sc.roiVisible(), strip: strip.progress(),
    sizes: Object.fromEntries(NAMES.map((n) => [n, [cv[n].width, cv[n].height]])),
  }),
  drawSlices, draw3dNow, resize,
  setOffset: (o: typeof SLICES[number], v: number) => { off[o] = v; drawPlane(o); },
  setMode, applyPreset,
  setCrop: (on: boolean) => { sc.setCropEnabled(on); invalidateStrip(); chrome.refresh(); draw3dNow(); },
  setRoi: (on: boolean) => { sc.setRoiVisible(on); invalidateStrip(); chrome.refresh(); draw3dNow(); },
};

setMode("cta");
// Canvases are sized from their client rect, which is only correct after the first layout.
// Sizing on rAF (not synchronously at module end) is what makes the first frame appear.
requestAnimationFrame(() => resize());
