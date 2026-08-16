// Headless checks for the cardiac example. Numeric assertions, not eyeballed screenshots.
//
//   deno run -A --unstable-webgpu examples/cardiac/test/cardiac-render.ts
//
// Needs the data served over http (fetch has no file:// support):
//   deno run -A --unstable-webgpu examples/cardiac/serve.ts &

import { initDevice } from "../../../render/device.ts";
import { buildCardiacScene, presetLUT } from "../cardiac-scene.ts";
import { framedCamera } from "../../../render/demos/camera-control.ts";
import { encodePNG } from "../../../render/png.ts";

const BASE = Deno.env.get("CARDIAC_BASE") ?? "http://localhost:8777/data/";
const OUT = new URL(".", import.meta.url).pathname + "out/";
await Deno.mkdir(OUT, { recursive: true });

const W = 420, H = 420;
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
};

// Mean radiance above the background, which is the honest "how much is being rendered"
// signal — the resolve is opaque so the alpha channel is saturated and useless.
const BG = [0.05, 0.06, 0.09].map((v) => Math.round(255 * Math.pow(v, 1 / 2.2)));
function litMean(rgba: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    s += Math.max(0, (rgba[i] - BG[0] + rgba[i + 1] - BG[1] + rgba[i + 2] - BG[2]) / 3);
  }
  return s / (rgba.length / 4);
}

console.log("--- transfer function presets ---");
{
  // The whole point of CT-EndoVascular: contrast-filled blood (>340 HU) must be INVISIBLE,
  // while myocardium (~100-260 HU) is opaque. Verified straight off the baked LUT.
  const { lut, clim } = presetLUT("CT-EndoVascular");
  const alphaAtHU = (hu: number) => {
    const t = Math.max(0, Math.min(1, (hu - clim[0]) / (clim[1] - clim[0])));
    return lut[Math.min(255, Math.round(t * 255)) * 4 + 3] / 255;
  };
  check("endo: myocardium 200 HU opaque", alphaAtHU(200) > 0.4, `alpha=${alphaAtHU(200).toFixed(3)}`);
  check("endo: contrast blood 600 HU transparent", alphaAtHU(600) < 0.02, `alpha=${alphaAtHU(600).toFixed(3)}`);
  check("endo: contrast blood 1000 HU transparent", alphaAtHU(1000) < 0.02, `alpha=${alphaAtHU(1000).toFixed(3)}`);
  check("endo: air -1000 HU transparent", alphaAtHU(-1000) < 0.02, `alpha=${alphaAtHU(-1000).toFixed(3)}`);

  const c3 = presetLUT("CT-Cardiac3");
  const a3 = (hu: number) => {
    const t = Math.max(0, Math.min(1, (hu - c3.clim[0]) / (c3.clim[1] - c3.clim[0])));
    return c3.lut[Math.min(255, Math.round(t * 255)) * 4 + 3] / 255;
  };
  check("cardiac3: blood 600 HU OPAQUE (the contrast with endo)", a3(600) > 0.4, `alpha=${a3(600).toFixed(3)}`);
}

console.log("\n--- scene ---");
const gpu = await initDevice();
const t0 = performance.now();
let bytes = 0;
const sc = await buildCardiacScene(gpu, BASE, undefined, (n) => { bytes += n; });
console.log(`  loaded ${(bytes / 1048576).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
check("cine frame count", sc.cine.frameCount === 10, `${sc.cine.frameCount} frames`);
check("browser item count", sc.browser.numberOfItems === 10, `${sc.browser.numberOfItems} items`);
check("index metadata", sc.browser.master!.indexName === "frame", `indexName="${sc.browser.master!.indexName}"`);

const aim = () => {
  const cam = framedCamera(sc.center as [number, number, number], sc.radius, 2.6);
  sc.scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
};
const savePng = async (path: string, rgba: Uint8Array) =>
  await Deno.writeFile(path, await encodePNG(rgba, W, H));

console.log("\n--- static CTA, preset switching ---");
aim();
const shots: Record<string, number> = {};
for (const p of ["CT-EndoVascular", "CT-Cardiac3", "CT-Coronary-Arteries-3"]) {
  sc.setPreset(p);
  const rgba = await sc.scene.renderToRGBA(W, H);
  shots[p] = litMean(rgba);
  await savePng(`${OUT}cta-${p}.png`, rgba);
  console.log(`  ${p}: mean lit radiance ${shots[p].toFixed(2)}  -> cta-${p}.png`);
}
check("CTA renders something", shots["CT-Cardiac3"] > 2, `mean=${shots["CT-Cardiac3"].toFixed(2)}`);
check(
  "presets produce visibly different images",
  Math.abs(shots["CT-EndoVascular"] - shots["CT-Cardiac3"]) > 1,
  `endo=${shots["CT-EndoVascular"].toFixed(2)} vs cardiac3=${shots["CT-Cardiac3"].toFixed(2)}`,
);

console.log("\n--- 4D cine ---");
sc.setMode("cine");
aim();
const frameMeans: number[] = [];
for (let f = 0; f < sc.cine.frameCount; f++) {
  sc.browser.setSelectedItemNumber(f);
  sc.cine.setFrame(f);
  sc.scene.refreshBindings();
  sc.scene.syncUniforms();
  const rgba = await sc.scene.renderToRGBA(W, H);
  frameMeans.push(litMean(rgba));
  if (f === 0 || f === 5) await savePng(`${OUT}cine-frame${f}.png`, rgba);
}
console.log("  per-frame mean radiance: " + frameMeans.map((v) => v.toFixed(2)).join(", "));
check("cine renders something", Math.min(...frameMeans) > 2, `min=${Math.min(...frameMeans).toFixed(2)}`);
// A beating heart: consecutive phases must DIFFER (not a static texture) but stay in the
// same ballpark (not garbage from a mis-strided de-interleave).
const diffs = frameMeans.slice(1).map((v, i) => Math.abs(v - frameMeans[i]));
const maxDiff = Math.max(...diffs), spread = Math.max(...frameMeans) - Math.min(...frameMeans);
check("frames differ (motion is present)", maxDiff > 0.02, `max |frame_n - frame_n-1| = ${maxDiff.toFixed(3)}`);
check(
  "frames are coherent (de-interleave correct)",
  spread < 0.35 * Math.max(...frameMeans),
  `spread ${spread.toFixed(2)} vs mean ${(frameMeans.reduce((a, b) => a + b) / frameMeans.length).toFixed(2)}`,
);

console.log("\n--- inter-frame interpolation ---");
// "In between" must be judged PER PIXEL. Mean radiance is a nonlinear functional of the
// volume (nonlinear TF + gradient shading), so a blend of two slightly-different anatomies
// legitimately produces a mean outside [m0, m1] — blurred edges put more voxels in the
// mid-opacity band. The image-space statement is the meaningful one: the half-blend must be
// closer to each endpoint than the endpoints are to each other.
const shot = async (t: number) => {
  sc.cine.setFrame(t); sc.scene.refreshBindings(); sc.scene.syncUniforms();
  return await sc.scene.renderToRGBA(W, H);
};
const l1 = (a: Uint8Array, b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
  return s / (a.length / 4);
};
const i0 = await shot(0), ih = await shot(0.5), i1 = await shot(1);
const d01 = l1(i0, i1), d0h = l1(i0, ih), dh1 = l1(ih, i1);
check("half-blend is closer to frame 0 than frame 1 is", d0h < d01, `d(0,0.5)=${d0h.toFixed(2)} < d(0,1)=${d01.toFixed(2)}`);
check("half-blend is closer to frame 1 than frame 0 is", dh1 < d01, `d(0.5,1)=${dh1.toFixed(2)} < d(0,1)=${d01.toFixed(2)}`);
check("half-blend is not a no-op", d0h > 0.05 && dh1 > 0.05, `d(0,0.5)=${d0h.toFixed(2)}, d(0.5,1)=${dh1.toFixed(2)}`);
// blend exactly 0 must reproduce the pure frame — proves the weight is wired, not smeared.
const i0b = await shot(0);
check("blend=0 is byte-identical to the pure frame", l1(i0, i0b) === 0, `L1=${l1(i0, i0b).toFixed(4)}`);

console.log("\n--- sequence browser semantics ---");
{
  const m = sc.browser.master!;
  check("exact index lookup", m.getItemNumberFromIndexValue("7", true) === 7, `"7" -> ${m.getItemNumberFromIndexValue("7", true)}`);
  check("missing exact lookup is -1", m.getItemNumberFromIndexValue("7.5", true) === -1, `"7.5" -> ${m.getItemNumberFromIndexValue("7.5", true)}`);
  check("inexact lookup returns preceding item", m.getItemNumberFromIndexValue("7.5", false) === 7, `"7.5" -> ${m.getItemNumberFromIndexValue("7.5", false)}`);
  sc.browser.setSelectedItemNumber(9);
  sc.browser.playbackLooped = true;
  sc.browser.selectNextItem(1);
  check("looped advance wraps 9 -> 0", sc.browser.selectedItemNumber === 0, `-> ${sc.browser.selectedItemNumber}`);
  sc.browser.setSelectedItemNumber(9);
  sc.browser.playbackLooped = false;
  sc.browser.playbackActive = true;
  sc.browser.selectNextItem(1);
  check("unlooped advance stops playback", !sc.browser.playbackActive, `playbackActive=${sc.browser.playbackActive}`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
Deno.exit(failures ? 1 : 0);
