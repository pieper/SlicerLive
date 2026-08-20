// Regression: SCREEN-CONSTANT glyphs must stay view-sized when the producer traces BELOW the view
// resolution. The remote path (traceSamples -> client Catmull-Rom upsample) reduces the sample grid
// while you interact; if the gizmo is sized from the sample focal it grows ~1/scale once upsampled
// (a gizmo twice too big, its pick points no longer under its arms).
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-gizmo-scale.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { TransformGizmoField } from "../transform-gizmo-field.ts";

const VIEW = 1024;
const gpu = await initDevice();
const scene = new SceneRenderer(gpu, "rgba8unorm");
const pivot: [number, number, number] = [0, 0, 0];
scene.build([new TransformGizmoField(pivot, 88)]);   // the gizmo ALONE: coverage == its footprint
scene.setBackground(0, 0, 0);

/** Fraction of the frame the gizmo covers, traced at `n` and presented into a VIEW-sized frame.
 *  `viewH` omitted reproduces the pre-fix behaviour (sized from the SAMPLE focal) as a control. */
async function coverage(n: number, corrected = true): Promise<number> {
  scene.setCamera([0, -600, 0], pivot, [0, 0, 1], 30, n, n);
  const s = corrected ? await scene.traceSamples(n, n, VIEW) : await scene.traceSamples(n, n);
  let on = 0;
  for (let i = 0; i < n * n; i++) if (s[i * 4 + 3] > 8) on++;
  return on / (n * n);
}

const full = await coverage(VIEW);
let fail = 0;
// 2x and 4x reduction — the range the BudgetController actually uses. Past ~6x the thin ring
// stroke falls below a sample and the shader's AA band widens it, so coverage stops being a
// clean size proxy (measured +13% at 8x) even though the sizing is right.
for (const n of [VIEW / 2, VIEW / 4]) {
  const c = await coverage(n);
  const ratio = c / full;
  const ok = Math.abs(ratio - 1) < 0.06;      // same fraction of the view, whatever the sample grid
  if (!ok) fail++;
  console.log(`${ok ? "OK  " : "FAIL"} trace ${n}×${n} for a ${VIEW}² view: coverage ${(c * 100).toFixed(2)}% vs ${(full * 100).toFixed(2)}% (×${ratio.toFixed(2)})`);
}
// Control: the same half-scale trace WITHOUT the view focal — the bug, ~4x the coverage.
const bug = await coverage(VIEW / 2, false) / full;
console.log(`     (control: sized from the sample focal instead → ×${bug.toFixed(2)} the footprint)`);
console.log(fail ? `${fail} FAILED` : "gizmo stays view-sized at every trace scale");
gpu.device.destroy();
Deno.exit(fail ? 1 : 0);
