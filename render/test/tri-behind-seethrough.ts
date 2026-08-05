// Two segments stacked along the view ray: a RED sphere BEHIND, a GREEN sphere in FRONT. Set the front
// (green) to each tri-state and measure how much RED shows through — the real see-through acceptance
// for the surface-opacity model (render/fields.ts surface_seg: optical-depth shell so per-segment
// opacity is a true SURFACE opacity, not a per-sample value that saturates over the shell thickness).
//   deno run --unstable-webgpu --allow-read --allow-write render/test/tri-behind-seethrough.ts
import { initDevice } from "../device.ts";
import { encodePNG } from "../png.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { framedCamera } from "../demos/camera-control.ts";

const W = 360, H = 360;
const gpu = await initDevice();
const n = 96, dims: [number, number, number] = [n, n, n];
const ijkToRAS = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
const lab = new Uint8Array(n * n * n);
// framedCamera looks along -y (S) by Slicer convention; stack the spheres in y so one is behind the other.
const ball = (cx: number, cy: number, cz: number, r: number, id: number) => {
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    if (dx*dx + dy*dy + dz*dz <= r*r) lab[(z*n + y)*n + x] = id;
  }
};
// camera sits at +Y looking toward -Y → nearer the camera = LARGER y.
ball(48, 30, 48, 22, 1);   // BACK  red  (smaller y, farther)
ball(48, 72, 48, 15, 2);   // FRONT green (larger y, nearer); smaller so it sits inside red's silhouette

const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf" });
logic.setLabelColor(1, [0.95, 0.25, 0.25]);  // back = red
logic.setLabelColor(2, [0.30, 0.90, 0.40]);  // front = green
seg.loadLabelmap(lab); logic.refineNow();

const scene = new SceneRenderer(gpu, undefined);
scene.build([logic.field()]);
scene.setBackground(0, 0, 0);
const cam = framedCamera([0, 0, 0], 55);
scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);

// Center pixel = green sphere directly in front of the red one. As the front opacity drops, the RED
// channel behind should rise and GREEN fall (see-through).
const centerRGB = (rgba: Uint8Array) => {
  let r = 0, g = 0, b = 0, k = 0;
  for (let y = H/2 - 6; y < H/2 + 6; y++) for (let x = W/2 - 6; x < W/2 + 6; x++) {
    const i = (y*W + x)*4; r += rgba[i]; g += rgba[i+1]; b += rgba[i+2]; k++;
  }
  return [r/k, g/k, b/k].map((v) => Math.round(v));
};
const shot = async (tag: string, file: string) => {
  const rgba = await scene.renderToRGBA(W, H);
  await Deno.writeFile(new URL(file, import.meta.url).pathname, await encodePNG(rgba, W, H));
  const [r, g, b] = centerRGB(rgba);
  console.log(`${tag}: center RGB = (${r}, ${g}, ${b})`);
  return [r, g, b];
};

logic.setLabelOpacity(2, 1.0); logic.refineNow(); const [r100, g100] = await shot("front 100%", "./behind-100.png");
logic.setLabelOpacity(2, 0.5); logic.refineNow(); const [r50, g50] = await shot("front  50%", "./behind-50.png");
logic.setLabelOpacity(2, 0.0); logic.refineNow(); const [r0, g0] = await shot("front   0%", "./behind-0.png");

// A true surface opacity means the back RED shows through progressively as the front GREEN thins:
// red rises monotonically 100→50→0, green falls monotonically, and 50% is genuinely between (not
// pinned to the opaque value — the bug we fixed made 50% ≈ 100%).
const redRises = r100 < r50 && r50 < r0;
const greenFalls = g100 > g50 && g50 > g0;
const midMeaningful = (r50 - r100) > 0.2 * (r0 - r100) && (r0 - r50) > 0.2 * (r0 - r100);   // 50% is a real middle, not stuck at either end
const ok = redRises && greenFalls && midMeaningful && r0 > g0 && g100 > r100;
console.log(`\nred ${r100}→${r50}→${r0} (rises ${redRises}); green ${g100}→${g50}→${g0} (falls ${greenFalls}); 50% a real middle ${midMeaningful}`);
console.log(ok ? "PASS — per-segment opacity is a true SURFACE opacity: 50% front reveals the segment behind" : "FAIL");
seg.destroy(); logic.destroy(); gpu.device.destroy();
if (!ok) Deno.exit(1);
