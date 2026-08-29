// histogram kernel (W3): the reusable reduction under auto W/L today and SegmentStatistics later.
// Replaces vtkImageAccumulate / vtkImageHistogramStatistics. CPU reference (exact, deno-testable) plus a
// WGSL compute path (atomic<u32> bins) that returns byte-identical integer counts. Value/geometry only —
// no RAS, no textures; callers pass a typed array.
//
//   deno test -A --no-check algorithms/kernels/histogram.test.ts        (CPU)
//   deno test -A --unstable-webgpu algorithms/kernels/histogram.gpu.test.ts   (GPU == CPU)
import type { Gpu } from "../../render/device.ts";

export type Scalars = { length: number; [i: number]: number };
export interface Histogram { counts: Uint32Array; min: number; max: number; bins: number; binWidth: number; }
export interface ImageStats { min: number; max: number; mean: number; stdev: number; count: number; }

/** vtkImageAccumulate-style scalar stats in one pass (min/max/mean/stdev). */
export function imageStats(data: Scalars): ImageStats {
  const n = data.length;
  if (!n) return { min: 0, max: 0, mean: 0, stdev: 0, count: 0 };
  let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; sum2 += v * v; }
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  return { min: mn, max: mx, mean, stdev: Math.sqrt(variance), count: n };
}

/** Full-precision data range (min,max), a single pass. */
export function dataRange(data: Scalars): [number, number] {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return [mn === Infinity ? 0 : mn, mx === -Infinity ? 0 : mx];
}

/**
 * CPU histogram. `bins` bins spanning [min,max] (default = the data range). Values are clamped into the
 * first/last bin (vtkImageAccumulate ignores nothing at the edges). A value v lands in
 * bin = clamp(floor((v-min)/binWidth), 0, bins-1).
 */
export function histogram(data: Scalars, opts: { bins?: number; range?: [number, number] } = {}): Histogram {
  const [mn, mx] = opts.range ?? dataRange(data);
  const bins = Math.max(1, opts.bins ?? 256);
  const binWidth = (mx - mn) / bins || 1;
  const counts = new Uint32Array(bins);
  const inv = 1 / binWidth, last = bins - 1;
  for (let i = 0; i < data.length; i++) {
    let b = Math.floor((data[i] - mn) * inv);
    b = b < 0 ? 0 : b > last ? last : b;
    counts[b]++;
  }
  return { counts, min: mn, max: mx, bins, binWidth };
}

/** The value at cumulative fraction `p` (0..1) of a histogram — the percentile used by auto W/L. */
export function percentileFromCounts(h: Histogram, p: number): number {
  let total = 0; for (let i = 0; i < h.counts.length; i++) total += h.counts[i];
  if (!total) return h.min;
  const target = p * total; let cum = 0;
  for (let i = 0; i < h.counts.length; i++) { cum += h.counts[i]; if (cum >= target) return h.min + (i + 0.5) * h.binWidth; }
  return h.max;
}

const WGSL = /* wgsl */ `
struct Params { lo: f32, invBinWidth: f32, bins: u32, count: u32 };
@group(0) @binding(0) var<storage, read> data: array<f32>;
@group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> P: Params;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let f = (data[i] - P.lo) * P.invBinWidth;
  var b = i32(floor(f));
  let last = i32(P.bins) - 1;
  if (b < 0) { b = 0; }
  if (b > last) { b = last; }
  atomicAdd(&counts[u32(b)], 1u);
}
`;

/** GPU histogram (atomic bins). Returns integer counts identical to `histogram(...).counts`. */
export async function histogramGPU(gpu: Gpu, data: Scalars, opts: { bins?: number; range?: [number, number] } = {}): Promise<Histogram> {
  const { device } = gpu;
  const [mn, mx] = opts.range ?? dataRange(data);
  const bins = Math.max(1, opts.bins ?? 256);
  const binWidth = (mx - mn) / bins || 1;
  const n = data.length;

  const f32 = data instanceof Float32Array ? data : Float32Array.from({ length: n }, (_, i) => data[i]);
  const dataBuf = device.createBuffer({ size: Math.max(4, f32.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(dataBuf, 0, f32);
  const countsBuf = device.createBuffer({ size: bins * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(countsBuf, 0, new Uint32Array(bins));
  const params = new ArrayBuffer(16);
  new Float32Array(params, 0, 2).set([mn, 1 / binWidth]);
  new Uint32Array(params, 8, 2).set([bins, n]);
  const paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramBuf, 0, params);

  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: dataBuf } },
    { binding: 1, resource: { buffer: countsBuf } },
    { binding: 2, resource: { buffer: paramBuf } },
  ] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(n / 256));
  pass.end();
  const readBuf = device.createBuffer({ size: bins * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyBufferToBuffer(countsBuf, 0, readBuf, 0, bins * 4);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const counts = new Uint32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  dataBuf.destroy(); countsBuf.destroy(); paramBuf.destroy(); readBuf.destroy();
  return { counts, min: mn, max: mx, bins, binWidth };
}
