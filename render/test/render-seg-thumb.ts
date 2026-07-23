// Gallery thumbnail for the Segmentation selftest — same framed camera + dark
// background as the live demo (selftest-browser.ts), rendered at 440x440 to match
// the other cards. Regenerate after changing SegmentField:
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net \
//     render/test/render-seg-thumb.ts [baseUrl] [outPath]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildSegmentation, SCENES } from "../demos/selftest-scenes.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const base = Deno.args[0]; if (base) SCENES.MRHead = `${base}/legacy/scenes/MRHead.json`;
const out = Deno.args[1] ?? new URL("./seg.png", import.meta.url).pathname;
const W = 440, H = 440;
const gpu = await initDevice();
const sc = await buildSegmentation(gpu.device);
const scene = new SceneRenderer(gpu);
scene.build(sc.segments);
scene.setBackground(0.05, 0.06, 0.09);   // matches the demo page background
const cam = framedCamera(sc.sv.center as Vec3, sc.sv.radius);
scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
await Deno.writeFile(out, await encodePNG(await scene.renderToRGBA(W, H), W, H));
console.log(`wrote ${out} (segments=${sc.segments.length} counts=${sc.counts})`);
gpu.device.destroy();
