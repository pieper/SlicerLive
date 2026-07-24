// Browser entry for the "Landmark Deform (TPS)" selftest port — a nonlinear
// thin-plate-spline transform warping a volume during the ray march. Drag the gain
// slider from 0 (identity) to 1 (full warp) to see the deformation applied live.
// Bundled to live/webgpu/deform.js.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildDeformScene } from "./deform-scene.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { attachWidgetControls, type Handle } from "./widget-control.ts";
import { installIntrospection } from "../introspect.ts";
import type { Vec3 } from "../mat4.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const sceneUrl = new URLSearchParams(location.search).get("scene") ??
    "https://pieper.github.io/live/legacy/scenes/MRHead.json";
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  status("initializing WebGPU…");
  const gpu = await initDevice();
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  let mb = 0;
  status("streaming MRHead from the bucket…");
  const sc = await buildDeformScene(gpu.device, sceneUrl, (n) => { mb += n; status(`streaming MRHead… ${(mb / 1e6).toFixed(1)} MB`); });
  const scene = new SceneRenderer(gpu, srgb);
  scene.build([sc.warp, sc.image, sc.fiducials]);
  scene.setBackground(0.06, 0.07, 0.10);

  const { center, radius } = sc.sv;
  const camera = framedCamera(center as Vec3, radius, 3.5);
  let msg = "drag a magenta pin to deform · drag empty space to rotate";
  const draw = () => {
    const w = canvas.width, h = canvas.height;
    scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h);
    const t0 = performance.now();
    scene.renderToView(ctx.getCurrentTexture().createView({ format: srgb }), w, h);
    status(`${sc.sv.name} · TPS landmark deform · gain ${sc.warp.gain.toFixed(2)} · ${(performance.now() - t0).toFixed(0)} ms/frame · ${msg}`);
  };
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(720, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size; draw();
  };
  globalThis.addEventListener("resize", resize);

  // gain slider: 0 = identity, 1 = full warp. Tier-A: only the uniform changes — syncUniforms,
  // no pipeline rebuild.
  const slider = document.getElementById("gain") as HTMLInputElement | null;
  slider?.addEventListener("input", () => {
    sc.warp.setGain(Number(slider.value) / 100);
    scene.syncUniforms();
    draw();
  });

  // Draggable TPS landmarks: the 8 magenta TARGET pins. Grab a pin -> re-solve the TPS in
  // place (syncUniforms, no rebuild) as you drag; empty space bubbles to the camera.
  attachWidgetControls(canvas, camera, {
    getHandles: (): Handle[] => sc.targets.map((world, id) => ({ id, world: world as Vec3, cursor: "grab" })),
    getSize: () => ({ w: canvas.width, h: canvas.height }),
    onDragStart: (h) => { msg = `dragging landmark ${h.id}`; },
    onDrag: (h, world) => { sc.setTarget(h.id, world, gpu.device); scene.syncUniforms(); },
    onDragEnd: () => { msg = "drag a magenta pin to deform · drag empty space to rotate"; },
    onHover: (h) => { sc.highlightTarget(h ? h.id : null); scene.syncUniforms(); },
    onChange: draw,
  });

  attachCameraControls(canvas, camera, { onChange: draw });

  installIntrospection({
    getCamera: () => ({ azimuth: 0, elevation: 0, distance: camera.distance, position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3, viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle }),
    setCamera: (p) => { if (p.position) camera.position = [...p.position] as Vec3; if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3; if (p.viewUp) camera.viewUp = [...p.viewUp] as Vec3; draw(); },
    extra: () => ({ gain: sc.warp.gain }),
    render: () => draw(),
  });

  // Debug hook for the on-screen drag harness: current targets + camera + canvas rect, so
  // the test can locate a pin in client px, synthesize a drag, and confirm the target moved.
  (globalThis as unknown as { __deformDbg: unknown }).__deformDbg = {
    snapshot: () => {
      const r = canvas.getBoundingClientRect();
      return {
        targets: sc.targets.map((t) => [...t]),
        camera: { position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp], viewAngle: camera.viewAngle },
        canvas: { w: canvas.width, h: canvas.height, left: r.left, top: r.top, width: r.width, height: r.height },
        gain: sc.warp.gain,
      };
    },
  };
  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
