// SlicerLive mirror — a browser view that mirrors the live Slicer 3D scene over the mrson
// live channel. LiveScene subscribes over WebSocket; its displayable managers drive a
// SceneRenderer: the VolumeRenderingDisplayableManager builds the volume field from the
// streamed image node, the CameraDisplayableManager tracks Slicer's camera. Orbit in
// Slicer -> this view follows.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import {
  CameraDisplayableManager,
  type CameraState,
  LiveScene,
  VolumeRenderingDisplayableManager,
  type VolumeMeta,
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
  addEventListener("resize", () => { resize(); a3d.draw(); });

  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;

  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
  });

  // Camera manager: apply Slicer's camera (snapshot + live CameraModified) to the view.
  const camDM = new CameraDisplayableManager((c: CameraState) => {
    camera.position = c.position as [number, number, number];
    camera.focalPoint = c.focalPoint as [number, number, number];
    camera.viewUp = c.viewUp as [number, number, number];
    if (c.viewAngle) camera.viewAngle = c.viewAngle;
    a3d.draw();
  });

  // Volume-rendering manager: (re)build the scene when the volume/TF arrives or changes.
  const volDM = new VolumeRenderingDisplayableManager(gpu.device, (m: VolumeMeta) => {
    const s = new SceneRenderer(gpu, srgb);
    s.build([m.field]);
    scene = s;
    status(`mirroring ${m.name} · ${m.dims.join("×")}`);
    a3d.draw();
  });

  const live = new LiveScene(wsUrl, httpBase, [camDM, volDM]);
  status("connecting to Slicer live channel…");
  await live.connect();
  status("subscribed — mirroring Slicer");
}
main();
