// Embedded structure: a small opaque TUMOR (label 2) fully inside a big LIVER (label 1). In the slice
// views the tumor is a solid ball; in SDF surface mode it should appear — but the tumor's surface is
// entirely a label↔label interface (never seeded, never on the merged in/out zero-set), so it's
// invisible / hollow. Reproduce, then this motivates per-voxel volume opacity.
import { initDevice } from "../render/device.ts";
import { encodePNG } from "../render/png.ts";
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { SegmentationLogic } from "../logic/segmentation-logic.ts";
import { SceneRenderer } from "../render/scene-renderer.ts";
import { framedCamera } from "../render/demos/camera-control.ts";

const W = 420, H = 420;
const gpu = await initDevice();
const n = 96, dims: [number, number, number] = [n, n, n];
const ijkToRAS = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
const lab = new Uint8Array(n * n * n);
const liverC = [40, 48, 48], liverR = 34;   // big liver
const tumorC = [54, 48, 48], tumorR = 12;   // tumor embedded near the liver's +x side
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const dl = (x - liverC[0]) ** 2 + (y - liverC[1]) ** 2 + (z - liverC[2]) ** 2;
  const dt = (x - tumorC[0]) ** 2 + (y - tumorC[1]) ** 2 + (z - tumorC[2]) ** 2;
  if (dt <= tumorR * tumorR) lab[(z * n + y) * n + x] = 2;        // tumor wins where they overlap
  else if (dl <= liverR * liverR) lab[(z * n + y) * n + x] = 1;
}
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf" });
logic.setLabelColor(1, [0.80, 0.45, 0.35]);   // liver, translucent
logic.setLabelColor(2, [0.30, 0.90, 0.40]);   // tumor, opaque green
logic.setLabelOpacity(1, 0.35);
logic.setLabelOpacity(2, 1.0);
seg.loadLabelmap(lab); logic.refineNow();

const scene = new SceneRenderer(gpu, undefined);
scene.build([logic.field()]);
scene.setBackground(0.02, 0.02, 0.03);
const cam = framedCamera([0, 0, 0], 42);
scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
const rgba = await scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./embedded.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

// How much GREEN (tumor) is visible? The tumor is a solid ball; if the surface SDF hides it we'll see
// little/none because its surface is an internal label↔label interface.
const green = [0.30, 0.90, 0.40];
let greenPx = 0, litPx = 0;
for (let i = 0; i < W * H; i++) {
  const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
  if (Math.max(r, g, b) < 0.12) continue; litPx++;
  if (g > 0.4 && g > r * 1.3 && g > b * 1.3) greenPx++;
}
console.log(`SDF surface mode: lit=${litPx}  green(tumor)=${greenPx}  (tumor is a solid ball; low green = hidden embedded structure)`);
seg.destroy(); logic.destroy(); gpu.device.destroy();
