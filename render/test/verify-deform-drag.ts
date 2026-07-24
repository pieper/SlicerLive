// Verify the TPS landmark drag path (ARCHITECTURE-2026-07-24 §6.1):
//   1. setTarget re-solves + re-uploads the displacement texture IN PLACE — same warp/image
//      field instances, so the SceneRenderer needs only syncUniforms(), no rebuild.
//   2. The render actually changes when a landmark moves.
//   3. Reproducing the same targets via setTarget matches a scene BUILT with those targets
//      (byte-identical) — the in-place update == a full rebuild.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-deform-drag.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildDeformScene } from "../demos/deform-scene.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const Q = 256;
const gpu = await initDevice();
const URL_ = "https://pieper.github.io/live/legacy/scenes/MRHead.json";

const sc = await buildDeformScene(gpu.device, URL_);
const scene = new SceneRenderer(gpu);
scene.build([sc.warp, sc.image, sc.fiducials]);
scene.setBackground(0.06, 0.07, 0.10);
const cam = framedCamera(sc.sv.center as Vec3, sc.sv.radius, 3.5);
const render = async (): Promise<Uint8Array> => {
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
  return await scene.renderToRGBA(Q, Q);
};
const diff = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

const warpBefore = sc.warp, imageBefore = sc.image;
const img0 = await render();

// Drag landmark 0 to a new target.
const moved = [sc.targets[0][0] + 35, sc.targets[0][1] - 20, sc.targets[0][2] + 15] as Vec3;
sc.setTarget(0, moved, gpu.device);
scene.syncUniforms();
const img1 = await render();

const sameInstances = sc.warp === warpBefore && sc.image === imageBefore;
const changed = diff(img0, img1);

// Ground truth: a fresh scene whose landmark 0 was set to `moved` from the start.
const scB = await buildDeformScene(gpu.device, URL_);
scB.setTarget(0, moved, gpu.device);
const sceneB = new SceneRenderer(gpu);
sceneB.build([scB.warp, scB.image, scB.fiducials]);
sceneB.setBackground(0.06, 0.07, 0.10);
sceneB.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
const imgFresh = await sceneB.renderToRGBA(Q, Q);
const matchesFresh = diff(img1, imgFresh);

console.log(`in-place (same field instances): ${sameInstances ? "OK" : "FAIL"}`);
console.log(`drag changed the render        : ${changed > 0 ? "OK" : "FAIL"} (${changed} bytes)`);
console.log(`matches a full rebuild         : ${matchesFresh === 0 ? "OK (byte-identical)" : "FAIL (" + matchesFresh + " differ)"}`);

gpu.device.destroy();
if (!sameInstances || changed === 0 || matchesFresh !== 0) Deno.exit(1);
console.log("\nTPS landmark drag verified.");
