// Browser entry for the ROI-crop demo: a single volume cropped by a draggable oriented
// (axis-aligned) ROI box. The box wireframe renders in the same ray-march as the volume
// and drives the clip planes, so a face/corner/centre drag re-crops the volume AND moves
// the widget in one syncUniforms — the event→state→render tight loop (ARCHITECTURE-2026-07-24
// §6.4). Grab a handle to resize/move; drag empty space to rotate. Bundled to live/webgpu/roi.js.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildRoiScene, type Box, type HandleMeta } from "./roi-scene.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { attachWidgetControls, type Handle } from "./widget-control.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import { installIntrospection } from "../introspect.ts";
import type { Vec3 } from "../mat4.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const sceneUrl = new URLSearchParams(location.search).get("scene") ??
    "https://pieper.github.io/live/scenes/CTACardio.json";
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  status("initializing WebGPU…");
  const gpu = await initDevice();
  (globalThis as unknown as { __gpuErr: string[] }).__gpuErr = [];
  gpu.device.addEventListener("uncapturederror", (e) => (globalThis as unknown as { __gpuErr: string[] }).__gpuErr.push(String((e as GPUUncapturedErrorEvent).error?.message ?? (e as GPUUncapturedErrorEvent).error)));
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  let mb = 0;
  status("streaming CT from the bucket…");
  const roi = await buildRoiScene(gpu.device, sceneUrl, (n) => { mb += n; status(`streaming CT… ${(mb / 1e6).toFixed(1)} MB`); });
  const scene = new SceneRenderer(gpu, srgb);
  scene.build([roi.image, roi.box, roi.handles]);
  scene.setBackground(0.05, 0.06, 0.09);
  scene.setClipBox(roi.lo(), roi.hi());

  const camera = framedCamera(roi.sv.center as Vec3, roi.sv.radius, 2.8);
  let msg = "drag a handle to crop · drag empty space to rotate";
  // Adaptive rendering (budget × temporal AA) via the shared, GPU-paced mountAdaptive3d: interacting
  // renders budget-scaled low-res Catmull-Rom-upsampled frames (first frame immediate, no backlog),
  // settling converges to a supersampled AA image. `draw` (kick) for interaction, `drawNow` (sync)
  // for the initial frame + tests.
  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
    onFrame: () => status(`${roi.sv.name} · ROI crop · ${msg}`),
  });
  const draw = () => a3d.draw();
  const drawNow = () => a3d.renderSettled(true);
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(720, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; drawNow();
  };
  globalThis.addEventListener("resize", resize);

  // Handle drag: capture the box at grab, then re-crop live as the pointer moves.
  let box0: Box = roi.snapshot();
  attachWidgetControls(canvas, camera, {
    getHandles: (): Handle[] => roi.handleList().map((hd) => ({ id: hd.id, world: hd.world, data: hd.data, cursor: hd.cursor })),
    getSize: () => ({ w: canvas.width, h: canvas.height }),
    onDragStart: () => { box0 = roi.snapshot(); msg = "cropping…"; },
    onDrag: (h, world) => {
      const d: Vec3 = [world[0] - h.world[0], world[1] - h.world[1], world[2] - h.world[2]];
      roi.applyDrag(h.data as HandleMeta, box0, d);
      scene.setClipBox(roi.lo(), roi.hi());
      scene.syncUniforms();
    },
    onDragEnd: () => { msg = "drag a handle to crop · drag empty space to rotate"; },
    onHover: (h) => { roi.setHover(h ? h.id : null); scene.syncUniforms(); },
    onChange: draw,
  });
  attachCameraControls(canvas, camera, { onChange: draw });

  installIntrospection({
    getCamera: () => ({ azimuth: 0, elevation: 0, distance: camera.distance, position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3, viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle }),
    setCamera: (p) => { if (p.position) camera.position = [...p.position] as Vec3; if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3; if (p.viewUp) camera.viewUp = [...p.viewUp] as Vec3; drawNow(); },
    extra: () => ({ center: roi.snapshot().center, half: roi.snapshot().half }),
    render: () => drawNow(),
  });

  // Debug hook for the on-screen drag harness: handles (world) + camera + canvas rect + box.
  (globalThis as unknown as { __roiDbg: unknown }).__roiDbg = {
    snapshot: () => {
      const r = canvas.getBoundingClientRect();
      return {
        handles: roi.handleList().map((hd) => ({ id: hd.id, world: hd.world, kind: (hd.data as { kind: string }).kind })),
        camera: { position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp], viewAngle: camera.viewAngle },
        canvas: { w: canvas.width, h: canvas.height, left: r.left, top: r.top, width: r.width, height: r.height },
        box: roi.snapshot(),
      };
    },
    accumCount: () => scene.accumCount(),
    scale: () => a3d.budget.scale(canvas.width, canvas.height),
    budgetPx: () => a3d.budget.budgetPx,
    setBudgetPx: (px: number) => { a3d.budget.budgetPx = px; },
    renderMovingN: (n: number) => { for (let i = 0; i < n; i++) a3d.renderMoving(); },
    converge: (n: number) => { a3d.renderSettled(true); for (let i = 1; i < n; i++) a3d.renderSettled(false); return scene.accumCount(); },
  };
  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
