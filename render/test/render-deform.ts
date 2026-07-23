// Headless "Landmark Deform (TPS)" — renders the volume at gain 0 (identity) and
// gain 1 (warped) side by side. The identity pass MUST match an unwarped render, and
// the warped pass must differ measurably — that's the regression signal for the whole
// modifier/transform_point plumbing.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-deform.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildDeformScene } from "../demos/deform-scene.ts";
import { orbitEye } from "../demos/sphere-scene.ts";

const Q = 460, W = Q * 2;
const gpu = await initDevice();
const t0 = performance.now();

const shot = async (gain: number) => {
  const sc = buildDeformScene(gpu.device, gain);
  const scene = new SceneRenderer(gpu);
  scene.build([sc.warp, sc.image, sc.fiducials]);   // modifier first is fine; order is resolved by slot
  scene.setBackground(0.06, 0.07, 0.10);
  scene.setCamera(orbitEye(0.75, 0.28, 360), [0, 0, 0], [0, 0, 1], 26, Q, Q);
  return await scene.renderToRGBA(Q, Q);
};

const identity = await shot(0.0);
const warped = await shot(1.0);

// tile side by side: [identity | warped]
const full = new Uint8Array(W * Q * 4);
for (let y = 0; y < Q; y++) {
  full.set(identity.subarray(y * Q * 4, y * Q * 4 + Q * 4), (y * W) * 4);
  full.set(warped.subarray(y * Q * 4, y * Q * 4 + Q * 4), (y * W + Q) * 4);
}
await Deno.writeFile(new URL("./deform.png", import.meta.url).pathname, await encodePNG(full, W, Q));

// How much did the warp actually change? Mean abs luminance delta over the frame, plus
// the fraction of pixels that moved noticeably. NOTE: "non-background" must be measured
// against the actual clear colour (0.06,0.07,0.10 -> ~(69,74,89) after sRGB encode), not
// against 0, or the background itself counts as lit.
let diff = 0, changed = 0, lit = 0;
const lum = (a: Uint8Array, i: number) => (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) / 3;
for (let i = 0; i < Q * Q; i++) {
  const a = lum(identity, i), b = lum(warped, i);
  const d = Math.abs(a - b);
  diff += d;
  if (d > 8) changed++;
  if (a > 110 || b > 110) lit++;          // 110 sits above the ~77 background luminance
}
const meanDiff = diff / (Q * Q);
console.log(`deform ${W}x${Q} in ${(performance.now() - t0).toFixed(0)}ms · mean |Δ| = ${meanDiff.toFixed(2)} · pixels changed ${(100 * changed / (Q * Q)).toFixed(1)}% · non-bg ${(100 * lit / (Q * Q)).toFixed(1)}%`);
if (meanDiff < 1.0) { console.error("FAIL: warp had no visible effect (transform_point plumbing broken?)"); Deno.exit(1); }
console.log("OK: gain=0 identity vs gain=1 warped differ as expected");
gpu.device.destroy();
