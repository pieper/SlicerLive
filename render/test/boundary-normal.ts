// A segment surface reaching the labelmap boundary must shade correctly and cap cleanly. Two coupled
// fixes (docs/ALGORITHMS.md boundary artifact):
//   1. JfaSdfBaker pads the SDF grid with `pad` voxels of background beyond the labelmap → a real cap
//      with room for the SDF to go positive, and gradient taps near the cap stay in-bounds.
//   2. SegmentField's normal finite-difference (vgrad_seg) clamps out-of-texture taps to the edge
//      (background) instead of the 1e3 out-of-volume cull sentinel, which fabricated a huge fake
//      gradient → normal pointing out through the volume face → unlit black speckle.
// A/B: same segment baked with pad=0 (old) vs pad=2 (new), viewed obliquely so the curved front
// surface runs up to the +X boundary. pad=2 must be speckle-free and materially brighter at the cap.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/boundary-normal.ts
import { initDevice } from "../device.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { JfaSdfBaker } from "../sdf-bake.ts";
import { SegmentField } from "../fields.ts";
import { SceneRenderer } from "../scene-renderer.ts";

const W = 420, H = 420;
const gpu = await initDevice();
const n = 96, dims: [number, number, number] = [n, n, n];
const ijkToRAS = [1, 0, 0, -n / 2, 0, 1, 0, -n / 2, 0, 0, 1, -n / 2, 0, 0, 0, 1];
const lab = new Uint8Array(n * n * n);
const cx = n + 4, cy = n / 2, cz = n / 2, rv = 50;   // sphere centre past +X → clipped by the x=n-1 face
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  const dx = x - cx, dy = y - cy, dz = z - cz;
  if (dx * dx + dy * dy + dz * dz <= rv * rv) lab[(z * n + y) * n + x] = 1;
}
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
seg.loadLabelmap(lab);

const render = async (pad: number) => {
  const baker = new JfaSdfBaker(gpu.device, seg.masterTexture(), dims, ijkToRAS, 1.0, pad);
  const palette = new Float32Array(256 * 4); palette[4] = 0.85; palette[5] = 0.8; palette[6] = 0.55; palette[7] = 1;
  baker.setPalette(palette); baker.setModePalette(new Float32Array(256 * 4));
  baker.refine();
  const field = new SegmentField(baker.sdfTexture(), baker.sdfDims(), [1, 1, 1], {
    color: [1, 1, 1], opacity: 1, ijkToRAS: baker.sdfIjkToRAS(), mode: "sdf",
    colorFromTexture: true, bandMm: 0.65, clippable: false, attrTexture: baker.attrTexture(),
  });
  const scene = new SceneRenderer(gpu, undefined);
  scene.build([field]);
  scene.setBackground(0.02, 0.02, 0.03);
  scene.setCamera([230, -230, 60], [20, 0, 0], [0, 0, 1], 30, W, H);
  const rgba = await scene.renderToRGBA(W, H);
  baker.destroy();
  return rgba;
};

const mx = (a: Uint8Array, i: number) => Math.max(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]);
const speckle = (a: Uint8Array) => {   // dark pixel (max<35) inside a mostly-lit neighbourhood
  let s = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (mx(a, i) >= 35) continue;
    let litN = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) if (mx(a, (y + dy) * W + (x + dx)) > 90) litN++;
    if (litN >= 6) s++;
  }
  return s;
};

const a0 = await render(0), a2 = await render(2);
let darkerIn0 = 0;
for (let i = 0; i < W * H; i++) if (mx(a0, i) < mx(a2, i) - 25) darkerIn0++;
const sp0 = speckle(a0), sp2 = speckle(a2);
console.log(`speckle pad0=${sp0} pad2=${sp2}; pixels pad0 darker than pad2 by >25 = ${darkerIn0}`);
const ok = sp2 <= 5 && darkerIn0 > 300;   // pad2 clean; padding materially brightens/repairs the boundary
console.log(ok ? "PASS — padded SDF + clamped normal: boundary caps render clean (no dark/speckle band)" : "FAIL");
seg.destroy(); gpu.device.destroy();
if (!ok) Deno.exit(1);
