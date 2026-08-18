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
import { attachEndoscopyControls, type Cruise, type EndoscopyControls } from "../../render/endoscopy-control.ts";
import { attachSliceControls } from "../../render/demos/slice-control.ts";
import { attachViewGrid, attachDoubleClick } from "../../render/demos/view-grid.ts";
import { mountAdaptive3d } from "../../render/demos/accum-loop.ts";
import { mountCrosshair } from "../../render/demos/crosshair.ts";
import { attachWidgetControls, type Handle } from "../../render/demos/widget-control.ts";
import { installChrome } from "../../render/demos/sl-chrome.ts";
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
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });
}

// ---- visible download progress ------------------------------------------------------------
// The whole payload is ~70 MB from a bucket, so silence is not acceptable. The overlay bar
// tracks the CINE only (10 phases, ~13 MB): the page opens on the cine and the 57 MB CTA is
// lazy, so this bar reflects exactly what you are waiting for.
const CINE_BYTES = 13.2e6;                 // measured payload of the 10 phases
let mb = 0;
const barFill = $("barfill"), loadPct = $("loadpct"), loadWrap = $("loadwrap"), pips = $("pips");
const setBar = (frac: number, label: string) => {
  barFill.style.width = `${Math.max(2, Math.min(100, frac * 100)).toFixed(1)}%`;
  loadPct.textContent = label;
};
/** One pip per cardiac phase, lit as it lands — progress you can count, not just a bar. */
const setPips = (loaded: number, total: number) => {
  if (pips.childElementCount !== total) {
    pips.innerHTML = "";
    for (let i = 0; i < total; i++) pips.appendChild(document.createElement("span"));
  }
  [...pips.children].forEach((el, i) => el.classList.toggle("on", i < loaded));
};
// Assigned once the scene exists; the loader keeps calling back while phases stream in.
let onPhaseLoaded: ((n: number) => void) | null = null;
status("loading cardiac data…");
// Where the zarr lives. The published demo streams from a public, CORS-enabled JS2 bucket
// (69.7 MB, 466 objects) rather than shipping data in the gallery repo. `?data=<url>` repoints
// it — e.g. `?data=data/` to run against a local prep.ts output next to the page.
const DATA_BASE = new URLSearchParams(location.search).get("data") ??
  "https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive/cardiac/";

// Two gallery entries share this bundle: the beating-heart cine and the endovascular flythrough.
// Each page sets window.CARDIAC_DEMO before loading the module, and we then fetch ONLY that
// page's dataset (13 MB vs 57 MB) instead of both.
const DEMO = ((globalThis as unknown as { CARDIAC_DEMO?: string }).CARDIAC_DEMO ??
  new URLSearchParams(location.search).get("demo") ?? "cine") as "cine" | "endo";
const ENDO = DEMO === "endo";
const TOTAL_BYTES = ENDO ? 57e6 : CINE_BYTES;
const sc: CardiacScene = await buildCardiacScene(gpu, DATA_BASE, srgb, (p) => {
  mb += p.bytes;
  if (ENDO) {
    setBar(mb / TOTAL_BYTES, `${(mb / 1e6).toFixed(0)} of ~57 MB`);
    status(`loading… ${(mb / 1e6).toFixed(1)} MB`);
    return;
  }
  if (p.what !== "cine") return;
  setBar(Math.max(mb / CINE_BYTES, p.frames / p.totalFrames),
    `${p.frames} of ${p.totalFrames} phases · ${(mb / 1e6).toFixed(1)} MB`);
  setPips(p.frames, p.totalFrames);
  status(`loading… ${(mb / 1e6).toFixed(1)} MB`);
  if (p.bytes === 0) onPhaseLoaded?.(p.frames);   // bytes==0 marks a phase finishing
}, { only: ENDO ? "cta" : "cine" });

// The chamber-interior seed point, computed during prep by eroding the contrast pool.
// Start pose: inside the DISTAL DESCENDING AORTA at the inferior edge of the volume, looking
// superiorly up the lumen — the long tunnel view. Read out of a live session rather than
// derived, because the automatic seed (deepest point of the contrast pool) lands mid-chamber
// where there is no tunnel to fly down.
const SEED_POS: Vec3 = [-33.922, -4.023, -200.459];
const SEED_DIR: Vec3 = [0.0376, 0.05, 0.998];      // essentially +S, up the descending aorta
const seedRAS: Vec3 = SEED_POS;

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

// ---- endovascular flight ------------------------------------------------------------------
let endo: EndoscopyControls | null = null;   // non-null only while flying
let flying = false;
// Clearance along the CURRENT direction of travel, refreshed asynchronously (a GPU readback
// must never block the input path, so the interactor always uses the previous frame's value).
let clearanceAhead = Infinity;
let probedDir: Vec3 = [0, 0, 1];
let probeInFlight = false;
let lastGoodPos: Vec3 | null = null;         // to recover if we escape the blood pool
let escapeChecks = 0;
const MARGIN_MM = 6;

// ---- autopilot: shift-click a target, fly toward it as far as the lumen allows ----------
// Deliberately a LOCAL steering behaviour, not a global path search. Each update it probes a
// fan of directions around the bearing to the target and takes the one that best trades
// progress against clearance. That gets you through a curved vessel or around a valve without
// segmenting anything — and when no direction makes progress it stops and says so, which is
// the honest answer to "or as close as the blood pool allows".
let autoTarget: Vec3 | null = null;
let autoDir: Vec3 | null = null;        // current best heading
let autoBusy = false;
let autoTicks = 0;
let autoStuck = 0;

// ---- depth seeking -------------------------------------------------------------------------
// While travelling forward, sample a coarse DEPTH MAP of the current view (a grid of the same
// 50%-opacity picks the crosshair uses) and steer gently toward its maximum — the direction in
// which the lumen continues furthest. That is what makes the flight follow a vessel round a
// bend instead of driving into the outer wall. Suppressed briefly after any manual look, so it
// never fights the user for control of the camera.
// The crosshair is a LEAD POINT a fixed distance in front of the camera along a temporally
// smoothed heading — not the raw depth-map hit. The hit lands ON a wall tens of mm away, so
// using it directly put the crosshair (and the slice planes) on tissue rather than in the
// lumen, which read as "pointing at a wall". A 1 cm lead sits inside the vessel and the
// smoothing lets it lean into a bend gradually instead of snapping between samples.
const LEAD_MM = 10;
const AIM_SMOOTH = 1.6;               // rad/s of turn toward the newest sample
let seekTarget: Vec3 | null = null;   // the LEAD point (what all views show)
let seekDir: Vec3 | null = null;      // raw direction of the latest depth maximum
let seekDist = 0;                     // how far that maximum was; caps the lead in tight vessels
let aimDir: Vec3 | null = null;       // smoothed heading; drives both the crosshair and steering
let leadTicks = 0;
let seekBusy = false;
let seekTicks = 0;
let manualLookAt = 0;

// Accumulation depth of the phase currently held in the cine accumulator. Declared here
// because everything that changes the image resets it. `var` so the later cine block's
// bookkeeping and these early resets are the same binding regardless of source order.
let accN = 0;
/** Restart the current accumulation — anything that changes what the image should look like. */
const invalidateStrip = () => { accN = 0; };

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
  // Exterior DVR of a 512^3 volume needs the resolution cut to stay interactive while dragging.
  // The endovascular view does not: rays terminate at the vessel wall within a few cm, so a
  // full-resolution pass costs ~6 ms even at a very fine step (measured — see setStepForView).
  // Upscaling there would only blur a frame we can afford to trace properly.
  movingScaleCap: ENDO ? 1 : 0.75,
  // In cine mode tickCine owns the canvas and the accumulator; the adaptive loop must never
  // render there — two consumers of SceneRenderer's single accumulator means flashing phases.
  onFrame: () => { if (sc.mode() === "cine") adaptiveFramesInCine++; cross.redraw(); },
});
let adaptiveFramesInCine = 0;
// ONE owner of the 3D canvas at a time. SceneRenderer has a SINGLE accumulation state
// (accumN / accumTex) and mountAdaptive3d's convergence check reads that same accumCount(),
// so two consumers interleave and flash each other's content. In cine mode tickCine owns the
// view outright and the adaptive loop stays inert.
const draw3d = () => { if (sc.mode() !== "cine") a3d.draw(); };   // kick (CTA mode only)
const draw3dNow = () => a3d.renderSettled(true);   // one immediate step (tests/debug)
/** Render straight to full convergence — used by the CDP driver for a like-for-like
 *  comparison against a VTK still, where waiting on the idle timer is not wanted. */
const converge = (n = 32) => { for (let i = 0; i < n; i++) a3d.renderSettled(i === 0); };
// (camera controls are attached further down, once camMoved exists)

// ---- crosshair + grid --------------------------------------------------------------------
const cross = mountCrosshair({
  cells: cv,
  getScene: () => sc.scene,
  getSlice: () => sc.slice,
  getCamera: () => camera,
  getOffset: (o) => off[o],
  onJump: (ras) => { scrollSlicesTo(ras); setMarker(ras); draw3d(); },
});

// Scrolling the planes and placing the crosshair are SEPARATE: in flight the slices follow the
// CAMERA, but the crosshair marks the point we are flying TOWARD. Conflating them meant every
// camera change reset the marker to the camera position — which projects to a degenerate point
// on screen, so the crosshair appeared to wander instead of sitting on the tunnel opening.
const SLICE_AXIS: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
function scrollSlicesTo(ras: Vec3) {
  for (const o of SLICES) {
    const a = SLICE_AXIS[o];
    off[o] = Math.max(0, Math.min(1, (ras[a] - rasLo[a]) / (rasHi[a] - rasLo[a])));
  }
  drawSlices();
}
function setMarker(ras: Vec3) {
  cross.state.set([...ras] as Vec3);
  cross.redraw();
}
/** The single point all four views agree on: what the camera is LOOKING AT — the autopilot
 *  target, else the depth-seek target, else (nothing in view) the camera itself. Slices scroll
 *  there and the crosshair marks it, so the MPRs show the anatomy ahead rather than the plane
 *  the camera happens to sit in. */
function focusPoint(fallback: Vec3): Vec3 {
  return seekTarget ?? fallback;   // the 1 cm lead point; see LEAD_MM
}
function jumpSlicesTo(cameraPos: Vec3) {
  const p = focusPoint(cameraPos);
  scrollSlicesTo(p);
  setMarker(p);
}

const resize = () => {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  for (const n of NAMES) {
    cv[n].width = Math.floor(cv[n].clientWidth * dpr);
    cv[n].height = Math.floor(cv[n].clientHeight * dpr);
  }
  accN = 0;
  drawSlices();
  draw3d();
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
  accN = 0;
  $("blurb").textContent = CARDIAC_PRESETS[name].blurb;
  drawSlices();
  draw3d();
};
presetSel.onchange = () => applyPreset(presetSel.value);

// ---- mode: static CTA vs 4D cine ------------------------------------------------------------
const ctaBar = $("ctabar"), ctaFill = $("ctafill"), ctaText = $("ctatext");
let ctaMb = 0;
const CTA_BYTES = 57e6;
/** The CTA is fetched on first use; show its own inline bar while it streams. */
const loadCtaIfNeeded = async (): Promise<boolean> => {
  if (sc.ctaLoaded()) return true;
  ctaBar.style.display = "flex"; ctaMb = 0;
  ctaText.textContent = "loading CTA…";
  await sc.ensureCta((p) => {
    ctaMb += p.bytes;
    ctaFill.style.width = `${Math.min(100, (ctaMb / CTA_BYTES) * 100).toFixed(1)}%`;
    ctaText.textContent = `loading CTA… ${(ctaMb / 1e6).toFixed(0)} MB`;
  });
  ctaBar.style.display = "none";
  return true;
};

const setMode = (m: "cta" | "cine") => {
  if (flying) { endo?.detach(); endo = null; flying = false; $("cruise").textContent = ""; }
  sc.setMode(m);
  resetPlanes();
  frameCamera();
  accN = 0;
  for (const o of ["cta", "cine"]) $(`mode-${o}`).classList.toggle("on", o === m);
  $("transport").style.display = m === "cine" ? "flex" : "none";
  ($("flyBtn") as HTMLElement).style.display = m === "cta" ? "inline-block" : "none";
  // In motion the standard cardiac preset (blood pool opaque) reads better than the
  // endovascular inversion, which is meant for a camera parked inside a chamber.
  applyPreset(m === "cine" ? "CT-Coronary-Arteries-3" : "CT-EndoVascular");
  status(m === "cine"
    ? "4D cine · 10 cardiac phases · press play"
    : "static CTA 512×512×321 · try “fly inside”");
};
for (const m of ["cta", "cine"] as const) {
  ($(`mode-${m}`) as HTMLButtonElement).onclick = async () => {
    if (m === "cta") { sc.browser.playbackActive = false; playBtn.textContent = "▶ play"; await loadCtaIfNeeded(); }
    setMode(m);
  };
}

// ---- "fly inside" — the JACC paper's endovascular view ----------------------------------------
/** Enter endovascular flight: park the camera in the blood pool and hand the 3D view to the
 *  first-person interactor. The orbit controls stay attached but are inert while flying (see
 *  `flying` guard in their onChange) — attaching both to one canvas would fight over drags. */
/** Put the flying camera at a pose from Slicer: position, view direction, and up. Shared by
 *  entering flight and by the first pose to arrive once a flight is already under way. */
function seatFlight(p: { pos: Vec3; fp: Vec3; up: Vec3; va?: number }): void {
  camera.position = [...p.pos] as Vec3;
  camera.viewUp = [...p.up] as Vec3;
  const v: Vec3 = [p.fp[0] - p.pos[0], p.fp[1] - p.pos[1], p.fp[2] - p.pos[2]];
  const l = Math.hypot(v[0], v[1], v[2]);
  lastGoodPos = [...p.pos] as Vec3;
  aimDir = null; seekDir = null; seekTarget = null;   // the old heading belongs to the old pose
  if (l > 1e-6) endo?.lookAlong([v[0] / l, v[1] / l, v[2] / l]);
  jumpSlicesTo(camera.position);
  draw3d();
}

// ---- flight speed ---------------------------------------------------------------------------
// A header control rather than a popup one: speed is the thing you adjust WHILE flying, and the
// SlicerLive popup opens over the 3D view, so it would hide what you are steering.
// Only endo.html carries the markup — cardiac.html shares this bundle, hence the null checks.
const speedEl = document.getElementById("speed") as HTMLInputElement | null;
const speedLbl = document.getElementById("speedLbl");
const DEFAULT_SPEED = 8;                       // mm/s
const flightSpeed = () => (speedEl ? Number(speedEl.value) : DEFAULT_SPEED);
const showSpeed = () => { if (speedLbl) speedLbl.textContent = `${flightSpeed()} mm/s`; };
if (speedEl) {
  speedEl.value = String(DEFAULT_SPEED);
  showSpeed();
  speedEl.oninput = () => {
    showSpeed();
    endo?.setSpeed(flightSpeed());             // live: takes effect on the next tick
  };
}

const startFlight = async () => {
  if (!sc.ctaLoaded()) { await loadCtaIfNeeded(); setMode("cta"); }
  applyPreset("CT-EndoVascular");
  // Prefer wherever Slicer's camera is parked — the point of the mrson follow is that you aim
  // the start of the flight by hand in Slicer. The baked seed is the fallback, and it is what
  // the published demo always uses since there is no Slicer behind it.
  const fromSlicer = followedPose;
  flightFromSlicer = !!fromSlicer;
  camera.position = [...seedRAS] as Vec3;
  camera.viewUp = [0, 1, 0];                                // +A up; roll is free from here
  camera.viewAngle = 80;                                    // wide, endoscope-like
  flying = true;
  lastGoodPos = [...camera.position] as Vec3;
  endo?.detach();
  endo = attachEndoscopyControls(cv.threeD, camera, {
    speedMmPerSec: flightSpeed(),
    marginMm: MARGIN_MM,
    referenceUp: [0, 0, 1],
    onChange: () => { jumpSlicesTo(camera.position); draw3d(); },
    onLook: () => { manualLookAt = performance.now(); },
    onState: (c) => showCruise(c),
    // Rails, forward only for now: pick(0.5,0.5) is the ray straight ahead, so it already
    // answers "how far to the wall?" without any renderer change. Sideways/backward
    // clearance needs a general probe(origin, dir) and is not wired yet.
    // Rails. The probe is fired for whatever direction we are actually travelling, so this
    // works for reverse as well as forward — pick(u,v) could only ever see what is on screen.
    clearance: (dir) => (dot3(dir, probedDir) > 0.9 ? clearanceAhead : Infinity),
  });
  endo.setSpeed(flightSpeed());
  endo.lookAlong(SEED_DIR);                                 // up the aorta
  if (fromSlicer) seatFlight(fromSlicer);
  status(fromSlicer ? "flight started from Slicer's camera" : "flight started from the aortic seed");
  jumpSlicesTo(camera.position);
  showCruise("stopped");
  draw3d();
};
($("flyBtn") as HTMLButtonElement).onclick = startFlight;

// Shift+CLICK in the 3D view sets an autopilot target. (Shift+MOVE already drives the shared
// crosshair via mountCrosshair; a click is the distinct, deliberate gesture.) The pick is the
// same 50%-opacity GPU trace the crosshair uses, so the target lands on the wall you aimed at.
cv.threeD.addEventListener("pointerdown", (e) => {
  if (!flying || e.button !== 0 || !e.shiftKey) return;
  const r = cv.threeD.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  e.preventDefault();
  sc.scene.pick(u, v).then((ras) => { if (ras) setAutoTarget(ras); });
});

const keysDown = new Set<string>();
globalThis.addEventListener("keydown", (e) => {
  keysDown.add(e.key);
  // any turn key counts as the user taking over the heading
  if (["ArrowLeft", "ArrowRight"].includes(e.key)) manualLookAt = performance.now();
});
globalThis.addEventListener("keyup", (e) => keysDown.delete(e.key));

const forwardDir = (): Vec3 => {
  const d: Vec3 = [
    camera.focalPoint[0] - camera.position[0],
    camera.focalPoint[1] - camera.position[1],
    camera.focalPoint[2] - camera.position[2],
  ];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
};
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const showCruise = (c: Cruise) => {
  const label = c === "forward" ? "▶ forward" : c === "back" ? "◀ back" : "■ stopped";
  $("cruise").textContent = label;
  $("cruise").className = c === "stopped" ? "" : "on";
  status(`endovascular flight · ${label} · ${flightSpeed()} mm/s · ↑↓ in/out · ←→ yaw · shift ←→ pitch · ctrl ←→ roll · space cruise`);
};

// Cine rendering: accumulate the CURRENT phase live, every frame, with no precomputation.
//
// This replaced a precomputed "filmstrip" of converged phases. That design was built on a
// wrong premise — that we could not render fast enough to converge during playback — and it
// cost exactly what Slicer does well: you could not rotate while playing, because a camera
// move invalidated every cached phase and playback stalled until they rebuilt.
//
// Measured (cine volume, 1184x820, single pass, no accumulation):
//     step 0.575 mm (what Slicer uses: half the voxel spacing)   7.1 ms   140 fps
//     step 0.402 mm                                              9.7 ms   103 fps
//     step 0.287 mm                                             13.0 ms    77 fps
// Slicer itself renders single-pass with UseJittering=0, AutoAdjustSampleDistances=0 — one
// clean pass, no accumulation, hence its speed (and its banding).
//
// So at 10 fps playback there is a ~100 ms budget per displayed phase and a pass costs ~7 ms:
// roughly 14 accumulation passes are free. We hold the phase, accumulate into it until the
// phase is due to advance, and reset on any phase or camera change. Result: converged-looking
// playback that stays fully interactive, with nothing to invalidate.
const scrub = $("scrub") as HTMLInputElement;
const fps = $("fps") as HTMLInputElement;
const playBtn = $("playBtn") as HTMLButtonElement;
scrub.max = String(sc.cine.frameCount - 1);

const selectFrame = (i: number) => {
  sc.cine.setFrame(i, sc.browser.playbackLooped);
  sc.scene.refreshBindings();
  sc.scene.syncUniforms();
};
let shownFrame = -1;      // phase currently held in the accumulator
let renderInFlight = false;
const SETTLE_TARGET = 48; // passes to converge to when paused

const showFrameSlices = (i: number) => {
  sc.slice.setTextures(sc.cine.volumeTexture());
  drawSlices();
  scrub.value = String(i);
  $("frameLbl").textContent = `${i + 1}/${sc.cine.frameCount}`;
};
scrub.oninput = () => {
  sc.browser.playbackActive = false;
  playBtn.textContent = "▶ play";
  sc.browser.setSelectedItemNumber(Number(scrub.value));
};
fps.oninput = () => {
  sc.browser.playbackRateFps = Number(fps.value);
  $("fpsLbl").textContent = `${fps.value} fps`;
};
playBtn.onclick = () => {
  sc.browser.playbackActive = !sc.browser.playbackActive;
  playBtn.textContent = sc.browser.playbackActive ? "❚❚ pause" : "▶ play";
  status(`4D cine · phase ${sc.browser.selectedItemNumber + 1}/${sc.cine.frameCount}` +
         (sc.browser.playbackActive ? ` · playing at ${sc.browser.playbackRateFps} fps` : " · converging"));
};

let acc = 0, lastT = 0;
let lastCamMove = 0;
const camMoved = () => { lastCamMove = performance.now(); accN = 0; };   // restart this phase's mean

// Converged frames use a finer ray step than interactive ones (0.5x voxel spacing is what
// Slicer uses, and measured FASTER here than our old 0.7x default).
let stepMmNow = 0;
const setStep = (mm: number) => {
  if (Math.abs(mm - stepMmNow) < 1e-6) return;
  stepMmNow = mm;
  sc.scene.setSampleStep(mm);
  accN = 0;                       // never mix step sizes within one accumulated mean
};

// Ray step per view, chosen from measurement rather than one global default.
//
// A single ray-march pass with a jittered start is a one-sample estimate: the jitter buys us
// freedom from banding and pays for it in speckle, which only accumulation averages out. While
// flying, the camera moves every frame, so accumulation never gets a chance and the speckle is
// all you see. The fix is to make the single pass itself accurate.
//
// Inside a vessel that is cheap, because rays terminate at the wall within a few cm. Measured at
// the aortic seed, 692x415 (examples/cardiac/test/endo-quality.ts), RMS error against a
// 256-sample converged reference:
//
//     step          interior ms/fps      RMS      exterior ms/fps
//     0.700x voxel   1.67 / 600         11.18      —
//     0.500x         2.04 / 489          6.67      11.4 / 88
//     0.250x         3.31 / 302          2.31      20.3 / 49
//     0.125x         5.85 / 171          1.23      36.4 / 27
//
// So the interior can afford 0.125x — nine times less error than the old default, still at
// 171 fps — while the exterior view cannot: the same step there crosses the whole 512^3 volume
// and collapses to 27 fps. Hence per-view, not global.
const ENDO_STEP_MULT = 0.125;
const CTA_STEP_MULT = 0.5;
const setStepForView = () => {
  if (sc.mode() === "cine") { setStep(sc.cine.sampleStep() * 0.5); return; }
  const sp = sc.cta?.sampleStep();
  if (sp) setStep(sp * (flying ? ENDO_STEP_MULT : CTA_STEP_MULT));
};

// ---- flight tick -------------------------------------------------------------------------
// Runs in the same rAF as the cine. The clearance probe is a GPU readback, so it is kicked off
// at most one at a time and the LAST result is used — never awaited in the input path.
let flightLastT = 0;
const tickFlight = (msNow: number) => {
  if (!flying || !endo) { flightLastT = msNow; return; }
  const dt = flightLastT ? (msNow - flightLastT) / 1000 : 0;
  flightLastT = msNow;

  if (!probeInFlight) {
    probeInFlight = true;
    const f = forwardDir();
    const c = endo.cruise();
    const dir: Vec3 = c === "back" ? [-f[0], -f[1], -f[2]] : f;
    probedDir = dir;
    const from: Vec3 = [...camera.position] as Vec3;
    sc.scene.probe(from, dir).then((d) => {
      clearanceAhead = d;
      probeInFlight = false;
    }).catch(() => { probeInFlight = false; });
  }

  // Escape recovery. CT-EndoVascular makes most of the scene transparent, so "outside the
  // blood pool" looks like "nothing anywhere" rather than an error. Every ~30 frames, probe
  // the six axes: if NONE finds a wall we are not inside anything, so snap back to the last
  // position that did have one. Without this, one wrong turn strands you in empty space with
  // no way to tell what happened.
  if (++escapeChecks % 30 === 0 && !probeInFlight) {
    const from: Vec3 = [...camera.position] as Vec3;
    const axes: Vec3[] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    Promise.all(axes.map((d) => sc.scene.probe(from, d))).then((ds) => {
      const enclosed = ds.some((d) => Number.isFinite(d) && d < 200);
      if (enclosed) lastGoodPos = from;
      else if (lastGoodPos) {
        camera.position = [...lastGoodPos] as Vec3;
        endo?.setCruise("stopped");
        status("left the blood pool — returned to the last enclosed position");
        jumpSlicesTo(camera.position);
        draw3d();
      }
    }).catch(() => {});
  }
  if (autoTarget) steerAutopilot();
  depthSeek(dt);         // always: it owns the smoothed aim + the crosshair lead point
  endo.tick(dt);
};

/** Sample a coarse depth map of the current view and steer toward its deepest point. */
function depthSeek(dt: number) {
  if (!endo || !flying) return;
  // Sample WHENEVER flying — the crosshair and the slices should always show what is ahead,
  // not go stale the moment you stop. Only the STEERING is gated on actually moving, and it
  // yields for a moment after any manual look so it never fights the user for the heading.
  const moving = endo.cruise() === "forward" || keysDown.has("ArrowUp");
  // the autopilot does its own steering; depth-seek then only maintains the crosshair
  const steer = moving && !autoTarget && performance.now() - manualLookAt >= 600;

  if (!seekBusy && ++seekTicks % 8 === 0) {
    seekBusy = true;
    const eye: Vec3 = [...camera.position] as Vec3;
    // 3x3 grid over the central half of the view: enough to find which way the lumen opens,
    // cheap enough to run several times a second.
    const uv: [number, number][] = [];
    for (const v of [0.32, 0.5, 0.68]) for (const u of [0.32, 0.5, 0.68]) uv.push([u, v]);
    Promise.all(uv.map(([u, v]) => sc.scene.pick(u, v))).then((hits) => {
      let bestD = -1, bestHit: Vec3 | null = null;
      hits.forEach((h) => {
        if (!h) return;                                     // no wall that way: not a lumen cue
        const d = Math.hypot(h[0] - eye[0], h[1] - eye[1], h[2] - eye[2]);
        if (d > bestD) { bestD = d; bestHit = h; }
      });
      if (bestHit && bestD > 4) {
        seekDist = bestD;
        const v: Vec3 = [bestHit[0] - eye[0], bestHit[1] - eye[1], bestHit[2] - eye[2]];
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        seekDir = [v[0] / l, v[1] / l, v[2] / l];   // raw; smoothed into aimDir per frame
      }
      seekBusy = false;
    }).catch(() => { seekBusy = false; });
  }

  // Smooth the heading every frame (not per sample), so the lead point drifts continuously
  // and is frame-rate independent.
  const want = autoDir ?? seekDir;
  if (want) aimDir = aimDir ? slerpDir(aimDir, want, AIM_SMOOTH * dt) : want;
  if (aimDir) {
    // Never lead past the wall we measured: in a tight vessel or head-on to a bend the full
    // 1 cm would land in tissue, which is the exact failure we are fixing.
    const lead = Math.max(2, Math.min(LEAD_MM, seekDist - 2));
    const p: Vec3 = [
      camera.position[0] + aimDir[0] * lead,
      camera.position[1] + aimDir[1] * lead,
      camera.position[2] + aimDir[2] * lead,
    ];
    // Recompute every frame, but only repaint the three slice canvases when it has actually
    // moved and at most ~20 Hz — this used to run once per depth sample, and redrawing them at
    // full 3D frame rate would cost more than the flight itself.
    const moved = !seekTarget || Math.hypot(p[0]-seekTarget[0], p[1]-seekTarget[1], p[2]-seekTarget[2]) > 0.2;
    seekTarget = p;
    if (moved && ++leadTicks % 3 === 0) { scrollSlicesTo(p); setMarker(p); }
    if (steer) endo.lookAlong(slerpDir(forwardDir(), aimDir, 0.9 * dt));
  }
}

/** Rotate `from` toward `to` by at most `maxRad` — so the view swings smoothly instead of snapping. */
function slerpDir(from: Vec3, to: Vec3, maxRad: number): Vec3 {
  const d = Math.max(-1, Math.min(1, dot3(from, to)));
  const ang = Math.acos(d);
  if (ang < 1e-4) return to;
  const t = Math.min(1, maxRad / ang);
  const s1 = Math.sin((1 - t) * ang) / Math.sin(ang), s2 = Math.sin(t * ang) / Math.sin(ang);
  const v: Vec3 = [from[0]*s1 + to[0]*s2, from[1]*s1 + to[1]*s2, from[2]*s1 + to[2]*s2];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/l, v[1]/l, v[2]/l];
}

function steerAutopilot() {
  if (!autoTarget || !endo) return;
  const pos = camera.position;
  const toT: Vec3 = [autoTarget[0]-pos[0], autoTarget[1]-pos[1], autoTarget[2]-pos[2]];
  const dist = Math.hypot(toT[0], toT[1], toT[2]);
  if (dist < 8) {                        // arrived
    endo.setCruise("stopped");
    autoTarget = null; autoDir = null;
    status("autopilot: arrived at the target");
    return;
  }
  const bearing: Vec3 = [toT[0]/dist, toT[1]/dist, toT[2]/dist];

  // Re-plan every few frames: probe a fan around the bearing and score progress x clearance.
  if (!autoBusy && ++autoTicks % 6 === 0) {
    autoBusy = true;
    const cands: Vec3[] = [bearing];
    const f = forwardDir();
    const left = normalize3(cross3([0,0,1], bearing));
    const up = cross3(bearing, left);
    for (const ang of [0.35, 0.7, 1.05]) {          // ~20, 40, 60 degrees off the bearing
      for (let k = 0; k < 6; k++) {
        const th = (k / 6) * Math.PI * 2;
        const off: Vec3 = [
          left[0]*Math.cos(th)*Math.sin(ang) + up[0]*Math.sin(th)*Math.sin(ang) + bearing[0]*Math.cos(ang),
          left[1]*Math.cos(th)*Math.sin(ang) + up[1]*Math.sin(th)*Math.sin(ang) + bearing[1]*Math.cos(ang),
          left[2]*Math.cos(th)*Math.sin(ang) + up[2]*Math.sin(th)*Math.sin(ang) + bearing[2]*Math.cos(ang),
        ];
        cands.push(normalize3(off));
      }
    }
    void f;
    const from: Vec3 = [...pos] as Vec3;
    Promise.all(cands.map((d) => sc.scene.probe(from, d))).then((ds) => {
      let best = -1, bestDir: Vec3 | null = null;
      cands.forEach((d, i) => {
        const clear = Math.min(Number.isFinite(ds[i]) ? ds[i] : 200, 60) - MARGIN_MM;
        if (clear <= 2) return;                       // no room this way
        const progress = dot3(d, bearing);            // 1 = straight at the target
        if (progress <= 0.1) return;                  // never steer away from the target
        const score = progress * clear;
        if (score > best) { best = score; bestDir = d; }
      });
      if (bestDir) { autoDir = bestDir; autoStuck = 0; }
      else if (++autoStuck > 2) {
        endo?.setCruise("stopped");
        autoTarget = null; autoDir = null;
        status(`autopilot: blocked — this is as close as the blood pool allows (${dist.toFixed(0)} mm short)`);
      }
      autoBusy = false;
    }).catch(() => { autoBusy = false; });
  }

  if (autoDir) {
    endo.lookAlong(slerpDir(forwardDir(), autoDir, 0.06));
    endo.setCruise("forward");
  }
}

const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const normalize3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/l, v[1]/l, v[2]/l];
};

/** Shift+click in the 3D view while flying = set an autopilot target. */
const setAutoTarget = (ras: Vec3) => {
  autoTarget = [...ras] as Vec3;
  autoDir = null; autoStuck = 0;
  status("autopilot: steering toward the picked target…");
};

const tickCine = (msNow: number) => {
  requestAnimationFrame(tickCine);
  tickFlight(msNow);
  if (!shown("threeD")) { lastT = msNow; return; }
  setStepForView();          // must run in CTA mode too — that is where flight lives
  if (sc.mode() !== "cine") { lastT = msNow; return; }

  // Wall-clock playback advance with frame dropping — vtkSlicerSequencesLogic's arithmetic.
  if (sc.browser.playbackActive) {
    const dt = lastT ? (msNow - lastT) / 1000 : 0;
    acc += dt * sc.browser.playbackRateFps;
    const inc = Math.floor(acc);
    if (inc > 0) { acc -= inc; sc.browser.selectNextItem(sc.browser.playbackItemSkippingEnabled ? inc : 1); }
  } else acc = 0;
  lastT = msNow;

  const cur = sc.browser.selectedItemNumber;
  if (cur !== shownFrame) {          // new phase: hold it and restart its mean
    selectFrame(cur);
    shownFrame = cur;
    accN = 0;
    showFrameSlices(cur);
    cross.redraw();
    status(`4D cine · phase ${cur + 1}/${sc.cine.frameCount}` +
           (sc.browser.playbackActive ? ` · playing at ${sc.browser.playbackRateFps} fps` : " · press play"));
  }

  // Keep refining the held phase. One pass in flight so input is never queued behind a backlog.
  if (renderInFlight) return;
  if (!sc.browser.playbackActive && accN >= SETTLE_TARGET) return;   // paused and converged
  renderInFlight = true;
  sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
  sc.scene.renderAccum(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height, accN === 0);
  accN++;
  cross.redraw();
  gpu.device.queue.onSubmittedWorkDone().then(() => { renderInFlight = false; });
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
      set: (on) => { sc.setCropEnabled(on); invalidateStrip(); draw3d(); },
    },
    {
      label: "Display ROI",
      get: () => sc.roiVisible(),
      set: (on) => { sc.setRoiVisible(on); invalidateStrip(); draw3d(); },
    },
  ],
  onChange: () => { drawSlices(); draw3d(); },
});

// Anything that changes the image restarts the current phase's accumulation.
// The trackball and the flight both want left-drag. While flying, the flight owns the canvas:
// gating only onChange left the trackball still mutating the camera, so a drag orbited instead
// of looking around.
attachCameraControls(cv.threeD, camera, {
  enabled: () => !flying,
  onChange: () => { camMoved(); invalidateStrip(); draw3d(); },
});

// ---- follow Slicer's camera over the mrson live stream -----------------------------------
// mrson_live.py (LiveStoryLib) streams CameraModified events from a running Slicer on a
// WebSocket, with pose dedup at the source. Subscribing to just "camera" lets you drive this
// view by orbiting in Slicer — the honest way to compare the two renderers on one camera.
//   In Slicer:  from LiveStoryLib import mrson_live; slicer.mrsonLive = mrson_live.startMrsonLive(2132)
//   Here:       ?follow=2132   (or window.cardiac.follow(2132))
let followWs: WebSocket | null = null;
// The last pose Slicer sent, kept even while we ignore it, so entering flight can start from
// wherever the user parked Slicer's camera. Null on the published demo, which has no Slicer.
let followedPose: { pos: Vec3; fp: Vec3; up: Vec3; va?: number } | null = null;
/** One-shot request to re-adopt Slicer's pose mid-flight (window.cardiac.resync()). */
let resyncOnce = false;
/** Whether THIS flight was seated from Slicer rather than the baked seed. */
let flightFromSlicer = false;
const follow = (port = 2132) => {
  followWs?.close();
  const ws = new WebSocket(`ws://localhost:${port}`);
  followWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: "subscribe", types: ["camera"] }));
    status(`following Slicer's camera on :${port}`);
  };
  ws.onerror = () => status(`could not reach the mrson live stream on :${port}`);
  ws.onclose = () => { if (followWs === ws) status("mrson camera follow disconnected"); };
  ws.onmessage = (e) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    // The snapshot arrives as NodeAdded carrying a full mrson camera node; live changes as
    // CameraModified. Both carry the same pose fields.
    const isCam = m.event === "CameraModified" ||
      (m.event === "NodeAdded" && (m.node as { type?: string } | undefined)?.type === "camera");
    if (!isCam) return;
    const c = (m.event === "CameraModified" ? m : m.node) as Record<string, unknown>;
    const pos = c.position as Vec3 | undefined;
    const fp = c.focalPoint as Vec3 | undefined;
    const up = c.viewUp as Vec3 | undefined;
    const va = c.viewAngle as number | undefined;
    if (!pos || !fp || !up) return;
    followedPose = { pos: [...pos] as Vec3, fp: [...fp] as Vec3, up: [...up] as Vec3, va };
    if (flying) {
      // The endo page autoplays, so the flight is usually already under way by the time the
      // first Slicer pose arrives. Seat the flight from that first pose — otherwise connecting
      // a Slicer would never take effect. After that, ignore the stream: applying every event
      // would yank the camera back mid-manoeuvre. resync() asks for one more.
      if (!flightFromSlicer || resyncOnce) {
        resyncOnce = false;
        flightFromSlicer = true;
        seatFlight({ pos: [...pos] as Vec3, fp: [...fp] as Vec3, up: [...up] as Vec3, va });
      }
      return;
    }
    camera.position = [...pos] as Vec3;
    camera.focalPoint = [...fp] as Vec3;
    camera.viewUp = [...up] as Vec3;
    if (va) camera.viewAngle = va;
    camMoved();
    invalidateStrip();      // restart this phase's mean
    draw3d();               // kick: cheap frame while they drag, converge when they stop
  };
};
if (new URLSearchParams(location.search).has("follow")) {
  follow(Number(new URLSearchParams(location.search).get("follow")) || 2132);
}

// Dev hook, in the style of seged's window.seged — lets a CDP driver assert on real state
// instead of eyeballing screenshots, and makes bugs like "the slice plane is out of range"
// diagnosable without a rebuild.
(globalThis as unknown as { cardiac: unknown }).cardiac = {
  state: () => ({
    mode: sc.mode(), preset: sc.presetName(),
    off: { ...off }, rasLo, rasHi,
    frame: sc.browser.selectedItemNumber, frames: sc.cine.frameCount,
    playing: sc.browser.playbackActive, fps: sc.browser.playbackRateFps,
    crop: sc.cropEnabled(), roiVisible: sc.roiVisible(),
    boundFrame: sc.cine.frame, accN,
    accumN: sc.scene.accumCount(),   // the renderer's real accumulation depth (accN is cine-only)
    adaptiveFramesInCine,        // must stay 0: two accumulator owners = flashing phases
    lastCamMove, renderInFlight,
    flying, cruise: endo ? endo.cruise() : "stopped",
    speedMmPerSec: endo ? endo.speed() : flightSpeed(),
    autoTarget: autoTarget ? [...autoTarget] : null,
    seekTarget: seekTarget ? [...seekTarget] : null,   // the lead point: LEAD_MM ahead along aimDir
    aimDir: aimDir ? [...aimDir] : null,
    seekDist,
    clearanceAhead: Number.isFinite(clearanceAhead) ? +clearanceAhead.toFixed(2) : null,
    cameraPos: [...camera.position], cameraFocal: [...camera.focalPoint],
    sizes: Object.fromEntries(NAMES.map((n) => [n, [cv[n].width, cv[n].height]])),
  }),
  drawSlices, draw3dNow, converge, resize,
  /** Explicit-ray depth probe — lets a driver assert the crosshair lead point sits in the lumen. */
  probe: (o: Vec3, d: Vec3) => sc.scene.probe(o, d),
  device: () => gpu.device,
  cineAccum: () => accN,
  setOffset: (o: typeof SLICES[number], v: number) => { off[o] = v; drawPlane(o); },
  setMode, applyPreset, follow, startFlight,
  /** Re-adopt Slicer's current pose once, mid-flight. */
  resync: () => { resyncOnce = true; },
  followedPose: () => followedPose,
  setCruise: (c: Cruise) => endo?.setCruise(c),
  setSpeed: (mmPerSec: number) => {
    if (speedEl) { speedEl.value = String(mmPerSec); showSpeed(); }
    endo?.setSpeed(mmPerSec);
  },
  setAutoTarget,
  // Drive the camera to exact values so a view can be matched 1:1 against Slicer.
  getCamera: () => ({
    position: [...camera.position], focalPoint: [...camera.focalPoint],
    viewUp: [...camera.viewUp], viewAngle: camera.viewAngle,
  }),
  setCamera: (p: { position?: Vec3; focalPoint?: Vec3; viewUp?: Vec3; viewAngle?: number }) => {
    if (p.position) camera.position = [...p.position] as Vec3;
    if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3;
    if (p.viewUp) camera.viewUp = [...p.viewUp] as Vec3;
    if (p.viewAngle) camera.viewAngle = p.viewAngle;
    camMoved();
    invalidateStrip();
    draw3d();
  },
  setCrop: (on: boolean) => { sc.setCropEnabled(on); invalidateStrip(); chrome.refresh(); draw3dNow(); },
  setRoi: (on: boolean) => { sc.setRoiVisible(on); invalidateStrip(); chrome.refresh(); draw3dNow(); },
};

if (ENDO) {
  // Endovascular page: no cine at all, straight into the flight.
  for (const el of ["mode-cta", "mode-cine", "flyBtn", "transport"]) $(el).style.display = "none";
  $("loadtitle").textContent = "Loading the CTA…";
  $("loadsub").textContent = "512x512x321 contrast CT streaming from a public JS2 bucket";
  loadWrap.classList.add("done");
  setTimeout(() => { loadWrap.style.display = "none"; }, 600);
  await startFlight();
  // resize() sizes the canvases from their client rect, which is only meaningful after the
  // first layout — and the flight only redraws when something MOVES, so without an explicit
  // settled render here the 3D view stays black until the user touches a control.
  requestAnimationFrame(() => {
    resize();
    draw3dNow();
    // Autoplay, like the beating heart: start cruising so the page flies itself down the aorta,
    // depth-seeking round the bends. A short delay lets the first converged frame land, so you
    // see where you are before it starts moving.
    setTimeout(() => { if (flying) endo?.setCruise("forward"); }, 900);
  });
} else {

// Open on the beating heart: that is the thing worth seeing first, and it demonstrates that
// playback stays fully interactive (rotate while it plays).
setMode("cine");
sc.browser.playbackRateFps = 10;
fps.value = "10";
$("fpsLbl").textContent = "10 fps";
// Phase 0 is already uploaded, so the view is live immediately. Keep the dialog up while the
// rest stream in and JUMP TO EACH PHASE AS IT LANDS — the heart visibly fills in, which is
// progress you can actually read, and it doubles as a preview of the sequence.
sc.browser.playbackActive = false;
playBtn.textContent = "▶ play";
onPhaseLoaded = (n) => {
  sc.browser.setSelectedItemNumber(n - 1);   // newest phase; tickCine renders it
  status(`4D cine · loaded phase ${n}/${sc.cine.frameCount}`);
};
onPhaseLoaded(1);

sc.cineReady.then(() => {
  setBar(1, `all ${sc.cine.frameCount} phases loaded`);
  setPips(sc.cine.frameCount, sc.cine.frameCount);
  onPhaseLoaded = null;
  loadWrap.classList.add("done");
  setTimeout(() => { loadWrap.style.display = "none"; }, 600);
  sc.browser.setSelectedItemNumber(0);
  sc.browser.playbackActive = true;
  playBtn.textContent = "❚❚ pause";
  status(`4D cine · ${sc.cine.frameCount} phases · playing at ${sc.browser.playbackRateFps} fps · rotate while it plays`);
});
// Canvases are sized from their client rect, which is only correct after the first layout.
// Sizing on rAF (not synchronously at module end) is what makes the first frame appear.
requestAnimationFrame(() => resize());
}
