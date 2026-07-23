// GPU ablation profiler for the Volume+Fiducials demo.
//
// Answers the question: is the cost the SPHERE LOOP (100 length() tests/step, no
// early rejection) or just the NUMBER OF FIELDS iterated per march step?
//
// Uses SceneRenderer.timePass() (timestamp-query, exact GPU pass time). Each row is
// the median over many iters; deltas between rows attribute cost to one variable:
//   - volume-only                     baseline (ImageField DVR alone)
//   - +N EMPTY fiducial fields (n=0)   isolates per-step CALL/setup overhead per field
//   - +N FULL  fiducial fields (n=25)  adds the sphere-loop body cost
//   - sweep field count 1..4           does cost scale with #fields?
//   - sweep spheres/field              does cost scale with #spheres? (=> loop dominates)
//   - sweep step size                  cost ~ #march steps (step drives everything)
//
//   deno run --unstable-webgpu --allow-read --allow-net render/test/profile-fiducials.ts [baseUrl]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ImageField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { framedCamera } from "../demos/camera-control.ts";
import { MARKUP_LISTS } from "../demos/selftest-scenes.ts";
import type { Vec3 } from "../mat4.ts";

const base = Deno.args[0];
const SCENE = base ? `${base}/scenes/CTACardio.json` : "https://pieper.github.io/live/scenes/CTACardio.json";
// Profile at a modest resolution so even the fiducial-heavy passes stay well under the
// macOS GPU watchdog window — huge (>0.5s) passes corrupt subsequent timestamp reads.
// Relative scaling (the diagnostic) is resolution-independent; only absolutes shrink.
const W = 448, H = 448;

const gpu = await initDevice();
if (!gpu.features.has("timestamp-query")) { console.error("no timestamp-query on this adapter"); Deno.exit(1); }
console.log(`adapter timestamp-query: yes · ${W}x${H} · median GPU ms/pass\n`);

const sv = await loadSceneVolumeField(gpu.device, SCENE);
const [lo, hi] = sv.field.aabb();
const cam = framedCamera(sv.center as Vec3, sv.radius);

// deterministic scatter (same construction as buildVolumeAndFiducials)
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeFields(fieldCount: number, spheresPer: number): FiducialField[] {
  const r = rng(20260415);
  const out: FiducialField[] = [];
  for (let f = 0; f < fieldCount; f++) {
    const { color, radius } = MARKUP_LISTS[f % MARKUP_LISTS.length];
    const pins: Sphere[] = [];
    for (let i = 0; i < spheresPer; i++) {
      pins.push({ center: [lo[0] + r() * (hi[0] - lo[0]), lo[1] + r() * (hi[1] - lo[1]), lo[2] + r() * (hi[2] - lo[2])] as Vec3, radius, color: [color[0], color[1], color[2], 1] });
    }
    out.push(new FiducialField(pins, { shininess: 90, kSpecular: 0.6 }));
  }
  return out;
}

async function time(label: string, fields: (ImageField | FiducialField)[], stepMul?: number): Promise<number> {
  const scene = new SceneRenderer(gpu);
  scene.build(fields);
  scene.setBackground(0.05, 0.06, 0.09);
  if (stepMul !== undefined) scene.setSampleStep(Math.min(...fields.map((f) => f.sampleStep())) * stepMul);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
  const ms = await scene.timePass(W, H);
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(3)} ms`);
  return ms;
}

console.log("A) isolate field-count overhead vs sphere-loop body (default step):");
const vol = await time("volume only", [sv.field]);
const empty4 = await time("volume + 4 EMPTY fiducial fields (n=0)", [sv.field, ...makeFields(4, 0)]);
const full4 = await time("volume + 4 FULL fiducial fields (n=25)", [sv.field, ...makeFields(4, 25)]);
console.log(`     -> per-step field overhead (4 empty - vol): ${(empty4 - vol).toFixed(3)} ms`);
console.log(`     -> sphere-loop body (4x25) (full - empty):   ${(full4 - empty4).toFixed(3)} ms`);
console.log(`     -> total fiducial cost (full - vol):         ${(full4 - vol).toFixed(3)} ms\n`);

console.log("B) scale with FIELD COUNT (25 spheres each):");
for (const n of [1, 2, 3, 4]) await time(`volume + ${n} field(s) x 25`, [sv.field, ...makeFields(n, 25)]);

console.log("\nC) scale with SPHERES/FIELD (single field):");
for (const s of [0, 25, 50, 100]) await time(`volume + 1 field x ${s}`, [sv.field, ...makeFields(1, s)]);

console.log("\nD) scale with STEP SIZE (4x25, stepMul x min-spacing):");
for (const m of [0.7, 1.0, 2.0, 3.0]) await time(`stepMul ${m}`, [sv.field, ...makeFields(4, 25)], m);

// The dense ImageField never yields a skip, so inside the volume the GLOBAL all-defer
// jump can never fire (only the per-field coasting does). A fiducials-only scene is the
// case that actually exercises the leap path end to end.
console.log("\nE) fiducials ONLY (no volume) — exercises the global all-defer leap:");
for (const n of [1, 2, 4]) await time(`${n} field(s) x 25, no volume`, makeFields(n, 25));

gpu.device.destroy();
