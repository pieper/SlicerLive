// Headless validation of the SlicerWGPU selftest ports running on the REAL datasets
// the selftests load (CTACardio / CTAAbdomenPanoramix / MRHead). Renders each and
// asserts something meaningful is on screen, then tiles them into one PNG.
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net render/test/render-selftests.ts [baseUrl]
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";
import { orbitEye } from "../demos/sphere-scene.ts";
import { buildMultiVolume, buildSegmentation, buildVolumeAndFiducials, SCENES } from "../demos/selftest-scenes.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import type { Vec3 } from "../mat4.ts";

// allow pointing at a local server while iterating
const base = Deno.args[0];
if (base) {
  SCENES.CTACardio = `${base}/scenes/CTACardio.json`;
  SCENES.Panoramix = `${base}/scenes/CTAAbdomenPanoramix.json`;
  SCENES.MRHead = `${base}/legacy/scenes/MRHead.json`;
}

const Q = 440;
const gpu = await initDevice();
const results: { name: string; rgba: Uint8Array; note: string }[] = [];
let failures = 0;

const frame = (scene: SceneRenderer, center: Vec3, radius: number, az = 0.9, el = 0.18, mul = 2.4) => {
  const o = orbitEye(az, el, radius * mul);
  scene.setCamera([center[0] + o[0], center[1] + o[1], center[2] + o[2]] as Vec3, center, [0, 0, 1], 26, Q, Q);
};
// Use the MAX channel, not mean luminance: a saturated segment colour like
// (0.90,0.20,0.20) has mean ~111 and would fall under a luminance threshold even though
// it is plainly visible. Max-channel is the honest "is anything drawn here" test.
const litFraction = (rgba: Uint8Array) => {
  let lit = 0;
  for (let i = 0; i < Q * Q; i++) {
    if (Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) > 120) lit++;
  }
  return lit / (Q * Q);
};
const check = (name: string, rgba: Uint8Array, minLit: number, note: string) => {
  const f = litFraction(rgba);
  const ok = f >= minLit;
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  XX "} ${name.padEnd(22)} lit ${(100 * f).toFixed(1)}%  ${note}`);
  results.push({ name, rgba, note });
};

// 1) Single Volume — CTACardio with its own transfer function
{
  const sv = await loadSceneVolumeField(gpu.device, SCENES.CTACardio);
  const scene = new SceneRenderer(gpu);
  scene.build([sv.field]);
  scene.setBackground(0.05, 0.06, 0.09);
  frame(scene, sv.center, sv.radius);
  check("SingleVolume", await scene.renderToRGBA(Q, Q), 0.05, `${sv.name} ${sv.dims.join("x")}`);
}

// 2) Volume + Fiducials — CTACardio + 4 markup lists of 25 points
{
  const sc = await buildVolumeAndFiducials(gpu.device);
  const scene = new SceneRenderer(gpu);
  scene.build([sc.image, ...sc.lists]);
  scene.setBackground(0.05, 0.06, 0.09);
  frame(scene, sc.sv.center, sc.sv.radius);
  const rgba = await scene.renderToRGBA(Q, Q);
  // the markup glyphs are saturated colours the CT transfer function never produces
  let sat = 0;
  for (let i = 0; i < Q * Q; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (Math.max(r, g, b) > 110 && Math.max(r, g, b) - Math.min(r, g, b) > 70) sat++;
  }
  const pct = 100 * sat / (Q * Q);
  const ok = pct > 0.05;
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  XX "} ${"VolumeAndFiducials".padEnd(22)} saturated ${pct.toFixed(2)}%  ${sc.lists.length} lists x 25 pts`);
  results.push({ name: "VolumeAndFiducials", rgba, note: "" });
}

// 3) Multi-Volume — CTACardio + Panoramix offset +200mm R
{
  const sc = await buildMultiVolume(gpu.device);
  const scene = new SceneRenderer(gpu);
  scene.build(sc.fields);
  scene.setBackground(0.05, 0.06, 0.09);
  const lo: Vec3 = [Math.min(sc.cta.center[0], sc.pano.center[0]), 0, 0];
  const center: Vec3 = [
    (sc.cta.center[0] + sc.pano.center[0]) / 2,
    (sc.cta.center[1] + sc.pano.center[1]) / 2,
    (sc.cta.center[2] + sc.pano.center[2]) / 2,
  ];
  void lo;
  frame(scene, center, Math.max(sc.cta.radius, sc.pano.radius), 0.9, 0.18, 3.0);
  check("MultiVolume", await scene.renderToRGBA(Q, Q), 0.05,
    `${sc.cta.name} + ${sc.pano.name} (+200mm R)`);
}

// 4) Segmentation — MRHead thresholds rendered as SegmentField `iso` shells.
// This must read as a SOLID OPAQUE surface, not a translucent colorize volume.
// Regression guard: among the red (Brain) pixels, the vast majority must be
// FULLY opaque — the dark background must not bleed through. A translucent /
// gradient-opacity render leaves many half-lit interior pixels and fails this.
{
  const sc = await buildSegmentation(gpu.device);
  const scene = new SceneRenderer(gpu);
  scene.build(sc.segments);
  scene.setBackground(0.05, 0.06, 0.09);
  frame(scene, sc.sv.center, sc.sv.radius, Math.PI, 0.12, 2.6);
  const rgba = await scene.renderToRGBA(Q, Q);
  // "red" = the Brain segment covers this pixel (R clearly dominant over B).
  // "solid" = the dark bluish background (b~23) is NOT bleeding through, i.e. the
  // shell is opaque. Brightness varies with Phong shading, so we test OPACITY via
  // low blue (b<80), not brightness. An opaque iso-shell renders ~98% solid here;
  // a translucent colorize / gradient-opacity render leaks bg and fails this.
  let red = 0, solid = 0;
  for (let i = 0; i < Q * Q; i++) {
    const r = rgba[i * 4], b = rgba[i * 4 + 2];
    if (r > 90 && r - b > 55) { red++; if (b < 80) solid++; }
  }
  const redFrac = red / (Q * Q);
  const solidFrac = red ? solid / red : 0;
  const ok = redFrac > 0.10 && solidFrac > 0.90;
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  XX "} ${"Segmentation".padEnd(22)} red ${(100 * redFrac).toFixed(1)}%  opaque ${(100 * solidFrac).toFixed(1)}%  Brain=${sc.counts[0]} High=${sc.counts[1]}`);
  results.push({ name: "Segmentation", rgba, note: "" });
}

// per-scene PNGs double as the gallery card thumbnails
for (const r of results) {
  const file = new URL(`./selftest-${r.name}.png`, import.meta.url).pathname;
  await Deno.writeFile(file, await encodePNG(r.rgba, Q, Q));
}

// tile 2x2
const W = Q * 2;
const full = new Uint8Array(W * W * 4);
results.forEach((r, i) => {
  const qx = i % 2, qy = (i / 2) | 0;
  for (let y = 0; y < Q; y++) {
    full.set(r.rgba.subarray(y * Q * 4, y * Q * 4 + Q * 4), ((qy * Q + y) * W + qx * Q) * 4);
  }
});
await Deno.writeFile(new URL("./selftests.png", import.meta.url).pathname, await encodePNG(full, W, W));
console.log(`\n${failures === 0 ? "ALL SELFTEST SCENES RENDER" : failures + " FAILED"} -> selftests.png`);
gpu.device.destroy();
if (failures) Deno.exit(1);
