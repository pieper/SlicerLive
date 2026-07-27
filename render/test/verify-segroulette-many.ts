// Regression for the many-segment edge case: a 76-segment TotalSegmentator SEG made one
// SegmentField (= one 3D texture) per segment, blowing WebGPU's 16-sampled-textures-per-stage
// limit → the 3D pipeline was invalid (blank view). buildSegrouletteScene now falls back to a
// single colorized RGBAVolumeField past MAX_ISO_SEGMENTS, so it always builds + renders + picks.
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-segroulette-many.ts
import { initDevice } from "../device.ts";
import { buildSegrouletteScene } from "../demos/segroulette-scene.ts";
import type { CTVolume, SegLabelmap } from "../vendor/idc_tools/types.js";

const gpu = await initDevice();
let fail = 0;
const check = (name: string, ok: boolean, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(40)} ${note}`); };

const D = 24;
const ct: CTVolume = { vol: new Int16Array(D * D * D).fill(50), dims: [D, D, D], ijkToRAS: [1, 0, 0, -12, 0, 1, 0, -12, 0, 0, 1, -12, 0, 0, 0, 1], win: 400, lev: 40, dtype: "int16", modality: "CT" };

function labelmap(nSeg: number): SegLabelmap {
  const lab = new Uint8Array(D * D * D);
  const colors: [number, number, number, number][] = [];
  const names: Record<number, string> = {};
  for (let s = 1; s <= nSeg; s++) { colors.push([s, (s * 37 % 255) / 255, (s * 91 % 255) / 255, (s * 53 % 255) / 255]); names[s] = `Seg${s}`; }
  // give each segment a small solid block so it has voxels; segment 1 gets a central cube so a
  // centre-of-view pick ray reliably passes through it
  for (let s = 2; s <= nSeg; s++) {
    const z = 2 + (s % (D - 4));
    for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) lab[(z * D + y) * D + x] = s;
  }
  for (let z = 8; z < 16; z++) for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) lab[(z * D + y) * D + x] = 1;
  return { lab, colors, names };
}

// (1) MANY segments (> MAX_ISO=12) -> colorized fallback, pipeline valid, renders + picks
{
  const rs = buildSegrouletteScene(gpu, "rgba8unorm", ct, labelmap(20));
  check("20 segments -> colorized mode", rs.mode === "colorized", `mode=${rs.mode}`);
  check("  segments enumerated", rs.segments.length === 20, `n=${rs.segments.length}`);
  // renders without a device error (an invalid pipeline would surface as an uncaptured error)
  rs.scene.setCamera([0, 120, 0], [0, 0, 0], [0, 0, 1], 30, 128, 128);
  const tex = gpu.device.createTexture({ size: [128, 128], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  gpu.device.pushErrorScope("validation");
  rs.scene.renderToView(tex.createView(), 128, 128);
  const err = await gpu.device.popErrorScope();
  check("  3D pipeline valid (no error)", err === null, err ? String(err.message).slice(0, 60) : "clean");
  const p = await rs.scene.pick(0.5, 0.5);
  check("  3D pick works on colorized vol", p !== null, p ? `ras=[${p.map((x) => x.toFixed(0))}]` : "null");
}

// (2) FEW segments (<= 12) -> per-segment iso shells (the crisp look is preserved)
{
  const rs = buildSegrouletteScene(gpu, "rgba8unorm", ct, labelmap(5));
  check("5 segments -> iso mode", rs.mode === "iso", `mode=${rs.mode}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
Deno.exit(fail ? 1 : 0);
