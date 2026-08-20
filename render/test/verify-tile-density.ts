// Regression for the 2026-08-20 "giant zoomed fragments" bug: a tile traced at REDUCED density
// must show the same CONTENT as the same tile at native density — before the fix, the ray grid
// kept the rect's size, so a reduced target rendered only the frustum's top-left corner.
//   deno run --unstable-webgpu --allow-read render/test/verify-tile-density.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildDualSphereFields } from "../demos/multi-scene.ts";

const W = 1024, H = 1024;
const gpu = await initDevice();
const scene = new SceneRenderer(gpu, "rgba8unorm");
scene.build(buildDualSphereFields(gpu.device));
scene.setBackground(0, 0, 0);
const eye: [number, number, number] = [30, -430, 150];

// A rect containing the LEFT (warm) sphere.
const rect = { x: 96, y: 320, w: 384, h: 384 };
const coverage = (s: Uint8Array, n: number) => {
  let on = 0;
  for (let i = 0; i < n; i++) if (s[i * 4 + 3] > 8) on++;
  return on / n;
};

scene.setCameraTile(eye, [0, 0, 0], [0, 0, 1], 30, W, H, rect);
const nativeTile = await scene.traceSamples(rect.w, rect.h);
const covNative = coverage(nativeTile, rect.w * rect.h);

let fail = 0;
for (const s2 of [0.5, 0.25]) {
  const pw = Math.round(rect.w * s2), ph = Math.round(rect.h * s2);
  scene.setCameraTile(eye, [0, 0, 0], [0, 0, 1], 30, W, H, rect);
  const t = await scene.traceSamples(pw, ph);
  const cov = coverage(t, pw * ph);
  const ok = Math.abs(cov - covNative) < 0.05;
  if (!ok) fail++;
  console.log(`${ok ? "OK  " : "FAIL"} tile at ×${s2}: coverage ${(cov * 100).toFixed(1)}% vs native ${(covNative * 100).toFixed(1)}%`);
}
console.log(fail ? `${fail} FAILED` : "reduced-density tiles show the same content as native");
gpu.device.destroy();
Deno.exit(fail ? 1 : 0);
