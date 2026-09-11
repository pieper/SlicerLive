// Headless "Field Compositing" (the SlicerWGPU lava lamp) -> PNGs, plus the checks that make
// FiberField's interval sampling trustworthy:
//   1. STEP INVARIANCE — fibers alone at the default step and at a 7x finer step must match. A point-
//      sampled tube thins out and vanishes as the step grows; exact per-interval crossings don't.
//   2. SKIP IS CONSERVATIVE — the same frame with empty-space skipping disabled must match.
//   3. The composite (lava volume + fibers + fiducials) draws with no WebGPU validation errors.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-fibers.ts [out-dir]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildFiberScene, sceneFields } from "../demos/fiber-scene.ts";
import { orbitEye } from "../demos/sphere-scene.ts";
import type { Field } from "../fields.ts";
import type { Vec3 } from "../mat4.ts";

const W = 640, H = 640;
const outDir = Deno.args[0] ?? new URL(".", import.meta.url).pathname;
const gpu = await initDevice();
const gpuErrors: string[] = [];
gpu.device.addEventListener("uncapturederror", (e) => gpuErrors.push(String((e as GPUUncapturedErrorEvent).error?.message)));
let failures = 0;
const report = (ok: boolean, name: string, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  XX "} ${name.padEnd(18)} ${detail}`);
};

const t0 = performance.now();
const sc = buildFiberScene(gpu.device);
const f = sc.fibers;
console.log(`FiberField: ${f.strandCount} strands, ${f.segmentCount} capsules, grid ${f.gridDims.join("x")} @ ${f.cellMm.toFixed(2)} mm, ${f.indexCount} cell entries — scene built in ${(performance.now() - t0).toFixed(0)} ms`);

const render = async (fields: Field[], opts: { step?: number; bg?: Vec3 } = {}) => {
  const scene = new SceneRenderer(gpu);
  scene.build(fields);
  const bg = opts.bg ?? [0, 0, 0];
  scene.setBackground(bg[0], bg[1], bg[2]);
  if (opts.step !== undefined) scene.setSampleStep(opts.step);
  const o = orbitEye(0.6, 0.35, sc.radius * 3);
  scene.setCamera([sc.center[0] + o[0], sc.center[1] + o[1], sc.center[2] + o[2]], sc.center, [0, 0, 1], 30, W, H);
  return { scene, rgba: await scene.renderToRGBA(W, H) };
};
const compare = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0, changed = 0, lit = 0;
  for (let i = 0; i < W * H; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
    sum += d;
    if (d > 24) changed++;
    if (Math.max(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]) > 40) lit++;
  }
  return { mean: sum / (W * H), changed: changed / (W * H), lit: lit / (W * H) };
};
const save = async (name: string, rgba: Uint8Array) => Deno.writeFile(`${outDir}/${name}`, await encodePNG(rgba, W, H));
const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)}%`;

// 1) Step invariance (fibers only).
const coarse = await render([f]);
const step = f.sampleStep() * 0.7;
const fine = await render([f], { step: step / 7 });
const inv = compare(coarse.rgba, fine.rgba);
report(inv.lit > 0.03 && inv.changed < 0.005, "step invariance", `lit ${pct(inv.lit, 1)} · step ${step.toFixed(2)} vs ${(step / 7).toFixed(2)} mm → ${pct(inv.changed, 3)} px differ (mean ${inv.mean.toFixed(2)})`);
await save("fibers-only.png", coarse.rgba);
await save("fibers-only-finestep.png", fine.rgba);

// 2) Skip is conservative: the same field with providesSkip off.
const noSkip = Object.assign(Object.create(Object.getPrototypeOf(f)), f, { providesSkip: false }) as Field;
const unskipped = await render([noSkip]);
const sk = compare(coarse.rgba, unskipped.rgba);
report(sk.changed < 0.001, "skip conservative", `${pct(sk.changed, 3)} px differ (mean ${sk.mean.toFixed(3)})`);
const msSkip = await coarse.scene.timePass(W, H, 10), msNoSkip = await unskipped.scene.timePass(W, H, 10);

// 3) The composite after 3 s of blob physics.
sc.lava.advance(3.0, sc.points[0]);
for (let i = 0; i < 11; i++) sc.lava.advance(0.25, sc.points[0]);
sc.lava.upload();
const comp = await render(sceneFields(sc), { bg: [0.06, 0.07, 0.10] });
await save("fibers-composite.png", comp.rgba);
const cmp = compare(comp.rgba, coarse.rgba);
report(cmp.changed > 0.01, "composite draws", `${pct(cmp.changed)} px differ from fibers-only (blobs + fiducials + background)`);
const msComp = await comp.scene.timePass(W, H, 10);

await gpu.device.queue.onSubmittedWorkDone();
report(gpuErrors.length === 0, "no GPU errors", gpuErrors.slice(0, 3).join(" | ") || "none");
console.log(`ray-march ${W}x${H}: fibers ${msSkip.toFixed(1)} ms (no skip ${msNoSkip.toFixed(1)} ms) · composite ${msComp.toFixed(1)} ms`);
console.log(`PNGs → ${outDir}`);
gpu.device.destroy();
Deno.exit(failures ? 1 : 0);
