// Browser entry for the whole-brain tractography demo: the fiber bundles of a real Slicer scene
// (SlicerDMRI, TractCloud-clustered) rendered as capsule tubes by FiberField — the same tube
// rendering as the synthetic lava-lamp demo, on 3.6M points of real data.
//
// The SlicerLive badge's popup mirrors the Slicer DATA MODULE's grouping: one opacity row per tract
// group (Association, Cerebellar, Commissural, Projection, Superficial), each scaling every bundle
// under it, so whole groups can be dialed independently — alongside the streamline-density, target
// frame rate, and depth-cue controls.
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
  // The tract chunks live in the public JS2 container alongside the other gallery assets. Override
  // with ?base=./ to serve them from the same directory as the page (how they are exported locally).
  const base = params.get("base") ?? "https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive/tracts/";
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
    // 10 fps rather than the usual 60: dense tracts downsampled hard to hold a high frame rate alias
    // badly while rotating (thin tubes scintillating), and detail matters more here than smoothness.
    // The Target fps slider below moves this at runtime.
    targetMs: 100,
    // These tubes are sub-pixel, so a single sample aliases badly even at full resolution — measured
    // mid-drag gradient energy 44.5 against 25.6 settled. Once the budget has bought native
    // resolution, spend what is left on jittered samples of the same frame: at a 1 fps target that is
    // ~17 samples, at 60 fps it stays at 1 and nothing changes. Capped so a very low target cannot
    // queue an unbounded stall on one frame.
    maxMovingSamples: 16,
  });

  // Reset the accumulation and then let the loop CONVERGE on it. renderSettled(true) by itself draws
  // a single accumulation sample and returns: the loop is not running, so nothing advances it toward
  // the 24-sample target and the image sits there under-baked — which on tubes this thin reads as
  // aliasing/scintillation rather than as noise. Kicking afterwards starts the loop, which settles
  // and then keeps accumulating until converged.
  const bake = () => { a3d.renderSettled(true); a3d.draw(); };

  // NOTHING unconverged reaches the canvas while loading. There are two sources of load-time jangle,
  // and both render here instead: the early samples of a temporal accumulation (sample 1 is
  // full-strength noise on sub-pixel tubes, quieting only as 1/n), and the density probe (a 640x360
  // frame upscaled to the window — visibly soft). The viewer therefore only ever sees finished
  // frames: a fully baked 5% first, then one clean image per fiber count as the tune walks up.
  let offTex: GPUTexture | undefined;
  const offscreenView = () => {
    const w = canvas.width, h = canvas.height;
    if (!offTex || offTex.width !== w || offTex.height !== h) {
      offTex?.destroy();
      offTex = gpu.device.createTexture({
        size: [w, h], format: srgb,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    return offTex.createView();
  };
  const settleOffscreen = async (samples = 24) => {
    const w = canvas.width, h = canvas.height;
    const off = offscreenView();
    // renderAccum resets whenever the camera matrix differs from the last accumulated frame, so the
    // camera must be set IDENTICALLY for every sample or it resets each time and never converges.
    const aim = () => scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h);
    aim();
    scene.renderAccum(off, w, h, true);
    for (let i = 0; i < samples * 2 && scene.accumCount() < samples; i++) {
      aim();
      scene.renderAccum(off, w, h, false);
      await gpu.device.queue.onSubmittedWorkDone();
    }
    // One more sample, this time onto the canvas: it carries the whole converged running mean.
    aim();
    scene.renderAccum(ctx.getCurrentTexture().createView({ format: srgb }), w, h, false);
    await gpu.device.queue.onSubmittedWorkDone();
  };

  let tuned: { capPct: number; ms: number } | null = null;
  // True until the startup density tune finishes. While it is set, the boot sequence owns the canvas
  // and puts only converged frames on it.
  let booting = true;
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
      bake();
      status(`${sc.strandCount.toLocaleString()} streamlines (${Math.round(sc.fraction * 100)}%) · ` +
        `${sc.capsuleCount.toLocaleString()} capsules · rebuilt in ${((performance.now() - t) / 1000).toFixed(1)}s`);
    } catch (e) {
      status(`could not load more streamlines — ${(e as Error).message}`, true);
    }
    applying = false;
    if (queued >= 0 && queued !== p) { const q = queued; queued = -1; await applyFraction(q); }
    else { queued = -1; setTimeout(showStatus, 1500); }
  };

  // Applying a control change. A uniform/palette edit is invisible to the ALREADY-ACCUMULATED image,
  // and kicking the loop is not enough on its own: a kick renders a low-res MOVING frame and only
  // resets accumulation on the moving→settled transition after the 120 ms idle gap, so a toggle could
  // look like it had not taken (and re-kicks kept pushing that reset further out). So: kick for
  // immediate cheap feedback, then force a reset+bake once the input stops. Debounced just past the
  // idle gap so dragging an opacity chip doesn't pay for a full-res settled frame per mouse-move.
  let bakeTimer = 0;
  const apply = () => {
    scene.syncUniforms();
    a3d.draw();
    clearTimeout(bakeTimer);
    bakeTimer = setTimeout(() => a3d.renderSettled(true), 140);
  };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(16, Math.round(canvas.clientWidth * dpr)), h = Math.max(16, Math.round(canvas.clientHeight * dpr));
    if (w === canvas.width && h === canvas.height) return;
    canvas.width = w; canvas.height = h;
    if (!userMoved) frameCamera(w, h);
    showStatus();
    // Baking here kicks the loop, which presents its moving frames and then the whole 1→24
    // convergence — exactly the load-time jangle. During boot the startup sequence renders instead.
    if (!booting) bake();
  };
  globalThis.addEventListener("resize", resize);
  new ResizeObserver(resize).observe(canvas);
  attachCameraControls(canvas, camera, { onChange: () => { userMoved = true; a3d.draw(); } });

  // The Data module's hierarchy: one opacity row per tract group, scaling every bundle under it.
  const chromeUi = installChrome({
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
      {
        label: "Human-expanded tracts",
        section: "Tracts",
        get: () => sc.highlight.active,
        set: (on: boolean) => { sc.setHighlight(on); apply(); showStatus(); },
      },
      {
        label: "Target fps",
        section: "Rendering",
        slider: {
          min: 1, max: 60, step: 1,
          get: () => Math.round(1000 / a3d.budget.targetMs),
          // Lower target = more time per frame = a bigger share of the native resolution kept while
          // rotating. The budget loop re-converges within a few frames either way.
          // Resolution only: this moves how much of the window is traced per frame, never how many
          // streamlines are loaded. Density is measured once at startup and then left alone.
          set: (v: number) => { a3d.budget.targetMs = 1000 / Math.max(1, Math.min(60, v)); },
          format: (v: number) => `${Math.round(v)} fps`,
        },
      },
      {
        label: "Halos (depth)",
        section: "Tracts",
        slider: {
          min: 0, max: 1, step: 0.1,
          get: () => sc.haloSettings.strength,
          set: (v: number) => { sc.setHalo(v); apply(); },
          format: (v: number) => (v <= 0.001 ? "off" : `${Math.round(v * 100)}%`),
        },
      },
      {
        label: "Ambient occlusion",
        section: "Tracts",
        slider: {
          min: 0, max: 1, step: 0.1,
          get: () => sc.aoSettings.strength,
          set: (v: number) => { sc.setAO(v); apply(); },
          format: (v: number) => (v <= 0.001 ? "off" : `${Math.round(v * 100)}%`),
        },
      },
      ...sc.groups.map((g) => ({
        label: `${g.name} (${g.bundleIds.length})`,
        section: "Tract groups",
        color: g.color,
        getOpacity: () => sc.groupOpacity(g.name),
        setOpacity: (o: number) => { sc.setGroupOpacity(g.name, o); apply(); },
      })),
    ],
    help: [{ title: "Tractography", rows: [
      ["Left-drag", "Rotate"], ["Right-drag / wheel", "Zoom"], ["Middle / Shift+Left-drag", "Pan"],
      ["SlicerLive badge", "Streamline % + target fps + depth cues + per-group opacity"],
      ["Human-expanded tracts", "Holds 10 tracts at full opacity and drops the rest to 10%, keeping their group colours as context: the dorsal language stream (arcuate, SLF II/III), the ventral semantic pathways (IOFF/IFOF, MdLF), the frontal projection systems that grew with prefrontal cortex (thalamo-frontal, striato-frontal, frontal corona radiata), the prefrontal arm of the cerebro-cerebellar loop (cortico-ponto-cerebellar), and frontal short-association fibres. This is prior knowledge from the comparative literature, not anything measured in this scan. NO tract is unique to humans — every one has a primate homologue, and the claim is expansion relative to chimpanzee and macaque, clearest for the arcuate's temporal projection (found in 10/10 humans, 1/4 chimpanzees, 0/3 macaques; Rilling 2008). Some inclusions are contested, notably whether macaques have an IFOF at all. Shown bilaterally, though the language evidence is strongest on the left."],
    ] }],
    onChange: () => apply(),
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
    // Deterministic hooks for the quality tests. Measuring a MOVING frame by dragging and guessing
    // when to screenshot is unreliable: one moving frame at a low fps target takes ~1s, and the loop
    // settles 120ms after the last kick, so a capture easily lands on a settled frame instead. These
    // render exactly one moving frame on demand and report what the budget is doing.
    renderMoving: () => a3d.renderMoving(),
    targetMs: () => a3d.budget.targetMs,
    budgetPx: () => a3d.budget.budgetPx,
    loadMs: () => loadMs,
    bytes: () => sc.bytesFetched,
    fraction: () => sc.fraction,
    highlight: () => ({ active: sc.highlight.active, bundles: sc.highlightedBundles(), dim: sc.highlight.dimOpacity }),
    setHighlight: (on: boolean) => { sc.setHighlight(on); scene.syncUniforms(); a3d.renderSettled(true); return sc.highlightedBundles().length; },
    setFraction: async (p: number) => { target = p; await applyFraction(p); return { streamlines: sc.strandCount, capsules: sc.capsuleCount, bytes: sc.bytesFetched }; },
    canvas: () => { const r = canvas.getBoundingClientRect(); return { w: canvas.width, h: canvas.height, left: r.left, top: r.top, width: r.width, height: r.height }; },
  };

  resize();                   // sizes the canvas; no bake while booting
  // Show the first render the moment there is geometry, then converge on top of it. Measured on the
  // shipping build: geometry is ready at ~2.7s, but the converged frame only reaches the screen at
  // ~3.7s — so waiting for the bake costs a full second of black. Sample 1 is noisier than the final
  // (gradient energy 15.4 against 10.0), but it is the FIRST thing shown rather than a regression of
  // something already on screen, and every present after it is a fully converged frame at a higher
  // fiber count. Quality only ever goes up from here.
  //   (accumCount is NOT a first-paint signal: settleOffscreen increments it off-screen too.)
  a3d.renderSettled(true);   // one direct frame; does not kick the loop, so nothing progressive shows
  await settleOffscreen();
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
  const PROBE_PX = PROBE_W * PROBE_H;
  // The ms the probe frame must come in under. The probe times a FIXED 640x360 frame, but what
  // actually matters is whether the device can trace the WHOLE window within the frame-time target —
  // that is exactly the point where rotating stops downsampling and the image stays sharp. So scale
  // the target by the window:probe pixel ratio. Sampled ONCE, during the startup tune — moving the
  // Target fps slider afterwards changes the render budget but never reopens this.
  //   (Before, this was a hardcoded 10 ms unrelated to the target — a 15 ms probe at 5% failed the
  //    very first test, so a capable GPU never loaded a single extra chunk.)
  const probeBudgetMs = () =>
    a3d.budget.targetMs * PROBE_PX / Math.max(PROBE_PX, canvas.width * canvas.height);
  const measureFrame = async () => {
    const vw = canvas.width, vh = canvas.height;
    scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, PROBE_W, PROBE_H);
    // Off-screen, NEVER the canvas: this frame is 640x360 upscaled to the window, so presenting it
    // stamped a soft blurry frame over the baked image once per density step.
    const view = offscreenView;
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
  // ONE-TIME density tune, at startup only: measure THIS GPU, then keep adding 5% chunks while it
  // still has headroom, stopping at the memory ceiling. Deliberately never re-run — changing the fps
  // target or resizing the window moves the frame budget but must NOT move the streamline count, so
  // what is on screen only changes when the viewer asks for it on the Streamlines slider.
  async function tuneDensity(): Promise<void> {
    if (fraction !== undefined) return;                 // ?fraction= pins the density explicitly
    // Quiesce the render loop FIRST. measureFrame waits on onSubmittedWorkDone, which drains every
    // outstanding submission — so with the loop running (it is: startup bakes, which kicks it) the
    // probe times the loop's frames as well as its own and reads far too high, and the ramp never
    // fires. Stopping is safe and reversible: the bake() below kicks, and kick() restarts run().
    a3d.loop.stop();
    const rebuild = () => { scene.build([sc.fibers]); scene.setBackground(0.05, 0.06, 0.09); };
    try {
      const cap = fractionCapForLimits(sc.manifest, gpu.adapter.limits);   // memory ceiling is the only cap
      const budget = probeBudgetMs();
      // (the boot sequence already presented a baked frame at the starting density)
      let ms = await measureFrame();
      // Up-only: the scene starts at the 5% floor, so there is nothing to give back on the way in.
      for (let step = 0; step < 20 && ms < budget && sc.fraction + 0.05 <= cap + 1e-6; step++) {
        const next = Math.min(cap, sc.fraction + 0.05);
        if (Math.abs(next - sc.fraction) < 1e-6) break;
        status(`tuning density for this GPU… trying ${Math.round(next * 100)}% ` +
          `(${ms.toFixed(0)} ms probe, ${budget.toFixed(0)} ms budget)`);
        await sc.setFraction(next);
        rebuild();
        await settleOffscreen();      // resolve this density off-screen, then show it in one step
        ms = await measureFrame();
        if (ms > budget * 1.35) {     // overshot: give the chunk back and stop
          await sc.setFraction(Math.max(0.05, sc.fraction - 0.05));
          rebuild();
          await settleOffscreen();
          ms = await measureFrame();
          break;
        }
      }
      target = Math.round(sc.fraction * 100);
      tuned = { capPct: Math.round(cap * 100), ms };
      chromeUi.refresh();   // the Streamlines slider still reads the pre-tune value otherwise
      // Converged, off-screen, presented once. bake() would kick the loop and show its moving frames.
      await settleOffscreen();
      showStatus();
    } catch (e) {
      status(`could not tune density — ${(e as Error).message}`, true);
    }
  }
  await tuneDensity();
  booting = false;     // from here on resize and the controls drive the loop normally
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
