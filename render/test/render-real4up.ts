// Headless real 4-up: MRHead (anisotropic 1x1x1.3, sagittally acquired) — 3 anatomical
// MPR planes (RAS reslice) + 3D VR, tiled. Proves correct anatomical orientation +
// aspect ratio (the whole point: IJK-plane slicing would distort these).
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net render/test/render-real4up.ts
import { initDevice } from "../device.ts";
import { encodePNG } from "../png.ts";
import { buildRealScene } from "../demos/real-scene.ts";
import { orbitEye } from "../demos/sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";

const SCENE = Deno.args[0] ?? "https://pieper.github.io/live/legacy/scenes/MRHead.json";
const Q = 360, FULL = Q * 2;
const gpu = await initDevice();
const rs = await buildRealScene(gpu, SCENE);
const { center, radius } = rs.sv;
console.log(`loaded ${rs.sv.name} dims=${rs.sv.dims} ijkToRAS-spacing-anisotropy check`);

rs.slice.setOverlayOpacity(0);
rs.slice.setPlane("axial", 0.5); const axial = await rs.slice.renderToRGBA(Q, Q);
rs.slice.setPlane("coronal", 0.5); const coronal = await rs.slice.renderToRGBA(Q, Q);
rs.slice.setPlane("sagittal", 0.5); const sagittal = await rs.slice.renderToRGBA(Q, Q);

const o = orbitEye(Math.PI, 0.12, radius * 3.0);   // anterior view (face), like Slicer's default
rs.scene.setCamera([center[0] + o[0], center[1] + o[1], center[2] + o[2]] as Vec3, center, [0, 0, 1], 26, Q, Q);
const dvr = await rs.scene.renderToRGBA(Q, Q);

const full = new Uint8Array(FULL * FULL * 4);
const blit = (src: Uint8Array, qx: number, qy: number) => {
  for (let y = 0; y < Q; y++) full.set(src.subarray(y * Q * 4, y * Q * 4 + Q * 4), ((qy * Q + y) * FULL + qx * Q) * 4);
};
blit(axial, 0, 0); blit(dvr, 1, 0); blit(coronal, 0, 1); blit(sagittal, 1, 1);
await Deno.writeFile(new URL("./real4up.png", import.meta.url).pathname, await encodePNG(full, FULL, FULL));
console.log(`real 4-up ${FULL}x${FULL} written`);
gpu.device.destroy();
