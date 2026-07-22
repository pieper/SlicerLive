// Headless "Volume + Fiducials" -> PNG. Composes an ImageField + procedural
// FiducialField in one SceneRenderer ray-march.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-fiducial.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildFiducialScene } from "../demos/fiducial-scene.ts";
import { orbitEye } from "../demos/sphere-scene.ts";

const W = 640, H = 640;
const gpu = await initDevice();
const t0 = performance.now();

const sc = buildFiducialScene(gpu.device);
const scene = new SceneRenderer(gpu);
scene.build([sc.image, sc.fiducials]);
scene.setBackground(0.06, 0.07, 0.10);
scene.setCamera(orbitEye(0.7, 0.28, 320), [0, 0, 0], [0, 0, 1], 26, W, H);

const rgba = await scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./fiducial.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

// crude sanity: count strongly-saturated pixels (the colored pins) as a regression signal
let pins = 0;
for (let i = 0; i < W * H; i++) {
  const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx > 120 && mx - mn > 70) pins++;   // saturated, not gray tissue
}
console.log(`fiducials=${sc.fiducials.count} rendered ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms -> saturated ${(100 * pins / (W * H)).toFixed(2)}%`);
gpu.device.destroy();
