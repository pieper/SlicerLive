// Multi-material INTERFACE field (SegmentationLogic boundaryMode "all"): an opaque tumor fully embedded
// in a translucent liver. Its surface is entirely a label↔label interface, so the outer-only shell
// hides it (0 green); the "all" field surfaces it with the correct colour (green shows through). Also
// checks the crisp presence bit gates the bled-colour halo (few lit pixels beyond the liver silhouette).
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/interface-embedded.ts
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { labelmapHasInternalBoundary } from "../geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { framedCamera } from "../../render/demos/camera-control.ts";

const W = 420, H = 420;
const gpu = await initDevice();
const n = 96, dims: [number, number, number] = [n, n, n];
const ijkToRAS = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
const lab = new Uint8Array(n * n * n);
const lc = [40, 48, 48], lr = 34, tc = [54, 48, 48], tr = 12;   // tumor embedded near the liver's +x side
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const dl = (x - lc[0]) ** 2 + (y - lc[1]) ** 2 + (z - lc[2]) ** 2;
  const dt = (x - tc[0]) ** 2 + (y - tc[1]) ** 2 + (z - tc[2]) ** 2;
  if (dt <= tr * tr) lab[(z * n + y) * n + x] = 2;
  else if (dl <= lr * lr) lab[(z * n + y) * n + x] = 1;
}

const greenPx = (rgba: Uint8Array) => {   // green channel clearly above red = tumor (liver is warm, red>green)
  let g = 0;
  for (let i = 0; i < W * H; i++) if (rgba[i * 4 + 1] - rgba[i * 4] > 25 && rgba[i * 4 + 1] > 60) g++;
  return g;
};

const render = async (mode: "outer" | "all") => {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf", boundaryMode: mode });
  logic.setLabelColor(1, [0.80, 0.45, 0.35]); logic.setLabelOpacity(1, 0.35);   // liver, translucent
  logic.setLabelColor(2, [0.30, 0.90, 0.40]); logic.setLabelOpacity(2, 1.0);    // tumor, opaque green
  seg.loadLabelmap(lab); logic.refineNow();
  const scene = new SceneRenderer(gpu, undefined);
  scene.build([logic.field()]);
  scene.setBackground(0, 0, 0);
  const cam = framedCamera([0, 0, 0], 42);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
  const rgba = await scene.renderToRGBA(W, H);
  await Deno.writeFile(new URL(`./interface-${mode}.png`, import.meta.url).pathname, await encodePNG(rgba, W, H));
  seg.destroy(); logic.destroy();
  return greenPx(rgba);
};

const adj = labelmapHasInternalBoundary(lab, dims);
const outer = await render("outer");
const all = await render("all");
console.log(`labelmapHasInternalBoundary=${adj}; embedded tumor green px — outer=${outer}  all=${all}`);
const ok = adj === true && outer < 50 && all > 800;
console.log(ok ? "PASS — multi-material interface field surfaces the embedded label↔label structure the outer shell hides" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
