// T2 (GPU): SUVpeak sphere convolution — parity with the CPU reference in logic/pet/indices.ts.
//
// The CPU path is the specification (it is what the unit tests pin against EANM/PERCIST wording);
// this asserts the GPU agrees. Agreement is to a relative tolerance rather than bit-exact: the
// weighted sum accumulates in a different order on the GPU and f32 addition is not associative.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { initDevice } from "../../render/device.ts";
import { peakKernel, suvPeak, type Volume3D } from "../../logic/pet/indices.ts";
import { peakSphereGPU, tapsFromKernel } from "./peak-sphere.ts";

const gpu = await initDevice().catch(() => null);

const SPACING: [number, number, number] = [4, 4, 4];   // whole-body PET sampling

function volume(d: number, fill: (i: number, j: number, k: number) => number): Volume3D {
  const data = new Float32Array(d * d * d);
  for (let k = 0; k < d; k++) {
    for (let j = 0; j < d; j++) {
      for (let i = 0; i < d; i++) data[(k * d + j) * d + i] = fill(i, j, k);
    }
  }
  return { data, dims: [d, d, d], spacing: SPACING };
}

const boxMaskAll = (d: number) => new Uint8Array(d * d * d).fill(1);

/** Deterministic pseudo-random field, so a failure is reproducible. */
function noisy(d: number): Volume3D {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return volume(d, () => rnd() * 12);
}

Deno.test({
  name: "peak-sphere: GPU matches the CPU reference on a noisy field",
  ignore: !gpu,
  fn: async () => {
    const d = 24;
    const vol = noisy(d);
    const mask = boxMaskAll(d);
    const kernel = peakKernel(SPACING);

    const cpu = suvPeak(vol, mask, { kernel })!;
    const g = (await peakSphereGPU(gpu!, {
      data: vol.data, dims: vol.dims, mask,
      taps: tapsFromKernel(kernel.offsets, kernel.weights),
    }))!;

    assert(g, "GPU returned a result");
    // Relative tolerance: f32 accumulation order differs between the two.
    assertAlmostEquals(g.peak, cpu.peak, Math.abs(cpu.peak) * 1e-4 + 1e-5, "peak value");
    assertEquals(g.candidates, cpu.candidates, "same number of candidate centres evaluated");
    // The winning centre must agree, or agree to within a tie: with random data an exact tie is
    // vanishingly unlikely, so demand the same voxel.
    assertEquals(g.center, cpu.center, "same maximising centre");
  },
});

Deno.test({
  name: "peak-sphere: GPU also finds the plateau rather than the spike",
  ignore: !gpu,
  fn: async () => {
    // The same clinical case the CPU unit test pins: a broad warm plateau beats an isolated hot
    // spike, because EANM maximises the sphere MEAN, not the voxel maximum.
    const d = 32;
    const vol = volume(d, (i, j, k) => {
      const plateau = Math.abs(i - 10) <= 3 && Math.abs(j - 10) <= 3 && Math.abs(k - 10) <= 3;
      const spike = i === 24 && j === 24 && k === 24;
      return spike ? 60 : plateau ? 10 : 0;
    });
    const mask = boxMaskAll(d);
    const kernel = peakKernel(SPACING);
    const g = (await peakSphereGPU(gpu!, {
      data: vol.data, dims: vol.dims, mask,
      taps: tapsFromKernel(kernel.offsets, kernel.weights),
    }))!;
    assertAlmostEquals(g.peak, 10, 0.5);
    const [ci, cj, ck] = g.center;
    assert(Math.abs(ci - 10) <= 3 && Math.abs(cj - 10) <= 3 && Math.abs(ck - 10) <= 3,
      `peak should sit on the plateau, got ${g.center}`);
  },
});

Deno.test({
  name: "peak-sphere: interiorOnly agrees with the CPU reference",
  ignore: !gpu,
  fn: async () => {
    const d = 24;
    const vol = noisy(d);
    // A lesion comfortably larger than the 1 mL sphere, so interior placements exist.
    const mask = new Uint8Array(d * d * d);
    for (let k = 6; k <= 17; k++) {
      for (let j = 6; j <= 17; j++) for (let i = 6; i <= 17; i++) mask[(k * d + j) * d + i] = 1;
    }
    const kernel = peakKernel(SPACING);
    const cpu = suvPeak(vol, mask, { kernel, interiorOnly: true })!;
    const g = (await peakSphereGPU(gpu!, {
      data: vol.data, dims: vol.dims, mask,
      taps: tapsFromKernel(kernel.offsets, kernel.weights),
      interiorOnly: true,
    }))!;
    assertAlmostEquals(g.peak, cpu.peak, Math.abs(cpu.peak) * 1e-4 + 1e-5);
    assertEquals(g.center, cpu.center);
  },
});

Deno.test({
  name: "peak-sphere: interiorOnly rejects a lesion smaller than the sphere, as PET-IndiC does",
  ignore: !gpu,
  fn: async () => {
    const d = 24;
    const vol = volume(d, () => 5);
    const mask = new Uint8Array(d * d * d);
    mask[(12 * d + 12) * d + 12] = 1;             // one voxel
    const kernel = peakKernel(SPACING);
    const g = await peakSphereGPU(gpu!, {
      data: vol.data, dims: vol.dims, mask,
      taps: tapsFromKernel(kernel.offsets, kernel.weights),
      interiorOnly: true,
    });
    assertEquals(g, null, "no valid interior placement exists");
  },
});

Deno.test({
  name: "peak-sphere: a bounding box containing the lesion gives the same answer as the whole volume",
  ignore: !gpu,
  fn: async () => {
    const d = 32;
    const vol = volume(d, (i, j, k) =>
      Math.abs(i - 20) <= 3 && Math.abs(j - 20) <= 3 && Math.abs(k - 20) <= 3 ? 8 : 0
    );
    const mask = boxMaskAll(d);
    const kernel = peakKernel(SPACING);
    const taps = tapsFromKernel(kernel.offsets, kernel.weights);
    const whole = (await peakSphereGPU(gpu!, { data: vol.data, dims: vol.dims, mask, taps }))!;
    const boxed = (await peakSphereGPU(gpu!, {
      data: vol.data, dims: vol.dims, mask, taps,
      bboxLo: [14, 14, 14], bboxHi: [26, 26, 26],
    }))!;
    assertAlmostEquals(boxed.peak, whole.peak, 1e-4);
    assertEquals(boxed.center, whole.center);
    assert(boxed.candidates < whole.candidates, "the box really did restrict the search");
  },
});

Deno.test({
  name: "peak-sphere: GPU beats the CPU reference on a whole-volume search",
  ignore: !gpu,
  fn: async () => {
    // Not a correctness assertion — a guard that the kernel is actually doing the work on the GPU.
    // A whole-body-ish search is ~1000 taps at every one of ~100k candidates.
    const d = 48;
    const vol = noisy(d);
    const mask = boxMaskAll(d);
    const kernel = peakKernel(SPACING);
    const taps = tapsFromKernel(kernel.offsets, kernel.weights);

    const t0 = performance.now();
    const cpu = suvPeak(vol, mask, { kernel })!;
    const cpuMs = performance.now() - t0;

    const t1 = performance.now();
    const g = (await peakSphereGPU(gpu!, { data: vol.data, dims: vol.dims, mask, taps }))!;
    const gpuMs = performance.now() - t1;

    assertAlmostEquals(g.peak, cpu.peak, Math.abs(cpu.peak) * 1e-4 + 1e-5);
    console.log(`    ${d}^3, ${kernel.weights.length} taps: CPU ${cpuMs.toFixed(0)} ms, GPU ${gpuMs.toFixed(0)} ms`);
    assert(gpuMs < cpuMs, `GPU (${gpuMs.toFixed(0)} ms) should beat CPU (${cpuMs.toFixed(0)} ms)`);
  },
});
