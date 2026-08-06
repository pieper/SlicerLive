// A visible organ must render the SAME whether it abuts a HIDDEN (opacity-0) segment or background —
// a hidden neighbour's COLOUR must not bleed into it via the colour-seam blur (user report: set the
// liver to 0% and the lungs went pale/"semi-transparent" where they touched it, from the liver's red
// tinting the green). Fixed by PREMULTIPLIED colour (rgb·opacity) in the bake, un-premultiplied at
// sample time, so a 0-opacity region contributes no colour to the blend.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/hidden-neighbor-bleed.ts
import { initDevice } from "../../render/device.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";

const W = 200, H = 200;
const gpu = await initDevice();
const n = 80, dims: [number, number, number] = [n, n, n];
const ijk = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];

const build = (withLiver: boolean) => {
  const lab = new Uint8Array(n * n * n);
  for (let z = 20; z < 60; z++) for (let y = 20; y < 60; y++) for (let x = 0; x < n; x++) {
    if (x >= 37 && x < 43) lab[(z * n + y) * n + x] = 1;                                              // OPAQUE green "lung"
    else if (withLiver && ((x >= 24 && x < 37) || (x >= 43 && x < 56))) lab[(z * n + y) * n + x] = 2;  // red "liver" on both faces
  }
  return lab;
};

const centreRGB = async (withLiver: boolean) => {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS: ijk });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf", boundaryMode: "all" });
  logic.setLabelColor(1, [0.2, 0.85, 0.4]); logic.setLabelOpacity(1, 1.0);   // lung opaque green
  logic.setLabelColor(2, [0.9, 0.3, 0.3]); logic.setLabelOpacity(2, 0.0);    // liver HIDDEN (red)
  seg.loadLabelmap(build(withLiver)); logic.refineNow();
  const scene = new SceneRenderer(gpu, undefined);
  scene.build([logic.field()]); scene.setBackground(1, 1, 1);
  scene.setCamera([-200, 0, 0], [0, 0, 0], [0, 0, 1], 30, W, H);
  const rgba = await scene.renderToRGBA(W, H);
  let r = 0, g = 0, k = 0;
  for (let y = H / 2 - 8; y < H / 2 + 8; y++) for (let x = W / 2 - 8; x < W / 2 + 8; x++, k++) { r += rgba[(y * W + x) * 4]; g += rgba[(y * W + x) * 4 + 1]; }
  seg.destroy(); logic.destroy();
  return [r / k, g / k];
};

const [rBg, gBg] = await centreRGB(false);
const [rLiver, gLiver] = await centreRGB(true);
console.log(`lung centre — abut bg: red=${rBg.toFixed(0)} green=${gBg.toFixed(0)}   abut hidden liver: red=${rLiver.toFixed(0)} green=${gLiver.toFixed(0)}`);
// No bleed: the red channel (the hidden liver's colour) must not climb, and green must hold.
const ok = Math.abs(rLiver - rBg) < 25 && gLiver > gBg - 25;
console.log(ok ? "PASS — a hidden neighbour's colour does not bleed into a visible segment (premultiplied colour)" : "FAIL — hidden segment colour bleeds (red climbs where the organ abuts the hidden liver)");
gpu.device.destroy();
if (!ok) Deno.exit(1);
