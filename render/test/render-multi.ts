// Validate the multi-field SceneRenderer: two off-origin volumes, distinct LUTs,
// union bounds + per-sample compositing. Deno headless -> PNG.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-multi.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildDualSphereFields } from "../demos/multi-scene.ts";

const W = 640, H = 640;
const gpu = await initDevice();
const t0 = performance.now();

const scene = new SceneRenderer(gpu);
scene.build(buildDualSphereFields(gpu.device));
scene.setBackground(0.07, 0.08, 0.12);
scene.setCamera([30, -430, 150], [0, 0, 0], [0, 0, 1], 30, W, H);

const rgba = await scene.renderToRGBA(W, H);
const outPath = new URL("./multi-demo.png", import.meta.url).pathname;
await Deno.writeFile(outPath, await encodePNG(rgba, W, H));

let red = 0, blue = 0;
for (let i = 0; i < W * H; i++) {
  const r = rgba[i * 4], b = rgba[i * 4 + 2];
  if (r > 90 && r > b + 20) red++;
  if (b > 90 && b > r + 20) blue++;
}
console.log(`multi-volume rendered ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms -> ${outPath}`);
console.log(`red-dominant px: ${red}, blue-dominant px: ${blue} (expect both > 0)`);
gpu.device.destroy();
