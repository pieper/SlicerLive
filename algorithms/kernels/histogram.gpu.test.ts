// T2 (W3): the WGSL histogram returns integer counts byte-identical to the CPU reference.
//   deno test -A --unstable-webgpu algorithms/kernels/histogram.gpu.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { histogram, histogramGPU } from "./histogram.ts";
import { initDevice } from "../../render/device.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({ name: "histogramGPU == CPU counts (ramp, clamped edges, real-ish noise)", ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false, async fn() {
  const gpu = await initDevice();

  // 1) uniform ramp
  const ramp = Float32Array.from({ length: 4096 }, (_, i) => i % 512);
  const cCpu = histogram(ramp, { bins: 64 });
  const cGpu = await histogramGPU(gpu, ramp, { bins: 64 });
  assertEquals(Array.from(cGpu.counts), Array.from(cCpu.counts), "ramp counts identical");

  // 2) values outside [range] clamp to first/last bin, same on both
  const edge = Float32Array.from({ length: 1000 }, (_, i) => (i < 100 ? -50 : i > 900 ? 500 : (i % 100)));
  const eCpu = histogram(edge, { bins: 10, range: [0, 100] });
  const eGpu = await histogramGPU(gpu, edge, { bins: 10, range: [0, 100] });
  assertEquals(Array.from(eGpu.counts), Array.from(eCpu.counts), "clamped-edge counts identical");

  // 3) a deterministic pseudo-random (no Math.random in the sandbox) volume-sized array
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const noise = Float32Array.from({ length: 100000 }, () => Math.floor(rnd() * 1000) - 200);
  const nCpu = histogram(noise, { bins: 256 });
  const nGpu = await histogramGPU(gpu, noise, { bins: 256 });
  assertEquals(Array.from(nGpu.counts), Array.from(nCpu.counts), "noise counts identical");

  gpu.device.destroy();
} });
