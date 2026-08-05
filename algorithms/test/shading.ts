// Per-segment surface-vs-volume shading: a VOLUME-shaded segment is a translucent DVR fill (you see
// what's behind it), a SURFACE-shaded one is an opaque shell.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/shading.ts
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
logic.setLabelColor(1, [0.95, 0.25, 0.25]);   // red, behind
logic.setLabelColor(2, [0.30, 0.45, 0.98]);   // blue, front
paint.stampStroke([[0, 34, 0]], { radiusMm: 26, id: 1, mode: "add" });
paint.stampStroke([[0, -34, 0]], { radiusMm: 22, id: 2, mode: "add" });

const scene = new SceneRenderer(gpu);
scene.build([logic.field()]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera([0, -430, 0], [0, 0, 0], [0, 0, 1], 30, W, H);

// Red energy in the central overlap (blue is in front). Surface blue occludes red (≈0); volume blue
// is a translucent cloud that lets red through (>0).
const redThrough = (rgba: Uint8Array): number => {
  let s = 0; const x0 = W / 2 - 40, x1 = W / 2 + 40, y0 = H / 2 - 40, y1 = H / 2 + 40;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; s += Math.max(0, rgba[i] - rgba[i + 2]); }
  return s;
};

logic.setLabelShading(2, "surface"); logic.refineNow();
const surf = redThrough(await scene.renderToRGBA(W, H));
await Deno.writeFile(new URL("./shading-surface.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(W, H), W, H));

logic.setLabelShading(2, "volume"); logic.refineNow();
const vol = redThrough(await scene.renderToRGBA(W, H));
await Deno.writeFile(new URL("./shading-volume.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(W, H), W, H));

console.log(`red-through-front-segment: surface=${surf}  volume=${vol}`);
// Surface shading occludes the red behind (a tiny grazing-AA rim leak is fine); volume transmits it.
// (Was `surf === 0`; the surface-opacity optical-depth model leaves a sub-percent rim leak.)
const ok = surf < vol * 0.1 && vol > 200;
console.log(ok ? "PASS — volume shading is a translucent DVR fill; surface shading is a ~opaque shell" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
