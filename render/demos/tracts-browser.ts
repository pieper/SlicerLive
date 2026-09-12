// Browser entry for the whole-brain tractography demo: the fiber bundles of a real Slicer scene
// (SlicerDMRI, TractCloud-clustered) rendered as capsule tubes by FiberField — the same tube
// rendering as the synthetic lava-lamp demo, on 3.6M points of real data.
//
// The SlicerLive badge's popup mirrors the Slicer DATA MODULE's grouping: one opacity row per tract
// group (Association, Cerebellar, Commissural, Projection, Superficial), each scaling every bundle
// under it, so whole groups can be dialed independently.
//   deno run -A npm:esbuild@0.21.5 render/demos/tracts-browser.ts --bundle --format=esm \
//     --outfile=/tmp/slicerlive-tracts/tracts.js
//   cp render/demos/tracts.html /tmp/slicerlive-tracts/tracts.html
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildTractScene, fractionCapForLimits, type TractScene } from "./tracts-scene.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import { installChrome } from "./sl-chrome.ts";
import { installIntrospection } from "../introspect.ts";
import type { Vec3 } from "../mat4.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);
  const base = params.get("base") ?? "./";
  const fraction = params.has("fraction") ? parseFloat(params.get("fraction")!) : undefined;
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  status("initializing WebGPU…");
  const gpu = await initDevice();
  (globalThis as unknown as { __gpuErr: string[] }).__gpuErr = [];
  gpu.device.addEventListener("uncapturederror", (e) => (globalThis as unknown as { __gpuErr: string[] }).__gpuErr.push(String((e as GPUUncapturedErrorEvent).error?.message ?? (e as GPUUncapturedErrorEvent).error)));
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  const t0 = performance.now();
  let sc: TractScene;
  try {
    // Start at the smallest chunk and let the measured ramp below decide how much this device can
    // actually hold and draw — a phone and a workstation get very different answers.
    sc = await buildTractScene(gpu.device, base, {
      fraction: fraction ?? 0.05,
      onProgress: (done, total, name) => status(`loading tracts… ${done}/${total} · ${name}`),
    });
  } catch (e) {
    status(`could not load the tracts from ${base} — ${(e as Error).message}`, true);
    return;
  }
  const loadMs = performance.now() - t0;
  const scene = new SceneRenderer(gpu, srgb);
  scene.build([sc.fibers]);
  scene.setBackground(0.05, 0.06, 0.09);

  // PURE SAGITTAL start view — camera on the patient's left looking along +R, superior up, the
  // orientation Slicer's sagittal view uses. Fitted to the tracts' PROJECTED extent: framing on the
  // bounding SPHERE (the 138 mm half-diagonal of a 145x192x132 mm box) leaves the brain filling about
  // half the view, because no single direction sees the diagonal. Fitting the box's eight corners to
  // the frustum in both screen axes zooms to what is actually on screen, at any window shape.
  const camera = framedCamera(sc.center, sc.radius, 2.6);
  const dir: Vec3 = [-1, 0, 0];
  let userMoved = false;
  const bb = sc.manifest.boundsRAS;
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) corners.push([bb[i & 1 ? 1 : 0], bb[i & 2 ? 3 : 2], bb[i & 4 ? 5 : 4]]);
  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const frameCamera = (w: number, h: number) => {
    const tanV = Math.tan((camera.viewAngle * Math.PI) / 360), tanH = tanV * (w / h);
    const right = unit(cross3(dir, [0, 0, 1]));
    const up = cross3(right, dir);
    let d = 0;
    for (const c of corners) {
      const o: Vec3 = [c[0] - sc.center[0], c[1] - sc.center[1], c[2] - sc.center[2]];
      const depth = dot3(o, dir);   // toward the eye: a nearer corner needs more distance
      d = Math.max(d, depth + Math.abs(dot3(o, up)) / tanV, depth + Math.abs(dot3(o, right)) / tanH);
    }
    d *= 1.06;
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

  let tuned: { capPct: number; ms: number } | null = null;
  const showStatus = () => status(
    `${sc.manifest.bundles.length} bundles · ${sc.strandCount.toLocaleString()} streamlines (${Math.round(sc.fraction * 100)}%` +
    `${tuned ? ` auto, ${tuned.ms.toFixed(0)} ms probe, fits ${tuned.capPct}%` : ""}) · ` +
    `${sc.capsuleCount.toLocaleString()} capsules · ${(sc.bytesFetched / 1e6).toFixed(1)} MB · ` +
    `${canvas.width}×${canvas.height} · drag to rotate`);

  // Streamline-percentage slider. Each step pulls only the 5% chunks not already held, then rebuilds
  // the field (its capsule grid is baked at construction). Debounced, so dragging across the slider
  // fetches once at the value you land on rather than at every step along the way.
  let target = Math.round(sc.fraction * 100), timer = 0, applying = false, queued = -1;
  const applyFraction = async (p: number) => {
    if (applying) { queued = p; return; }
    applying = true;
    const t = performance.now();
    try {
      await sc.setFraction(p / 100, (done, total, name) => status(`loading ${p}% · chunk ${done}/${total} · ${name}`));
      scene.build([sc.fibers]);            // a new field object: rebuild pipeline + bind group
      scene.setBackground(0.05, 0.06, 0.09);
      a3d.renderSettled(true);
      status(`${sc.strandCount.toLocaleString()} streamlines (${Math.round(sc.fraction * 100)}%) · ` +
        `${sc.capsuleCount.toLocaleString()} capsules · rebuilt in ${((performance.now() - t) / 1000).toFixed(1)}s`);
    } catch (e) {
      status(`could not load more streamlines — ${(e as Error).message}`, true);
    }
    applying = false;
    if (queued >= 0 && queued !== p) { const q = queued; queued = -1; await applyFraction(q); }
    else { queued = -1; setTimeout(showStatus, 1500); }
  };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(16, Math.round(canvas.clientWidth * dpr)), h = Math.max(16, Math.round(canvas.clientHeight * dpr));
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w; canvas.height = h;
    if (!userMoved) frameCamera(w, h);
    showStatus();
    a3d.renderSettled(true);
  };
  globalThis.addEventListener("resize", resize);
  new ResizeObserver(resize).observe(canvas);
  attachCameraControls(canvas, camera, { onChange: () => { userMoved = true; a3d.draw(); } });

  // The Data module's hierarchy: one opacity row per tract group, scaling every bundle under it.
  installChrome({
    controls: [
      {
        label: "Streamlines",
        section: "Tracts",
        slider: {
          min: 5, max: 100, step: 5,
          get: () => target,
          set: (v: number) => {
            target = Math.round(v);
            clearTimeout(timer);
            timer = setTimeout(() => applyFraction(target), 350);
          },
          format: (v: number) => `${Math.round(v)}%`,
        },
      },
      ...sc.groups.map((g) => ({
        label: `${g.name} (${g.bundleIds.length})`,
        section: "Tract groups",
        color: g.color,
        getOpacity: () => sc.groupOpacity(g.name),
        setOpacity: (o: number) => { sc.setGroupOpacity(g.name, o); scene.syncUniforms(); },
      })),
    ],
    help: [{ title: "Tractography", rows: [
      ["Left-drag", "Rotate"], ["Right-drag / wheel", "Zoom"], ["Middle / Shift+Left-drag", "Pan"],
      ["SlicerLive badge", "Streamline % + per-group opacity"],
    ] }],
    onChange: () => a3d.draw(),
  });

  const fullBtn = document.getElementById("full") as HTMLButtonElement | null;
  if (fullBtn) {
    fullBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    };
  }

  installIntrospection({
    getCamera: () => ({ azimuth: 0, elevation: 0, distance: camera.distance, position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3, viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle }),
    setCamera: (p) => { if (p.position) camera.position = [...p.position] as Vec3; if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3; userMoved = true; a3d.renderSettled(true); },
    extra: () => ({ bundles: sc.manifest.bundles.length, streamlines: sc.strandCount, capsules: sc.capsuleCount }),
    render: () => a3d.renderSettled(true),
  });
  (globalThis as unknown as { __tractsDbg: unknown }).__tractsDbg = {
    bundles: () => sc.manifest.bundles.length,
    streamlines: () => sc.strandCount,
    capsules: () => sc.capsuleCount,
    groups: () => sc.groups.map((g) => ({ name: g.name, n: g.bundleIds.length, opacity: sc.groupOpacity(g.name) })),
    setGroupOpacity: (g: string, o: number) => { sc.setGroupOpacity(g, o); scene.syncUniforms(); a3d.renderSettled(true); },
    accumCount: () => scene.accumCount(),
    loadMs: () => loadMs,
    bytes: () => sc.bytesFetched,
    fraction: () => sc.fraction,
    setFraction: async (p: number) => { target = p; await applyFraction(p); return { streamlines: sc.strandCount, capsules: sc.capsuleCount, bytes: sc.bytesFetched }; },
    canvas: () => { const r = canvas.getBoundingClientRect(); return { w: canvas.width, h: canvas.height, left: r.left, top: r.top, width: r.width, height: r.height }; },
  };

  resize();
  a3d.renderSettled(true);
  showStatus();

  // ADAPTIVE DENSITY. Two limits decide how many streamlines this device gets: what its buffers can
  // hold (from the adapter's reported limits) and what it can draw fast enough (measured here, not
  // guessed from a device name). Starting at 5%, time a real full-resolution frame and step up one
  // 5% chunk while frames stay under budget — so a phone settles low and a workstation climbs.
  // An explicit ?fraction= overrides the whole thing.
  // Probe the DEVICE, not the window. Timing a full-resolution settled frame conflates geometry with
  // however large the window happens to be (55 ms at 1600x856 says nothing about whether this GPU can
  // hold more streamlines), and the settled frame is the converging still — interaction already
  // renders scaled down. So time a FIXED-SIZE frame through the same upscale path interaction uses.
  const PROBE_W = 640, PROBE_H = 360;
  const PROBE_BUDGET_MS = 10;
  const AUTO_MAX = 0.5;            // past this the viewer asks for it on the slider
  const measureFrame = async () => {
    const vw = canvas.width, vh = canvas.height;
    scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, PROBE_W, PROBE_H);
    const view = () => ctx.getCurrentTexture().createView({ format: srgb });
    // Warm up FIRST, then time: onSubmittedWorkDone drains everything already queued (the full-res
    // frame that just ran), and the frame after each scene.build() pays WGSL pipeline compilation.
    // Timing the second frame measures the geometry, which is what density should be judged on.
    scene.renderUpscaled(view(), PROBE_W, PROBE_H, vw, vh);
    await gpu.device.queue.onSubmittedWorkDone();
    const t = performance.now();
    scene.renderUpscaled(view(), PROBE_W, PROBE_H, vw, vh);
    await gpu.device.queue.onSubmittedWorkDone();
    return performance.now() - t;
  };
  if (fraction === undefined) {
    const cap = Math.min(fractionCapForLimits(sc.manifest, gpu.adapter.limits), AUTO_MAX);
    let ms = await measureFrame();
    for (let step = 0; step < 8 && sc.fraction + 0.05 <= cap + 1e-6 && ms < PROBE_BUDGET_MS; step++) {
      const next = Math.round((sc.fraction + 0.05) * 100);
      status(`tuning density for this GPU… trying ${next}% (${ms.toFixed(0)} ms probe)`);
      await sc.setFraction(next / 100);
      scene.build([sc.fibers]);
      scene.setBackground(0.05, 0.06, 0.09);
      ms = await measureFrame();
      if (ms > PROBE_BUDGET_MS * 1.35) {     // overshot: drop back a chunk and stop
        await sc.setFraction(Math.max(0.05, sc.fraction - 0.05));
        scene.build([sc.fibers]);
        scene.setBackground(0.05, 0.06, 0.09);
        a3d.renderSettled(true);
        break;
      }
    }
    target = Math.round(sc.fraction * 100);
    tuned = { capPct: Math.round(cap * 100), ms };
    a3d.renderSettled(true);
    showStatus();
  }
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
