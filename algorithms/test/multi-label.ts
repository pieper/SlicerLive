// Multi-label render verification: distinct label colours + a colour seam where neighbours touch.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/multi-label.ts
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { PaintEffect } from "../effects/paint.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../geom.ts";

const W = 640, H = 640;
const gpu = await initDevice();
const dims: Vec3 = [96, 96, 96];
const sp = 2;
const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

async function run(mode: "sdf" | "surface", name: string) {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: mode, opacity: 1.0, sigmaVoxels: 1.0 });
  const paint = new PaintEffect(seg);
  // Three labels: two TOUCHING (1 red, 2 green — share a boundary → colour seam), one SEPARATE (3 blue).
  logic.setLabelColor(1, [0.95, 0.30, 0.30]);
  logic.setLabelColor(2, [0.30, 0.90, 0.40]);
  logic.setLabelColor(3, [0.35, 0.55, 0.98]);
  paint.stampStroke([[-22, 0, 0]], { radiusMm: 26, id: 1, mode: "add" });
  paint.stampStroke([[22, 0, 0]], { radiusMm: 26, id: 2, mode: "add" });   // overlaps label 1 → id 2 wins in the shared voxels (last write); they meet
  paint.stampStroke([[0, 0, 62]], { radiusMm: 20, id: 3, mode: "add" });   // separate blue blob

  const scene = new SceneRenderer(gpu);
  scene.build([logic.field()]);
  scene.setBackground(0.05, 0.06, 0.09);
  scene.setCamera([120, -430, 150], [0, 0, 20], [0, 0, 1], 32, W, H);
  const rgba = await scene.renderToRGBA(W, H);
  await Deno.writeFile(new URL(`./multi-${name}.png`, import.meta.url).pathname, await encodePNG(rgba, W, H));

  let red = 0, green = 0, blue = 0;
  for (let i = 0; i < W * H; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (Math.max(r, g, b) < 45) continue;                 // background
    if (r > g + 25 && r > b + 25) red++;
    else if (g > r + 20 && g > b + 20) green++;
    else if (b > r + 15 && b > g + 15) blue++;
  }
  const ok = red > 300 && green > 300 && blue > 300;
  console.log(`${name.padEnd(8)} red=${red} green=${green} blue=${blue} → ${ok ? "PASS (3 distinct label colours render)" : "FAIL"}`);
  seg.destroy(); logic.destroy();
  return ok;
}

const a = await run("sdf", "sdf");
const b = await run("surface", "surface");
gpu.device.destroy();
if (!(a && b)) Deno.exit(1);
