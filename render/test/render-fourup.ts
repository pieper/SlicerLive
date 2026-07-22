// Validate the 4-up: three MPR slices (grayscale CT + colored seg overlay) + a 3D
// ColorizeVolume view, tiled 2x2 into one PNG. Deno headless.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-fourup.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildFourUpScene } from "../demos/fourup-scene.ts";
import { orbitEye } from "../demos/sphere-scene.ts";

const Q = 380, FULL = Q * 2;
const gpu = await initDevice();
const t0 = performance.now();
const sc = buildFourUpScene(gpu.device);

// 3D DVR (top-right)
const scene = new SceneRenderer(gpu);
scene.build([sc.field3d]);
scene.setBackground(0.05, 0.06, 0.09);
scene.setCamera(orbitEye(0.5, 0.3, 430), [0, 0, 0], [0, 0, 1], 28, Q, Q);
const dvr = await scene.renderToRGBA(Q, Q);

// 3 MPR slices
const slice = new SliceRenderer(gpu);
slice.setTextures(sc.scalarTex, sc.colorizeTex);
slice.setWindowLevel(sc.win, sc.lev);
slice.setOverlayOpacity(0.6);
slice.setSlice(2, 0.5); const axial = await slice.renderToRGBA(Q, Q);      // Z
slice.setSlice(1, 0.5); const coronal = await slice.renderToRGBA(Q, Q);    // Y
slice.setSlice(0, 0.55); const sagittal = await slice.renderToRGBA(Q, Q);  // X

// tile 2x2: [axial | 3D] / [coronal | sagittal]
const full = new Uint8Array(FULL * FULL * 4);
const blit = (src: Uint8Array, qx: number, qy: number) => {
  for (let y = 0; y < Q; y++) {
    const dstRow = ((qy * Q + y) * FULL + qx * Q) * 4;
    full.set(src.subarray(y * Q * 4, y * Q * 4 + Q * 4), dstRow);
  }
};
blit(axial, 0, 0); blit(dvr, 1, 0); blit(coronal, 0, 1); blit(sagittal, 1, 1);

await Deno.writeFile(new URL("./fourup-demo.png", import.meta.url).pathname, await encodePNG(full, FULL, FULL));
console.log(`4-up (3 MPR + 3D) ${FULL}x${FULL} in ${(performance.now() - t0).toFixed(0)}ms`);
gpu.device.destroy();
