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

// Finalize → sdfTex rgba16float (.rgb = nearest region's palette colour, .a = signed distance mm) and
// attrTex rgba16float (.r = that region's per-segment OPACITY = palette alpha). Opacity comes from the
// FLOODED region label, so it's non-zero across the whole ±band shell (not just inside voxels).
const FINAL_WGSL = /* wgsl */ `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_label : texture_3d<u32>;
@group(0) @binding(2) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> u : U;
@group(0) @binding(4) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(5) var t_attr : texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var<uniform> u_mode : array<vec4<f32>, 256>;   // .x = shading mode (0 surface, 1 volume)
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
  let pal = select(vec4<f32>(0.0), u_pal[lbl], valid);
  let mode = select(0.0, u_mode[lbl].x, valid);
  textureStore(t_out, c, vec4<f32>(pal.rgb, sdf));
  textureStore(t_attr, c, vec4<f32>(pal.a, mode, 0.0, 0.0));   // .r = per-segment opacity, .g = shading mode
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

// Separable Gaussian on the .rgb (label colour), carrying .a (distance). Used ONLY in the refinement
// pass: it pre-blends the voxel-quantized colour seams between neighbouring labels so ray-march
// samples get a smooth colour transition instead of a staircase — while the geometry (.a) stays put.
const COLBLUR_WGSL = /* wgsl */ `
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
  var sum = center.rgb * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).rgb
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).rgb);
  }
  textureStore(t_out, c, vec4<f32>(sum, center.a));
}`;

// Separable Gaussian on ALL channels — used to seam-blur the attribute texture (.r opacity, .g
// shading mode) so the surface↔volume / opacity classification transitions as smoothly as the colour
// does, instead of a voxel-quantized (and JFA-approximate) hard edge that reads as jaggies where an
// opaque surface segment meets a translucent volume one.
const FULLBLUR_WGSL = /* wgsl */ `
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
  var sum = textureLoad(t_in, c, 0) * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0)
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0));
  }
  textureStore(t_out, c, sum);
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
  private attrTex: GPUTexture;                   // rgba16float: .r = per-segment opacity, .g = shading mode — sampled by SegmentField
  private attrScratch: GPUTexture;              // rgba16float attr-blur ping-pong
  private sdfScratch: GPUTexture;               // rgba16float blur ping-pong
  private uni: GPUBuffer;
  private palBuf: GPUBuffer;                     // 256 × vec4 label→colour palette (.a = opacity)
  private modeBuf: GPUBuffer;                    // 256 × vec4 label→shading mode (.x = 0 surface / 1 volume)
  private initPipe: GPUComputePipeline;
  private jfaPipe: GPUComputePipeline;
  private finalPipe: GPUComputePipeline;
  private blurPipe: GPUComputePipeline;      // blurs .a (distance), carries .rgb
  private colBlurPipe: GPUComputePipeline;   // blurs .rgb (colour), carries .a
  private fullBlurPipe: GPUComputePipeline;  // blurs all channels — the attr texture (opacity + mode)
  private g: [number, number, number];
  private steps: number[];
  private smoothSigma: number;

  constructor(dev: GPUDevice, private labelTex: GPUTexture, private dims: Vec3, private ijkToRAS: number[], smoothSigmaVoxels = 1.0) {
    this.dev = dev;
    this.smoothSigma = smoothSigmaVoxels;
    const [dx, dy, dz] = dims;
    const mk = (fmt: GPUTextureFormat, extra = 0) => dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: fmt, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | extra });
    this.seed = [mk("rgba32float"), mk("rgba32float")];
    this.sdfTex = mk("rgba16float", GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC);   // blur copies in; readDistance copies out
    this.attrTex = mk("rgba16float", GPUTextureUsage.COPY_DST);  // .r opacity, .g mode; seam-blurred in refine
    this.attrScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.sdfScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.uni = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.palBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.modeBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = (code: string) => dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code }), entryPoint: "main" } });
    this.initPipe = mod(INIT_WGSL);
    this.jfaPipe = mod(JFA_WGSL);
    this.finalPipe = mod(FINAL_WGSL);
    this.blurPipe = mod(BLUR_WGSL);
    this.colBlurPipe = mod(COLBLUR_WGSL);
    this.fullBlurPipe = mod(FULLBLUR_WGSL);
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

  /** The resident per-segment attribute texture (rgba16float; .r = opacity). Identity stable. */
  attrTexture(): GPUTexture { return this.attrTex; }

  /** Read back the per-voxel signed distance (sdfTex .a, mm) to CPU. For accuracy comparison/tests. */
  async readDistance(): Promise<Float32Array> {
    const [dx, dy, dz] = this.dims;
    const bpr = Math.ceil((dx * 8) / 256) * 256;   // rgba16float = 8 bytes/voxel
    const rowU16 = bpr / 2;
    const buf = this.dev.createBuffer({ size: bpr * dy * dz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.sdfTex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: dy }, [dx, dy, dz]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const u16 = new Uint16Array(buf.getMappedRange());
    const h2f = (h: number): number => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const out = new Float32Array(dx * dy * dz);
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++) {
      out[(z * dy + y) * dx + x] = h2f(u16[(z * dy + y) * rowU16 + x * 4 + 3]);
    }
    buf.unmap(); buf.destroy();
    return out;
  }

  /** Set the label→colour palette (256 × rgba f32: rgb = colour, a = opacity). Call before bake(). */
  setPalette(palette: Float32Array) {
    const pal = new Float32Array(256 * 4);
    pal.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.palBuf, 0, pal);
  }

  /** Set the per-label shading mode palette (256 × vec4; .x = 0 surface shell / 1 volume DVR fill). */
  setModePalette(modes: Float32Array) {
    const m = new Float32Array(256 * 4);
    m.set(modes.subarray(0, Math.min(modes.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.modeBuf, 0, m);
  }

  private writeUni(step: number) {
    const ab = new ArrayBuffer(96);
    const f = new Float32Array(ab), u = new Uint32Array(ab);
    f.set(transpose4(this.ijkToRAS), 0);
    u[16] = this.dims[0]; u[17] = this.dims[1]; u[18] = this.dims[2]; u[19] = 0;
    f[20] = step; f[21] = 0; f[22] = 0; f[23] = 0;
    this.dev.queue.writeBuffer(this.uni, 0, ab);
  }

  /** FAST bake for LIVE editing: plain JFA (approximate) + a light distance-only blur (crisp colour
   *  seams). Cheap, so it keeps up with an in-progress stroke; the seams stay voxel-jagged until the
   *  edit settles and refine() runs. */
  bake() { this.sweep([], this.smoothSigma, 0); }

  /** REFINE for a STATIC labelmap (run once the edit settles): JFA+2 extra passes → a near-exact
   *  Voronoi/SDF (fixes the small JFA mistakes near close/overlapping segments) and a colour-seam blur
   *  so neighbouring-label boundaries are smooth, not a voxel staircase. Distance blur stays at the
   *  same σ (dropping it re-introduces Voronoi facets — crispness comes from the render band, not from
   *  under-smoothing). Higher quality lives in the resident texture, so camera renders stay cheap. */
  refine() { this.sweep([2, 1], this.smoothSigma, 1.0); }

  /** One full sweep: init → JFA (schedule + extra) → finalize → blur .a → optional blur .rgb. */
  private sweep(extraSteps: number[], distSigma: number, colorSigma: number) {
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

    // JFA passes (+ optional extra small steps = JFA+N refinement), ping-ponging seed[src] → seed[dst].
    let src = 0;
    for (const step of [...this.steps, ...extraSteps]) {
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
      { binding: 5, resource: this.attrTex.createView() },
      { binding: 6, resource: { buffer: this.modeBuf } },
    ] });
    const p = enc.beginComputePass(); p.setPipeline(this.finalPipe); p.setBindGroup(0, bf); p.dispatchWorkgroups(gx, gy, gz); p.end();
    dev.queue.submit([enc.finish()]);

    // Distance blur (smooths the shading normal; keeps colour crisp), then optional colour-seam blur,
    // then (refine only) the attribute-seam blur so opacity + shading-mode transition as smoothly as
    // the colour — removing the jaggies where an opaque surface segment meets a translucent volume one.
    if (distSigma > 0) this.blurStage(this.blurPipe, distSigma, this.sdfTex, this.sdfScratch);
    if (colorSigma > 0) this.blurStage(this.colBlurPipe, colorSigma, this.sdfTex, this.sdfScratch);
    if (colorSigma > 0) this.blurStage(this.fullBlurPipe, colorSigma, this.attrTex, this.attrScratch);
  }

  /** 3 separable Gaussian passes with the given pipeline (which channels it blurs), tex↔scratch,
   *  ending in scratch → copied back to `tex` so its identity stays stable for the renderer. */
  private blurStage(pipe: GPUComputePipeline, sigma: number, tex: GPUTexture, scratch: GPUTexture) {
    const dev = this.dev, [gx, gy, gz] = this.g, [dx, dy, dz] = this.dims;
    const { radius, w } = gaussHalfKernel(sigma);
    const passes: Array<[GPUTexture, GPUTexture, number]> = [[tex, scratch, 0], [scratch, tex, 1], [tex, scratch, 2]];
    const enc = dev.createCommandEncoder();
    for (const [srcT, dstT, axis] of passes) {
      const ab = new ArrayBuffer(96);
      const u32 = new Uint32Array(ab), f32 = new Float32Array(ab);
      u32[0] = dx; u32[1] = dy; u32[2] = dz; u32[4] = axis; u32[5] = radius;
      f32.set(w, 8);   // w starts at byte 32 = float index 8 (dims 16B + axis_r 16B)
      const ub = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ub, 0, ab);
      const b = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: srcT.createView() },
        { binding: 1, resource: dstT.createView() },
        { binding: 2, resource: { buffer: ub } },
      ] });
      const bp = enc.beginComputePass(); bp.setPipeline(pipe); bp.setBindGroup(0, b); bp.dispatchWorkgroups(gx, gy, gz); bp.end();
    }
    enc.copyTextureToTexture({ texture: scratch }, { texture: tex }, this.dims as [number, number, number]);
    dev.queue.submit([enc.finish()]);
  }

  destroy() { this.seed[0].destroy(); this.seed[1].destroy(); this.sdfTex.destroy(); this.attrTex.destroy(); this.attrScratch.destroy(); this.sdfScratch.destroy(); this.uni.destroy(); this.palBuf.destroy(); this.modeBuf.destroy(); }
}
