// Browser entry for the A-0 `algorithms/` demo: an EditableSegmentation rendered in SURFACE mode
// (gradient-opacity soft edges, the Carve/SegmentSurfaces look — not the iso shell). "Poke sphere"
// stamps another sphere on-GPU through the shared master buffer; the surface re-renders in place with
// no rebuild — the shared-buffer → renderer loop that A-1's paint effect will drive from the mrson
// stream. No editing UI yet (by design). Drag to orbit · scroll to zoom.
// Bundled to live/webgpu/algorithms.js.
import { initDevice } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { attachCameraControls, framedCamera } from "../../render/demos/camera-control.ts";
import { mountAdaptive3d } from "../../render/demos/accum-loop.ts";
import { buildAlgorithmsScene } from "./algorithms-scene.ts";
import type { Vec3 } from "../../render/mat4.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status-text");
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

  const a = buildAlgorithmsScene(gpu, srgb);
  const camera = framedCamera(a.center, a.radius, 2.8);

  const a3d = mountAdaptive3d({
    scene: () => a.scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
    onFrame: () => {},
  });
  const draw = () => a3d.draw();
  const drawNow = () => a3d.renderSettled(true);

  // A shared-buffer edit (effect → logic rebakes the render texture in place) needs only a redraw.
  // onRedraw fires POST-rebake and persists across render-mode swaps.
  a.onRedraw(() => drawNow());

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(760, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; drawNow();
  };
  globalThis.addEventListener("resize", resize);
  attachCameraControls(canvas, camera, { onChange: draw });

  // The A-0 "poke": stamp a sphere at a pseudo-random RAS point within the grid. (No RNG-in-shader
  // needed — plain JS Math.random on the client.) Foreshadows A-1's incremental paint stamps.
  let n = 0;
  const poke = () => {
    const R = 70;
    const c: Vec3 = [(Math.random() * 2 - 1) * R, (Math.random() * 2 - 1) * R, (Math.random() * 2 - 1) * R];
    a.poke(c, 16 + Math.random() * 12);
    status(`poked ${++n} sphere${n === 1 ? "" : "s"} through the shared buffer · surface re-rendered in place`);
  };
  document.getElementById("poke")?.addEventListener("click", poke);

  // "Paint stroke": drive an incremental arc through the SegEditDriver (the SAME path a Slicer SegEdit
  // stream drives), one sample per animation frame — so you watch it paint in real time, interpolated
  // into a continuous tube. No UI palette; the driver consumes ops, exactly as A-1 intends.
  let painting = false, strokeN = 0;
  const paintStroke = async () => {
    if (painting) return;
    painting = true;
    const R = 55, N = 26;
    const cx = (Math.random() * 2 - 1) * 30, cy = (Math.random() * 2 - 1) * 30, cz = (Math.random() * 2 - 1) * 30;
    // A unique segmentId per stroke → the driver allocates a new coloured label.
    a.driver.beginStroke({ segmentId: `stroke_${++strokeN}`, effect: "Paint", brush: { shape: "sphere", diameterMm: 14 } });
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * Math.PI * 1.5;
      a.driver.addPoint([cx + R * Math.cos(t), cy + R * Math.sin(t) * 0.6, cz + (i / N) * 40 - 20]);
      status(`painting stroke from the SegEdit stream… sample ${i + 1}/${N}`);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    a.driver.endStroke();
    status(`painted a stroke via SegEditDriver (${N} samples, interpolated) · orbit to inspect`);
    painting = false;
  };
  document.getElementById("paint")?.addEventListener("click", paintStroke);

  // Render-path toggle: sdf (crisp, terrace-free surface model) ↔ surface (Gaussian gradient-opacity).
  // Swaps in place, preserving the painted segmentation, so you can A/B the look.
  const modeBtn = document.getElementById("mode") as HTMLButtonElement | null;
  const syncModeBtn = () => { if (modeBtn) modeBtn.textContent = a.renderMode() === "sdf" ? "Render: SDF" : "Render: Gaussian"; };
  syncModeBtn();
  modeBtn?.addEventListener("click", () => {
    a.setRenderMode(a.renderMode() === "sdf" ? "surface" : "sdf");
    syncModeBtn();
    drawNow();
    status(`render path: ${a.renderMode() === "sdf" ? "SDF (crisp, terrace-free)" : "Gaussian (gradient-opacity)"}`);
  });

  // Opaque ↔ translucent surface models (per-segment opacity): translucent lets you see inner
  // segments through outer ones.
  const opacBtn = document.getElementById("opac") as HTMLButtonElement | null;
  const syncOpacBtn = () => { if (opacBtn) opacBtn.textContent = a.allOpacity() < 1 ? "Surfaces: Translucent" : "Surfaces: Opaque"; };
  syncOpacBtn();
  opacBtn?.addEventListener("click", () => {
    a.setAllOpacity(a.allOpacity() < 1 ? 1 : 0.45);
    syncOpacBtn();
    drawNow();
    status(a.allOpacity() < 1 ? "translucent surface models — see through outer segments to inner ones" : "opaque surfaces");
  });

  document.getElementById("reset")?.addEventListener("click", () => location.reload());

  resize();
  status("surface-mode segmentation · drag to orbit · scroll to zoom · Poke to edit the shared buffer");
}

main();
