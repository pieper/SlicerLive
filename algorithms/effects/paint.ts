// PaintEffect (A-1a) — the Paint/Erase brush: rasterizes a stroke (a sampled RAS polyline + a
// spherical brush) into the master labelmap on-GPU, INTERPOLATING between samples so a fast drag with
// sparse points paints one continuous tube (not disconnected blobs). One compute dispatch per stroke
// call: each voxel takes the min distance to the polyline; within the brush radius it writes the
// segment id (add) or 0 (remove). A single point is a sphere (Slicer's dab); two points is a capsule
// (swept sphere) — the same primitive covers a click, a dab, and an incremental drag segment.
//
// Incremental real-time apply (the A-1 requirement): the driver calls stampStroke([prev, next]) per
// pointer move — a 2-point capsule that welds onto what's already painted (add is idempotent). No
// waiting for mouse-up. This lives in `algorithms/`; it writes EditableSegmentation.masterTexture()
// and calls markDirty() — no render/ dependency.
import { transpose4, type Vec3 } from "../geom.ts";
import type { EditableSegmentation } from "../editable-segmentation.ts";

export type PaintMode = "add" | "remove";

export interface StrokeOpts {
  radiusMm: number;        // brush radius (= diameterMm / 2)
  id?: number;             // segment id to write (default 1)
  mode?: PaintMode;        // add (write id) or remove (write 0). default add
}

// Brush = a swept-sphere over the polyline. `params` = (radiusMm, id, mode[0=add,1=remove], count).
// Points ride in a storage buffer as vec4 (xyz RAS + pad). One dispatch over the whole grid; the
// min-distance-to-polyline test is the interpolation (the capsule between consecutive samples).
const PAINT_WGSL = /* wgsl */ `
struct U {
  ijkToRAS : mat4x4<f32>,   // column-major (transpose of the row-major host matrix)
  dims     : vec4<u32>,
  params   : vec4<f32>,     // x=radiusMm, y=id, z=mode(0 add/1 remove), w=pointCount
};
@group(0) @binding(0) var t_label : texture_storage_3d<r32uint, write>;
@group(0) @binding(1) var<uniform> u : U;
@group(0) @binding(2) var<storage, read> pts : array<vec4<f32>>;   // xyz = RAS sample points

fn seg_dist(p : vec3<f32>, a : vec3<f32>, b : vec3<f32>) -> f32 {
  let ab = b - a;
  let denom = max(dot(ab, ab), 1e-8);
  let t = clamp(dot(p - a, ab) / denom, 0.0, 1.0);
  return length(p - (a + t * ab));
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let n = u32(u.params.w);
  if (n == 0u) { return; }
  var dmin = 1e30;
  if (n == 1u) {
    dmin = length(p - pts[0].xyz);
  } else {
    for (var i = 0u; i < n - 1u; i = i + 1u) {
      dmin = min(dmin, seg_dist(p, pts[i].xyz, pts[i + 1u].xyz));
    }
  }
  if (dmin <= u.params.x) {
    let id = select(u32(u.params.y), 0u, u.params.z > 0.5);   // remove → 0
    textureStore(t_label, vec3<i32>(gid), vec4<u32>(id, 0u, 0u, 0u));
  }
}`;

export class PaintEffect {
  private dev: GPUDevice;
  private pipe: GPUComputePipeline;
  private uni: GPUBuffer;
  private ptsBuf?: GPUBuffer;
  private ptsCap = 0;

  constructor(private seg: EditableSegmentation) {
    const dev = seg.device;
    this.dev = dev;
    this.pipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: PAINT_WGSL }), entryPoint: "main" } });
    // mat4(64) + uvec4(16) + vec4(16) = 96 bytes.
    this.uni = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Rasterize a stroke (RAS polyline + spherical brush) into the master, interpolating between
   *  samples, then mark the segmentation dirty (one redraw). A single point = a sphere dab. */
  stampStroke(points: Vec3[], opts: StrokeOpts) {
    if (points.length === 0) return;
    const dev = this.dev, dims = this.seg.dims;

    // Points → storage buffer (vec4 per point). Grow the buffer as needed; reuse across calls.
    const need = points.length * 4 * 4;
    if (!this.ptsBuf || this.ptsCap < points.length) {
      this.ptsBuf?.destroy();
      this.ptsCap = Math.max(points.length, 64);
      this.ptsBuf = dev.createBuffer({ size: this.ptsCap * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    const pd = new Float32Array(points.length * 4);
    for (let i = 0; i < points.length; i++) { pd[i * 4] = points[i][0]; pd[i * 4 + 1] = points[i][1]; pd[i * 4 + 2] = points[i][2]; }
    dev.queue.writeBuffer(this.ptsBuf, 0, pd, 0, points.length * 4);

    const ab = new ArrayBuffer(96);
    const f = new Float32Array(ab), uu = new Uint32Array(ab);
    f.set(transpose4(this.seg.ijkToRAS), 0);
    uu[16] = dims[0]; uu[17] = dims[1]; uu[18] = dims[2]; uu[19] = 0;
    f[20] = opts.radiusMm; f[21] = opts.id ?? 1; f[22] = opts.mode === "remove" ? 1 : 0; f[23] = points.length;
    dev.queue.writeBuffer(this.uni, 0, ab);

    const bind = dev.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seg.masterTexture().createView() },
      { binding: 1, resource: { buffer: this.uni } },
      { binding: 2, resource: { buffer: this.ptsBuf, size: need } },
    ] });
    const [gx, gy, gz] = [Math.ceil(dims[0] / 4), Math.ceil(dims[1] / 4), Math.ceil(dims[2] / 4)];
    const enc = dev.createCommandEncoder();
    const p = enc.beginComputePass(); p.setPipeline(this.pipe); p.setBindGroup(0, bind); p.dispatchWorkgroups(gx, gy, gz); p.end();
    dev.queue.submit([enc.finish()]);

    this.seg.markDirty();
  }

  /** Incremental segment: weld a capsule from `prev` to `next` (one pointer move). */
  extend(prev: Vec3, next: Vec3, opts: StrokeOpts) { this.stampStroke([prev, next], opts); }

  destroy() { this.uni.destroy(); this.ptsBuf?.destroy(); }
}
