// Eyeball the opaque-surface ↔ translucent-volume boundary (the reported jaggy zone): two big
// overlapping spheres, one opaque surface, one translucent volume — render before/after the attr blur.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/mixed-boundary.ts
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { PaintEffect } from "../effects/paint.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../geom.ts";

const W = 700, H = 700;
const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf" });
const paint = new PaintEffect(seg);
logic.setLabelColor(1, [0.35, 0.85, 0.45]); logic.setLabelShading(1, "surface"); logic.setLabelOpacity(1, 1.0);   // opaque surface
logic.setLabelColor(2, [0.95, 0.6, 0.3]);  logic.setLabelShading(2, "volume");  logic.setLabelOpacity(2, 0.6);   // translucent volume
paint.stampStroke([[-14, 0, 0]], { radiusMm: 30, id: 1, mode: "add" });
paint.stampStroke([[26, 0, 10]], { radiusMm: 26, id: 2, mode: "add" });   // overlaps label 1 (2 wins in overlap)

const scene = new SceneRenderer(gpu);
scene.build([logic.field()]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera([60, -430, 130], [0, 0, 0], [0, 0, 1], 30, W, H);
logic.refineNow();
await Deno.writeFile(new URL("./mixed-boundary.png", import.meta.url).pathname, await encodePNG(await scene.renderToRGBA(W, H), W, H));
console.log("wrote mixed-boundary.png");
gpu.device.destroy();
