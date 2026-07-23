// ADVERSARIAL orientation check: prove the MPR reslice respects the ijkToRAS
// direction metadata (from the scene json), not the voxel-index axes. We load MRHead
// once, then build two ImageFields from the SAME voxels but different ijkToRAS:
//   (A) the real ijkToRAS from the scene metadata
//   (B) that same matrix pre-rotated 25 deg about the RAS A-axis (a different physical pose)
// A correct RAS reslicer must render B's axial plane rotated 25 deg vs A. A hack keyed
// to IJK axes would render them identically (FAIL).
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net render/test/verify-orientation.ts
import { initDevice } from "../device.ts";
import { encodePNG } from "../png.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { ImageField } from "../fields.ts";
import { fetchZarrVolume, type ZarrDesc } from "../zarr.ts";

const SCENE = "https://pieper.github.io/live/legacy/scenes/MRHead.json";
const Q = 360;
const gpu = await initDevice();

// Pull the scene metadata: ijkToRAS lives here (the zarr itself carries NO orientation).
const raw = await (await fetch(SCENE)).json();
const nodes = raw.nodes ?? raw;
const vol = Object.values(nodes).find((n: any) => n.class === "vtkMRMLScalarVolumeNode" && n.attrs?.zarr) as any;
const ijkToRAS: number[] = vol.attrs.ijkToRAS;
const zv = await fetchZarrVolume(raw.blobBase, vol.attrs.zarr as ZarrDesc);
console.log("ijkToRAS (from scene metadata):", ijkToRAS.map((v) => +v.toFixed(2)).join(" "));

// Row-major 4x4 multiply, and a rotation about the RAS A-axis (index 1).
const mul = (a: number[], b: number[]) => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
};
const th = 25 * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
const rotA = [cs, 0, sn, 0, 0, 1, 0, 0, -sn, 0, cs, 0, 0, 0, 0, 1]; // rotate about A (RAS y)
const ijkToRAS_rot = mul(rotA, ijkToRAS);

const lut = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) { const t = i / 255; lut.set([Math.round(t * 255), Math.round(t * 255), Math.round(t * 255), 255], i * 4); }

const render = async (m: number[]) => {
  const f = new ImageField(gpu.device, zv.data, zv.dims, [1, 1, 1], lut, { clim: [0, 200], ijkToRAS: m, shade: [1, 0, 0, 1] });
  const s = new SliceRenderer(gpu);
  const [lo, hi] = f.aabb();
  s.setVolume(f.patientToTexture(), lo, hi);
  s.setTextures(f.volumeTexture());
  s.setWindowLevel(150, 75);
  s.setOverlayOpacity(0);
  s.setPlane("axial", 0.5);
  return await s.renderToRGBA(Q, Q);
};

const a = await render(ijkToRAS);
const b = await render(ijkToRAS_rot);
const full = new Uint8Array(2 * Q * Q * 4);
for (let y = 0; y < Q; y++) {
  full.set(a.subarray(y * Q * 4, y * Q * 4 + Q * 4), (y * (2 * Q)) * 4);
  full.set(b.subarray(y * Q * 4, y * Q * 4 + Q * 4), (y * (2 * Q) + Q) * 4);
}
await Deno.writeFile(new URL("./verify-orientation.png", import.meta.url).pathname, await encodePNG(full, 2 * Q, Q));
console.log("wrote verify-orientation.png — LEFT: real ijkToRAS · RIGHT: +25deg about A. Right must be visibly rotated.");
gpu.device.destroy();
