// SlicerLive mirror — mirrors the live Slicer scene over the mrson live channel into a
// Four-Up layout (3 MPR slice cells + a 3D cell). LiveScene subscribes over WebSocket; its
// displayable managers drive a MirrorView: the volume manager builds the shared volume field
// (slices reslice it on load; the 3D cell shows it when VR is enabled), the slice manager sets
// each cell's reslice plane, the layout manager arranges the cells, camera/markups/ROI as before.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import type { Field, ImageField } from "../fields.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import {
  CameraDisplayableManager,
  type CameraState,
  LayoutDisplayableManager,
  LiveScene,
  MarkupsDisplayableManager,
  type MirrorView,
  RoiCropDisplayableManager,
  SliceDisplayableManager,
  type SlicePlane,
  type Vec3,
  VolumeRenderingDisplayableManager,
} from "../livescene.ts";

const status = (m: string) => { const e = document.getElementById("status"); if (e) e.textContent = m; };
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;

const CELLS = ["red", "yellow", "green", "threeD"] as const;
const SLICE_CELLS = ["red", "yellow", "green"] as const;
type Cell = typeof CELLS[number];

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available"); return; }
  const p = new URLSearchParams(location.search);
  const host = p.get("host") ?? "localhost";
  const wsUrl = p.get("ws") ?? `ws://${host}:2132/`;
  const httpBase = p.get("http") ?? `http://${host}:2131/mrson/`;

  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const c of CELLS) {
    cv[c] = el("c-" + c);
    cx[c] = cv[c].getContext("webgpu") as GPUCanvasContext;
    cx[c].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }
  const dpr = Math.min(2, (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1);
  const resizeAll = () => { for (const c of CELLS) { cv[c].width = Math.max(1, Math.round(cv[c].clientWidth * dpr)); cv[c].height = Math.max(1, Math.round(cv[c].clientHeight * dpr)); } };
  resizeAll();

  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;
  const fields3d = new Map<string, Field>();
  let volumeField: ImageField | null = null;
  let volumeShown3D = false;
  let clip: { lo: Vec3; hi: Vec3 } | null = null;

  const slice = new SliceRenderer(gpu, srgb);
  let volumeReady = false;
  const planes: Record<string, SlicePlane | undefined> = {};
  const visible = new Set<string>(CELLS);

  const clearCanvas = (c: string) => {
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: cx[c].getCurrentTexture().createView({ format: srgb }), clearValue: { r: 0.02, g: 0.024, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.end();
    gpu.device.queue.submit([enc.finish()]);
  };

  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => cx.threeD.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: visible.has("threeD") ? cv.threeD.width : 0, h: cv.threeD.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
  });

  const renderSlice = (c: string) => {
    if (c === "threeD" || !visible.has(c)) return;
    if (!volumeReady) { clearCanvas(c); return; }
    const pl = planes[c];
    if (!pl) { clearCanvas(c); return; }
    const [lo, hi] = volumeField!.aabb();
    const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
    const off01 = Math.max(0, Math.min(1, (pl.posMm - lo[axis]) / Math.max(hi[axis] - lo[axis], 1e-6)));
    slice.setPlane(pl.orient, off01);
    slice.renderToView(cx[c].getCurrentTexture().createView({ format: srgb }), cv[c].width, cv[c].height);
  };
  const renderSlices = () => { for (const c of SLICE_CELLS) renderSlice(c); };

  const rebuild3d = () => {
    const fs = [...fields3d.values()];
    if (volumeShown3D && volumeField) fs.unshift(volumeField);
    if (fs.length === 0) { scene = null; clearCanvas("threeD"); return; }
    if (!scene) scene = new SceneRenderer(gpu, srgb);
    scene.build(fs);
    if (clip) scene.setClipBox(clip.lo, clip.hi);
    a3d.draw();
  };

  const LAYOUTS: Record<string, Cell[]> = {
    fourUp: ["red", "yellow", "green", "threeD"], conventional: ["red", "yellow", "green", "threeD"],
    conventionalWidescreen: ["red", "yellow", "green", "threeD"], fourByThree: ["red", "yellow", "green", "threeD"],
    oneUp3D: ["threeD"], dual3D: ["threeD"], oneUpRed: ["red"], oneUpYellow: ["yellow"], oneUpGreen: ["green"],
  };
  const applyLayout = (name: string) => {
    const cells = LAYOUTS[name] ?? LAYOUTS.fourUp;
    visible.clear();
    for (const c of cells) visible.add(c);
    const grid = document.getElementById("grid")!;
    grid.style.gridTemplateColumns = cells.length === 1 ? "1fr" : "1fr 1fr";
    grid.style.gridTemplateRows = cells.length === 1 ? "1fr" : "1fr 1fr";
    for (const c of CELLS) document.getElementById("cell-" + c)!.classList.toggle("hidden", !visible.has(c));
    resizeAll();
    renderSlices();
    a3d.draw();
  };

  const view: MirrorView = {
    setField(k, f) { fields3d.set(k, f); rebuild3d(); },
    removeField(k) { if (fields3d.delete(k)) rebuild3d(); },
    redraw() { a3d.draw(); },
    setCamera(c: CameraState) {
      camera.position = c.position as Vec3;
      camera.focalPoint = c.focalPoint as Vec3;
      camera.viewUp = c.viewUp as Vec3;
      if (c.viewAngle) camera.viewAngle = c.viewAngle;
      a3d.draw();
    },
    setClipBox(lo, hi) {
      clip = lo ? { lo, hi: hi! } : null;
      if (scene) { if (clip) scene.setClipBox(clip.lo, clip.hi); else scene.setClipPlanes([]); }
      a3d.draw();
    },
    setVolumeField(f, wl) {
      volumeField = f;
      if (f) {
        const [lo, hi] = f.aabb();
        slice.setVolume(f.patientToTexture(), lo, hi);
        slice.setTextures(f.volumeTexture());
        if (wl) slice.setWindowLevel(wl.win, wl.lev);
        slice.setOverlayOpacity(0);
        volumeReady = true;
        renderSlices();
      } else {
        volumeReady = false;
        for (const c of SLICE_CELLS) clearCanvas(c);
      }
      rebuild3d();
    },
    showVolume3D(show) { volumeShown3D = show; rebuild3d(); },
    setSlicePlane(cell, pl) { planes[cell] = pl; renderSlice(cell); },
    setLayout(name) { applyLayout(name); },
  };

  addEventListener("resize", () => { resizeAll(); renderSlices(); a3d.draw(); });

  const live = new LiveScene(wsUrl, httpBase, [
    new LayoutDisplayableManager(),
    new CameraDisplayableManager(),
    new VolumeRenderingDisplayableManager(gpu.device),
    new SliceDisplayableManager(),
    new MarkupsDisplayableManager(),
    new RoiCropDisplayableManager(),
  ]);
  live.view = view;
  status("connecting to Slicer live channel…");
  await live.connect();
  status("subscribed — mirroring Slicer");
}
main();
