// A-0 headless verification: the shared-buffer → surface-render loop.
//   deno run --unstable-webgpu --allow-read --allow-write algorithms/test/render-algorithms.ts
// Proves (numerically, per [[visible-verifiable-testing]]):
//   1. an EditableSegmentation renders in SURFACE mode (green surface pixels present), and
//   2. a GPU sphere-stamp through the shared master buffer updates the render live (green grows).
import { initDevice } from "../../render/device.ts";
import { encodePNG } from "../../render/png.ts";
import { buildAlgorithmsScene } from "../demos/algorithms-scene.ts";

const W = 640, H = 640;
const gpu = await initDevice();
const t0 = performance.now();

const a = buildAlgorithmsScene(gpu);
a.scene.setCamera([90, -430, 150], a.center, [0, 0, 1], 30, W, H);

// Colour-agnostic "painted" count (poke now stamps a DIFFERENT-coloured label, so don't key on green).
const countPainted = (rgba: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < W * H; i++) if (Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 45) n++;
  return n;
};

// Before: the seeded sphere.
const before = await a.scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./algorithms-a0-before.png", import.meta.url).pathname, await encodePNG(before, W, H));
const g0 = countPainted(before);

// Poke: stamp a second (new-coloured) sphere off-centre through the SHARED BUFFER (GPU compute write).
a.poke([46, 0, 24], 22);
const after = await a.scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./algorithms-a0-after.png", import.meta.url).pathname, await encodePNG(after, W, H));
const g1 = countPainted(after);

console.log(`A-0 surface render ${W}x${H} in ${(performance.now() - t0).toFixed(0)}ms`);
console.log(`painted pixels: before=${g0}  after=${g1}  (expect before>0 and after>before)`);

const ok = g0 > 500 && g1 > g0 * 1.05;
console.log(ok ? "PASS — surface render present + shared-buffer poke propagated to render" : "FAIL");
gpu.device.destroy();
if (!ok) Deno.exit(1);
