// Headless single-volume DVR (via the field SceneRenderer) -> PNG.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-demo.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ImageField } from "../fields.ts";
import { encodePNG } from "../png.ts";
import { N, SPACING, buildLUT, syntheticVolume } from "../demos/sphere-scene.ts";

const W = 640, H = 640;
const gpu = await initDevice();
const t0 = performance.now();

const field = new ImageField(gpu.device, syntheticVolume(), [N, N, N], SPACING, buildLUT(), { clim: [0, 255], shade: [0.35, 0.75, 0.35, 24] });
const scene = new SceneRenderer(gpu);
scene.build([field]);
scene.setBackground(0.07, 0.08, 0.12);
scene.setCamera([40, -320, 110], [0, 0, 0], [0, 0, 1], 26, W, H);

const rgba = await scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./dvr-demo.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

let lit = 0;
for (let i = 0; i < W * H; i++) { if (rgba[i * 4] > 40 || rgba[i * 4 + 1] > 40 || rgba[i * 4 + 2] > 40) lit++; }
console.log(`rendered ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms -> non-bg ${((100 * lit) / (W * H)).toFixed(1)}%`);
gpu.device.destroy();
