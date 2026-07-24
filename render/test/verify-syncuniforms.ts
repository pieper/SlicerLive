// Verify SceneRenderer.syncUniforms (Tier-A interactive updates, ARCHITECTURE-2026-07-24 §7):
//   1. Moving a fiducial + syncUniforms produces the SAME pixels as building a fresh scene
//      with the fiducial already moved  -> correctness (uniform re-pack == full build).
//   2. syncUniforms does NOT recompile the pipeline or rebuild the bind group -> the point
//      (a per-frame drag must not rebuild the shader).
//   3. The moved-fiducial render actually DIFFERS from the original -> the update took effect.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-syncuniforms.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const Q = 256;
const gpu = await initDevice();

const pins = (shift: number): Sphere[] => [
  { center: [0, 0, 0], radius: 30, color: [0.95, 0.2, 0.2, 1] },
  { center: [60 + shift, 10, -20], radius: 22, color: [0.2, 0.6, 0.95, 1] },
  { center: [-50, -30 + shift, 40], radius: 26, color: [0.2, 0.85, 0.3, 1] },
];
const cam = framedCamera([0, 0, 0] as Vec3, 140);

function render(scene: SceneRenderer): Promise<Uint8Array> {
  scene.setBackground(0.05, 0.06, 0.09);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
  return scene.renderToRGBA(Q, Q);
}
const diffCount = (a: Uint8Array, b: Uint8Array) => {
  let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n;
};

// A: build at shift=0, render, then MOVE the fiducial and syncUniforms (no rebuild).
const field = new FiducialField(pins(0), { shininess: 90 });
const sceneA = new SceneRenderer(gpu);
sceneA.build([field]);
const pipeBefore = (sceneA as unknown as { pipeline: unknown }).pipeline;
const bindBefore = (sceneA as unknown as { bind: unknown }).bind;
const imgBefore = await render(sceneA);

field.setSpheres(pins(40));           // interaction: node state changed
sceneA.syncUniforms();                // Tier-A: re-pack uniforms, no rebuild
const imgSync = await render(sceneA);
const pipeAfter = (sceneA as unknown as { pipeline: unknown }).pipeline;
const bindAfter = (sceneA as unknown as { bind: unknown }).bind;

// B: ground truth — a FRESH scene built with the moved fiducial.
const sceneB = new SceneRenderer(gpu);
sceneB.build([new FiducialField(pins(40), { shininess: 90 })]);
const imgFresh = await render(sceneB);

const noRebuild = pipeBefore === pipeAfter && bindBefore === bindAfter;
const tookEffect = diffCount(imgBefore, imgSync) > 0;
const matchesFresh = diffCount(imgSync, imgFresh);

console.log(`no pipeline/bind rebuild : ${noRebuild ? "OK" : "FAIL"}`);
console.log(`update took effect       : ${tookEffect ? "OK" : "FAIL"} (${diffCount(imgBefore, imgSync)} px changed)`);
console.log(`matches full rebuild     : ${matchesFresh === 0 ? "OK (byte-identical)" : "FAIL (" + matchesFresh + " bytes differ)"}`);

gpu.device.destroy();
if (!noRebuild || !tookEffect || matchesFresh !== 0) Deno.exit(1);
console.log("\nsyncUniforms verified.");
