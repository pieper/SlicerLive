// nnLive LiveModule demo — the payoff: a REAL CT in the SlicerLive 4-up where each
// click runs interactive segmentation (nnLive's ORT-Web model on a 64^3 patch),
// splats the mask into a labelmap, re-bakes it via ColorizeVolume, and shows it
// live as a colored 3D volume + MPR overlay, with a pushpin fiducial at each click.
// The whole SlicerLive-side pipeline is real; the only external dependency is the
// hosted nnLive model (via ?model=). If it can't load, a built-in region-grow stub
// keeps the pipeline demonstrable (clearly labeled). Bundled to live/webgpu/nnlive.js.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { RGBAVolumeField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { bakeColorizeRGBA } from "../bake.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { anatomicalAxes } from "./real-scene.ts";
import { orbitEye } from "./sphere-scene.ts";
import { applyRowMajor, type Vec3 } from "../mat4.ts";
import { type Click, applyMaskDelta, buildPatchInput, type Segmenter, SyntheticSegmenter } from "../live-segmenter.ts";
import { OrtWorkerSegmenter } from "../ort-segmenter.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;
const P = 64;

// Default CT scene (real, CT modality — the modality nnLive was trained on) and the
// (to-be-hosted) model location; both overridable via URL params.
const params = new URLSearchParams(location.search);
const SCENE = params.get("scene") ?? "https://pieper.github.io/live/legacy/scenes/TotalSegmentator-CT.json";
const MODEL = params.get("model") ?? "https://js2.jetstream-cloud.org:8001/swift/v1/nnlive-models/net_64_webgpu_fp16.onnx";

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "coronal", "sagittal", "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = el("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  status("streaming CT from the bucket…");
  let mb = 0;
  const sv = await loadSceneVolumeField(gpu.device, SCENE, (n) => { mb += n; status(`streaming CT… ${(mb / 1e6).toFixed(1)} MB`); });
  const [X, Y, Z] = sv.dims;

  // Segmentation state: full-volume labelmap + gold palette + baked colorize texture.
  const labelmap = new Uint8Array(X * Y * Z);
  const palette = new Float32Array(256 * 4);
  palette.set([0.96, 0.78, 0.30, 0.92], 4);       // label 1 -> gold
  let colorizeTex = bakeColorizeRGBA(gpu.device, labelmap, sv.dims, palette, 1.2);
  const overlay = new RGBAVolumeField(colorizeTex, sv.dims, [1, 1, 1], { ijkToRAS: sv.ijkToRAS, shade: [0.28, 0.8, 0.5, 28] });
  const fiducials = new FiducialField([]);

  const scene = new SceneRenderer(gpu, srgb);
  scene.build([sv.field, overlay, fiducials]);
  scene.setBackground(0.05, 0.06, 0.09);

  const slice = new SliceRenderer(gpu, srgb);
  slice.setTextures(sv.field.volumeTexture(), colorizeTex);
  slice.setWindowLevel(sv.win, sv.lev);
  slice.setOverlayOpacity(0.55);

  // Anatomical plane assignment.
  const cellFor: Record<string, "axial" | "coronal" | "sagittal"> = { AXIAL: "axial", CORONAL: "coronal", SAGITTAL: "sagittal" };
  const planes: { cell: "axial" | "coronal" | "sagittal"; axis: 0 | 1 | 2 }[] = [];
  for (const a of anatomicalAxes(sv.ijkToRAS)) {
    planes.push({ cell: cellFor[a.label], axis: a.axis });
    const lab = document.querySelector(`#lab-${cellFor[a.label]}`) as HTMLElement | null;
    if (lab) lab.textContent = a.label;
  }
  const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };

  const { center, radius } = sv;
  let az = 0.6, elev = 0.25, dist = radius * 2.6;
  const eyeAt = (): Vec3 => { const o = orbitEye(az, elev, dist); return [center[0] + o[0], center[1] + o[1], center[2] + o[2]]; };

  const drawPlane = (p: { cell: "axial" | "coronal" | "sagittal"; axis: 0 | 1 | 2 }) => {
    slice.setSlice(p.axis, off[p.cell]);
    slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    scene.setCamera(eyeAt(), center, [0, 0, 1], 26, cv.threeD.width, cv.threeD.height);
    scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  const drawAll = () => { for (const p of planes) drawPlane(p); draw3d(); };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) { const s = Math.floor(cv[n].clientWidth * dpr); cv[n].width = s; cv[n].height = s; }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  resize();

  // --- Segmenter backend: real nnLive model, else region-grow stub -------------
  status("loading nnLive model… (first click after this is a warm forward)");
  let seg: Segmenter, stub = false;
  const ort = new OrtWorkerSegmenter({ workerUrl: "./nnlive-worker.js", modelUrl: MODEL, patch: P, onStatus: (m) => status(m) });
  try {
    await ort.ready();
    seg = ort;
  } catch (_e) {
    ort.dispose();
    seg = new SyntheticSegmenter(P);
    stub = true;
    status(`nnLive model not reachable — using a built-in region-grow stub so the pipeline is live. Host net_64 (see ?model=) for real inference.`, true);
  }

  // --- Click -> segment -> re-bake -> render -----------------------------------
  const clicks: Click[] = [];
  const pins: Sphere[] = [];
  let busy = false;

  const voxelFromPixel = (p: { cell: string; axis: 0 | 1 | 2 }, px: number, py: number, w: number, h: number): [number, number, number] => {
    const u = px / w, vv = py / h, s = off[p.cell];
    if (p.axis === 0) return [Math.min(X - 1, Math.floor(s * X)), Math.min(Y - 1, Math.floor(u * Y)), Math.min(Z - 1, Math.floor(vv * Z))];       // sagittal
    if (p.axis === 1) return [Math.min(X - 1, Math.floor(u * X)), Math.min(Y - 1, Math.floor(s * Y)), Math.min(Z - 1, Math.floor(vv * Z))];       // coronal
    return [Math.min(X - 1, Math.floor(u * X)), Math.min(Y - 1, Math.floor(vv * Y)), Math.min(Z - 1, Math.floor(s * Z))];                          // axial
  };

  const segmentAt = async (i: number, j: number, k: number, sign: 1 | -1) => {
    if (busy) return;
    busy = true;
    clicks.push({ x: i, y: j, z: k, sign });
    const ras = applyRowMajor(sv.ijkToRAS, [i, j, k]);
    pins.push({ center: ras, radius: 4.5, color: sign > 0 ? [0.2, 0.85, 1, 1] : [1, 0.3, 0.8, 1] });
    fiducials.setSpheres(pins);
    scene.build([sv.field, overlay, fiducials]);   // fiducial count changed -> uniform reshaped; rebuild
    scene.setBackground(0.05, 0.06, 0.09);
    status(`segmenting… (${stub ? "stub" : "nnLive"} · click ${clicks.length})`);
    const t0 = performance.now();

    const { inp, lo } = buildPatchInput(sv.voxels, sv.dims, clicks, P, labelmap);
    const mask = await seg.infer(inp);
    const fg = applyMaskDelta(labelmap, sv.dims, mask, lo, P, 1);

    colorizeTex = bakeColorizeRGBA(gpu.device, labelmap, sv.dims, palette, 1.2);
    overlay.setTexture(colorizeTex);
    scene.refreshBindings();
    slice.setTextures(sv.field.volumeTexture(), colorizeTex);
    // center the slices on the latest click so the overlay is visible
    off.sagittal = i / X; off.coronal = j / Y; off.axial = k / Z;
    drawAll();
    const runMs = (seg as OrtWorkerSegmenter).lastRunMs ?? 0;
    status(`${stub ? "region-grow stub" : "nnLive"} · click ${clicks.length} · patch fg ${fg} vox · ${runMs || Math.round(performance.now() - t0)} ms · shift-click = background point`);
    busy = false;
  };

  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => { e.preventDefault(); off[p.cell] = Math.max(0, Math.min(1, off[p.cell] + (e.deltaY > 0 ? 0.02 : -0.02))); drawPlane(p); }, { passive: false });
    cv[p.cell].addEventListener("pointerdown", (e) => {
      const r = cv[p.cell].getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * cv[p.cell].width, py = (e.clientY - r.top) / r.height * cv[p.cell].height;
      const [i, j, k] = voxelFromPixel(p, px, py, cv[p.cell].width, cv[p.cell].height);
      segmentAt(i, j, k, e.shiftKey ? -1 : 1);
    });
  }

  // 3D orbit / zoom.
  let dragging = false, lx = 0, ly = 0;
  cv.threeD.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; cv.threeD.setPointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointerup", (e) => { dragging = false; cv.threeD.releasePointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    az += (e.clientX - lx) * 0.008; elev = Math.max(-1.4, Math.min(1.4, elev - (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY; draw3d();
  });
  cv.threeD.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(radius * 1.2, Math.min(radius * 6, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw3d(); }, { passive: false });

  if (!stub) status(`${sv.name} · nnLive ready · click an organ in any MPR view to segment · shift-click = background`);
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
