// Does the DEFAULT AABB-distance skip (SceneRenderer.boxSkip) actually pay for itself?
//
// Hypothesis was that Multi-Volume would win, since Panoramix sits +200mm R of CTACardio
// so each ray spends much of the union box outside one volume or both. Counter-hypothesis:
// ImageField's out-of-bounds sample was ALREADY nearly free (it early-returns on the tex
// bounds test), so gating it behind a horizon saves little while adding skip evaluations.
//
// A/B'd in ONE process, alternating, so machine state can't bias the comparison.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/profile-boxskip.ts [baseUrl]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import type { Field } from "../fields.ts";
import { buildMultiVolume, buildSegmentation, buildVolumeAndFiducials, SCENES } from "../demos/selftest-scenes.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const base = Deno.args[0];
if (base) {
  SCENES.CTACardio = `${base}/scenes/CTACardio.json`;
  SCENES.Panoramix = `${base}/scenes/CTAAbdomenPanoramix.json`;
  SCENES.MRHead = `${base}/legacy/scenes/MRHead.json`;
}
const Q = 448;
const gpu = await initDevice();

interface Case { name: string; fields: Field[]; center: Vec3; radius: number }
const cases: Case[] = [];
{
  const sv = await loadSceneVolumeField(gpu.device, SCENES.CTACardio);
  cases.push({ name: "SingleVolume", fields: [sv.field], center: sv.center, radius: sv.radius });
}
{
  const sc = await buildMultiVolume(gpu.device);
  cases.push({
    name: "MultiVolume", fields: sc.fields,
    center: [(sc.cta.center[0] + sc.pano.center[0]) / 2, (sc.cta.center[1] + sc.pano.center[1]) / 2, (sc.cta.center[2] + sc.pano.center[2]) / 2],
    radius: Math.max(sc.cta.radius, sc.pano.radius) * 1.35,
  });
}
{
  const sc = await buildVolumeAndFiducials(gpu.device);
  cases.push({ name: "Volume+Fiducials", fields: [sc.image, ...sc.lists], center: sc.sv.center, radius: sc.sv.radius });
}
{
  const sc = await buildSegmentation(gpu.device);
  cases.push({ name: "Segmentation", fields: sc.segments, center: sc.sv.center, radius: sc.sv.radius });
}

async function run(c: Case): Promise<number> {
  const scene = new SceneRenderer(gpu);
  scene.build(c.fields);
  scene.setBackground(0.05, 0.06, 0.09);
  const cam = framedCamera(c.center, c.radius);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
  return await scene.timePass(Q, Q, 40);
}

// Warm up FIRST and discard: shader compile + GPU clock ramp otherwise land entirely on
// whichever variant is measured first, which is exactly the bias that made the first row
// look like a 16% win in an earlier run.
SceneRenderer.boxSkip = false; await run(cases[0]);
SceneRenderer.boxSkip = true;  await run(cases[0]);

console.log(`${Q}x${Q} · median GPU ms/pass · alternating A/B in one process (warmed up)\n`);
console.log("scene                 boxSkip=off   boxSkip=on     delta");
for (const c of cases) {
  // alternate off/on twice and take the better (lower) of each to blunt drift
  const off: number[] = [], on: number[] = [];
  for (let i = 0; i < 2; i++) {
    SceneRenderer.boxSkip = false; off.push(await run(c));
    SceneRenderer.boxSkip = true;  on.push(await run(c));
  }
  const a = Math.min(...off), b = Math.min(...on);
  const pct = ((b - a) / a) * 100;
  console.log(`  ${c.name.padEnd(20)} ${a.toFixed(2).padStart(8)} ms ${b.toFixed(2).padStart(9)} ms  ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
}
SceneRenderer.boxSkip = true;
gpu.device.destroy();
