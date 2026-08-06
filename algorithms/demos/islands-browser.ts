// Browser entry for the "islands within islands" demo: a random multi-material labelmap (organs with
// embedded tumors, tumors with necrotic cores, touching clusters, vessels) rendered through the
// multi-material INTERFACE field (SegmentationLogic boundaryMode "all"). Proves internal label↔label
// boundaries surface with correct per-region colour and per-segment opacity — the case the outer-only
// shell couldn't show. Regenerate for new scenarios; Randomize look for opacity/shading variety.
// Bundled to live/webgpu/islands.js.
import { initDevice } from "../../render/device.ts";
import { attachCameraControls, framedCamera } from "../../render/demos/camera-control.ts";
import { mountAdaptive3d } from "../../render/demos/accum-loop.ts";
import { buildIslandsScene } from "./islands-scene.ts";
import { SegBudget } from "../../logic/seg-budget.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status-text");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  status("initializing WebGPU…");
  const gpu = await initDevice();
  (globalThis as unknown as { __gpuErr: string[] }).__gpuErr = [];
  gpu.device.addEventListener("uncapturederror", (e) => (globalThis as unknown as { __gpuErr: string[] }).__gpuErr.push(String((e as GPUUncapturedErrorEvent).error?.message ?? (e as GPUUncapturedErrorEvent).error)));
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  status("probing device capability…");
  const budget = await SegBudget.probe(gpu.device);
  // grid resolution from the device tier (phone stays smooth; high-end gets detail)
  const dim = budget.tier === "high" ? 144 : budget.tier === "mid" ? 112 : 88;
  const rs = buildIslandsScene(gpu, srgb, { refineDelayMs: budget.refineDelayMs(), dim });
  const camera = framedCamera(rs.center, rs.radius, 2.6);

  const a3d = mountAdaptive3d({
    scene: () => rs.scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
    onFrame: () => {},
  });
  const draw = () => a3d.draw();
  const drawNow = () => a3d.renderSettled(true);
  rs.onRedraw(() => drawNow());

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(820, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; drawNow();
  };
  globalThis.addEventListener("resize", resize);
  attachCameraControls(canvas, camera, { onChange: draw });

  const summary = () => `${rs.labels().length} labels · ${dim}³ · multi-material interface field`;
  document.getElementById("regen")?.addEventListener("click", () => {
    rs.regenerate(); drawNow();
    status(`new scene — ${summary()} · drag to orbit`);
  });
  document.getElementById("rand")?.addEventListener("click", () => {
    rs.randomizeLook(); drawNow();
    status("randomized per-segment opacity + surface/volume shading");
  });
  document.getElementById("reset")?.addEventListener("click", () => {
    rs.resetLook(); drawNow();
    status("reset per-segment look (depth-based: outer translucent, inner opaque)");
  });
  const op = document.getElementById("opacity") as HTMLInputElement | null;
  op?.addEventListener("input", () => { rs.setAllOpacity(parseInt(op.value, 10) / 100); drawNow(); });

  resize();
  status(`${summary()} · ${budget.tier}-tier · drag to orbit · scroll/pinch to zoom · Regenerate for a new case`);

  (globalThis as unknown as { __islandsDbg: unknown }).__islandsDbg = {
    labels: () => rs.labels().length,
    dist: () => camera.distance,
    err: () => ((globalThis as unknown as { __gpuErr: string[] }).__gpuErr || []).length,
    tier: () => budget.tier,
    regenerate: () => { rs.regenerate(); drawNow(); },
  };
}

main();
