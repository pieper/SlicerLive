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
//
// WHAT THE SMOOTHING CONTROL DOES (outer mode): it is NOT applied to this distance field. The attr
// texture's .b carries the labelmap's 0/1 indicator, low-passed by the same separable Gaussian at the
// caller's σ, and the renderer takes the surface to be the p = 0.5 level set of THAT — a band-limited
// rendition of the labels, with σ the reconstruction width. The JFA distance stays sharp and is used
// for the sphere-trace skip horizon and to flood each region's colour/opacity across the shell band.

import { transpose4, type Vec3 } from "./mat4.ts";

// U: ijkToRAS(64) + dims(16) + params(16). params.x = jfa step (voxels).
// Seeds store (RAS.xyz, regionLabel): a boundary voxel's REGION LABEL (its own if inside, else its
// inside neighbour's) so the flood carries per-label colour along with distance. w>0.5 = valid seed.
const INIT_WGSL = /* wgsl */ `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32>, origin : vec4<i32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
// PADDED SDF GRID: the seed/SDF textures are LARGER than the labelmap by 'pad' voxels on every side
// (dims.w). Coord c is a padded-grid coord; the label lives at c-pad, and everything outside the label
// range is background (0). This gives a real spatial margin of background BEYOND the segmentation, so
// a segment touching the labelmap edge closes as a genuine capped surface with room for the SDF to go
// positive — and gradient/finite-difference samples near that cap stay in-bounds (they read real
// background) instead of hitting the out-of-volume cull sentinel, which used to poison the normal.
fn labelAt(c : vec3<i32>) -> u32 {
  let pad = i32(u.dims.w);
  let ld = vec3<i32>(u.dims.xyz) - vec3<i32>(2 * pad);   // label dims = padded dims - 2·pad
  let lc = c - vec3<i32>(pad);
  if (any(lc < vec3<i32>(0)) || any(lc >= ld)) { return 0u; }
  return textureLoad(t_label, lc, 0).r;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;   // region-limited dispatch offsets into the grid
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let my = labelAt(c);
  let meIn = my != 0u;
  let allMode = u.params.y > 0.5;                   // 0 = outer boundary only; 1 = ANY label change (multi-material interfaces)
  var boundary = false;
  var region = my;                                  // inside voxel → own label
  let offs = array<vec3<i32>, 6>(vec3<i32>(1,0,0), vec3<i32>(-1,0,0), vec3<i32>(0,1,0), vec3<i32>(0,-1,0), vec3<i32>(0,0,1), vec3<i32>(0,0,-1));
  for (var i = 0; i < 6; i = i + 1) {
    let nl = labelAt(c + offs[i]);
    // outer mode: boundary at inside↔outside (segment↔background). all mode: boundary at ANY label change
    // (segment↔background AND segment↔segment) so embedded/nested structures get an interface shell too.
    let isChange = select((nl != 0u) != meIn, nl != my, allMode);
    // outer: a background boundary voxel adopts the neighbour's label (so the outer shell renders on both
    // sides). all: every voxel keeps its OWN label (background stays 0 = transparent), so the region
    // COLOUR changes across EVERY interface — including the outer one — which the shader's on-the-fly
    // re-signing needs to recover a clean inside/outside normal there too.
    if (isChange) { boundary = true; if (my == 0u && !allMode) { region = nl; } }
  }
  var seed = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (boundary) { seed = vec4<f32>((u.ijkToRAS * vec4<f32>(vec3<f32>(c), 1.0)).xyz, f32(region)); }
  textureStore(t_seed_out, c, seed);
}`;

const JFA_WGSL = /* wgsl */ `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32>, origin : vec4<i32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;   // region-limited dispatch offsets into the grid
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(c), 1.0)).xyz;
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
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32>, origin : vec4<i32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_label : texture_3d<u32>;
@group(0) @binding(2) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> u : U;
@group(0) @binding(4) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(5) var t_attr : texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var<uniform> u_mode : array<vec4<f32>, 256>;   // .x = shading mode (0 surface, 1 volume)
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;   // region-limited dispatch offsets into the grid
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(c), 1.0)).xyz;
  let s = textureLoad(t_seed_in, c, 0);
  let valid = s.w > 0.5;
  let dist = select(1e3, distance(p, s.xyz), valid);
  let pad = i32(u.dims.w);                                       // label is offset by pad; pad region = background (outside)
  let lc = c - vec3<i32>(pad);
  let ld = vec3<i32>(u.dims.xyz) - vec3<i32>(2 * pad);
  let inRange = all(lc >= vec3<i32>(0)) && all(lc < ld);
  let ins = inRange && textureLoad(t_label, lc, 0).r != 0u;
  // outer mode: SIGNED (neg inside the union) — smooth zero-crossing = clean normals. all mode:
  // UNSIGNED distance to the nearest interface (every label change is a wall; no global inside/outside).
  let sdf = select(select(dist, -dist, ins), dist, u.params.y > 0.5);
  let lbl = u32(s.w + 0.5) & 255u;
  let pal = select(vec4<f32>(0.0), u_pal[lbl], valid);
  let mode = select(0.0, u_mode[lbl].x, valid);
  // PREMULTIPLIED colour (rgb·opacity): the colour-seam blur then can't bleed a HIDDEN (opacity 0)
  // segment's colour into a visible neighbour — an invisible organ was still tinting the organ it
  // abutted (looked like half-opacity). The shader divides by the per-segment opacity to recover the
  // true colour, so a 0-opacity region contributes nothing to the blend.
  textureStore(t_out, c, vec4<f32>(pal.rgb * pal.a, sdf));
  // .r = opacity, .g = shading mode, .a = CRISP presence (1 inside a real segment, 0 background) —
  // the FULLBLUR carries .a unblurred so the shader can tell a genuine in-segment voxel from one that
  // merely caught BLED colour/opacity outside any segment, and gate the shell to the real edge.
  //
  // .b is the BAND-LIMITED LABEL FIELD, and in outer mode it is what the surface IS. It starts as the
  // crisp 0/1 presence and FULLBLUR low-passes it, so the shader reads p = G_σ * 1(label≠0) and takes
  // the surface to be its p = 0.5 level set. A labelmap is a SAMPLED indicator function: its voxel
  // staircase is ALIASING, not data, and the faithful surface is that indicator reconstructed with a
  // kernel at the grid's Nyquist limit — which is what the smoothing control now sets. Thresholding a
  // BOUNDED field at 0.5 also cannot do what blurring the unbounded SIGNED DISTANCE did (fuse two
  // vertebrae across a disc space): in the middle of a 4-voxel gap p ≈ 2·Φ(-2) ≈ 0.05, nowhere near
  // 0.5, so the gap stays open at every σ in range.
  //
  // Interface ("all") mode keeps the blurred DISTANCE here instead: its field is UNSIGNED (distance to
  // the nearest label change), so a union indicator says nothing about the internal interfaces that
  // mode exists to show, and its normal still comes from the smoothed distance.
  let bchan = select(select(0.0, 1.0, ins), sdf, u.params.y > 0.5);
  textureStore(t_attr, c, vec4<f32>(pal.a, mode, bchan, select(0.0, 1.0, ins)));
}`;

// Separable Gaussian on the SDF's .a (distance) only, carrying .rgb (colour) from the centre tap.
// JFA distance is distance-to-nearest-SEED-VOXEL, so it is piecewise-linear (Voronoi facets) and its
// gradient — the shading normal — is faceted (golf-ball look). A light blur of the distance barely
// moves the zero level set (silhouette stays crisp) but smooths the gradient. The colour is NOT
// blurred, so label seams stay crisp.
const BLUR_WGSL = /* wgsl */ `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4>, origin : vec4<i32> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
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
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4>, origin : vec4<i32> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
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

// Separable Gaussian on ONLY the attribute texture's .g (shading mode) and .b (the band-limited label
// field in outer mode, the interface distance in "all" mode) — .b is THE GEOMETRY in outer mode, so
// this pass is what band-limits the labelmap; .g needs to transition smoothly for the surface↔volume
// blend. Carries .r (opacity) AND .a
// (presence) UNBLURRED: opacity is PER-SEGMENT, so blurring it across a label boundary drags a
// segment's edge toward its neighbour's opacity — an opaque organ goes half-transparent exactly where
// it abuts a hidden (0-opacity) one. Keeping .r crisp (linear sampling still gives ~1-voxel AA) renders
// each segment's surface at its own opacity regardless of neighbours. .a is the crisp presence bit.
const FULLBLUR_WGSL = /* wgsl */ `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4>, origin : vec4<i32> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var gb = center.gb * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    gb = gb + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).gb
                          + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).gb);
  }
  textureStore(t_out, c, vec4<f32>(center.r, gb.x, gb.y, center.a));
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
  // ONE blur scratch, shared by the colour, distance and attribute blurs. They are the same format
  // and size and blurStage runs them one at a time, so a second copy was 8 B per voxel of pure
  // duplication — 12% of this pipeline, which is the difference between fitting a device and losing
  // it. Named `scratch` rather than per-target so it cannot drift back into two.
  private scratch: GPUTexture;                   // rgba16float blur ping-pong (shared)
  private lastSeed = 0;                          // seed buffer the last sweep finalized from

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
  private pad: number;                            // background margin (voxels) padded around the labelmap
  readonly labelDims: Vec3;                        // original (label) dims, before padding

  // `pad` voxels of background are added on every side so segments touching the labelmap edge get a
  // real cap + in-bounds gradient neighbourhood (docs/ALGORITHMS.md border artifact). The SDF textures,
  // dispatch, seeds, blur and readback all run on the PADDED grid; `dims`/`ijkToRAS` become the padded
  // grid's, and `sdfDims()`/`sdfIjkToRAS()` expose them to the SegmentField.
  private bmode: number;                          // 0 = outer boundary (signed); 1 = any label change (unsigned, multi-material)

  constructor(dev: GPUDevice, private labelTex: GPUTexture, private dims: Vec3, private ijkToRAS: number[], smoothSigmaVoxels = 1.0, pad = 2, boundaryMode: "outer" | "all" = "outer") {
    this.dev = dev;
    this.smoothSigma = smoothSigmaVoxels;
    this.bmode = boundaryMode === "all" ? 1 : 0;
    this.pad = pad;
    this.labelDims = [dims[0], dims[1], dims[2]];
    // Grow the grid, and shift the ijkToRAS origin so padded voxel (pad,pad,pad) still maps to the RAS
    // of original voxel (0,0,0): newOrigin = origin - M₃ₓ₃·(pad,pad,pad).
    this.dims = [dims[0] + 2 * pad, dims[1] + 2 * pad, dims[2] + 2 * pad];
    const m = ijkToRAS.slice();
    for (let r = 0; r < 3; r++) m[r * 4 + 3] -= pad * (m[r * 4] + m[r * 4 + 1] + m[r * 4 + 2]);
    this.ijkToRAS = m;
    const [dx, dy, dz] = this.dims;
    const mk = (fmt: GPUTextureFormat, extra = 0) => dev.createTexture({ size: this.dims as [number, number, number], dimension: "3d", format: fmt, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | extra });
    // COPY usages: refineRegion() makes the ping-pong pair consistent with a texture copy
    // before region-limited passes.
    const seedUsage = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.seed = [mk("rgba32float", seedUsage), mk("rgba32float", seedUsage)];
    this.sdfTex = mk("rgba16float", GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC);   // blur copies in; readDistance copies out
    this.attrTex = mk("rgba16float", GPUTextureUsage.COPY_DST);  // .r opacity, .g mode; seam-blurred in refine
    this.scratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.uni = dev.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

  /** GPU bytes this baker holds, and what it WOULD hold for a given label grid.
   *
   *  The JFA is the memory-hungry part of the pipeline by a wide margin: the seed ping-pong is two
   *  rgba32float volumes (32 B/voxel between them) and there are four more rgba16float volumes
   *  (sdf, attr, and a scratch for each). On the PADDED grid that is 68 B per voxel including the
   *  r32uint master the caller owns — so a 250³ grid is 1.06 GB, per segmentation. Two of them side
   *  by side is how a comparison view walks off the end of a laptop's VRAM: the device is lost and
   *  the canvas goes white, with no error a user can act on. Callers size their grid against this
   *  (see render/gpu-budget.ts) instead of finding out the hard way. */
  static bytesPerVoxel(): number {
    return 2 * 16    // seed ping-pong, rgba32float
      + 8             // sdfTex, rgba16float
      + 8             // attrTex, rgba16float
      + 8             // ONE shared blur scratch, rgba16float
      + 4;            // the r32uint master the EditableSegmentation owns
  }
  /** Bytes for a label grid of `dims` once padded by `pad` voxels on every side. */
  static estimateBytes(dims: Vec3, pad = 2): number {
    const n = (dims[0] + 2 * pad) * (dims[1] + 2 * pad) * (dims[2] + 2 * pad);
    return n * JfaSdfBaker.bytesPerVoxel();
  }
  /** Bytes this instance actually holds. */
  byteSize(): number {
    const n = this.dims[0] * this.dims[1] * this.dims[2];
    return n * JfaSdfBaker.bytesPerVoxel();
  }

  /** The resident colorized-SDF texture (rgba16float: .rgb = per-label colour, .a = signed mm).
   *  Identity stable across bakes → the SceneRenderer bind group stays valid; a live edit updates in
   *  place. */
  sdfTexture(): GPUTexture { return this.sdfTex; }

  /** The resident per-segment attribute texture (rgba16float; .r = opacity). Identity stable. */
  attrTexture(): GPUTexture { return this.attrTex; }

  /** The PADDED grid the SDF/attr textures live on (labelDims + 2·pad), and the ijkToRAS that maps it
   *  to RAS — hand these to the SegmentField so its patient→texture transform covers the padded extent. */
  sdfDims(): Vec3 { return this.dims; }
  sdfIjkToRAS(): number[] { return this.ijkToRAS; }
  /** Background margin (voxels) padded on each side; readDistance() is on the padded grid, so a label
   *  voxel (x,y,z) is at padded (x+pad, y+pad, z+pad). */
  padVoxels(): number { return this.pad; }

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

  private writeUni(step: number, origin: [number, number, number] = [0, 0, 0]) {
    const ab = new ArrayBuffer(112);
    const f = new Float32Array(ab), u = new Uint32Array(ab);
    f.set(transpose4(this.ijkToRAS), 0);
    u[16] = this.dims[0]; u[17] = this.dims[1]; u[18] = this.dims[2]; u[19] = this.pad;   // dims.w = pad (label is offset by pad; pad region = background)
    f[20] = step; f[21] = this.bmode; f[22] = 0; f[23] = 0;   // params.y = boundary mode (0 outer / 1 any-change)
    const i32v = new Int32Array(ab);
    i32v[24] = origin[0]; i32v[25] = origin[1]; i32v[26] = origin[2]; i32v[27] = 0;
    this.dev.queue.writeBuffer(this.uni, 0, ab);
  }

  /** Distance-blur σ, in VOXELS, applied to the signed distance on every bake/refine (0 = none).
   *  The zero level set barely moves, so the silhouette stays where the labelmap put it; what the
   *  blur smooths is the GRADIENT, i.e. the shading normal — which is what turns a voxel-faceted
   *  "golf ball" into a surface. Takes effect on the next bake(); the caller decides when that is,
   *  since a sweep is ~20 compute passes. */
  setSmoothing(sigmaVoxels: number) { this.smoothSigma = Math.max(0, sigmaVoxels); }
  smoothing(): number { return this.smoothSigma; }

  /** σ for the COLOUR-seam blur, which is NOT the geometry σ and must not follow it up.
   *
   *  The seam blur exists for one narrow job: the region colour is flooded per voxel, so the border
   *  between two labels is a voxel staircase in COLOUR even when the surface is smooth. A fraction of
   *  a voxel of blur hides that. Tying it to the geometry σ (it used to be min(1, σ)) meant that
   *  asking for a smoother SURFACE also dissolved the label boundaries — and a boundary is the entire
   *  signal in a comparison view. It showed up worst on the SPINEPS disc layer: a near-white disc
   *  between two saturated vertebra colours, blurred a full voxel, reads as a milky smear over both
   *  bones instead of a disc. Capped well below a voxel, the seam stays a seam. */
  private seamSigma(): number { return Math.min(0.4, this.smoothSigma); }

  /** FAST bake for LIVE editing: plain JFA (approximate) + the attr blur that band-limits the label
   *  field (no colour-seam blur). Cheap, so it keeps up with an in-progress stroke; the colour seams
   *  stay voxel-jagged until the edit settles and refine() runs. */
  bake() { this.sweep([], this.smoothSigma, 0); }

  /** REFINE for a STATIC labelmap (run once the edit settles): JFA+2 extra passes → a near-exact
   *  Voronoi/SDF (fixes the small JFA mistakes near close/overlapping segments) and a colour-seam blur
   *  so neighbouring-label boundaries are smooth, not a voxel staircase. The attr blur stays at the
   *  caller's σ — it is the geometry, not a quality knob. Higher quality lives in the resident
   *  texture, so camera renders stay cheap. */
  refine() { this.sweep([2, 1], this.smoothSigma, this.seamSigma()); }

  /** REGION-LIMITED refine: re-flood ONLY `regionIjk` (padded-grid coords) after a labelmap edit
   *  confined to it — a per-vertebra visibility flip re-bakes a few % of the grid instead of the
   *  whole volume, which is what makes level stepping feel instant. The seed ping-pong pair is
   *  first made consistent with a full-texture copy, so region passes can ping-pong while JFA
   *  taps read valid exterior seeds (surfaces just outside the region flood in correctly).
   *  Exterior distances that referenced a surface REMOVED inside the region go stale, but only
   *  ≫band away from any visible shell — invisible, and the next full sweep cleans them. */
  refineRegion(regionIjk: { lo: [number, number, number]; hi: [number, number, number] }, maxStep = Infinity) {
    const dev = this.dev, [dx, dy, dz] = this.dims;
    const lo: [number, number, number] = [Math.max(0, regionIjk.lo[0]), Math.max(0, regionIjk.lo[1]), Math.max(0, regionIjk.lo[2])];
    const hi: [number, number, number] = [Math.min(dx, regionIjk.hi[0]), Math.min(dy, regionIjk.hi[1]), Math.min(dz, regionIjk.hi[2])];
    const [rx, ry, rz] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if (rx <= 0 || ry <= 0 || rz <= 0) return;
    const g: [number, number, number] = [Math.ceil(rx / 4), Math.ceil(ry / 4), Math.ceil(rz / 4)];
    const region = { lo, hi };
    let src = this.lastSeed;
    let enc = dev.createCommandEncoder();
    enc.copyTextureToTexture({ texture: this.seed[src] }, { texture: this.seed[src ^ 1] }, this.dims as [number, number, number]);
    dev.queue.submit([enc.finish()]);
    // region init → seed[src] (exterior keeps the previous flood — still valid there)
    this.writeUni(0, lo);
    enc = dev.createCommandEncoder();
    {
      const b = dev.createBindGroup({ layout: this.initPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.labelTex.createView() },
        { binding: 1, resource: this.seed[src].createView() },
        { binding: 2, resource: { buffer: this.uni } },
      ] });
      const p = enc.beginComputePass(); p.setPipeline(this.initPipe); p.setBindGroup(0, b); p.dispatchWorkgroups(g[0], g[1], g[2]); p.end();
    }
    dev.queue.submit([enc.finish()]);
    // Region JFA, step schedule capped at `maxStep` — the caller's HALO width, so the flood's taps
    // never reach outside the ring this sweep just re-initialised.
    //
    // Both bounds matter, in opposite directions. Sizing the schedule to the REGION (which is what
    // this did) makes the largest step ~the region extent, so a voxel inside the region whose nearest
    // surface lies OUTSIDE it finds no seed at all, reports 1e3 mm, and the sphere-trace skip leaps
    // straight through whatever is actually there — the shell comes back cut along a flat plane.
    // Letting the schedule run to the FULL GRID fixes that but lets a tap land on a seed from an
    // older bake, pointing at a surface that has since been removed, which walks back in as a phantom
    // over a run of patches. Capping at the halo gives neither: every tap lands on a seed this sweep
    // re-seeded, and a voxel whose nearest surface is beyond the halo honestly has none — the skip
    // refuses to leap on that (see SegmentField.skipWGSL), so the ray marches and still finds it.
    //
    // Measured on spine myeloma/Myel_046, "1 vert": before, one arrow step rendered 3221 lit px
    // against 4994 for the same level reached by a full rebake, and five steps left a whole extra
    // vertebra on screen.
    const steps: number[] = [...this.steps.filter((v) => v <= maxStep), 2, 1];
    for (const step of steps) {
      this.writeUni(step, lo);
      const dst = src ^ 1;
      enc = dev.createCommandEncoder();
      const b = dev.createBindGroup({ layout: this.jfaPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.seed[src].createView() },
        { binding: 1, resource: this.seed[dst].createView() },
        { binding: 2, resource: { buffer: this.uni } },
      ] });
      const p = enc.beginComputePass(); p.setPipeline(this.jfaPipe); p.setBindGroup(0, b); p.dispatchWorkgroups(g[0], g[1], g[2]); p.end();
      dev.queue.submit([enc.finish()]);
      src = dst;
    }
    this.lastSeed = src;
    // region finalize → sdfTex + attrTex, then the refine()-grade seam blurs, region-limited
    this.writeUni(0, lo);
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
    const p = enc.beginComputePass(); p.setPipeline(this.finalPipe); p.setBindGroup(0, bf); p.dispatchWorkgroups(g[0], g[1], g[2]); p.end();
    dev.queue.submit([enc.finish()]);
    // The colour-seam blur is capped well below a voxel (seamSigma): it hides the per-voxel colour
    // staircase at a label boundary without dissolving the boundary itself.
    if (this.seamSigma() > 0) this.blurStage(this.colBlurPipe, this.seamSigma(), this.sdfTex, this.scratch, region);
    if (this.smoothSigma > 0) this.blurStage(this.fullBlurPipe, this.smoothSigma, this.attrTex, this.scratch, region);
  }

  /** ATTR-ONLY rebake for palette/opacity changes (per-segment visibility): the distance field
   *  doesn't move, so re-run ONLY the finalize (from the last sweep's seed) with its sdf writes
   *  routed to the scratch texture (discarded — the blurred resident sdfTex stays pristine) and
   *  re-blur the attributes. ~4 passes instead of the ~20-pass init+JFA+blur sweep, which is
   *  what makes per-vertebra focus switching real-time. */
  rebakeAttr(blurSeams = false, regionIjk?: { lo: [number, number, number]; hi: [number, number, number] }) {
    const dev = this.dev, [dx, dy, dz] = this.dims;
    const region = regionIjk && {
      lo: [Math.max(0, regionIjk.lo[0]), Math.max(0, regionIjk.lo[1]), Math.max(0, regionIjk.lo[2])] as [number, number, number],
      hi: [Math.min(dx, regionIjk.hi[0]), Math.min(dy, regionIjk.hi[1]), Math.min(dz, regionIjk.hi[2])] as [number, number, number],
    };
    const [gx, gy, gz] = region
      ? [Math.ceil((region.hi[0] - region.lo[0]) / 4), Math.ceil((region.hi[1] - region.lo[1]) / 4), Math.ceil((region.hi[2] - region.lo[2]) / 4)]
      : this.g;
    if (region && (gx <= 0 || gy <= 0 || gz <= 0)) return;
    this.writeUni(0, region ? region.lo : [0, 0, 0]);
    const enc = dev.createCommandEncoder();
    const bf = dev.createBindGroup({ layout: this.finalPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seed[this.lastSeed].createView() },
      { binding: 1, resource: this.labelTex.createView() },
      { binding: 2, resource: this.scratch.createView() },   // sdf writes discarded
      { binding: 3, resource: { buffer: this.uni } },
      { binding: 4, resource: { buffer: this.palBuf } },
      { binding: 5, resource: this.attrTex.createView() },
      { binding: 6, resource: { buffer: this.modeBuf } },
    ] });
    const p = enc.beginComputePass(); p.setPipeline(this.finalPipe); p.setBindGroup(0, bf); p.dispatchWorkgroups(gx, gy, gz); p.end();
    dev.queue.submit([enc.finish()]);
    // The attr blur is NOT optional any more: .b is the band-limited field the outer-mode surface is
    // the 0.5 level set OF, so skipping it would snap the geometry back to the raw voxel staircase for
    // the duration of a visibility step and pop smooth again 600 ms later. `blurSeams` now only records
    // the caller's intent (it is ~4 passes either way, and no JFA re-sweep).
    if (this.smoothSigma > 0) this.blurStage(this.fullBlurPipe, this.smoothSigma, this.attrTex, this.scratch, region);
  }

  /** Re-apply the SMOOTHING only: the distance field does not depend on σ, so re-running the JFA
   *  for a smoothing change is both wasteful and WRONG — the fast bake's approximate flood differs
   *  from the refined one by a fraction of a voxel, so the surface visibly shifted back and forth
   *  as the control moved. This re-derives the attributes and the colour from the EXISTING seeds
   *  (so the distance is bit-identical) and re-blurs them at the new σ. */
  resmooth() {
    const dev = this.dev;
    this.writeUni(0, [0, 0, 0]);
    const enc = dev.createCommandEncoder();
    const bf = dev.createBindGroup({ layout: this.finalPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seed[this.lastSeed].createView() },
      { binding: 1, resource: this.labelTex.createView() },
      { binding: 2, resource: this.sdfTex.createView() },     // re-derive colour + the SHARP distance
      { binding: 3, resource: { buffer: this.uni } },
      { binding: 4, resource: { buffer: this.palBuf } },
      { binding: 5, resource: this.attrTex.createView() },
      { binding: 6, resource: { buffer: this.modeBuf } },
    ] });
    const p = enc.beginComputePass(); p.setPipeline(this.finalPipe); p.setBindGroup(0, bf); p.dispatchWorkgroups(this.g[0], this.g[1], this.g[2]); p.end();
    dev.queue.submit([enc.finish()]);
    const seam = this.seamSigma();
    if (seam > 0) this.blurStage(this.colBlurPipe, seam, this.sdfTex, this.scratch);
    if (this.smoothSigma > 0) this.blurStage(this.fullBlurPipe, this.smoothSigma, this.attrTex, this.scratch);
  }

  /** Blur the attribute seams of the CURRENT attr texture in place (no re-finalize) — the
   *  cheapest possible settle after a run of rebakeAttr(false) visibility steps. */
  blurAttrOnly() { if (this.smoothSigma > 0) this.blurStage(this.fullBlurPipe, this.smoothSigma, this.attrTex, this.scratch); }

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

    this.lastSeed = src;   // rebakeAttr() re-finalizes from this seed without re-running JFA
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

    // Attribute blur (band-limits .b — the outer-mode GEOMETRY — and smooths .g), then the colour-seam blur,
    // then (refine only) the attribute-seam blur so opacity + shading-mode transition as smoothly as
    // the colour — removing the jaggies where an opaque surface segment meets a translucent volume one.
    // The smoothing goes to the ATTR texture's .b, NEVER to sdfTex.a.
    //
    // sdfTex.a is an unbounded SIGNED DISTANCE, and blurring one moves its zero crossing outward
    // wherever the field is thin. A 4-voxel disc space between two vertebrae is thin: blurred at
    // σ=1 it goes negative from both sides and closes, so smoothing silently FUSED neighbouring
    // bones. That is a property of smoothing an UNBOUNDED field, not of smoothing as such: attr.b
    // is a BOUNDED 0/1 indicator, whose 0.5 level set cannot cross a gap much wider than 2σ.
    // sdfTex.a stays sharp — it is still what the sphere-trace skip and the colour flood use.
    if (colorSigma > 0) this.blurStage(this.colBlurPipe, colorSigma, this.sdfTex, this.scratch);
    // attr's blur is the SHADING smoothness, so it takes the caller's σ exactly. Flooring it at
    // the colour-seam σ (1.0) made every setting from 0 to 1 render identically — the control
    // did nothing over half its range.
    if (distSigma > 0) this.blurStage(this.fullBlurPipe, distSigma, this.attrTex, this.scratch);
  }

  /** 3 separable Gaussian passes with the given pipeline (which channels it blurs), tex↔scratch,
   *  ending in scratch → copied back to `tex` so its identity stays stable for the renderer. */
  private blurStage(pipe: GPUComputePipeline, sigma: number, tex: GPUTexture, scratch: GPUTexture,
                    region?: { lo: [number, number, number]; hi: [number, number, number] }) {
    const dev = this.dev, [dx, dy, dz] = this.dims;
    const { radius, w } = gaussHalfKernel(sigma);
    const passes: Array<[GPUTexture, GPUTexture, number]> = [[tex, scratch, 0], [scratch, tex, 1], [tex, scratch, 2]];
    const enc = dev.createCommandEncoder();
    // Region-limited: pass i is dispatched over the region expanded by (2-i)·radius, so every
    // tap of the NEXT pass reads freshly-written texels; the final copy restores exactly the
    // region. (The +radius ring pass 2 writes into tex gets an extra partial blur — invisible,
    // and it keeps the scheme to 3 passes.) Full-volume when no region is given.
    let passIdx = 0;
    for (const [srcT, dstT, axis] of passes) {
      const expand = region ? (2 - passIdx) * radius : 0;
      const lo: [number, number, number] = region
        ? [Math.max(0, region.lo[0] - expand), Math.max(0, region.lo[1] - expand), Math.max(0, region.lo[2] - expand)]
        : [0, 0, 0];
      const hi: [number, number, number] = region
        ? [Math.min(dx, region.hi[0] + expand), Math.min(dy, region.hi[1] + expand), Math.min(dz, region.hi[2] + expand)]
        : [dx, dy, dz];
      const ab = new ArrayBuffer(112);
      const u32 = new Uint32Array(ab), f32 = new Float32Array(ab), i32 = new Int32Array(ab);
      u32[0] = dx; u32[1] = dy; u32[2] = dz; u32[4] = axis; u32[5] = radius;
      f32.set(w, 8);   // w starts at byte 32 = float index 8 (dims 16B + axis_r 16B)
      i32[24] = lo[0]; i32[25] = lo[1]; i32[26] = lo[2];
      const ub = dev.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ub, 0, ab);
      const b = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: srcT.createView() },
        { binding: 1, resource: dstT.createView() },
        { binding: 2, resource: { buffer: ub } },
      ] });
      const bp = enc.beginComputePass(); bp.setPipeline(pipe); bp.setBindGroup(0, b);
      bp.dispatchWorkgroups(Math.ceil((hi[0] - lo[0]) / 4), Math.ceil((hi[1] - lo[1]) / 4), Math.ceil((hi[2] - lo[2]) / 4));
      bp.end();
      passIdx++;
    }
    if (region) {
      const sz: [number, number, number] = [region.hi[0] - region.lo[0], region.hi[1] - region.lo[1], region.hi[2] - region.lo[2]];
      enc.copyTextureToTexture({ texture: scratch, origin: region.lo }, { texture: tex, origin: region.lo }, sz);
    } else {
      enc.copyTextureToTexture({ texture: scratch }, { texture: tex }, this.dims as [number, number, number]);
    }
    dev.queue.submit([enc.finish()]);
  }

  destroy() { this.seed[0].destroy(); this.seed[1].destroy(); this.sdfTex.destroy(); this.attrTex.destroy(); this.scratch.destroy(); this.uni.destroy(); this.palBuf.destroy(); this.modeBuf.destroy(); }
}
