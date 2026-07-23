// nnLive LiveModule demo — the payoff: a REAL CT in the SlicerLive 4-up where each
// click runs nnLive's FAITHFUL 192³ interactive segmentation (the distilled
// nnInteractive port: trunk encode + perclick decode, EDT-ball prompts, autoregressive
// prev_seg, auto-zoom). The returned mask is splatted into a labelmap, re-baked via
// ColorizeVolume, and shown live as a colored 3D volume + MPR overlay, with a pushpin
// at each click. Left-click = foreground, shift-click = background (refines).
//
// Coordinates are handled correctly end-to-end: the MPR views reslice in RAS (honoring
// the scene's ijkToRAS), and a click is mapped view -> RAS -> texture -> voxel index via
// the SAME patientToTexture, so the segmentation patch is centered on the true voxel.
// Bundled to live/webgpu/nnlive.js.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer, type Orientation } from "../slice-renderer.ts";
import { RGBAVolumeField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { bakeColorizeRGBA } from "../bake.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { orbitEye } from "./sphere-scene.ts";
import { applyRowMajor, type Vec3 } from "../mat4.ts";
import { FaithfulSegmenter } from "../faithful-segmenter.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;

const params = new URLSearchParams(location.search);
const SCENE = params.get("scene") ?? "https://pieper.github.io/live/legacy/scenes/TotalSegmentator-CT.json";
const BASE = params.get("base") ?? "https://pieper.github.io/nnLive/models/pathA/faithful/";
const WEIGHTS = params.get("weights") ?? "https://js2.jetstream-cloud.org:8001/swift/v1/nnlive-models/perclick_192.weights.bin";

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
  const [rasLo, rasHi] = sv.field.aabb();
  const p2t = sv.field.patientToTexture();

  // Segmentation state: gold ColorizeVolume overlay from the running labelmap.
  const palette = new Float32Array(256 * 4);
  palette.set([0.96, 0.78, 0.30, 0.92], 4);       // label 1 -> gold
  let labelmap = new Uint8Array(X * Y * Z);
  let colorizeTex = bakeColorizeRGBA(gpu.device, labelmap, sv.dims, palette, 1.2);
  const overlay = new RGBAVolumeField(colorizeTex, sv.dims, [1, 1, 1], { ijkToRAS: sv.ijkToRAS, shade: [0.28, 0.8, 0.5, 28] });
  const fiducials = new FiducialField([]);

  const scene = new SceneRenderer(gpu, srgb);
  scene.build([sv.field, overlay, fiducials]);
  scene.setBackground(0.05, 0.06, 0.09);

  const slice = new SliceRenderer(gpu, srgb);
  slice.setVolume(p2t, rasLo, rasHi);
  slice.setTextures(sv.field.volumeTexture(), colorizeTex);
  slice.setWindowLevel(sv.win, sv.lev);
  slice.setOverlayOpacity(0.5);

  const planes = [
    { cell: "axial", orient: "axial" as Orientation },
    { cell: "coronal", orient: "coronal" as Orientation },
    { cell: "sagittal", orient: "sagittal" as Orientation },
  ];
  const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };
  const norm: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 }; // RAS axis the plane scrubs

  const { center: ctr3d, radius } = sv;
  let az = Math.PI, elev = 0.12, dist = radius * 2.6;  // default: anterior view (face/front toward viewer), like Slicer
  const eyeAt = (): Vec3 => { const o = orbitEye(az, elev, dist); return [ctr3d[0] + o[0], ctr3d[1] + o[1], ctr3d[2] + o[2]]; };

  const drawPlane = (p: { cell: string; orient: Orientation }) => {
    slice.setPlane(p.orient, off[p.cell]);
    slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    scene.setCamera(eyeAt(), ctr3d, [0, 0, 1], 26, cv.threeD.width, cv.threeD.height);
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

  // --- nnLive faithful 192 backend ---------------------------------------------
  status("loading nnLive faithful model (188 MB perclick weights, cached after first load)…");
  const seg = new FaithfulSegmenter({
    workerUrl: new URL("nnlive/pathA-faithful-worker.js", location.href).href,
    encUrl: new URL("nnlive/faithful-enc.js", location.href).href,
    base: BASE, weights: WEIGHTS, onStatus: (m) => status(m),
  });
  try {
    await seg.init();
    seg.setVolume(sv.voxels, sv.dims);
  } catch (e) {
    status("nnLive model failed to load: " + ((e as Error)?.message ?? e) + " — check WebGPU shader-f16 support.", true);
    return;
  }

  // --- Click -> faithful segment -> re-bake -> render ---------------------------
  const pins: Sphere[] = [];
  let busy = false;

  // View pixel -> voxel index (i,j,k) via the SAME RAS->texture map the slice uses.
  const voxelAt = (orient: Orientation, u: number, v: number): [number, number, number] => {
    slice.setPlane(orient, off[orient]);
    const t = slice.viewToTex(u, v);   // normalized texture coords [0,1]^3 (or outside)
    const i = Math.max(0, Math.min(X - 1, Math.round(t[0] * X - 0.5)));
    const j = Math.max(0, Math.min(Y - 1, Math.round(t[1] * Y - 0.5)));
    const k = Math.max(0, Math.min(Z - 1, Math.round(t[2] * Z - 0.5)));
    return [i, j, k];
  };

  const segmentAt = async (i: number, j: number, k: number, sign: 1 | -1) => {
    if (busy) return;
    busy = true;
    const ras = applyRowMajor(sv.ijkToRAS, [i, j, k]);
    pins.push({ center: ras, radius: 4.5, color: sign > 0 ? [0.2, 0.85, 1, 1] : [1, 0.3, 0.8, 1] });
    fiducials.setSpheres(pins);
    scene.build([sv.field, overlay, fiducials]);   // fiducial count changed -> rebuild
    scene.setBackground(0.05, 0.06, 0.09);
    status(`nnLive faithful · ${sign > 0 ? "foreground" : "background"} point ${pins.length} · encoding + decoding 192³…`);

    labelmap = await seg.clickPredict(k, j, i, sign);   // (z,y,x) = (k,j,i)

    colorizeTex = bakeColorizeRGBA(gpu.device, labelmap, sv.dims, palette, 1.2);
    overlay.setTexture(colorizeTex);
    scene.refreshBindings();
    slice.setTextures(sv.field.volumeTexture(), colorizeTex);
    // center the MPR planes on the click so the overlay is visible
    off.sagittal = (ras[0] - rasLo[0]) / (rasHi[0] - rasLo[0]);
    off.coronal = (ras[1] - rasLo[1]) / (rasHi[1] - rasLo[1]);
    off.axial = (ras[2] - rasLo[2]) / (rasHi[2] - rasLo[2]);
    drawAll();
    let vox = 0; for (let n = 0; n < labelmap.length; n++) vox += labelmap[n];
    status(`nnLive faithful · ${pins.length} point${pins.length > 1 ? "s" : ""} · ${vox.toLocaleString()} vox · ${seg.lastMs} ms decode · zoom ×${seg.lastZoom.toFixed(1)} · shift-click = background point`);
    busy = false;
  };

  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => { e.preventDefault(); off[p.cell] = Math.max(0, Math.min(1, off[p.cell] + (e.deltaY > 0 ? 0.02 : -0.02))); drawPlane(p); }, { passive: false });
    cv[p.cell].addEventListener("pointerdown", (e) => {
      const r = cv[p.cell].getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      const [i, j, k] = voxelAt(p.orient, u, v);
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

  status(`${sv.name} · nnLive faithful 192³ ready · click an organ in any MPR view · shift-click = background`);
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
