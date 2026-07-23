// Headless faithful Segmentation (SegmentField) render, for A/B vs SlicerWGPU.
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net render/test/render-seg.ts [baseUrl]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildSegmentation, SCENES } from "../demos/selftest-scenes.ts";
import type { Vec3 } from "../mat4.ts";
const base = Deno.args[0]; if (base) SCENES.MRHead = `${base}/legacy/scenes/MRHead.json`;
const W = 700, H = 700;
const gpu = await initDevice();
const sc = await buildSegmentation(gpu.device);
console.log(`segments=${sc.segments.length} counts=${sc.counts}`);
const scene = new SceneRenderer(gpu);
scene.build(sc.segments);
scene.setBackground(0.45, 0.47, 0.72);   // slicer-ish blue to match the reference
const { center, radius } = sc.sv;
const eye: Vec3 = [center[0], center[1] + radius * 2.6, center[2]];
scene.setCamera(eye, center, [0, 0, 1], 30, W, H);
await Deno.writeFile(new URL("./seg.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(W, H), W, H));
console.log("wrote seg.png");
gpu.device.destroy();
