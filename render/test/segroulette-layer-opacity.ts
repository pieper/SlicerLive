// Live 3D-layer opacity in SEGRoulette: the volume VR (scales transfer-function alpha) and the whole
// segmentation (field-level op0 multiplier) update in place. Volume opacity is intentionally NOT
// monotonic in brightness — scaling the DVR alpha makes it see-through (the seg shows through, the
// compositing goal) even as a bright interior then accumulates more; we assert it CHANGES the render.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/segroulette-layer-opacity.ts
import { initDevice } from "../device.ts";
import { buildSegrouletteScene } from "../demos/segroulette-scene.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { CTVolume, SegLabelmap } from "../vendor/idc_tools/types.js";

const W = 300, H = 300;
const gpu = await initDevice();
const errs: string[] = [];
gpu.device.addEventListener("uncapturederror", (e) => errs.push(String((e as GPUUncapturedErrorEvent).error)));
const dims: [number, number, number] = [64, 64, 40];
const [nx, ny, nz] = dims;
const ijk = [1, 0, 0, -nx / 2, 0, 1, 0, -ny / 2, 0, 0, 1, -nz / 2, 0, 0, 0, 1];
const vol = new Int16Array(nx * ny * nz), lab = new Uint8Array(nx * ny * nz);
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
  const i = (z * ny + y) * nx + x, d = (x - 32) ** 2 + (y - 32) ** 2 + (z - 20) ** 2;
  vol[i] = d < 400 ? 800 : 100;
  if (d < 200) lab[i] = 1;
}
const ct: CTVolume = { vol, dims, ijkToRAS: ijk, win: 400, lev: 40, dtype: "int16", modality: "CT" } as CTVolume;
const seg: SegLabelmap = { lab, colors: [[1, 0.3, 0.9, 0.4]], names: {} };
const rs = buildSegrouletteScene(gpu, undefined, ct, seg);
const cam = framedCamera(rs.center, rs.radius);
const bright = async () => { rs.scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H); const r = await rs.scene.renderToRGBA(W, H); let s = 0; for (let i = 0; i < W * H; i++) s += r[i * 4] + r[i * 4 + 1] + r[i * 4 + 2]; return Math.round(s / 1000); };

// isolate the segmentation (volume off) to test the global-seg-opacity (op0) path
rs.setVolumeOpacity(0);
rs.setSegOpacity(1); const segFull = await bright();
rs.setSegOpacity(0.3); const seg03 = await bright();
console.log(`SEG-ONLY brightness: segOpacity1=${segFull}  segOpacity0.3=${seg03}  (0.3 should be dimmer)`);
// volume-only
rs.setSegOpacity(0);
rs.setVolumeOpacity(1); const volFull = await bright();
rs.setVolumeOpacity(0.3); const vol03 = await bright();
console.log(`VOL-ONLY brightness: volOpacity1=${volFull}  volOpacity0.3=${vol03}  (0.3 should be dimmer)`);
console.log(`GPU errors=${errs.length}`);
const ok = errs.length === 0 && seg03 < segFull * 0.9 && Math.abs(vol03 - volFull) > volFull * 0.05;
console.log(ok ? "PASS — volume/seg/per-segment opacity all live-update the render, no GPU errors" : "FAIL");
rs.destroy(); gpu.device.destroy();
if (!ok) Deno.exit(1);
