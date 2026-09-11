// Browser entry for the fiber-tract "lava lamp" demo — a port of SlicerWGPU SceneRendering's
// test_vtk_FieldCompositing: ~1500 synthetic streamlines rendered as capsule tubes (FiberField), three
// breathing glow blobs in an animated RGBA volume that chase a draggable attractor fiducial, and the
// markup fiducials, all composited in one ray-march. While playing, the animation loop owns the canvas
// and renders with rolling accumulation (the fibers stay anti-aliased as the blobs move); paused, the
// shared adaptive loop converges to a fully accumulated still.
//   deno run -A npm:esbuild@0.21.5 render/demos/fibers-browser.ts --bundle --format=esm \
//     --outfile=live/webgpu/fibers.js
//   cp render/demos/fibers.html live/webgpu/fibers.html
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { BUNDLE_COLORS, BUNDLE_NAMES, buildFiberScene, fiducialSpheres, LavaLamp, sceneFields } from "./fiber-scene.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { orbitEye } from "./sphere-scene.ts";
import { attachWidgetControls, type Handle } from "./widget-control.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import { installChrome } from "./sl-chrome.ts";
import { installIntrospection } from "../introspect.ts";
import type { Vec3 } from "../mat4.ts";

const ROLLING_FRAMES = 6;   // accumulation window while the blobs move
const ATTRACTOR_INSET = 12; // mm — keep the attractor inside the lava volume so the blobs stay visible

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const playBtn = document.getElementById("play") as HTMLButtonElement;
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  status("initializing WebGPU…");
  const gpu = await initDevice();
  (globalThis as unknown as { __gpuErr: string[] }).__gpuErr = [];
  gpu.device.addEventListener("uncapturederror", (e) => (globalThis as unknown as { __gpuErr: string[] }).__gpuErr.push(String((e as GPUUncapturedErrorEvent).error?.message ?? (e as GPUUncapturedErrorEvent).error)));
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  status("building fiber tracts…");
  const sc = buildFiberScene(gpu.device);
  const scene = new SceneRenderer(gpu, srgb);
  scene.build(sceneFields(sc));
  scene.setBackground(0.05, 0.06, 0.09);
  // Oblique start view: from the front the half-opacity U-arc bulges toward the camera and veils the
  // rest, while from above-and-aside every bundle (and the blobs) reads separately.
  const camera = framedCamera(sc.center, sc.radius, 3.0);
  const dir = orbitEye(0.6, 0.35, 1);
  // Frame to the TIGHTER screen dimension: viewAngle is the VERTICAL fov, so a wide window (a
  // maximized 4K panel, or this page's short canvas under the header) would otherwise crop the
  // bundles off the top and bottom. Re-applied on resize until the viewer moves the camera.
  let userMoved = false;
  const frameCamera = (w: number, h: number) => {
    const d = (sc.radius * 1.12) / Math.tan((camera.viewAngle * Math.PI) / 360) * Math.max(1, h / w);
    camera.position = [sc.center[0] + dir[0] * d, sc.center[1] + dir[1] * d, sc.center[2] + dir[2] * d];
    camera.focalPoint = [...sc.center] as Vec3;
  };
  frameCamera(1, 1);

  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
  });

  let playing = false, raf = 0, lastT = 0, lastCamMove = -1e9, inFlight = false;
  let fps = 0, nFrames = 0, fpsT0 = performance.now(), hint = "drag the yellow attractor to lead the blobs";
  const showStatus = () => status(`${sc.fibers.strandCount} tracts · ${sc.fibers.segmentCount.toLocaleString()} capsules · ${canvas.width}×${canvas.height} · ${playing ? (fps > 0 ? `${fps.toFixed(0)} fps` : "starting…") : "paused"} · ${hint}`);

  // Playing: advance the blob physics, re-upload the volume, and render — budget-scaled while the
  // camera moves, rolling-accumulated otherwise. GPU-paced: skip a rAF while a frame is in flight.
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (inFlight) return;
    sc.lava.advance((now - lastT) / 1000, sc.points[0]);
    lastT = now;
    sc.lava.upload();
    if (now - lastCamMove < 120) a3d.renderMoving(); else a3d.renderSettled(false);
    inFlight = true;
    gpu.device.queue.onSubmittedWorkDone().then(() => { inFlight = false; });
    nFrames++;
    if (now - fpsT0 > 500) { fps = (nFrames * 1000) / (now - fpsT0); nFrames = 0; fpsT0 = now; showStatus(); }
  };
  const setPlaying = (on: boolean) => {
    if (on === playing) return;
    playing = on;
    playBtn.textContent = on ? "❚❚ pause" : "▶ play";
    if (on) {
      a3d.loop.stop();                     // the animation loop owns the canvas + accumulator now
      scene.accumWindow = ROLLING_FRAMES;
      lastT = performance.now();
      raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(raf);
      raf = 0;
      scene.accumWindow = Infinity;        // a frozen scene converges to the full running mean
      scene.resetAccumulation();
      a3d.draw();
    }
    showStatus();
  };
  const redraw = () => { if (!playing) a3d.draw(); };   // while playing, every frame is already rendering

  // The canvas fills the window, so the drawing buffer follows its CSS size × devicePixelRatio (a
  // maximized window on a 4K panel traces at ~3840 wide). While interacting, BudgetController still
  // scales the traced frame down and upsamples, so a big view stays responsive.
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(16, Math.round(canvas.clientWidth * dpr)), h = Math.max(16, Math.round(canvas.clientHeight * dpr));
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w; canvas.height = h;
    if (!userMoved) frameCamera(w, h);
    showStatus();
    if (!playing) a3d.renderSettled(true);
  };
  globalThis.addEventListener("resize", resize);
  new ResizeObserver(resize).observe(canvas);

  // The attractor (the list's first control point) is the one draggable handle.
  attachWidgetControls(canvas, camera, {
    // A COPY: onDrag mutates sc.points[0] in place, and the widget holds the grabbed handle's
    // `world` as the drag plane for the life of the drag — handing out the live array would move
    // that plane under the drag, collapsing the attractor toward the camera axis instead of
    // following the cursor.
    getHandles: (): Handle[] => [{ id: 0, world: [...sc.points[0]] as Vec3, pickPx: 18 }],
    getSize: () => ({ w: canvas.width, h: canvas.height }),
    onDragStart: () => { hint = "leading the blobs…"; showStatus(); },
    onDrag: (_h, world) => {
      for (let a = 0; a < 3; a++) {
        sc.points[0][a] = Math.min(LavaLamp.HI[a] - ATTRACTOR_INSET, Math.max(LavaLamp.LO[a] + ATTRACTOR_INSET, world[a]));
      }
      sc.fiducials.setSpheres(fiducialSpheres(sc.points));
      scene.syncUniforms();
    },
    onDragEnd: () => { hint = "drag the yellow attractor to lead the blobs"; showStatus(); },
    onChange: redraw,
  });
  attachCameraControls(canvas, camera, { onChange: () => { userMoved = true; lastCamMove = performance.now(); redraw(); } });

  // Per-bundle opacity lives in the SlicerLive badge: a live palette write, no rebuild.
  const bundleOpacity: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 1 };
  installChrome({
    controls: [1, 2, 3, 4].map((id) => {
      const c = BUNDLE_COLORS[id];
      return {
        label: BUNDLE_NAMES[id],
        section: "Fiber bundles",
        color: [c[0], c[1], c[2]] as [number, number, number],
        getOpacity: () => bundleOpacity[id],
        setOpacity: (o: number) => { bundleOpacity[id] = o; sc.fibers.setBundleColor(id, [c[0], c[1], c[2], c[3] * o]); },
      };
    }),
    help: [{ title: "Fiber tracts", rows: [
      ["Drag the yellow attractor", "Lead the glow blobs"], ["Space / button", "Play / pause"],
      ["Left-drag", "Rotate"], ["Right-drag / wheel", "Zoom"], ["Middle / Shift+Left-drag", "Pan"],
      ["SlicerLive badge", "Per-bundle opacity"],
    ] }],
    onChange: redraw,
  });

  playBtn.onclick = () => setPlaying(!playing);
  const fullBtn = document.getElementById("full") as HTMLButtonElement | null;
  if (fullBtn) {
    fullBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    };
  }
  globalThis.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || (e.target as HTMLElement)?.tagName === "INPUT") return;
    e.preventDefault();
    setPlaying(!playing);
  });

  installIntrospection({
    getCamera: () => ({ azimuth: 0, elevation: 0, distance: camera.distance, position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3, viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle }),
    setCamera: (p) => { if (p.position) camera.position = [...p.position] as Vec3; if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3; if (p.viewUp) camera.viewUp = [...p.viewUp] as Vec3; lastCamMove = performance.now(); redraw(); },
    extra: () => ({ playing, fps, attractor: [...sc.points[0]], blobs: sc.lava.pos.map((p) => [...p]) }),
    render: () => a3d.renderSettled(true),
  });
  (globalThis as unknown as { __fibersDbg: unknown }).__fibersDbg = {
    playing: () => playing,
    setPlaying,
    fps: () => fps,
    attractor: () => [...sc.points[0]],
    blobs: () => sc.lava.pos.map((p) => [...p]),
    accumCount: () => scene.accumCount(),
    camera: () => ({ position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp], viewAngle: camera.viewAngle }),
    canvas: () => { const r = canvas.getBoundingClientRect(); return { w: canvas.width, h: canvas.height, left: r.left, top: r.top, width: r.width, height: r.height }; },
  };

  resize();
  setPlaying(true);
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
