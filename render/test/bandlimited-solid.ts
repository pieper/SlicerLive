// BAND-LIMITED SOLID — numeric proof for the three claims behind making the smoothing control move
// the geometry again (render/fields.ts sdf outer mode + render/sdf-bake.ts attr.b):
//
//   1. STAIRCASE. A voxelized sphere rendered at σ=0⁺ is the trilinear reconstruction of a binary
//      indicator — flat voxel faces, i.e. aliasing. Band-limiting the indicator and taking its 0.5
//      level set should shrink the silhouette's deviation from a circle by a large factor.
//   2. NO FUSION. The reason smoothing used to be forbidden from moving the surface: blurring the
//      unbounded SIGNED DISTANCE closed the disc space between two vertebrae. A BOUNDED indicator
//      cannot — the gap must stay open at every σ in range.
//   3. SOLID. A clip plane through the body must cut a FACE, not open a hole into a shell. Measured
//      as shading uniformity across the cut disc: a flat cap facing the camera is evenly lit; the
//      inner far wall of a hollow shell is bright at the centre and dark at the rim.
//
//   deno run --unstable-webgpu --allow-read --allow-write render/test/bandlimited-solid.ts
import { initDevice } from "../device.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { SceneRenderer } from "../scene-renderer.ts";

const W = 420, H = 420;
const gpu = await initDevice();
const N = 96, dims: [number, number, number] = [N, N, N];
const sp = 1.0;
const ijkToRAS = [sp, 0, 0, -sp * N / 2, 0, sp, 0, -sp * N / 2, 0, 0, sp, -sp * N / 2, 0, 0, 0, 1];
const lit = (rgba: Uint8Array, i: number) => Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);

/** One scene over `lab`, rendered at each σ with `setup` applied to the renderer. */
async function sweep(lab: Uint8Array, sigmas: number[], setup: (s: SceneRenderer) => void,
                     eye: [number, number, number], boundaryMode: "outer" | "all" = "outer") {
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf", clippable: true, opacity: 1, boundaryMode });
  logic.setLabelColor(1, [0.85, 0.80, 0.70]);
  logic.setLabelColor(2, [0.55, 0.70, 0.90]);
  seg.loadLabelmap(lab);
  logic.refineNow();
  const scene = new SceneRenderer(gpu, undefined);
  scene.build([logic.field()]);
  scene.setBackground(0, 0, 0);
  scene.setCamera(eye, [0, 0, 0], [0, 0, 1], 30, W, H);
  setup(scene);
  const out: Uint8Array[] = [];
  for (const s of sigmas) {
    logic.setSmoothing(s);
    logic.refineNow();
    scene.syncUniforms();
    out.push(await scene.renderToRGBA(W, H));
  }
  seg.destroy(); logic.destroy();
  return out;
}

// ── 1. staircase: a voxelized sphere's silhouette vs the best-fit circle ──────────────────────
const sphere = new Uint8Array(N * N * N);
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const r = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5, z - N / 2 + 0.5);
  if (r <= 26) sphere[(z * N + y) * N + x] = 1;
}
/** Shading roughness: mean |Laplacian| of brightness over the sphere's interior, normalised by its
 *  mean brightness. A band-limited surface shades as a smooth gradient; a voxel-faceted one shades in
 *  terraces, and a terrace edge is exactly what a Laplacian picks up. Measured well inside the
 *  silhouette so the edge itself contributes nothing. */
function shadeRoughness(rgba: Uint8Array): number {
  let cx = 0, cy = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lit(rgba, y * W + x) >= 40) { cx += x; cy += y; n++; }
  cx /= n; cy /= n;
  let maxr = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lit(rgba, y * W + x) >= 40) maxr = Math.max(maxr, Math.hypot(x - cx, y - cy));
  }
  let sum = 0, cnt = 0, bright = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (Math.hypot(x - cx, y - cy) > 0.8 * maxr) continue;       // stay off the silhouette
    const c = lit(rgba, y * W + x);
    if (c < 40) continue;
    const lap = 4 * c - lit(rgba, y * W + x - 1) - lit(rgba, y * W + x + 1)
                      - lit(rgba, (y - 1) * W + x) - lit(rgba, (y + 1) * W + x);
    sum += Math.abs(lap); bright += c; cnt++;
  }
  return sum / bright;
}

/** RMS deviation (px) of the silhouette from its best-fit circle — the stair amplitude in the
 *  GEOMETRY. Needs a close camera: at ~10 px per voxel a voxel-face staircase is several px of
 *  radius wobble, while at 2 px per voxel it hides under the shell's own edge AA. */
function edgeRms(rgba: Uint8Array): number {
  let cx = 0, cy = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lit(rgba, y * W + x) >= 40) { cx += x; cy += y; n++; }
  if (n < 100) return NaN;
  cx /= n; cy /= n;
  const radii: number[] = [];
  for (let a = 0; a < 1440; a++) {
    const th = (a / 1440) * 2 * Math.PI, dx = Math.cos(th), dy = Math.sin(th);
    let last = 0;
    for (let r = 2; r < 260; r += 0.2) {
      const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      if (lit(rgba, y * W + x) >= 40) last = r;
    }
    if (last > 0) radii.push(last);
  }
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  return Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length);
}

const sigmas = [0.25, 0.5, 1.0, 1.5, 2.0];
const sphereShots = await sweep(sphere, sigmas, () => {}, [0, -230, 0]);
const rough = sphereShots.map(shadeRoughness);
console.log("\n1. SHADING ROUGHNESS over a voxelized sphere (mean |Laplacian| / mean brightness):");
sigmas.forEach((s, i) => console.log(`     σ ${s.toFixed(2)} vox  →  ${rough[i].toFixed(4)}`));
const roughOk = rough[0] > 0 && rough[4] < rough[0] * 0.5;

// 1b. The silhouette itself, close up (≈10 px per voxel), on a small sphere — this is the GEOMETRY,
// and it is what the previous design held fixed at the labelmap staircase while σ smoothed only the
// normal. A stepped silhouette lit by a velvet normal is what read as "chunky yet over-smooth".
const small = new Uint8Array(N * N * N);
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const r = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5, z - N / 2 + 0.5);
  if (r <= 12) small[(z * N + y) * N + x] = 1;
}
const closeShots = await sweep(small, sigmas, () => {}, [0, -80, 0]);
const edge = closeShots.map(edgeRms);
console.log("\n1b. SILHOUETTE vs best-fit circle, close up (RMS px — the staircase in the geometry):");
sigmas.forEach((s, i) => console.log(`     σ ${s.toFixed(2)} vox  →  ${edge[i].toFixed(2)} px`));
const stairOk = roughOk && edge[0] > 0 && edge[4] < edge[0] * 0.75;

// ── 2. no fusion: two slabs with a 4-voxel gap ───────────────────────────────────────────────
const slabs = new Uint8Array(N * N * N);
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const inXY = Math.abs(x - N / 2) < 22 && Math.abs(y - N / 2) < 22;
  if (!inXY) continue;
  if (z >= 30 && z < 46) slabs[(z * N + y) * N + x] = 1;          // lower slab
  if (z >= 50 && z < 66) slabs[(z * N + y) * N + x] = 2;          // upper slab, 4-voxel gap at z=46..49
}
const slabShots = await sweep(slabs, sigmas, () => {}, [0, -230, 0]);
/** Height (px) of the dark band between the two slabs, down the image centre column. */
function gapPx(rgba: Uint8Array): number {
  const x = Math.round(W / 2);
  let run = 0, best = 0, seenTop = false, seenBottom = false;
  for (let y = 0; y < H; y++) {
    const on = lit(rgba, y * W + x) >= 40;
    if (on) { if (!seenTop) seenTop = true; else if (run > 0) { seenBottom = true; best = Math.max(best, run); } run = 0; }
    else if (seenTop) run++;
  }
  return seenBottom ? best : 0;
}
const gaps = slabShots.map(gapPx);
console.log("\n2. DISC-SPACE GAP between two slabs 4 voxels apart (px of daylight, centre column):");
sigmas.forEach((s, i) => console.log(`     σ ${s.toFixed(2)} vox  →  ${gaps[i]} px`));
const gapOk = gaps.every((g) => g > 0);

// ── 3. solid: clip the sphere at y = 0 and look straight at the cut ───────────────────────────
// Keep y >= 0, camera at y = -230: the cut plane is the FIRST thing every ray meets.
const capShots = await sweep(sphere, [1.0], (s) => s.setClipPlanes([[0, 1, 0, 0]]), [0, -230, 0]);
/** rim/centre brightness ratio over the cut disc. ~1 = a flat cap; ≪1 = looking into a hollow shell. */
function capUniformity(rgba: Uint8Array): { ratio: number; cover: number } {
  let cx = 0, cy = 0, n = 0, maxr = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lit(rgba, y * W + x) >= 40) { cx += x; cy += y; n++; }
  cx /= n; cy /= n;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lit(rgba, y * W + x) >= 40) maxr = Math.max(maxr, Math.hypot(x - cx, y - cy));
  }
  let cSum = 0, cN = 0, rSum = 0, rN = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - cx, y - cy) / maxr, v = lit(rgba, y * W + x);
    if (r < 0.3) { cSum += v; cN++; }
    else if (r > 0.7 && r < 0.9) { rSum += v; rN++; }
  }
  return { ratio: (rSum / rN) / (cSum / cN), cover: n / (Math.PI * maxr * maxr) };
}
const cap = capUniformity(capShots[0]);
// CONTROL: the multi-material interface path ("all") has no CSG cap — same scene, same clip, so it
// shows what the cut looked like before, and keeps this metric honest about what it is detecting.
const hollowShots = await sweep(sphere, [1.0], (s) => s.setClipPlanes([[0, 1, 0, 0]]), [0, -230, 0], "all");
const hollow = capUniformity(hollowShots[0]);
console.log("\n3. CLIPPED SPHERE, looking at the cut (σ 1.0):");
console.log(`     solid (outer, CSG cap)  rim/centre = ${cap.ratio.toFixed(3)}  coverage ${(cap.cover * 100).toFixed(0)}%`);
console.log(`     uncapped (interface)    rim/centre = ${hollow.ratio.toFixed(3)}  coverage ${(hollow.cover * 100).toFixed(0)}%`);
console.log(`     (flat cap ≈ 1; looking into a hollow shell ≪ 1)`);
const capOk = cap.ratio > 0.8 && cap.cover > 0.85 && cap.ratio > hollow.ratio + 0.1;

console.log("");
console.log(`  ${stairOk ? "PASS" : "FAIL"} — band-limiting removes the voxel staircase from the silhouette`);
console.log(`  ${gapOk ? "PASS" : "FAIL"} — a 4-voxel gap stays open at every σ (no fusion)`);
console.log(`  ${capOk ? "PASS" : "FAIL"} — a clip plane cuts a solid face, not a hole`);
gpu.device.destroy();
if (!(stairOk && gapOk && capOk)) Deno.exit(1);
