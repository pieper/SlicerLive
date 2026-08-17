// How smooth can the endovascular view be at real-time rates?
//
//   deno run -A --unstable-webgpu examples/cardiac/serve.ts &
//   deno run -A --unstable-webgpu examples/cardiac/test/endo-quality.ts
//
// The interior view speckles because a single ray-march pass with a jittered start offset is a
// one-sample Monte Carlo estimate: the jitter trades banding for noise, and only temporal
// accumulation averages it away. While the camera is flying there is no accumulation, so every
// displayed frame carries the full single-sample noise.
//
// The lever is the ray step. Inside a vessel the ray hits the wall within a few cm, so the march
// is SHORT — far shorter than an exterior DVR of the same volume — which means a much finer step
// than the 0.7x-voxel default is affordable here. This measures what each step actually costs and
// how far it lands from a fully converged reference, so the choice is made on numbers.
//
// Metric: RMS difference (0-255 per channel) between ONE single-pass frame and a 256-sample
// converged render of the same view. That is exactly "how wrong is the frame you actually see".

import { initDevice } from "../../../render/device.ts";
import { buildCardiacScene } from "../cardiac-scene.ts";

const BASE = Deno.env.get("CARDIAC_BASE") ?? "http://localhost:8777/data/";
const W = 692, H = 415;                 // the demo's 3D cell at 1x

// The seed the demo starts from, looking up the descending aorta.
const POS: [number, number, number] = [-33.922, -4.023, -200.459];
const DIR: [number, number, number] = [0.0376, 0.05, 0.998];
const FOCAL: [number, number, number] = [POS[0] + DIR[0] * 60, POS[1] + DIR[1] * 60, POS[2] + DIR[2] * 60];

const gpu = await initDevice();
const sc = await buildCardiacScene(gpu, BASE, "rgba8unorm", () => {}, { only: "cta" });
sc.setMode("cta");
sc.setPreset("CT-EndoVascular");
const scene = sc.scene;
const setCam = () => scene.setCamera(POS, FOCAL, [0, 1, 0], 80, W, H);

const spacing = sc.cta!.sampleStep();
console.log(`CTA voxel step: ${spacing.toFixed(3)} mm   (renderer default = 0.7x = ${(spacing * 0.7).toFixed(3)} mm)`);

/** One single-pass frame — what you see while flying. */
async function onePass(stepMm: number): Promise<Uint8Array> {
  scene.setSampleStep(stepMm);
  setCam();
  return await scene.renderToRGBA(W, H);
}

/** Fully converged reference at a fine step: the image we are trying to look like. */
async function converged(stepMm: number, n = 256): Promise<Uint8Array> {
  scene.setSampleStep(stepMm);
  const tex = gpu.device.createTexture({
    size: [W, H], format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = tex.createView();
  for (let i = 0; i < n; i++) { setCam(); scene.renderAccum(view, W, H, i === 0); }
  // read it back through the same path renderToRGBA uses
  const bpr = Math.ceil((W * 4) / 256) * 256;
  const buf = gpu.device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = gpu.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: H }, [W, H]);
  gpu.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) out.set(padded.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
  buf.unmap(); tex.destroy(); buf.destroy();
  return out;
}

/** Wall-clock cost of one ray-march pass. timePass() needs timestamp-query, which this device
 *  does not expose under Deno, so time a burst of real frames and wait for the GPU to drain. */
async function passMs(stepMm: number, iters = 40): Promise<number> {
  scene.setSampleStep(stepMm);
  const tex = gpu.device.createTexture({
    size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = tex.createView();
  setCam(); scene.renderAccum(view, W, H, true);          // warm up
  await gpu.device.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) { setCam(); scene.renderAccum(view, W, H, true); }
  await gpu.device.queue.onSubmittedWorkDone();
  const ms = (performance.now() - t0) / iters;
  tex.destroy();
  return ms;
}

function rms(a: Uint8Array, b: Uint8Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; s += d * d; n++; }
  }
  return Math.sqrt(s / n);
}

const ref = await converged(spacing * 0.25, 256);
console.log("\nstep (mm)   x voxel   pass ms    fps    RMS vs converged");
const rows: { step: number; ms: number; err: number }[] = [];
for (const mult of [0.7, 0.5, 0.35, 0.25, 0.175, 0.125]) {
  const step = spacing * mult;
  const img = await onePass(step);
  const err = rms(img, ref);
  const ms = await passMs(step);
  rows.push({ step, ms, err });
  console.log(
    `  ${step.toFixed(3)}      ${mult.toFixed(3)}    ${ms.toFixed(2)}   ${(1000 / ms).toFixed(0).padStart(4)}    ${err.toFixed(2)}`,
  );
}

// How much does averaging a couple of passes per displayed frame buy, at a given step?
console.log("\naccumulated passes at 0.35x voxel (each pass costs the ms above):");
{
  const step = spacing * 0.35;
  scene.setSampleStep(step);
  const tex = gpu.device.createTexture({
    size: [W, H], format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = tex.createView();
  const bpr = Math.ceil((W * 4) / 256) * 256;
  for (const n of [1, 2, 4, 8]) {
    for (let i = 0; i < n; i++) { setCam(); scene.renderAccum(view, W, H, i === 0); }
    const buf = gpu.device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: H }, [W, H]);
    gpu.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const img = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) img.set(padded.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
    buf.unmap(); buf.destroy();
    console.log(`  n=${String(n).padStart(2)}   RMS ${rms(img, ref).toFixed(2)}`);
  }
  tex.destroy();
}

// The same fine step on the EXTERIOR view is a different proposition: inside a vessel a ray
// terminates within a few cm, outside it crosses the whole 512^3 volume. This decides whether
// the fine step can be global or has to be conditional on being in flight.
console.log("\nexterior view (camera outside the volume, whole-volume rays):");
{
  const c = sc.center, r = sc.radius;
  const eye: [number, number, number] = [c[0], c[1] - r * 2.5, c[2]];
  const setExt = () => scene.setCamera(eye, [c[0], c[1], c[2]], [0, 0, 1], 30, W, H);
  for (const mult of [0.5, 0.25, 0.125]) {
    const step = spacing * mult;
    scene.setSampleStep(step);
    const tex = gpu.device.createTexture({
      size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const view = tex.createView();
    setExt(); scene.renderAccum(view, W, H, true);
    await gpu.device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { setExt(); scene.renderAccum(view, W, H, true); }
    await gpu.device.queue.onSubmittedWorkDone();
    const ms = (performance.now() - t0) / 20;
    tex.destroy();
    console.log(`  ${step.toFixed(3)} mm (${mult}x)   ${ms.toFixed(2)} ms   ${(1000 / ms).toFixed(0)} fps`);
  }
}

const best = rows.filter((r) => 1000 / r.ms >= 60).sort((a, b) => a.err - b.err)[0];
console.log(`\nsmoothest step that still clears 60 fps: ${best ? best.step.toFixed(3) + " mm (RMS " + best.err.toFixed(2) + ")" : "none"}`);
