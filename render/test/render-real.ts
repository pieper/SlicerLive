// Headless real-scene DVR: fetch a live SlicerLive scene (zarr volume from the
// JS2 bucket) and ray-march it with the field SceneRenderer -> PNG. Proves the
// blob-decode + rotated-ijkToRAS geometry path with the SAME code the browser runs.
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net render/test/render-real.ts [sceneUrl]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { orbitEye } from "../demos/sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";

const SCENE = Deno.args[0] ?? "https://pieper.github.io/live/legacy/scenes/MRHead.json";
const W = 700, H = 700;

const gpu = await initDevice();
const t0 = performance.now();
let bytes = 0;
const sv = await loadSceneVolumeField(gpu.device, SCENE, (n) => { bytes += n; });
const tLoad = performance.now();
console.log(`loaded "${sv.name}" dims=${sv.dims} range=[${sv.range[0]},${sv.range[1]}] ` +
  `center=[${sv.center.map((v) => v.toFixed(0))}] r=${sv.radius.toFixed(0)} · ${(bytes / 1e6).toFixed(1)}MB in ${(tLoad - t0).toFixed(0)}ms`);

const scene = new SceneRenderer(gpu);
scene.build([sv.field]);
scene.setBackground(0.05, 0.06, 0.09);
const eye: Vec3 = [
  sv.center[0] + orbitEye(0.6, 0.25, sv.radius * 3.0)[0],
  sv.center[1] + orbitEye(0.6, 0.25, sv.radius * 3.0)[1],
  sv.center[2] + orbitEye(0.6, 0.25, sv.radius * 3.0)[2],
];
scene.setCamera(eye, sv.center, [0, 0, 1], 26, W, H);

const rgba = await scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./real-scene.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

let lit = 0;
for (let i = 0; i < W * H; i++) { if (rgba[i * 4] > 30 || rgba[i * 4 + 1] > 30 || rgba[i * 4 + 2] > 30) lit++; }
console.log(`rendered ${W}x${H} in ${(performance.now() - tLoad).toFixed(0)}ms -> non-bg ${((100 * lit) / (W * H)).toFixed(1)}%`);
gpu.device.destroy();
