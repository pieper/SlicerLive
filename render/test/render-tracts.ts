// Headless render of the real tractography scene exported from Slicer — reads the per-bundle
// binaries straight off disk (Deno's fetch handles file://) and renders the FiberField tubes.
//   deno run --unstable-webgpu -A render/test/render-tracts.ts [baseUrl] [out-dir]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { buildTractScene } from "../demos/tracts-scene.ts";
import { orbitEye } from "../demos/sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";

const BASE = Deno.args[0] ?? "file:///tmp/slicerlive-tracts/";
const OUT = Deno.args[1] ?? new URL(".", import.meta.url).pathname;
const W = 720, H = 720;
const gpu = await initDevice();
const gpuErrors: string[] = [];
gpu.device.addEventListener("uncapturederror", (e) => gpuErrors.push(String((e as GPUUncapturedErrorEvent).error?.message)));
let failures = 0;
const report = (ok: boolean, name: string, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  XX "} ${name.padEnd(20)} ${detail}`);
};
const litFraction = (rgba: Uint8Array) => {
  let lit = 0;
  for (let i = 0; i < W * H; i++) if (Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 40) lit++;
  return lit / (W * H);
};

let t0 = performance.now();
const sc = await buildTractScene(gpu.device, BASE);
const loadMs = performance.now() - t0;
const f = sc.fibers;
console.log(`${sc.manifest.bundles.length} bundles · ${sc.strandCount.toLocaleString()} streamlines · ` +
  `${f.segmentCount.toLocaleString()} capsules · ${(sc.bytesFetched / 1e6).toFixed(1)} MB · ` +
  `grid ${f.gridDims.join("x")} @ ${f.cellMm.toFixed(2)} mm, ${f.indexCount.toLocaleString()} cell entries · ` +
  `loaded+built in ${(loadMs / 1000).toFixed(1)}s`);
console.log(`groups: ${sc.groups.map((g) => `${g.name}(${g.bundleIds.length})`).join(" ")}`);

const scene = new SceneRenderer(gpu);
scene.build([f]);
scene.setBackground(0.05, 0.06, 0.09);
const frame = () => {
  const o = orbitEye(0.6, 0.28, sc.radius * 2.4);
  scene.setCamera([sc.center[0] + o[0], sc.center[1] + o[1], sc.center[2] + o[2]] as Vec3, sc.center, [0, 0, 1], 30, W, H);
};
frame();
t0 = performance.now();
const all = await scene.renderToRGBA(W, H);
await Deno.writeFile(`${OUT}/tracts-all.png`, await encodePNG(all, W, H));
report(litFraction(all) > 0.05, "tracts render", `${(100 * litFraction(all)).toFixed(1)}% lit in ${(performance.now() - t0).toFixed(0)} ms`);
report(sc.groups.length === 5 && sc.groups.every((g) => g.bundleIds.length > 0), "five groups",
  sc.groups.map((g) => `${g.name}=${g.bundleIds.length}`).join(" "));

// Group opacity: hiding one group must remove pixels, and restoring it must bring them back exactly.
const before = litFraction(all);
// Restore to whatever it started at, not to 1: Superficial ships semi-transparent (the outer shell
// would otherwise hide the deep groups), so "restored" only equals the original at its own default.
const supWas = sc.groupOpacity("Superficial");
sc.setGroupOpacity("Superficial", 0);
scene.syncUniforms();
const hidden = await scene.renderToRGBA(W, H);
await Deno.writeFile(`${OUT}/tracts-no-superficial.png`, await encodePNG(hidden, W, H));
report(litFraction(hidden) < before * 0.95, "group opacity hides", `lit ${(100 * before).toFixed(1)}% → ${(100 * litFraction(hidden)).toFixed(1)}%`);
sc.setGroupOpacity("Superficial", supWas);
scene.syncUniforms();
const restored = await scene.renderToRGBA(W, H);
let same = 0;
for (let i = 0; i < all.length; i++) if (all[i] === restored[i]) same++;
report(same === all.length, "restores exactly", `${((100 * same) / all.length).toFixed(2)}% identical bytes`);

// Raising the fraction pulls only the chunks not already held and rebuilds with more streamlines.
const bytes0 = sc.bytesFetched, strands0 = sc.strandCount;
await sc.setFraction(0.2);
scene.build([sc.fibers]);
scene.setBackground(0.05, 0.06, 0.09);
frame();
const more = await scene.renderToRGBA(W, H);
report(sc.strandCount > strands0 * 1.5 && sc.bytesFetched > bytes0, "fraction 10% → 20%",
  `${strands0.toLocaleString()} → ${sc.strandCount.toLocaleString()} streamlines, ` +
  `${(bytes0 / 1e6).toFixed(1)} → ${(sc.bytesFetched / 1e6).toFixed(1)} MB fetched`);
report(litFraction(more) > litFraction(all), "denser render", `${(100 * litFraction(all)).toFixed(1)}% → ${(100 * litFraction(more)).toFixed(1)}% lit`);
await Deno.writeFile(`${OUT}/tracts-20pct.png`, await encodePNG(more, W, H));

await gpu.device.queue.onSubmittedWorkDone();
report(gpuErrors.length === 0, "no GPU errors", gpuErrors.slice(0, 2).join(" | ") || "none");
console.log(`PNGs → ${OUT}`);
gpu.device.destroy();
Deno.exit(failures ? 1 : 0);
