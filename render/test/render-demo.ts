// Headless DVR demo: synthetic nested-sphere volume -> PNG. Run under Deno:
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-demo.ts
// Verifies the Stage-1 single-volume renderer (TS port of slicer_wgpu single_volume).

import { initDevice } from "../device.ts";
import { VolumeRenderer } from "../volume-renderer.ts";
import { encodePNG } from "../png.ts";

const N = 128, SP = 1.5;

function syntheticVolume(): Float32Array {
  const data = new Float32Array(N * N * N);
  const c = (N - 1) / 2;
  const ic = [c + 16, c, c + 12]; // inner dense sphere, offset so it reads as a distinct blob
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const ro = Math.hypot(x - c, y - c, z - c);
        const ri = Math.hypot(x - ic[0], y - ic[1], z - ic[2]);
        const soft = 45 * clamp01((44 - ro) / 3);
        const dense = 210 * clamp01((20 - ri) / 3);
        data[(z * N + y) * N + x] = Math.max(soft, dense);
      }
    }
  }
  return data;
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function buildLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    if (i >= 15 && i < 120) {          // soft tissue: warm red, low opacity
      const t = clamp01((i - 25) / 55);
      r = 0.78; g = 0.40; b = 0.34; a = 0.02 + 0.11 * t;
    } else if (i >= 120) {             // dense: bone white, high opacity
      const t = clamp01((i - 120) / 100);
      r = 0.80 + 0.15 * t; g = 0.76 + 0.16 * t; b = 0.66 + 0.19 * t; a = 0.25 + 0.65 * t;
    }
    lut[i * 4] = Math.round(r * 255); lut[i * 4 + 1] = Math.round(g * 255);
    lut[i * 4 + 2] = Math.round(b * 255); lut[i * 4 + 3] = Math.round(a * 255);
  }
  return lut;
}

const W = 640, H = 640;
const t0 = performance.now();
const gpu = await initDevice();
const r = new VolumeRenderer(gpu);
r.setVolume({ data: syntheticVolume(), dims: [N, N, N], spacing: [SP, SP, SP] });
r.setLUT(buildLUT());
r.setClim(0, 255);
r.setShade(0.35, 0.75, 0.35, 24);
r.setBackground(0.07, 0.08, 0.12);
r.setCamera([40, -320, 110], [0, 0, 0], [0, 0, 1], 26, W, H);

const rgba = await r.renderToRGBA(W, H);
const outPath = new URL("./dvr-demo.png", import.meta.url).pathname;
await Deno.writeFile(outPath, await encodePNG(rgba, W, H));

// quick sanity: count non-background pixels
let lit = 0;
for (let i = 0; i < W * H; i++) { if (rgba[i * 4] > 40 || rgba[i * 4 + 1] > 40 || rgba[i * 4 + 2] > 40) lit++; }
console.log(`rendered ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms -> ${outPath}`);
console.log(`non-background pixels: ${lit} (${((100 * lit) / (W * H)).toFixed(1)}%)`);
gpu.device.destroy();
