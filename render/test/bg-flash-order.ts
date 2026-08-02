// Regression test for the moving-frame black-background flash: on a FRESH renderer, render the
// upscaled (moving) tier FIRST — exactly what the adaptive loop does with movingScaleCap<=0.98
// (always renderUpscaled, never renderToView). renderUpscaled must populate its own bg uniform;
// if it relies on renderToView having run, the background composites to BLACK. Must equal the bg
// (18,20,31 for 0.07,0.08,0.12). deno run -A --unstable-webgpu render/test/bg-flash-order.ts

import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";

const gpu = await initDevice();
const W = 64, H = 64;
const FMT: GPUTextureFormat = "rgba8unorm-srgb";

const sr = new SceneRenderer(gpu, FMT);   // fresh: resolveBgBuf still zero-initialized
sr.build([]);
sr.setCamera([0, 0, 500], [0, 0, 0], [0, 1, 0], 30, W / 2, H / 2);

const tex = gpu.device.createTexture({ size: [W, H], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
sr.renderUpscaled(tex.createView(), W / 2, H / 2, W, H);   // FIRST render is the moving tier
const buf = gpu.device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const enc = gpu.device.createCommandEncoder();
enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 }, [W, H, 1]);
gpu.device.queue.submit([enc.finish()]);
await buf.mapAsync(GPUMapMode.READ);
const b = new Uint8Array(buf.getMappedRange().slice(0, 4));
const px = [b[0], b[1], b[2]];
buf.unmap();

const expected = [18, 20, 31];
const ok = px.every((v, i) => Math.abs(v - expected[i]) <= 1);
console.log(`\n  renderUpscaled-first background: rgba(${px.join(",")})  expected ~(${expected.join(",")})`);
console.log(ok ? "  ✅ background correct\n" : "  ❌ BLACK/wrong — renderUpscaled did not populate its bg uniform\n");
Deno.exit(ok ? 0 : 1);
