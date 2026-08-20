// Headless probe: does the SlicerLive TS/WebGPU renderer run under Deno on a Modal GPU
// container, and how fast? Run inside the container by deno_probe.py; also runnable locally:
//   deno run --unstable-webgpu -A tools/modal_spike/deno_probe.ts /tmp/out
//
// Answers, in order: (1) is the adapter the real NVIDIA GPU (Vulkan) or a software fallback,
// (2) does a synthetic multi-field scene render, (3) how long does the REAL multi-volume
// scene (CTACardio + Panoramix + gizmo) take to stream in and trace at streaming sizes.
import { initDevice } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { encodePNG } from "../../render/png.ts";
import { buildDualSphereFields } from "../../render/demos/multi-scene.ts";
import { buildMultiVolume } from "../../render/demos/selftest-scenes.ts";
import { TransformGizmoField } from "../../render/transform-gizmo-field.ts";
import type { Vec3 } from "../../render/mat4.ts";

const outDir = Deno.args[0] ?? "/tmp/out";
await Deno.mkdir(outDir, { recursive: true });
const R: Record<string, unknown> = {};
const ms = (t: number) => Math.round(performance.now() - t);

// ---- (1) adapter ----
let t = performance.now();
const gpu = await initDevice();
const info = (gpu.adapter as unknown as { info?: Record<string, string> }).info ?? {};
R.adapter = {
  vendor: info.vendor, architecture: info.architecture, device: info.device,
  description: info.description, backend: (info as { backend?: string }).backend,
  features: [...gpu.features],
};
R.initMs = ms(t);
console.log(`[probe] adapter ${JSON.stringify(R.adapter)} in ${R.initMs}ms`);

// ---- (2) synthetic multi-field scene ----
t = performance.now();
const syn = new SceneRenderer(gpu);
syn.build(buildDualSphereFields(gpu.device));
syn.setBackground(0.07, 0.08, 0.12);
syn.setCamera([30, -430, 150], [0, 0, 0], [0, 0, 1], 30, 640, 640);
const synRGBA = await syn.renderToRGBA(640, 640);
await Deno.writeFile(`${outDir}/synthetic.png`, await encodePNG(synRGBA, 640, 640));
let red = 0, blue = 0;
for (let i = 0; i < 640 * 640; i++) {
  const r = synRGBA[i * 4], b = synRGBA[i * 4 + 2];
  if (r > 90 && r > b + 20) red++;
  if (b > 90 && b > r + 20) blue++;
}
R.synthetic = { ms: ms(t), redPx: red, bluePx: blue };
console.log(`[probe] synthetic dual-sphere ${JSON.stringify(R.synthetic)}`);

// ---- (3) the REAL demo=multi scene: CTACardio + Panoramix + transform gizmo ----
t = performance.now();
let bytes = 0;
const sc = await buildMultiVolume(gpu.device, (n) => { bytes += n; });
R.load = { ms: ms(t), mb: +(bytes / 1e6).toFixed(1), mbps: +((bytes / 1e6) / ((performance.now() - t) / 1000)).toFixed(1) };
console.log(`[probe] scene stream ${JSON.stringify(R.load)}`);

t = performance.now();
const center: Vec3 = [
  (sc.cta.center[0] + sc.pano.center[0]) / 2,
  (sc.cta.center[1] + sc.pano.center[1]) / 2,
  (sc.cta.center[2] + sc.pano.center[2]) / 2,
];
const radius = Math.max(sc.cta.radius, sc.pano.radius) * 1.35;
const giz = new TransformGizmoField(sc.pano.field.worldCenter(), 88);
const scene = new SceneRenderer(gpu, "rgba8unorm");
scene.build([...sc.fields, giz]);
scene.setBackground(0.05, 0.06, 0.09);
R.buildMs = ms(t);
const dist = radius * 3;
const eye: Vec3 = [center[0], center[1] - dist, center[2]];

const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const sizes: [number, number][] = [[512, 512], [1024, 1024], [1920, 1080], [2560, 1440], [3840, 2160]];
const trace: Record<string, number> = {};
for (const [w, h] of sizes) {
  scene.setCamera(eye, center, [0, 0, 1], 30, w, h);
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) { const t1 = performance.now(); await scene.traceSamples(w, h); runs.push(performance.now() - t1); }
  trace[`${w}x${h}`] = +median(runs).toFixed(1);
  console.log(`[probe] traceSamples ${w}x${h} median ${trace[`${w}x${h}`]}ms`);
}
R.traceMs = trace;

scene.setCamera(eye, center, [0, 0, 1], 30, 1024, 1024);
await Deno.writeFile(`${outDir}/multi.png`, await encodePNG(await scene.renderToRGBA(1024, 1024), 1024, 1024));

console.log("PROBE_JSON " + JSON.stringify(R));
gpu.device.destroy();
