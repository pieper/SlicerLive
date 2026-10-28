// Per-segment opacity: a translucent segment in FRONT lets the segment BEHIND show through
// (translucent surface-model rendering).
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/opacity.ts
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { PaintEffect } from "../effects/paint.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../geom.ts";

const W = 512, H = 512;
const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf" });
const paint = new PaintEffect(seg);
// Camera looks down -Y. label 1 red = BEHIND (+Y, far), label 2 blue = IN FRONT (−Y, near), aligned in x,z.
logic.setLabelColor(1, [0.95, 0.25, 0.25]);
logic.setLabelColor(2, [0.30, 0.45, 0.98]);
paint.stampStroke([[0, 34, 0]], { radiusMm: 26, id: 1, mode: "add" });   // red, back
paint.stampStroke([[0, -34, 0]], { radiusMm: 22, id: 2, mode: "add" });  // blue, front

const scene = new SceneRenderer(gpu);
scene.build([logic.field()]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera([0, -430, 0], [0, 0, 0], [0, 0, 1], 30, W, H);

// Mean RED in the central region — where the blue segment is in FRONT of the red one. Opaque blue
// blocks the red (its own low red channel is all that shows); translucent blue lets it through.
//
// This used to measure max(0, red - blue) per pixel. That only works if the translucent front
// segment is transparent enough for red to OUTWEIGH blue, which it is not once the renderer honours
// the opacity contract: a 35%-opaque segment shows a front AND a back face, so it composites to
// 1-(1-0.35)² = 58% blue over 42% red — visibly purple, but still blue-dominant. The old shell band
// leaked (an opaque segment was not opaque — see render/test/shell-opacity.ts), which is the only
// reason red ever dominated here. Mean red measures the same thing without that assumption.
const redThrough = (rgba: Uint8Array): number => {
  let sum = 0, n = 0;
  const x0 = W / 2 - 40, x1 = W / 2 + 40, y0 = H / 2 - 40, y1 = H / 2 + 40;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += rgba[(y * W + x) * 4]; n++; }
  return sum / n;
};

logic.setLabelOpacity(2, 1.0); logic.refineNow();
const opaque = redThrough(await scene.renderToRGBA(W, H));
await Deno.writeFile(new URL("./opacity-opaque.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(W, H), W, H));

logic.setLabelOpacity(2, 0.35); logic.refineNow();
const translucent = redThrough(await scene.renderToRGBA(W, H));
await Deno.writeFile(new URL("./opacity-translucent.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(W, H), W, H));

console.log(`mean red in the overlap: opaque=${opaque.toFixed(1)}  translucent=${translucent.toFixed(1)}`);
const ok = translucent > opaque * 1.5;
console.log(ok ? "PASS — translucent front segment reveals the segment behind" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
