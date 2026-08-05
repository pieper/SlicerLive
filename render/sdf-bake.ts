// JfaSdfBaker — a signed-distance-field bake for terrace-free "surface model" segmentation rendering.
// The Gaussian-presence path (ColorizeBaker → SegmentField iso/surface) always trades edge-crispness
// against voxel terracing (docs/ALGORITHMS.md surface-quality findings). An SDF sidesteps that: the
// distance field is smooth, so a narrow-band shell around sdf=0 renders crisp and terrace-free at any
// resolution — the closest match to Slicer's polydata surface models.
//
// Method = the Jump Flooding Algorithm (JFA), 3D. Seed the segment boundary voxels with their RAS
// position; flood nearest-seed with halving step sizes (⌈log2 N⌉ passes × 27 taps); finalize to a
// signed distance in MM (negative inside, positive outside). Reads an EXTERNAL r32uint master (the
// shared buffer `algorithms/EditableSegmentation` owns) and writes a resident r32float SDF texture the
// renderer samples (SegmentField mode "sdf"). Resident textures/pipelines are reused so a live edit
// just re-floods in place.
//
// Distances are computed in RAS mm (seeds store RAS), so anisotropic geometry is handled exactly.

import { transpose4, type Vec3 } from "./mat4.ts";

// U: ijkToRAS(64) + dims(16) + params(16). params.x = jfa step (voxels).
// Seeds store (RAS.xyz, regionLabel): a boundary voxel's REGION LABEL (its own if inside, else its
// inside neighbour's) so the flood carries per-label colour along with distance. w>0.5 = valid seed.
const INIT_WGSL = /* wgsl */ `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
fn labelAt(c : vec3<i32>) -> u32 {
  let d = vec3<i32>(u.dims.xyz);
  return textureLoad(t_label, clamp(c, vec3<i32>(0), d - vec3<i32>(1)), 0).r;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let my = labelAt(c);
  let meIn = my != 0u;
  var boundary = false;
  var region = my;                                  // inside voxel → own label
  let offs = array<vec3<i32>, 6>(vec3<i32>(1,0,0), vec3<i32>(-1,0,0), vec3<i32>(0,1,0), vec3<i32>(0,-1,0), vec3<i32>(0,0,1), vec3<i32>(0,0,-1));
  for (var i = 0; i < 6; i = i + 1) {
    let nl = labelAt(c + offs[i]);
    let nIn = nl != 0u;
    if (nIn != meIn) { boundary = true; if (!meIn) { region = nl; } }  // outside boundary → adopt inside neighbour's label
  }
  var seed = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (boundary) { seed = vec4<f32>((u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz, f32(region)); }
  textureStore(t_seed_out, c, seed);
}`;

const JFA_WGSL = /* wgsl */ `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let step = i32(u.params.x);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var best = textureLoad(t_seed_in, c, 0);
  var bestD = select(1e30, distance(p, best.xyz), best.w > 0.5);
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        if (dx == 0 && dy == 0 && dz == 0) { continue; }
        let nc = clamp(c + vec3<i32>(dx, dy, dz) * step, vec3<i32>(0), dmax);
        let s = textureLoad(t_seed_in, nc, 0);
        if (s.w > 0.5) {
          let d = distance(p, s.xyz);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
  }
  textureStore(t_seed_out, c, best);
}`;

// Finalize → rgba16float: .rgb = the nearest region's palette colour, .a = signed distance (mm).
const FINAL_WGSL = /* wgsl */ `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_label : texture_3d<u32>;
@group(0) @binding(2) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> u : U;
@group(0) @binding(4) var<uniform> u_pal : array<vec4<f32>, 256>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let s = textureLoad(t_seed_in, c, 0);
  let valid = s.w > 0.5;
  let dist = select(1e3, distance(p, s.xyz), valid);
  let ins = textureLoad(t_label, c, 0).r != 0u;
  let sdf = select(dist, -dist, ins);
  let lbl = u32(s.w + 0.5) & 255u;
  let color = select(vec3<f32>(0.0), u_pal[lbl].rgb, valid);
  textureStore(t_out, c, vec4<f32>(color, sdf));
}`;

// Separable Gaussian on the SDF's .a (distance) only, carrying .rgb (colour) from the centre tap.
// JFA distance is distance-to-nearest-SEED-VOXEL, so it is piecewise-linear (Voronoi facets) and its
// gradient — the shading normal — is faceted (golf-ball look). A light blur of the distance barely
// moves the zero level set (silhouette stays crisp) but smooths the gradient. The colour is NOT
// blurred, so label seams stay crisp.
const BLUR_WGSL = /* wgsl */ `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var sum = center.a * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).a
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).a);
  }
  textureStore(t_out, c, vec4<f32>(center.rgb, sum));
}`;

function gaussHalfKernel(sigma: number): { radius: number; w: Float32Array } {
  const radius = Math.max(1, Math.min(15, Math.ceil(3 * sigma)));
  const raw = new Float32Array(radius + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) { raw[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); total += (i === 0 ? 1 : 2) * raw[i]; }
  const w = new Float32Array(16);
  for (let i = 0; i <= radius; i++) w[i] = raw[i] / total;
  return { radius, w };
}

export class JfaSdfBaker {
  private dev: GPUDevice;
  private seed: [GPUTexture, GPUTexture];       // rgba32float ping-pong (RAS seed xyz + regionLabel)
  private sdfTex: GPUTexture;                    // rgba16float: .rgb = per-label colour, .a = signed dist (mm) — sampled by SegmentField
  private sdfScratch: GPUTexture;               // rgba16float blur ping-pong
  private uni: GPUBuffer;
  private palBuf: GPUBuffer;                     // 256 × vec4 label→colour palette
  private initPipe: GPUComputePipeline;
  private jfaPipe: GPUComputePipeline;
  private finalPipe: GPUComputePipeline;
  private blurPipe: GPUComputePipeline;
  private g: [number, number, number];
  private steps: number[];
  private smoothSigma: number;

  constructor(dev: GPUDevice, private labelTex: GPUTexture, private dims: Vec3, private ijkToRAS: number[], smoothSigmaVoxels = 1.0) {
    this.dev = dev;
    this.smoothSigma = smoothSigmaVoxels;
    const [dx, dy, dz] = dims;
    const mk = (fmt: GPUTextureFormat, extra = 0) => dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: fmt, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | extra });
    this.seed = [mk("rgba32float"), mk("rgba32float")];
    this.sdfTex = mk("rgba16float", GPUTextureUsage.COPY_DST);   // final blur pass copies into it
    this.sdfScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.uni = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.palBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = (code: string) => dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code }), entryPoint: "main" } });
    this.initPipe = mod(INIT_WGSL);
    this.jfaPipe = mod(JFA_WGSL);
    this.finalPipe = mod(FINAL_WGSL);
    this.blurPipe = mod(BLUR_WGSL);
    this.g = [Math.ceil(dx / 4), Math.ceil(dy / 4), Math.ceil(dz / 4)];
    // JFA step schedule: largest power of two < maxDim, halving to 1.
    const maxDim = Math.max(dx, dy, dz);
    const steps: number[] = [];
    for (let s = 1 << Math.floor(Math.log2(maxDim - 1)); s >= 1; s >>= 1) steps.push(s);
    this.steps = steps;
  }

  /** The resident colorized-SDF texture (rgba16float: .rgb = per-label colour, .a = signed mm).
   *  Identity stable across bakes → the SceneRenderer bind group stays valid; a live edit updates in
   *  place. */
  sdfTexture(): GPUTexture { return this.sdfTex; }

  /** Set the label→colour palette (256 × rgba f32; index = label id). Call before bake(). */
  setPalette(palette: Float32Array) {
    const pal = new Float32Array(256 * 4);
    pal.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.palBuf, 0, pal);
  }

  private writeUni(step: number) {
    const ab = new ArrayBuffer(96);
    const f = new Float32Array(ab), u = new Uint32Array(ab);
    f.set(transpose4(this.ijkToRAS), 0);
    u[16] = this.dims[0]; u[17] = this.dims[1]; u[18] = this.dims[2]; u[19] = 0;
    f[20] = step; f[21] = 0; f[22] = 0; f[23] = 0;
    this.dev.queue.writeBuffer(this.uni, 0, ab);
  }

  /** Recompute the SDF from the current master labelmap (one JFA sweep), in place. */
  bake() {
    const dev = this.dev, [gx, gy, gz] = this.g;
    // init → seed[0]
    this.writeUni(0);
    let enc = dev.createCommandEncoder();
    {
      const b = dev.createBindGroup({ layout: this.initPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.labelTex.createView() },
        { binding: 1, resource: this.seed[0].createView() },
        { binding: 2, resource: { buffer: this.uni } },
      ] });
      const p = enc.beginComputePass(); p.setPipeline(this.initPipe); p.setBindGroup(0, b); p.dispatchWorkgroups(gx, gy, gz); p.end();
    }
    dev.queue.submit([enc.finish()]);

    // JFA passes, ping-ponging seed[src] → seed[dst]. Each pass needs its own uniform step, so submit
    // per pass (small count, ≤ ~7). src starts at 0 (the init result).
    let src = 0;
    for (const step of this.steps) {
      this.writeUni(step);
      const dst = src ^ 1;
      enc = dev.createCommandEncoder();
      const b = dev.createBindGroup({ layout: this.jfaPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.seed[src].createView() },
        { binding: 1, resource: this.seed[dst].createView() },
        { binding: 2, resource: { buffer: this.uni } },
      ] });
      const p = enc.beginComputePass(); p.setPipeline(this.jfaPipe); p.setBindGroup(0, b); p.dispatchWorkgroups(gx, gy, gz); p.end();
      dev.queue.submit([enc.finish()]);
      src = dst;
    }

    // finalize: seed[src] + label + palette → sdfTex (.rgb colour, .a signed mm)
    enc = dev.createCommandEncoder();
    const bf = dev.createBindGroup({ layout: this.finalPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seed[src].createView() },
      { binding: 1, resource: this.labelTex.createView() },
      { binding: 2, resource: this.sdfTex.createView() },
      { binding: 3, resource: { buffer: this.uni } },
      { binding: 4, resource: { buffer: this.palBuf } },
    ] });
    const p = enc.beginComputePass(); p.setPipeline(this.finalPipe); p.setBindGroup(0, bf); p.dispatchWorkgroups(gx, gy, gz); p.end();
    dev.queue.submit([enc.finish()]);

    // Smooth the SDF (3 separable Gaussian passes) so the shading normal isn't Voronoi-faceted. Passes
    // ping-pong sdfTex↔scratch ending in scratch, then copy back into sdfTex (identity stable for the
    // renderer's bind group).
    if (this.smoothSigma > 0) {
      const { radius, w } = gaussHalfKernel(this.smoothSigma);
      const [dx, dy, dz] = this.dims;
      const passes: Array<[GPUTexture, GPUTexture, number]> = [[this.sdfTex, this.sdfScratch, 0], [this.sdfScratch, this.sdfTex, 1], [this.sdfTex, this.sdfScratch, 2]];
      enc = dev.createCommandEncoder();
      for (const [srcT, dstT, axis] of passes) {
        const ab = new ArrayBuffer(96);
        const u32 = new Uint32Array(ab), f32 = new Float32Array(ab);
        u32[0] = dx; u32[1] = dy; u32[2] = dz; u32[4] = axis; u32[5] = radius;
        f32.set(w, 8);   // w starts at byte 32 = float index 8 (dims 16B + axis_r 16B)
        // NB: each pass needs its own uniform contents; use a fresh small buffer per pass to avoid
        // overwriting a still-queued read.
        const ub = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(ub, 0, ab);
        const b = dev.createBindGroup({ layout: this.blurPipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: srcT.createView() },
          { binding: 1, resource: dstT.createView() },
          { binding: 2, resource: { buffer: ub } },
        ] });
        const bp = enc.beginComputePass(); bp.setPipeline(this.blurPipe); bp.setBindGroup(0, b); bp.dispatchWorkgroups(gx, gy, gz); bp.end();
      }
      // passes end in sdfScratch → copy back into the resident sdfTex.
      enc.copyTextureToTexture({ texture: this.sdfScratch }, { texture: this.sdfTex }, this.dims as [number, number, number]);
      dev.queue.submit([enc.finish()]);
    }
  }

  destroy() { this.seed[0].destroy(); this.seed[1].destroy(); this.sdfTex.destroy(); this.sdfScratch.destroy(); this.uni.destroy(); this.palBuf.destroy(); }
}
