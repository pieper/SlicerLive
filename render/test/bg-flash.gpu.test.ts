// T2: the "background flashes across progressive tiers" regression, as a deno test (from bg-flash.ts).
// With build([]) every ray misses, so all three progressive tiers (renderToView / renderUpscaled /
// renderAccum) must be byte-identical; the background image is also pinned as a golden.
//   deno test -A --unstable-webgpu render/test/bg-flash.gpu.test.ts
import { assertGolden, assertIdentical, renderToImage } from "../../test/golden.ts";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({ name: "empty scene: renderToView / renderUpscaled / renderAccum are byte-identical", ignore: !hasGpu, sanitizeResources: false, async fn() {
  const gpu = await initDevice();
  const W = 64, H = 64, FMT: GPUTextureFormat = "rgba8unorm-srgb";
  const sr = new SceneRenderer(gpu, FMT);
  sr.build([]);
  const cam = (w = W, h = H) => sr.setCamera([0, 0, 500], [0, 0, 0], [0, 1, 0], 30, w, h);
  cam();
  const toView = await renderToImage(gpu.device, FMT, W, H, (v) => sr.renderToView(v, W, H));
  cam(W / 2, H / 2);
  const upscaled = await renderToImage(gpu.device, FMT, W, H, (v) => sr.renderUpscaled(v, W / 2, H / 2, W, H));
  cam();
  const accum1 = await renderToImage(gpu.device, FMT, W, H, (v) => sr.renderAccum(v, W, H, true));
  const accum2 = await renderToImage(gpu.device, FMT, W, H, (v) => sr.renderAccum(v, W, H, false));
  assertIdentical(toView, upscaled, "renderToView vs renderUpscaled");
  assertIdentical(toView, accum1, "renderToView vs renderAccum(first)");
  assertIdentical(toView, accum2, "renderToView vs renderAccum(second)");
  await assertGolden(toView, "bg-empty-64");
} });
