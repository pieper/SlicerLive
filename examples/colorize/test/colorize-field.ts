// Headless checks for ColorizeField, on synthetic data with known answers.
//   deno run -A --unstable-webgpu examples/colorize/test/colorize-field.ts
//
// The point is to pin the two things that fail SILENTLY in a full demo: the label fetch
// returning 0 everywhere (so nothing is ever coloured) and the palette alpha not reaching the
// shader (so group sliders do nothing).

import { initDevice } from "../../../render/device.ts";
import { SceneRenderer } from "../../../render/scene-renderer.ts";
import { ColorizeField } from "../../../render/colorize-field.ts";
import { lutFromTransferFunctions } from "../../../render/scene-volume.ts";

const gpu = await initDevice();
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
};

const N = 64, W = 160, H = 160;
const dims: [number, number, number] = [N, N, N];
const ct = new Int16Array(N * N * N);
const lab = new Uint8Array(N * N * N);
for (let z = 0; z < N; z++) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (z * N + y) * N + x;
      const inside = x > 8 && x < N - 8 && y > 8 && y < N - 8 && z > 8 && z < N - 8;
      ct[i] = inside ? 50 : -1000;
      if (inside) lab[i] = x < N / 2 ? 1 : 2;
    }
  }
}
const lut = lutFromTransferFunctions(
  [[-1000, 1, 1, 1], [1000, 1, 1, 1]],
  [[-1000, 0], [-501, 0], [-500, 1], [1000, 1]], [-1000, 1000]);

const field = new ColorizeField(gpu.device, ct, lab, dims, lut, {
  clim: [-1000, 1000], spacing: [1, 1, 1], center: [0, 0, 0], contextOpacity: 1,
  ctModulation: 0,          // flat colour, so the assertions are on the palette alone
});
field.setSegmentColor(1, [1, 0, 0]);
field.setSegmentColor(2, [0, 0, 1]);
field.setSegmentOpacity(1, 1);
field.setSegmentOpacity(2, 1);
field.flushPalette();

const scene = new SceneRenderer(gpu, "rgba8unorm");
scene.build([field]);
scene.setBackground(0, 0, 0);
scene.setCamera([0, -200, 0], [0, 0, 0], [0, 0, 1], 30, W, H);

const px = (img: Uint8Array, x: number, y: number) => {
  const o = (y * W + x) * 4;
  return [img[o], img[o + 1], img[o + 2]];
};
const img = await scene.renderToRGBA(W, H);
const LX = Math.floor(W * 0.32), RX = Math.floor(W * 0.68), MY = Math.floor(H * 0.5);
const left = px(img, LX, MY), right = px(img, RX, MY);
console.log(`  left pixel  rgb(${left})`);
console.log(`  right pixel rgb(${right})`);

check("something is rendered", left.concat(right).reduce((a, b) => a + b, 0) > 30, `left ${left}, right ${right}`);
const leftIsRed = left[0] > left[2];
const redSide = leftIsRed ? left : right, blueSide = leftIsRed ? right : left;
check("one half is red (palette colour reaches the shader)", redSide[0] > 2 * Math.max(1, redSide[2]), `rgb(${redSide})`);
check("the other half is blue", blueSide[2] > 2 * Math.max(1, blueSide[0]), `rgb(${blueSide})`);

field.setSegmentOpacity(1, 0);
field.flushPalette();
const img2 = await scene.renderToRGBA(W, H);
const redAfter = px(img2, leftIsRed ? LX : RX, MY);
const blueAfter = px(img2, leftIsRed ? RX : LX, MY);
console.log(`  after opacity 0 on the red segment: rgb(${redAfter})`);
check("segment opacity 0 removes the segment colour", !(redAfter[0] > 2 * Math.max(1, redAfter[2])), `rgb(${redAfter})`);
check("the other segment is unaffected", blueAfter[2] > 2 * Math.max(1, blueAfter[0]), `rgb(${blueAfter})`);

// REGRESSION: fetchZarrVolume returns a Float32Array whatever the stored dtype is, so the
// label volume reaches ColorizeField as floats. Passing that to writeTexture unchanged
// reinterprets each 4-byte float as four label bytes and the labelmap renders as scattered
// noise — while every value-based read of the same array still looks correct, which is what
// made it survive a CPU-side spot check. Build the field from a Float32Array and require the
// identical image.
{
  const labF = Float32Array.from(lab);
  const f2 = new ColorizeField(gpu.device, ct, labF, dims, lut, {
    clim: [-1000, 1000], spacing: [1, 1, 1], center: [0, 0, 0], contextOpacity: 1, ctModulation: 0,
  });
  f2.setSegmentColor(1, [1, 0, 0]); f2.setSegmentColor(2, [0, 0, 1]);
  f2.setSegmentOpacity(1, 1); f2.setSegmentOpacity(2, 1); f2.flushPalette();
  const s2 = new SceneRenderer(gpu, "rgba8unorm");
  s2.build([f2]); s2.setBackground(0, 0, 0);
  s2.setCamera([0, -200, 0], [0, 0, 0], [0, 0, 1], 30, W, H);
  const imgF = await s2.renderToRGBA(W, H);
  const lf = px(imgF, LX, MY), rf = px(imgF, RX, MY);
  console.log(`  float-typed labels: left rgb(${lf}) right rgb(${rf})`);
  check("a Float32Array label volume renders identically to Uint8Array",
    lf.join() === left.join() && rf.join() === right.join(),
    `got left ${lf} right ${rf}, expected left ${left} right ${right}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL CHECKS PASSED");
Deno.exit(failures ? 1 : 0);
