// Browser entry for the ColorizeVolume (segmentation) gallery demo. Bundled to
// live/webgpu/colorize.js. Bakes a synthetic segmentation on the GPU and renders
// it with the RGBAVolumeField — the same path a real nnLive mask will take.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { DIST, buildColorizeField } from "./colorize-scene.ts";
import { orbitEye } from "./sphere-scene.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  status("initializing WebGPU…");
  const gpu = await initDevice();

  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  const scene = new SceneRenderer(gpu, srgb);
  status("baking segmentation → RGBA volume…");
  scene.build([buildColorizeField(gpu.device)]);
  scene.setBackground(0.06, 0.07, 0.10);

  let az = 0.1, el = 0.22, dist = DIST;
  const draw = () => {
    const w = canvas.width, h = canvas.height;
    scene.setCamera(orbitEye(az, el, dist), [0, 0, 0], [0, 0, 1], 30, w, h);
    const t0 = performance.now();
    scene.renderToView(ctx.getCurrentTexture().createView({ format: srgb }), w, h);
    status(`ColorizeVolume · 3-label segmentation baked on GPU · ${w}×${h} · ${(performance.now() - t0).toFixed(0)} ms/frame · drag to orbit`);
  };
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(720, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; draw();
  };
  globalThis.addEventListener("resize", resize);

  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    az += (e.clientX - lx) * 0.008;
    el = Math.max(-1.4, Math.min(1.4, el - (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY; draw();
  });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(220, Math.min(1100, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw(); }, { passive: false });
  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
