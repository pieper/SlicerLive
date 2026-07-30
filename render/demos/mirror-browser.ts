// SlicerLive mirror — a browser view that mirrors the live Slicer 3D scene over the mrson
// live channel. LiveScene subscribes over WebSocket; its displayable managers drive a
// MirrorView backed by a SceneRenderer: the volume manager builds the field, the camera
// manager tracks Slicer's camera, the markups manager draws point glyphs. Orbit / edit in
// Slicer -> this view follows.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import type { Field } from "../fields.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import {
  CameraDisplayableManager,
  type CameraState,
  LiveScene,
  MarkupsDisplayableManager,
  type MirrorView,
  type Vec3,
  VolumeRenderingDisplayableManager,
} from "../livescene.ts";

const status = (m: string) => { const e = document.getElementById("status"); if (e) e.textContent = m; };

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available"); return; }
  const p = new URLSearchParams(location.search);
  const host = p.get("host") ?? "localhost";
  const wsUrl = p.get("ws") ?? `ws://${host}:2132/`;
  const httpBase = p.get("http") ?? `http://${host}:2131/mrson/`;

  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  const dpr = Math.min(2, (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1);
  const resize = () => { canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr); };
  resize();

  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;
  const fields = new Map<string, Field>();
  let clip: { lo: Vec3; hi: Vec3 } | null = null;

  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
  });
  addEventListener("resize", () => { resize(); a3d.draw(); });

  // Rebuild the SceneRenderer's field list (coarse: field set changed). Clip is re-applied
  // after build() since it lives in the scene uniform.
  const rebuild = () => {
    if (fields.size === 0) return;
    if (!scene) scene = new SceneRenderer(gpu, srgb);
    scene.build([...fields.values()]);
    if (clip) scene.setClipBox(clip.lo, clip.hi);
    a3d.draw();
  };

  const view: MirrorView = {
    setField(key, field) { fields.set(key, field); rebuild(); },
    removeField(key) { if (fields.delete(key)) rebuild(); },
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
  };

  const live = new LiveScene(wsUrl, httpBase, [
    new CameraDisplayableManager(),
    new VolumeRenderingDisplayableManager(gpu.device),
    new MarkupsDisplayableManager(),
  ]);
  live.view = view;
  status("connecting to Slicer live channel…");
  await live.connect();
  status("subscribed — mirroring Slicer");
}
main();
