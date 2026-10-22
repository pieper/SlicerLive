// Verify the VR "Shift" path — a clim-ONLY change on an ImageField (what the transfer-function
// Shift slider does: it offsets the LUT along the intensity axis and touches nothing else).
//
// The bug this pins: setClim() mutates CPU state only. Each field's uniform block is packed by
// fillUniforms(), which runs in build() and syncUniforms() and NOWHERE ELSE — so a clim change
// that is not followed by one of those never reaches the shader and the slider does nothing,
// silently. setLUT() is NOT affected (it writes its own texture), which is why a preset change
// appeared to work while Shift looked dead. server/live-renderer.ts's "lut" message had exactly
// this shape: setLUT + setClim, no syncUniforms.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-vr-shift.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ImageField } from "../fields.ts";

const Q = 192;
const gpu = await initDevice();

// A ramp volume: intensity rises with radius, so MOVING the clim window changes which shell is
// opaque — a shift is plainly visible rather than a subtle brightness nudge.
const N = 32;
const dims: [number, number, number] = [N, N, N];
const data = new Float32Array(N * N * N);
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dx = x - (N - 1) / 2, dy = y - (N - 1) / 2, dz = z - (N - 1) / 2;
  data[x + N * (y + N * z)] = Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / (N / 2));
}
const lut = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {
  lut[i * 4] = 240; lut[i * 4 + 1] = 200; lut[i * 4 + 2] = 160;
  lut[i * 4 + 3] = i > 120 && i < 200 ? 200 : 0;          // a narrow opaque band the shift moves
}
const BASE: [number, number] = [0, 1], SHIFT = 0.35;      // shift = a fraction of the scalar range

const mkField = (clim: [number, number]) =>
  new ImageField(gpu.device, data, dims, [1, 1, 1], lut, { clim });
const render = (sr: SceneRenderer) => {
  sr.setBackground(0.05, 0.06, 0.09);
  sr.setCamera([0, 0, 70], [0, 0, 0], [0, 1, 0], 35, Q, Q);
  return sr.renderToRGBA(Q, Q);
};
const diff = (a: Uint8Array, b: Uint8Array) => {
  let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n;
};

// A: build at the base clim, render, then SHIFT with no flush, then shift WITH the flush.
const field = mkField(BASE);
const srA = new SceneRenderer(gpu);
srA.build([field]);
const imgBase = await render(srA);

field.setClim(BASE[0] + SHIFT, BASE[1] + SHIFT);          // the slider moved — CPU state only
const imgNoSync = await render(srA);                      // ...and this is why it looked dead
const pipeBefore = (srA as unknown as { pipeline: unknown }).pipeline;
srA.syncUniforms();                                       // the one line the server was missing
const imgSynced = await render(srA);
const pipeAfter = (srA as unknown as { pipeline: unknown }).pipeline;

// B: ground truth — a fresh scene built with the shifted clim already in place.
const srB = new SceneRenderer(gpu);
srB.build([mkField([BASE[0] + SHIFT, BASE[1] + SHIFT])]);
const imgFresh = await render(srB);

const dropped = diff(imgBase, imgNoSync);
const applied = diff(imgBase, imgSynced);
const vsFresh = diff(imgSynced, imgFresh);
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) bad++;
  console.log(`${label.padEnd(34)}: ${ok ? "OK" : "FAIL"} (${detail})`);
};
check("setClim alone is NOT visible", dropped === 0, `${dropped} bytes changed, expected 0`);
check("setClim + syncUniforms IS visible", applied > 0, `${applied} bytes changed`);
check("matches a full rebuild", vsFresh === 0, vsFresh === 0 ? "byte-identical" : `${vsFresh} bytes differ`);
check("no pipeline rebuild", pipeBefore === pipeAfter, "syncUniforms stayed Tier-A");

gpu.device.destroy();
console.log(bad === 0 ? "\nverify-vr-shift: PASS" : `\nverify-vr-shift: ${bad} FAILED`);
if (bad) Deno.exit(1);
