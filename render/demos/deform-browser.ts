// Browser entry for the "Landmark Deform (TPS)" selftest port — a nonlinear
// thin-plate-spline transform warping a volume during the ray march. Drag the gain
// slider from 0 (identity) to 1 (full warp) to see the deformation applied live.
// Bundled to live/webgpu/deform.js.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildDeformScene } from "./deform-scene.ts";
import { orbitEye } from "./sphere-scene.ts";
import { installIntrospection } from "../introspect.ts";

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

  status("solving thin-plate spline…");
  const sc = buildDeformScene(gpu.device, 1.0);
  const scene = new SceneRenderer(gpu, srgb);
  scene.build([sc.warp, sc.image, sc.fiducials]);
  scene.setBackground(0.06, 0.07, 0.10);

  let az = 0.75, el = 0.28, dist = 360;
  const draw = () => {
    const w = canvas.width, h = canvas.height;
    scene.setCamera(orbitEye(az, el, dist), [0, 0, 0], [0, 0, 1], 26, w, h);
    const t0 = performance.now();
    scene.renderToView(ctx.getCurrentTexture().createView({ format: srgb }), w, h);
    status(`Landmark deform (TPS) · gain ${sc.warp.gain.toFixed(2)} · ${w}×${h} · ${(performance.now() - t0).toFixed(0)} ms/frame · drag to orbit`);
  };
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(720, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; draw();
  };
  globalThis.addEventListener("resize", resize);

  // gain slider: 0 = identity, 1 = full warp. Only the uniform changes — no rebuild.
  const slider = document.getElementById("gain") as HTMLInputElement | null;
  slider?.addEventListener("input", () => {
    sc.warp.setGain(Number(slider.value) / 100);
    scene.build([sc.warp, sc.image, sc.fiducials]);   // refresh uniforms
    scene.setBackground(0.06, 0.07, 0.10);
    draw();
  });

  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    az += (e.clientX - lx) * 0.008;
    el = Math.max(-1.4, Math.min(1.4, el - (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY; draw();
  });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(120, Math.min(900, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw(); }, { passive: false });

  installIntrospection({
    getCamera: () => ({ azimuth: az, elevation: el, distance: dist, position: orbitEye(az, el, dist), focalPoint: [0, 0, 0], viewUp: [0, 0, 1], viewAngle: 26 }),
    setCamera: (p) => { if (p.azimuth !== undefined) az = p.azimuth; if (p.elevation !== undefined) el = p.elevation; if (p.distance !== undefined) dist = p.distance; draw(); },
    extra: () => ({ gain: sc.warp.gain }),
    render: () => draw(),
  });
  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
