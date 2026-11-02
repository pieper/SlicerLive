// SUVpeak on the GPU: the maximum, over candidate centres, of a 1 mL sphere's weighted mean.
//
// EANM v2.0 asks for a "3D 1.2 cm diameter (and 1.0 mL volume) spherical VOI positioned such that
// the average value across all positions within the lesion is maximised". Done honestly that is a
// convolution — roughly a thousand taps per candidate centre, at every candidate — which is why
// other implementations approximate it (cornerstone3D tests only the ten hottest voxels). On a GPU
// the honest version is one dispatch, so the conformant answer is also the cheap one.
//
// The CPU reference lives in logic/pet/indices.ts (suvPeak); this kernel must agree with it.
// Agreement is to a float tolerance, not bit-exact: the weighted sum runs in a different ORDER on
// the GPU, and f32 addition is not associative. The parity test pins the relative difference.
//
// Work is restricted to a bounding box because a lesion is small and the volume is not: evaluating
// 168x168x186 candidates to measure a 2 cm node would be two orders of magnitude of wasted work.

import type { Gpu } from "../../render/device.ts";

export interface PeakSphereInput {
  data: Float32Array;
  dims: [number, number, number];
  /** Non-zero where a voxel is a candidate centre AND (for interiorOnly) part of the lesion. */
  mask: Uint8Array;
  /** Kernel taps: [di, dj, dk, weight] per entry, weight = fraction of that voxel in the sphere. */
  taps: Float32Array;
  /** Inclusive voxel bounds to search. Defaults to the whole volume. */
  bboxLo?: [number, number, number];
  bboxHi?: [number, number, number];
  /** Require every tap to land inside the mask (PET-IndiC's default). */
  interiorOnly?: boolean;
}

export interface PeakSphereResult {
  peak: number;
  center: [number, number, number];
  candidates: number;
}

const WG = 4;   // 4x4x4 = 64 threads, matching the paint effect's workgroup shape

/** Anything at or below this is the shader's "not a candidate" sentinel. */
const SENTINEL_LIMIT = -1e38;

const PEAK_WGSL = /* wgsl */ `
struct U {
  dims : vec4<u32>,        // nx, ny, nz, tapCount
  lo : vec4<u32>,          // bbox lo i,j,k, interiorOnly
  span : vec4<u32>,        // bbox span i,j,k, _
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var<storage, read> vol : array<f32>;
@group(0) @binding(2) var<storage, read> mask : array<u32>;
@group(0) @binding(3) var<storage, read> taps : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> out : array<f32>;

fn idx3(i : u32, j : u32, k : u32) -> u32 { return (k * u.dims.y + j) * u.dims.x + i; }

@compute @workgroup_size(${WG}, ${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.span.x || gid.y >= u.span.y || gid.z >= u.span.z) { return; }
  let o = (gid.z * u.span.y + gid.y) * u.span.x + gid.x;
  let i = u.lo.x + gid.x;
  let j = u.lo.y + gid.y;
  let k = u.lo.z + gid.z;

  // Not a candidate centre. A sentinel below any plausible SUV, so the reduction ignores it.
  if (mask[idx3(i, j, k)] == 0u) { out[o] = -3.402823e38; return; }

  let interior = u.lo.w != 0u;
  var acc = 0.0;
  var wsum = 0.0;
  for (var t = 0u; t < u.dims.w; t = t + 1u) {
    let tap = taps[t];
    let ii = i32(i) + i32(tap.x);
    let jj = i32(j) + i32(tap.y);
    let kk = i32(k) + i32(tap.z);
    if (ii < 0 || jj < 0 || kk < 0 ||
        ii >= i32(u.dims.x) || jj >= i32(u.dims.y) || kk >= i32(u.dims.z)) {
      // Outside the volume contributes nothing and does not inflate the weight sum, so a sphere
      // hanging off the edge is not rewarded for the part that is missing.
      if (interior) { out[o] = -3.402823e38; return; }
      continue;
    }
    let n = idx3(u32(ii), u32(jj), u32(kk));
    if (interior && mask[n] == 0u) { out[o] = -3.402823e38; return; }
    acc = acc + vol[n] * tap.w;
    wsum = wsum + tap.w;
  }
  if (wsum <= 0.0) { out[o] = -3.402823e38; return; }
  out[o] = acc / wsum;
}
`;

function u32Mask(mask: Uint8Array): Uint32Array {
  const out = new Uint32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 1 : 0;
  return out;
}

/** Run the sphere convolution on the GPU and return the maximising centre. */
export async function peakSphereGPU(gpu: Gpu, input: PeakSphereInput): Promise<PeakSphereResult | null> {
  const { data, dims, mask, taps } = input;
  const [nx, ny, nz] = dims;
  const lo = input.bboxLo ?? [0, 0, 0];
  const hi = input.bboxHi ?? [nx - 1, ny - 1, nz - 1];
  const span: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  if (span[0] <= 0 || span[1] <= 0 || span[2] <= 0) return null;
  const outCount = span[0] * span[1] * span[2];
  const dev = gpu.device;

  const mkStorage = (src: ArrayBufferView) => {
    const b = dev.createBuffer({ size: Math.max(4, src.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(b, 0, src.buffer as ArrayBuffer, src.byteOffset, src.byteLength);
    return b;
  };

  const volBuf = mkStorage(data);
  const maskBuf = mkStorage(u32Mask(mask));
  const tapBuf = mkStorage(taps);
  const outBuf = dev.createBuffer({ size: outCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = dev.createBuffer({ size: outCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  // All members are vec4-aligned, so the CPU packing and the WGSL struct stay in step by
  // construction rather than by comment.
  const uni = new Uint32Array(12);
  uni.set([nx, ny, nz, taps.length / 4], 0);
  uni.set([lo[0], lo[1], lo[2], input.interiorOnly ? 1 : 0], 4);
  uni.set([span[0], span[1], span[2], 0], 8);
  const uniBuf = dev.createBuffer({ size: uni.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(uniBuf, 0, uni.buffer as ArrayBuffer);

  const pipe = dev.createComputePipeline({
    layout: "auto",
    compute: { module: dev.createShaderModule({ code: PEAK_WGSL }), entryPoint: "main" },
  });
  const bind = dev.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniBuf } },
      { binding: 1, resource: { buffer: volBuf } },
      { binding: 2, resource: { buffer: maskBuf } },
      { binding: 3, resource: { buffer: tapBuf } },
      { binding: 4, resource: { buffer: outBuf } },
    ],
  });

  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(
    Math.ceil(span[0] / WG),
    Math.ceil(span[1] / WG),
    Math.ceil(span[2] / WG),
  );
  pass.end();
  enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outCount * 4);
  dev.queue.submit([enc.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const means = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  // The argmax runs on the CPU over the bounding box, which is a lesion-sized array. A second GPU
  // reduction would save a readback that is already small, at the cost of a float-atomic dance
  // WebGPU core cannot do (there is no atomicMax on f32).
  let best = -Infinity;
  let center: [number, number, number] | null = null;
  let candidates = 0;
  // The sentinel is tested by RANGE, not equality: the WGSL literal -3.402823e38 round-trips
  // through f32 as -3.4028230607370965e+38, which is not === the JS double of the same text.
  // Comparing a float sentinel for exact equality across that boundary silently never matches.
  for (let t = 0; t < outCount; t++) {
    const v = means[t];
    if (!Number.isFinite(v) || v <= SENTINEL_LIMIT) continue;
    candidates++;
    if (v > best) {
      const i = t % span[0];
      const j = Math.floor(t / span[0]) % span[1];
      const k = Math.floor(t / (span[0] * span[1]));
      best = v;
      center = [lo[0] + i, lo[1] + j, lo[2] + k];
    }
  }

  for (const b of [volBuf, maskBuf, tapBuf, outBuf, readBuf, uniBuf]) b.destroy();
  if (!center) return null;
  return { peak: best, center, candidates };
}

/** Flatten a PeakKernel (from logic/pet/indices.ts) into the vec4 tap array this kernel wants. */
export function tapsFromKernel(offsets: Int32Array, weights: Float32Array): Float32Array {
  const n = weights.length;
  const out = new Float32Array(n * 4);
  for (let t = 0; t < n; t++) {
    out[t * 4] = offsets[t * 3];
    out[t * 4 + 1] = offsets[t * 3 + 1];
    out[t * 4 + 2] = offsets[t * 3 + 2];
    out[t * 4 + 3] = weights[t];
  }
  return out;
}
