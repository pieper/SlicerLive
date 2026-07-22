// ColorizeVolume RGBA bake — TS/WebGPU port of add_colorize_volume's density path.
// labelmap (r8uint 3D) + palette (256 x RGBA) -> rgba16float 3D texture via compute:
//   init: palette lookup -> (rgb, present*opacity)
//   3x separable Gaussian on the ALPHA channel only (RGB carried from center tap)
// The result is rendered by an RGBAVolumeField (see fields.ts). This is where a
// segmentation labelmap (e.g. nnLive's mask) becomes a cinematic colored volume.

import type { Vec3 } from "./mat4.ts";

const INIT_WGSL = /* wgsl */ `
struct U { dims : vec4<u32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(3) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let label = textureLoad(t_label, vec3<i32>(gid), 0).r;
  let pal = u_pal[label & 255u];
  let present = select(0.0, 1.0, label != 0u);
  textureStore(t_out, vec3<i32>(gid), vec4<f32>(pal.rgb, present * pal.a));
}`;

const BLUR_WGSL = /* wgsl */ `
struct U { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };  // axis, radius; half-kernel weights
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : U;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var asum = center.a * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    let o = av * i;
    let p1 = clamp(c + o, vec3<i32>(0), dmax);
    let p2 = clamp(c - o, vec3<i32>(0), dmax);
    asum = asum + wt(u32(i)) * (textureLoad(t_in, p1, 0).a + textureLoad(t_in, p2, 0).a);
  }
  textureStore(t_out, c, vec4<f32>(center.rgb, asum));
}`;

function gaussHalfKernel(sigma: number): { radius: number; w: Float32Array } {
  const radius = Math.max(1, Math.min(15, Math.ceil(3 * sigma)));
  const raw = new Float32Array(radius + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) { raw[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); total += (i === 0 ? 1 : 2) * raw[i]; }
  const w = new Float32Array(16); // array<vec4,4>
  for (let i = 0; i <= radius; i++) w[i] = raw[i] / total;
  return { radius, w };
}

/** Bake labelmap + palette -> rgba16float 3D texture (density mode). palette: 256*4 f32 (rgb + opacity). */
export function bakeColorizeRGBA(dev: GPUDevice, labelmap: Uint8Array, dims: Vec3, palette: Float32Array, sigmaVoxels = 1.5): GPUTexture {
  const [dx, dy, dz] = dims;
  const storageUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;

  const labelTex = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  dev.queue.writeTexture({ texture: labelTex }, labelmap, { bytesPerRow: dx, rowsPerImage: dy }, dims as [number, number, number]);
  const texA = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: "rgba16float", usage: storageUsage });
  const texB = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: "rgba16float", usage: storageUsage });

  const palBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const palData = new Float32Array(256 * 4);
  palData.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
  dev.queue.writeBuffer(palBuf, 0, palData);
  const dimsBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(dimsBuf, 0, new Uint32Array([dx, dy, dz, 0]));

  const gx = Math.ceil(dx / 4), gy = Math.ceil(dy / 4), gz = Math.ceil(dz / 4);

  // init: label+palette -> texA
  const initPipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: INIT_WGSL }), entryPoint: "main" } });
  const initBind = dev.createBindGroup({ layout: initPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: labelTex.createView() },
    { binding: 1, resource: texA.createView() },
    { binding: 2, resource: { buffer: palBuf } },
    { binding: 3, resource: { buffer: dimsBuf } },
  ] });
  const enc = dev.createCommandEncoder();
  { const p = enc.beginComputePass(); p.setPipeline(initPipe); p.setBindGroup(0, initBind); p.dispatchWorkgroups(gx, gy, gz); p.end(); }

  // 3 separable Gaussian passes on alpha: X (A->B), Y (B->A), Z (A->B). Result in texB.
  const { radius, w } = gaussHalfKernel(sigmaVoxels);
  const blurPipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BLUR_WGSL }), entryPoint: "main" } });
  const passes: Array<[GPUTexture, GPUTexture, number]> = [[texA, texB, 0], [texB, texA, 1], [texA, texB, 2]];
  for (const [src, dst, axis] of passes) {
    const ub = dev.createBuffer({ size: 16 + 16 + 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(ub, 0, new Uint32Array([dx, dy, dz, 0, axis, radius, 0, 0]));
    dev.queue.writeBuffer(ub, 32, w);
    const b = dev.createBindGroup({ layout: blurPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: src.createView() },
      { binding: 1, resource: dst.createView() },
      { binding: 2, resource: { buffer: ub } },
    ] });
    const p = enc.beginComputePass(); p.setPipeline(blurPipe); p.setBindGroup(0, b); p.dispatchWorkgroups(gx, gy, gz); p.end();
  }
  dev.queue.submit([enc.finish()]);

  labelTex.destroy(); texA.destroy();
  return texB; // rgba16float 3D, ready for RGBAVolumeField
}
