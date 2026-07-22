// Validate the ColorizeVolume bake + RGBAVolumeField: synthetic 3-label segmentation
// -> GPU bake -> colored DVR. Deno headless -> PNG.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-colorize.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildColorizeField } from "../demos/colorize-scene.ts";

const W = 640, H = 640;
const gpu = await initDevice();
const t0 = performance.now();

const scene = new SceneRenderer(gpu);
scene.build([buildColorizeField(gpu.device)]);
scene.setBackground(0.06, 0.07, 0.10);
scene.setCamera([60, -440, 170], [0, 0, 0], [0, 0, 1], 30, W, H);

const rgba = await scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./colorize-demo.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

let red = 0, green = 0, blue = 0;
for (let i = 0; i < W * H; i++) {
  const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
  if (r > 100 && r > g + 25 && r > b + 25) red++;
  if (g > 100 && g > r + 15 && g > b + 15) green++;
  if (b > 100 && b > r + 15 && b > g) blue++;
}
console.log(`colorize baked+rendered ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms`);
console.log(`red=${red} green=${green} blue=${blue} (expect all > 0)`);
gpu.device.destroy();
