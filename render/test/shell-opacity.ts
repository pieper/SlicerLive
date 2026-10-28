// SHELL OPACITY — does an OPAQUE segment actually render opaque, at every σ?
//
// The sdf surface is a thin shell: the ray accumulates optical depth across a band around the
// surface and the profile is normalised to reach exactly the target opacity T. That holds in the
// continuum, but the ray samples it at a finite step, so if the band is only ~1-2 samples wide the
// per-pixel sum fluctuates with the ray jitter and an opaque segment renders DUSTY — speckled, with
// the background showing through, worst where the surface is thin or curved.
//
// Measured against a BLUE background with a yellow (no blue) segment at opacity 1: any blue left
// inside the silhouette is background leaking through a surface that should be solid.
//   deno run --unstable-webgpu -A render/test/shell-opacity.ts
import { initDevice } from "../device.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { encodePNG } from "../png.ts";

/** The present target is rgba8unorm-SRGB, so a byte is gamma-encoded: decode before doing any
 *  arithmetic on how much background survived. (Differencing raw bytes reads a correct 1-(1-T)²
 *  composite as if it were ~1.3 crossings — a renderer bug that is not there.) */
const dec = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const W = 360, H = 360;
const gpu = await initDevice();
const N = 100, dims: [number, number, number] = [N, N, N];
const sp = 1.0;
const ijkToRAS = [sp, 0, 0, -sp * N / 2, 0, sp, 0, -sp * N / 2, 0, 0, sp, -sp * N / 2, 0, 0, 0, 1];
// A sphere (every surface orientation, including grazing at the rim) plus a thin 4-voxel plate
// sticking out of it — the endplate/process case where the dust was worst on real data.
const lab = new Uint8Array(N * N * N);
const c = N / 2;
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dx = x - c, dy = y - c, dz = z - c;
  if (Math.hypot(dx, dy, dz) <= 22) lab[(z * N + y) * N + x] = 1;
  if (Math.abs(dz) < 2 && Math.hypot(dx, dy) < 40) lab[(z * N + y) * N + x] = 1;
}
const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf", opacity: 1 });
logic.setLabelColor(1, [1.0, 0.85, 0.0]);        // yellow: zero blue
logic.setLabelOpacity(1, 1.0);
seg.loadLabelmap(lab);
logic.refineNow();
const scene = new SceneRenderer(gpu, undefined);
scene.build([logic.field()]);
scene.setBackground(0, 0, 1);                     // blue: anything blue inside the shape leaked through
scene.setCamera([0, -150, 55], [0, 0, 0], [0, 0, 1], 30, W, H);

const sigmas = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
console.log("  σ(vox)   leak%   worst-pixel-leak   (blue showing through an opacity-1 segment)");
let worstAll = 0;
for (const s of sigmas) {
  logic.setSmoothing(s);
  logic.refineNow();
  scene.syncUniforms();
  const rgba = await scene.renderToRGBA(W, H);
  // On-object mask, then ERODED by 3 px so the legitimately semi-transparent silhouette AA at the
  // rim is excluded — what is left is interior, where an opacity-1 segment must be fully opaque.
  const on = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) on[i] = (rgba[i * 4] >= 40 || rgba[i * 4 + 1] >= 40) ? 1 : 0;
  const inner = new Uint8Array(W * H);
  for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
    let all = 1;
    for (let dy = -3; dy <= 3 && all; dy++) for (let dx = -3; dx <= 3; dx++) if (!on[(y + dy) * W + x + dx]) { all = 0; break; }
    inner[y * W + x] = all;
  }
  let n = 0, leak = 0, worst = 0;
  for (let i = 0; i < W * H; i++) {
    if (!inner[i]) continue;
    n++;
    const v = dec(rgba[i * 4 + 2]);               // 0 = fully opaque segment, 1 = pure background (linear)
    leak += v; worst = Math.max(worst, v);
  }
  if (Math.abs(s - 1.0) < 1e-6 || Math.abs(s - 0.5) < 1e-6) {
    // leak map: red where the background shows through an opacity-1 segment
    const map = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = inner[i] ? Math.min(255, Math.round(rgba[i * 4 + 2] * 4)) : 0;
      map[i * 4] = v; map[i * 4 + 1] = inner[i] ? 40 : 0; map[i * 4 + 2] = 0; map[i * 4 + 3] = 255;
    }
    Deno.writeFileSync(`/private/tmp/claude-501/-Users-pieper-slicer-slicer-skill/cb026e79-b1c6-4b64-ae02-45e9b57f30a0/scratchpad/leak-${s}.png`, await encodePNG(map, W, H));
  }
  const pct = 100 * leak / Math.max(n, 1);
  worstAll = Math.max(worstAll, pct);
  console.log(`  ${s.toFixed(2).padStart(5)}   ${pct.toFixed(2).padStart(5)}%   ${(worst * 100).toFixed(0).padStart(3)}%`);
}
console.log("");

// THE OPACITY CONTRACT, measured. One crossing of the surface contributes exactly T, so a ray that
// enters and leaves a translucent segment composites to 1-(1-T)² — the same as a pair of polydata
// surfaces at that opacity, which is the parity this renderer targets.
logic.setSmoothing(1.0);
logic.refineNow();
let contractOk = true;
console.log("  per-segment opacity T   expected 1-(1-T)²   measured (front+back crossing)");
for (const T of [0.25, 0.5, 0.75, 1.0]) {
  logic.setLabelOpacity(1, T);
  logic.refineNow();
  scene.syncUniforms();
  // Alpha by DIFFERENCING two backgrounds: the segment's own colour and its specular highlight
  // contribute identically to both renders, so what is left is purely the background's survival.
  scene.setBackground(0, 0, 1);
  const litBlue = await scene.renderToRGBA(W, H);
  scene.setBackground(0, 0, 0);
  const litBlack = await scene.renderToRGBA(W, H);
  scene.setBackground(0, 0, 1);
  let d = 0, n = 0;
  for (let y = H / 2 - 6; y < H / 2 + 6; y++) for (let x = W / 2 - 6; x < W / 2 + 6; x++) {
    const i = (y * W + x) * 4;
    d += dec(litBlue[i + 2]) - dec(litBlack[i + 2]); n++;
  }
  const alpha = 1 - d / n;                        // bg_linear = 1 for pure blue
  const want = 1 - (1 - T) ** 2;
  const off = Math.abs(alpha - want);
  if (off > 0.02) contractOk = false;
  console.log(`  ${T.toFixed(2).padStart(13)}   ${want.toFixed(3).padStart(16)}   ${alpha.toFixed(3).padStart(10)}${off > 0.07 ? "   <-- off" : ""}`);
}
logic.setLabelOpacity(1, 1.0);

console.log("");
const ok = worstAll < 2.0 && contractOk;
console.log(worstAll < 2.0 ? "  PASS — an opaque segment renders opaque at every σ" : `  FAIL — up to ${worstAll.toFixed(1)}% background leaks through an opacity-1 segment`);
console.log(contractOk ? "  PASS — a translucent segment composites to 1-(1-T)², as two polydata surfaces would" : "  FAIL — per-segment opacity does not match the surface-pair contract");
gpu.device.destroy();
if (!ok) Deno.exit(1);
