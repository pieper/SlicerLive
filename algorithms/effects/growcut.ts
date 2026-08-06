// GrowCutEffect (A-5) — "Grow from seeds" as a GPU cellular automaton (Vezhnevets & Konouchine 2005),
// the WebGPU-native counterpart to Slicer's GrowCut / vtkFastGrowCut. Sparse multi-label seed scribbles
// (the current master labelmap; label 0 = unseeded) compete outward to fill the volume, an edit weighted
// by intensity similarity so a label spreads freely across a homogeneous region and stalls at an edge.
//
// State per voxel = (label, strength). Seeds start at strength 1. Each iteration every voxel is
// "attacked" by its neighbours: attack = neighbour.strength · g(|I−I_neighbour|), g(d)=max(0,1−d/range);
// the strongest attacker (that beats the voxel's own strength) captures the voxel with its label and
// attack strength. Ping-ponged over two rg32float textures; one compute dispatch per iteration, fully
// parallel — no per-voxel queues. Reads the source IMAGE (intensity-guided, so the effect takes it in);
// writes EditableSegmentation.masterTexture() at the end + markDirty(). No render/ dependency.
import type { Vec3 } from "../geom.ts";
import type { EditableSegmentation } from "../editable-segmentation.ts";

const INIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_dst : texture_storage_3d<rg32float, write>;
struct U { dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(2) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let lbl = textureLoad(t_label, vec3<i32>(gid), 0).r;
  textureStore(t_dst, vec3<i32>(gid), vec4<f32>(f32(lbl), select(0.0, 1.0, lbl != 0u), 0.0, 0.0));   // seed → strength 1
}`;

// One cellular-automaton iteration. 6-connected (face) neighbours: standard growcut, 1 voxel of
// propagation per pass. Attack strength decays with intensity difference (g), so labels flood
// homogeneous tissue and are damped across edges.
const ITER_WGSL = /* wgsl */ `
@group(0) @binding(0) var t_img : texture_3d<f32>;
@group(0) @binding(1) var t_src : texture_3d<f32>;
@group(0) @binding(2) var t_dst : texture_storage_3d<rg32float, write>;
struct U { dims : vec4<u32>, params : vec4<f32> };   // params.x = edgeHi (t1), params.y = 1/(t1-t0)
@group(0) @binding(3) var<uniform> u : U;
fn img(c : vec3<i32>) -> f32 { let d = vec3<i32>(u.dims.xyz); return textureLoad(t_img, clamp(c, vec3<i32>(0), d - vec3<i32>(1)), 0).r; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let st = textureLoad(t_src, c, 0);   // (label, strength)
  var bestLabel = st.r;
  var bestStr = st.g;
  let myI = img(c);
  let t1 = u.params.x; let invSpan = u.params.y;
  let offs = array<vec3<i32>, 6>(vec3<i32>(1,0,0), vec3<i32>(-1,0,0), vec3<i32>(0,1,0), vec3<i32>(0,-1,0), vec3<i32>(0,0,1), vec3<i32>(0,0,-1));
  for (var i = 0; i < 6; i = i + 1) {
    let nc = c + offs[i];
    if (any(nc < vec3<i32>(0)) || any(nc >= vec3<i32>(u.dims.xyz))) { continue; }
    let ns = textureLoad(t_src, nc, 0);
    if (ns.g <= 0.0) { continue; }
    // THRESHOLDED similarity: g=1 below the noise floor t0 (no decay inside a region), →0 at the edge
    // contrast t1. Lets a label flood homogeneous tissue and stall at a boundary — robust to noise,
    // unlike the raw 1−d/range which decays every step and can't cross a large homogeneous region.
    let g = clamp((t1 - abs(myI - img(nc))) * invSpan, 0.0, 1.0);
    let attack = ns.g * g;
    if (attack > bestStr) { bestStr = attack; bestLabel = ns.r; }
  }
  textureStore(t_dst, c, vec4<f32>(bestLabel, bestStr, 0.0, 0.0));
}`;

const FINAL_WGSL = /* wgsl */ `
@group(0) @binding(0) var t_src : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<r32uint, write>;
struct U { dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(2) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let lbl = u32(textureLoad(t_src, vec3<i32>(gid), 0).r + 0.5);
  textureStore(t_out, vec3<i32>(gid), vec4<u32>(lbl, 0u, 0u, 0u));
}`;

export interface GrowCutOpts {
  /** Max CA iterations (each = 1 voxel of propagation for the 6-neighbour rule). Default fills the grid.
   *  Convergence is checked every `checkEvery` iterations via a change count so it stops early. */
  iterations?: number;
  /** Intensity range (max−min) for the similarity thresholds. Default = measured from the image. */
  intensityRange?: number;
  /** Noise floor as a fraction of range: below this intensity difference, neighbours count as the SAME
   *  region (g=1, no strength decay). Default 0.15. */
  edgeLo?: number;
  /** Edge contrast as a fraction of range: above this difference, neighbours are a boundary (g=0).
   *  Default 0.5. */
  edgeHi?: number;
  /** Convergence poll interval (iterations). 0 disables early stop. Default 16. */
  checkEvery?: number;
}

export class GrowCutEffect {
  private dev: GPUDevice;
  private initPipe: GPUComputePipeline;
  private iterPipe: GPUComputePipeline;
  private finalPipe: GPUComputePipeline;
  private a: GPUTexture;
  private b: GPUTexture;
  private uni: GPUBuffer;
  private g: [number, number, number];

  /** `imageTex` is the r32float intensity volume aligned to the segmentation grid (same dims/ijkToRAS). */
  constructor(private seg: EditableSegmentation, private imageTex: GPUTexture) {
    const dev = seg.device;
    this.dev = dev;
    const mk = (code: string) => dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code }), entryPoint: "main" } });
    this.initPipe = mk(INIT_WGSL);
    this.iterPipe = mk(ITER_WGSL);
    this.finalPipe = mk(FINAL_WGSL);
    const state = () => dev.createTexture({ size: seg.dims as [number, number, number], dimension: "3d", format: "rg32float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });   // COPY_SRC: filledCount readback
    this.a = state();
    this.b = state();
    this.uni = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // uvec4 dims + vec4 params
    const [dx, dy, dz] = seg.dims;
    this.g = [Math.ceil(dx / 4), Math.ceil(dy / 4), Math.ceil(dz / 4)];
  }

  private writeUni(t1: number, invSpan: number) {
    const ab = new ArrayBuffer(32);
    const u = new Uint32Array(ab), f = new Float32Array(ab);
    u[0] = this.seg.dims[0]; u[1] = this.seg.dims[1]; u[2] = this.seg.dims[2]; u[3] = 0;
    f[4] = t1; f[5] = invSpan; f[6] = 0; f[7] = 0;
    this.dev.queue.writeBuffer(this.uni, 0, ab);
  }

  private pass(pipe: GPUComputePipeline, entries: GPUBindGroupEntry[]) {
    const enc = this.dev.createCommandEncoder();
    const p = enc.beginComputePass();
    p.setPipeline(pipe); p.setBindGroup(0, this.dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries })); p.dispatchWorkgroups(...this.g); p.end();
    this.dev.queue.submit([enc.finish()]);
  }

  /** Grow the current sparse seed labelmap to fill the volume, writing the dense result back to the
   *  master. Returns the iterations actually run (early-stops at convergence). */
  async grow(opts: GrowCutOpts = {}): Promise<number> {
    const dims = this.seg.dims;
    const range = opts.intensityRange ?? await this.imageRange();
    const t0 = (opts.edgeLo ?? 0.15) * range, t1 = (opts.edgeHi ?? 0.5) * range;
    this.writeUni(t1, 1 / Math.max(t1 - t0, 1e-6));
    const maxIter = opts.iterations ?? Math.ceil(Math.max(...dims) * 1.2);
    const checkEvery = opts.checkEvery ?? 16;

    // init master → state A
    this.pass(this.initPipe, [
      { binding: 0, resource: this.seg.masterTexture().createView() },
      { binding: 1, resource: this.a.createView() },
      { binding: 2, resource: { buffer: this.uni } },
    ]);

    let src = this.a, dst = this.b, ran = 0;
    for (let i = 0; i < maxIter; i++) {
      this.pass(this.iterPipe, [
        { binding: 0, resource: this.imageTex.createView() },
        { binding: 1, resource: src.createView() },
        { binding: 2, resource: dst.createView() },
        { binding: 3, resource: { buffer: this.uni } },
      ]);
      [src, dst] = [dst, src];
      ran++;
      if (checkEvery > 0 && (i + 1) % checkEvery === 0) {
        const filled = await this.filledCount(src);
        if (filled === this.lastFilled) break;   // no new voxels captured → converged
        this.lastFilled = filled;
      }
    }
    this.lastFilled = -1;

    // state → master
    this.pass(this.finalPipe, [
      { binding: 0, resource: src.createView() },
      { binding: 1, resource: this.seg.masterTexture().createView() },
      { binding: 2, resource: { buffer: this.uni } },
    ]);
    this.seg.markDirty();
    return ran;
  }

  private lastFilled = -1;
  /** Count labelled voxels in a state texture (readback of the label channel) — for convergence + tests. */
  private async filledCount(state: GPUTexture): Promise<number> {
    const [dx, dy, dz] = this.seg.dims;
    const bpr = Math.ceil((dx * 8) / 256) * 256;   // rg32float = 8 B/voxel
    const rowF = bpr / 4;
    const buf = this.dev.createBuffer({ size: bpr * dy * dz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: state }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: dy }, [dx, dy, dz]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange());
    let n = 0;
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++) if (f[(z * dy + y) * rowF + x * 2] > 0.5) n++;
    buf.unmap(); buf.destroy();
    return n;
  }

  /** Image intensity range (max−min) for the default similarity scale. */
  private async imageRange(): Promise<number> {
    const [dx, dy, dz] = this.seg.dims;
    const bpr = Math.ceil((dx * 4) / 256) * 256;   // r32float = 4 B/voxel
    const rowF = bpr / 4;
    const buf = this.dev.createBuffer({ size: bpr * dy * dz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.imageTex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: dy }, [dx, dy, dz]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange());
    let mn = Infinity, mx = -Infinity;
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++) { const v = f[(z * dy + y) * rowF + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
    buf.unmap(); buf.destroy();
    return mx - mn;
  }

  destroy() { this.a.destroy(); this.b.destroy(); this.uni.destroy(); }
}

/** Upload a scalar volume (any TypedArray) to an r32float 3D texture aligned to a segmentation grid —
 *  the source image growcut needs. */
export function uploadImage(dev: GPUDevice, data: ArrayLike<number>, dims: Vec3): GPUTexture {
  const [dx, dy, dz] = dims;
  const tex = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });   // COPY_SRC: imageRange readback
  const f = data instanceof Float32Array ? data : Float32Array.from(data);
  dev.queue.writeTexture({ texture: tex }, f, { bytesPerRow: dx * 4, rowsPerImage: dy }, dims as [number, number, number]);
  return tex;
}
