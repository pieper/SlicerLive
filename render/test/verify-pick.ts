// Regression for SceneRenderer.pick() — the 3D volume pick (Slicer's shift-move ray-cast to the
// >=50% accumulated-opacity RAS point). Traces the composited fields; ghost handles excluded.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-pick.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { FiducialField } from "../fiducial-field.ts";
import { SegmentField } from "../fields.ts";
import { bakeSegmentPresence } from "../bake.ts";
import type { Vec3 } from "../mat4.ts";

const gpu = await initDevice();
let fail = 0;
const check = (name: string, ok: boolean, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(34)} ${note}`); };
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// --- (1) opaque sphere at the origin, camera down +A: pick centre -> front surface (A ~= +R) ---
const R = 30;
const sphere = new FiducialField([{ center: [0, 0, 0], radius: R, color: [1, 0.2, 0.2, 1] }]);
const scene = new SceneRenderer(gpu, "rgba8unorm");
scene.build([sphere]);
scene.setCamera([0, 200, 0], [0, 0, 0], [0, 0, 1], 30, 256, 256);
const p = await scene.pick(0.5, 0.5) as Vec3;
check("sphere pick hits", !!p, p ? `ras=[${p.map((x) => x.toFixed(1)).join(", ")}]` : "MISS");
if (p) {
  check("  front surface A ~= +R", near(p[1], R, 4), `A=${p[1].toFixed(1)} want ~${R}`);
  check("  on the centre ray (R,S ~0)", near(p[0], 0, 3) && near(p[2], 0, 3), `R=${p[0].toFixed(1)} S=${p[2].toFixed(1)}`);
}

// --- (2) miss: a ray that never hits the sphere returns null ---
const miss = await scene.pick(0.02, 0.02);   // corner pixel, past the sphere
check("corner ray misses -> null", miss === null, miss ? `got [${(miss as Vec3).map((x) => x.toFixed(0))}]` : "null");

// --- (3) a SegmentField iso shell is traceable (segmentations pick, not just DVR) ---
const dims: Vec3 = [32, 32, 32];
const mask = new Uint8Array(32 * 32 * 32);
for (let k = 0; k < 32; k++) for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
  const dx = i - 15.5, dy = j - 15.5, dz = k - 15.5;
  if (dx * dx + dy * dy + dz * dz < 9 * 9) mask[(k * 32 + j) * 32 + i] = 1;   // sphere r=9 voxels
}
const tex = bakeSegmentPresence(gpu.device, mask, dims, 1.5);
// 1mm spacing, volume centered near origin via ijkToRAS = identity-ish (voxel centre -> RAS mm)
const ijkToRAS = [1, 0, 0, -15.5, 0, 1, 0, -15.5, 0, 0, 1, -15.5, 0, 0, 0, 1];
const seg = new SegmentField(tex, dims, [1, 1, 1], { color: [0.4, 0.9, 0.5], opacity: 1, ijkToRAS });
const scene2 = new SceneRenderer(gpu, "rgba8unorm");
scene2.build([seg]);
scene2.setCamera([0, 120, 0], [0, 0, 0], [0, 0, 1], 30, 256, 256);
const ps = await scene2.pick(0.5, 0.5) as Vec3;
check("segmentation iso pick hits", !!ps, ps ? `ras=[${ps.map((x) => x.toFixed(1)).join(", ")}]` : "MISS");
if (ps) check("  hits shell front (A ~= +9)", near(ps[1], 9, 3), `A=${ps[1].toFixed(1)} want ~9`);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
Deno.exit(fail ? 1 : 0);
