// Feature-cortex GPU runner (Deno + browser, via render/device.ts).
//
// Uploads a scalar volume once into a storage buffer, then runs named WGSL compute
// "feature kernels" over it, returning per-voxel Float32 feature maps. This is the
// perception layer of SEGMENTATION-SKILL: task-specific volumetric operators, designed
// from radiology and calibrated ("weights") on labeled data, evaluated efficiently on
// the local GPU. Kernels see the raw volume plus up to 8 scalar params (the calibrated
// weights) and write one output value per voxel.
import { initDevice, type Gpu } from "../../render/device.ts";

export type Dims = [number, number, number];

const PREAMBLE = /* wgsl */ `
struct U { nx:u32, ny:u32, nz:u32, _pad:u32,
           p0:f32, p1:f32, p2:f32, p3:f32, p4:f32, p5:f32, p6:f32, p7:f32 };
@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<f32>;
@group(0) @binding(2) var<uniform>             P   : U;
fn IDX(x:i32,y:i32,z:i32)->i32 { return x + i32(P.nx)*(y + i32(P.ny)*z); }
fn INB(x:i32,y:i32,z:i32)->bool { return x>=0 && y>=0 && z>=0 && x<i32(P.nx) && y<i32(P.ny) && z<i32(P.nz); }
fn IN(x:i32,y:i32,z:i32)->f32 { if(!INB(x,y,z)){ return -1024.0; } return src[IDX(x,y,z)]; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g:vec3u){
  // 2-D dispatch grid to dodge the 65535 workgroups-per-dimension cap.
  // P._pad holds the row width (gx*64); linear index = g.x + g.y*width.
  let i = i32(g.x) + i32(g.y) * i32(P._pad);
  let nxy = i32(P.nx)*i32(P.ny);
  let total = nxy*i32(P.nz);
  if(i >= total){ return; }
  let z = i / nxy; let r = i % nxy; let y = r / i32(P.nx); let x = r % i32(P.nx);
  var o : f32 = 0.0;
  { BODY }
  dst[i] = o;
}`;

export interface FeatureRunner {
  gpu: Gpu;
  dims: Dims;
  run(name: string, body: string, params?: number[]): Promise<Float32Array>;
  destroy(): void;
}

export async function makeRunner(vol: Float32Array, dims: Dims, gpu?: Gpu): Promise<FeatureRunner> {
  const g = gpu ?? await initDevice();
  const dev = g.device;
  const N = dims[0] * dims[1] * dims[2];
  const bytes = N * 4;
  const src = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(src, 0, vol.buffer, vol.byteOffset, bytes);
  const dst = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const ubuf = dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const cache = new Map<string, GPUComputePipeline>();

  async function run(name: string, body: string, params: number[] = []): Promise<Float32Array> {
    let pipe = cache.get(name);
    if (!pipe) {
      const code = PREAMBLE.replace("{ BODY }", body);
      const mod = dev.createShaderModule({ code });
      pipe = dev.createComputePipeline({ layout: "auto", compute: { module: mod, entryPoint: "main" } });
      cache.set(name, pipe);
    }
    // 2-D dispatch grid: total workgroups = ceil(N/64), tiled so neither dim exceeds 65535.
    const wgs = Math.ceil(N / 64);
    const gx = Math.min(wgs, 65535);
    const gy = Math.ceil(wgs / gx);
    const width = gx * 64; // row width in voxels; shader reconstructs i = g.x + g.y*width
    // uniforms: 3 dims + width (u32), then 8 f32 params
    const ab = new ArrayBuffer(48); const u32 = new Uint32Array(ab, 0, 4); const f32 = new Float32Array(ab, 16, 8);
    u32[0] = dims[0]; u32[1] = dims[1]; u32[2] = dims[2]; u32[3] = width;
    for (let i = 0; i < 8; i++) f32[i] = params[i] ?? 0;
    dev.queue.writeBuffer(ubuf, 0, ab);
    const bg = dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } }, { binding: 2, resource: { buffer: ubuf } }],
    });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(gx, gy); pass.end();
    const rb = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(dst, 0, rb, 0, bytes);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return out;
  }
  return { gpu: g, dims, run, destroy() { src.destroy(); dst.destroy(); ubuf.destroy(); } };
}
