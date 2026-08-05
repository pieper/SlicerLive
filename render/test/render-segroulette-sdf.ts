// Verify the rewired SEGRoulette scene: a synthetic 288³ volume (exceeds SDF_MAX_DIM → exercises the
// downsample cap) with 15 spherical segments → ONE unified colorized-SDF 3D surface.
//   deno run --unstable-webgpu --allow-read --allow-write render/test/render-segroulette-sdf.ts
import { initDevice } from "../device.ts";
import { encodePNG } from "../png.ts";
import { buildSegrouletteScene } from "../demos/segroulette-scene.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { CTVolume, SegLabelmap } from "../vendor/idc_tools/types.js";

const W = 700, H = 700;
const gpu = await initDevice();

const dims: [number, number, number] = [288, 288, 180];   // > 256 → cap kicks in
const [nx, ny, nz] = dims;
const ijkToRAS = [1, 0, 0, -nx / 2, 0, 1, 0, -ny / 2, 0, 0, 1, -nz / 2, 0, 0, 0, 1];
const vol = new Int16Array(nx * ny * nz);                  // empty VR (we're testing the seg surface)
const lab = new Uint8Array(nx * ny * nz);

const COLORS: [number, number, number][] = [
  [.95, .3, .3], [.3, .9, .4], [.35, .5, .98], [.95, .6, .3], [.7, .45, .95], [.35, .85, .9], [.95, .85, .35],
  [.95, .5, .8], [.55, .8, .35], [.5, .55, .9], [.9, .7, .5], [.4, .9, .7], [.9, .4, .6], [.6, .8, .95], [.85, .85, .5],
];
// 15 spheres on a 5×3 grid in the mid slab; radius chosen so horizontal neighbours touch (colour seams).
const colors: [number, number, number, number][] = [];
let num = 0;
for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 5; gx++) {
  num++;
  const cx = 40 + gx * 52, cy = 55 + gy * 52, cz = 90, rv = 26;
  for (let z = Math.max(0, cz - rv); z < Math.min(nz, cz + rv); z++)
    for (let y = Math.max(0, cy - rv); y < Math.min(ny, cy + rv); y++)
      for (let x = Math.max(0, cx - rv); x < Math.min(nx, cx + rv); x++) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        if (dx * dx + dy * dy + dz * dz <= rv * rv) lab[(z * ny + y) * nx + x] = num;
      }
  colors.push([num, ...COLORS[num - 1]]);
}

const ct: CTVolume = { vol, dims, ijkToRAS, win: 400, lev: 40, dtype: "int16", modality: "CT" } as CTVolume;
const seg: SegLabelmap = { lab, colors, names: {} };

const t0 = performance.now();
const rs = buildSegrouletteScene(gpu, undefined, ct, seg);
const bakeMs = performance.now() - t0;

const cam = framedCamera(rs.center, rs.radius);
rs.scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H);
const rgba = await rs.scene.renderToRGBA(W, H);
await Deno.writeFile(new URL("./segroulette-sdf.png", import.meta.url).pathname, await encodePNG(rgba, W, H));

// Count how many of the 15 segment colours are visibly present (dominant-channel bucketed).
const seen = new Set<number>();
for (let i = 0; i < W * H; i++) {
  const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
  if (Math.max(r, g, b) < 50) continue;
  let best = -1, bestD = 1e9;
  for (let k = 0; k < COLORS.length; k++) {
    const c = COLORS[k];
    const d = (r / 255 - c[0]) ** 2 + (g / 255 - c[1]) ** 2 + (b / 255 - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  if (bestD < 0.06) seen.add(best);
}
console.log(`SEGRoulette SDF: build+bake ${bakeMs.toFixed(0)}ms (dims ${nx}³ capped for SDF); distinct segment colours visible = ${seen.size}/15`);

// Tri-state per-segment opacity (UI: 1 → 0.5 → 0 → 1). Verify the two robust, entanglement-free
// signals: (a) hiding EVERY segment leaves the seg surface fully gone, (b) all-50% is translucent so
// the scene is dimmer than all-opaque but not gone — plus the per-segment readback round-trips.
const litMask = (rgba: Uint8Array) => { const m = new Uint8Array(W * H); let n = 0; for (let i = 0; i < W * H; i++) if (Math.max(rgba[i*4], rgba[i*4+1], rgba[i*4+2]) >= 40) { m[i] = 1; n++; } return { m, n }; };
const brightIn = (rgba: Uint8Array, mask: Uint8Array) => { let s = 0; for (let i = 0; i < W * H; i++) if (mask[i]) s += rgba[i*4] + rgba[i*4+1] + rgba[i*4+2]; return s; };
const render2 = async () => { rs.scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, W, H); return await rs.scene.renderToRGBA(W, H); };

rs.setSegmentOpacity(1, 0.5);
const triReadOk = rs.segmentOpacity(1) === 0.5 && rs.segmentOpacity(3) === 1;
for (let s = 1; s <= 15; s++) rs.setSegmentOpacity(s, 1);
const rgba100 = await render2();
const { m: mask, n: lit100 } = litMask(rgba100);
const bright100 = brightIn(rgba100, mask);          // brightness over the opaque-surface footprint
for (let s = 1; s <= 15; s++) rs.setSegmentOpacity(s, 0.5);
const bright50 = brightIn(await render2(), mask);   // ... same pixels, now translucent
for (let s = 1; s <= 15; s++) rs.setSegmentOpacity(s, 0);
const lit0 = litMask(await render2()).n;
const hideOk = lit0 < lit100 * 0.02;                // opacity 0 on all → seg surface gone
const dimOk = bright50 < bright100 * 0.95;           // 50% measurably changes the render (opacity applied, not ignored); the strong see-through proof is render/test/tri-behind-seethrough.ts
console.log(`tri-state: readback ${triReadOk ? "ok" : "MISMATCH"}; lit 100%=${lit100} → 0%=${lit0} (hide ${hideOk ? "ok" : "FAIL"}); bright 50/100 over footprint=${(bright50/bright100).toFixed(2)} (dim ${dimOk ? "ok" : "FAIL"})`);

const ok = seen.size >= 7 && rs.mode === "sdf" && rs.hasSeg && triReadOk && hideOk && dimOk;
console.log(ok ? "PASS — unified colorized-SDF renders many segments + tri-state opacity hides/dims per segment" : "FAIL");
rs.destroy();
gpu.device.destroy();
if (!ok) Deno.exit(1);
