// Headless proof of the nnLive LiveModule pipeline (backend-agnostic): synthetic CT
// -> click -> buildPatchInput -> SyntheticSegmenter -> applyMaskDelta -> ColorizeVolume
// bake -> RGBAVolumeField over the CT ImageField -> PNG. Validates the encode/splat/
// bake/render path without the 200 MB ORT model (which the browser demo loads).
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-nnlive.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ImageField, RGBAVolumeField } from "../fields.ts";
import { bakeColorizeRGBA } from "../bake.ts";
import { encodePNG } from "../png.ts";
import { orbitEye } from "../demos/sphere-scene.ts";
import { type Click, applyMaskDelta, buildPatchInput, SyntheticSegmenter } from "../live-segmenter.ts";
import type { Vec3 } from "../mat4.ts";

const W = 640, H = 640;
const D = 96;                              // synthetic CT dims (X=Y=Z=D)
const SP: Vec3 = [2, 2, 2];
const dims: [number, number, number] = [D, D, D];

// Synthetic "CT": soft-tissue background + a bright ellipsoid "organ" the segmenter will grab.
function syntheticCT(): Float32Array {
  const v = new Float32Array(D * D * D);
  const oc = [D * 0.55, D * 0.5, D * 0.45];
  for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    const rBody = Math.hypot(x - D / 2, y - D / 2, z - D / 2);
    let hu = rBody < D * 0.46 ? -20 : -1000;                       // body vs air
    const e = Math.hypot((x - oc[0]) / 14, (y - oc[1]) / 11, (z - oc[2]) / 12);
    if (e < 1) hu = 300 + 8 * Math.cos(e * 6);                      // organ — distinct from the -20 HU body
    v[(z * D + y) * D + x] = hu;
  }
  return v;
}

const gpu = await initDevice();
const t0 = performance.now();
const vol = syntheticCT();

// A click at the organ centroid (voxel coords x,y,z = oc), positive.
const clicks: Click[] = [{ x: Math.round(D * 0.55), y: Math.round(D * 0.5), z: Math.round(D * 0.45), sign: 1 }];
const seg = new SyntheticSegmenter(64, 1.0);
await seg.ready();
const { inp, lo } = buildPatchInput(vol, dims, clicks, seg.patch);
const mask = await seg.infer(inp);
const labelmap = new Uint8Array(D * D * D);
const fg = applyMaskDelta(labelmap, dims, mask, lo, seg.patch, 1);
console.log(`patch@${lo} -> mask fg ${mask.reduce((a, b) => a + b, 0)} · splatted ${fg} voxels`);

// Bake the labelmap to a colored RGBA volume (gold organ), render CT + overlay in 3D.
const palette = new Float32Array(256 * 4);
palette.set([0.95, 0.78, 0.30, 0.9], 1 * 4);   // label 1 -> gold, opacity .9
const colorizeTex = bakeColorizeRGBA(gpu.device, labelmap, dims, palette, 1.5);

const lut = new Uint8Array(256 * 4);           // faint CT context ramp
for (let i = 0; i < 256; i++) { const t = i / 255; lut.set([Math.round(t * 220), Math.round(t * 220), Math.round(t * 230), i > 150 ? 40 : 0], i * 4); }
const ct = new ImageField(gpu.device, vol, dims, SP, lut, { clim: [-200, 300], shade: [0.3, 0.7, 0.3, 20] });
const overlay = new RGBAVolumeField(colorizeTex, dims, SP, { opacityUnitDistance: SP[0], shade: [0.30, 0.78, 0.5, 28] });

const scene = new SceneRenderer(gpu);
scene.build([ct, overlay]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera(orbitEye(0.7, 0.3, 360), [0, 0, 0], [0, 0, 1], 26, W, H);
const rgba = await scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./nnlive.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

let gold = 0;
for (let i = 0; i < W * H; i++) { if (rgba[i * 4] > 150 && rgba[i * 4 + 1] > 110 && rgba[i * 4 + 2] < 110) gold++; }
console.log(`rendered ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms -> gold(mask) ${(100 * gold / (W * H)).toFixed(2)}%`);
gpu.device.destroy();
