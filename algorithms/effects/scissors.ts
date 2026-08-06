// ScissorsEffect (A-3) — the WebGPU-native Scissors: a closed 2D contour drawn on a slice view carves
// the labelmap in 3D. "Through-plane" = the contour is extruded along the view normal across the whole
// volume (Slicer's unlimited-thickness scissors); a voxel is affected when its projection onto the view
// plane lies inside the polygon. One compute dispatch: per voxel, project RAS→(u,v), even-odd
// point-in-polygon, then fill inside / erase inside / erase outside. Writes EditableSegmentation +
// markDirty; no render/ dependency. (A slab-limited variant adds a distance-along-normal gate later.)
import { transpose4, type Vec3 } from "../geom.ts";
import type { EditableSegmentation } from "../editable-segmentation.ts";

export type ScissorsOp = "fillInside" | "eraseInside" | "eraseOutside";

export interface ScissorsOpts {
  /** View-plane basis: the two in-plane axes the contour lives in (e.g. axial → u=R, v=A). The polygon
   *  is extruded along u×v (the view normal). */
  u: Vec3;
  v: Vec3;
  operation?: ScissorsOp;   // default eraseInside (Slicer's default scissors action)
  id?: number;              // segment id for fillInside (default 1)
}

const SCISSORS_WGSL = /* wgsl */ `
struct U {
  ijkToRAS : mat4x4<f32>,    // column-major
  uAxis    : vec4<f32>,      // in-plane basis (xyz)
  vAxis    : vec4<f32>,
  dims     : vec4<u32>,
  params   : vec4<f32>,      // x=vertexCount, y=id, z=op(0 fillInside/1 eraseInside/2 eraseOutside)
};
@group(0) @binding(0) var t_label : texture_storage_3d<r32uint, write>;
@group(0) @binding(1) var<uniform> u : U;
@group(0) @binding(2) var<storage, read> poly : array<vec2<f32>>;   // contour projected to (u,v)

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let q = vec2<f32>(dot(p, u.uAxis.xyz), dot(p, u.vAxis.xyz));   // project the voxel onto the view plane
  let n = u32(u.params.x);
  if (n < 3u) { return; }
  // even-odd (crossing-number) point-in-polygon on the projected contour.
  var inside = false;
  var j = n - 1u;
  for (var i = 0u; i < n; i = i + 1u) {
    let a = poly[i]; let b = poly[j];
    if ((a.y > q.y) != (b.y > q.y)) {
      let xcross = (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x;
      if (q.x < xcross) { inside = !inside; }
    }
    j = i;
  }
  let op = u.params.z;
  let affected = select(inside, !inside, op > 1.5);        // eraseOutside acts where NOT inside
  if (affected) {
    let val = select(0u, u32(u.params.y), op < 0.5);       // fillInside → id; erase → 0
    textureStore(t_label, vec3<i32>(gid), vec4<u32>(val, 0u, 0u, 0u));
  }
}`;

export class ScissorsEffect {
  private dev: GPUDevice;
  private pipe: GPUComputePipeline;
  private uni: GPUBuffer;
  private polyBuf?: GPUBuffer;
  private polyCap = 0;

  constructor(private seg: EditableSegmentation) {
    const dev = seg.device;
    this.dev = dev;
    this.pipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: SCISSORS_WGSL }), entryPoint: "main" } });
    this.uni = dev.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // mat4(64)+2×vec4(32)+uvec4(16)+vec4(16)
  }

  /** Carve the labelmap with a closed RAS contour on the (u,v) view plane, then mark dirty. */
  apply(contourRAS: Vec3[], opts: ScissorsOpts) {
    if (contourRAS.length < 3) return;
    const dev = this.dev, dims = this.seg.dims;
    const [u, v] = [opts.u, opts.v];
    // Project the contour to (u,v) on the CPU (the same projection the shader applies to voxels).
    const proj = new Float32Array(contourRAS.length * 2);
    for (let i = 0; i < contourRAS.length; i++) {
      const p = contourRAS[i];
      proj[i * 2] = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
      proj[i * 2 + 1] = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
    }
    const need = contourRAS.length * 8;
    if (!this.polyBuf || this.polyCap < contourRAS.length) {
      this.polyBuf?.destroy();
      this.polyCap = Math.max(contourRAS.length, 64);
      this.polyBuf = dev.createBuffer({ size: this.polyCap * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    dev.queue.writeBuffer(this.polyBuf, 0, proj);

    const op = opts.operation ?? "eraseInside";
    const ab = new ArrayBuffer(128);
    const f = new Float32Array(ab), uu = new Uint32Array(ab);
    f.set(transpose4(this.seg.ijkToRAS), 0);
    f[16] = u[0]; f[17] = u[1]; f[18] = u[2]; f[19] = 0;
    f[20] = v[0]; f[21] = v[1]; f[22] = v[2]; f[23] = 0;
    uu[24] = dims[0]; uu[25] = dims[1]; uu[26] = dims[2]; uu[27] = 0;
    f[28] = contourRAS.length; f[29] = opts.id ?? 1; f[30] = op === "fillInside" ? 0 : op === "eraseInside" ? 1 : 2; f[31] = 0;
    dev.queue.writeBuffer(this.uni, 0, ab);

    const bind = dev.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seg.masterTexture().createView() },
      { binding: 1, resource: { buffer: this.uni } },
      { binding: 2, resource: { buffer: this.polyBuf, size: need } },
    ] });
    const [gx, gy, gz] = [Math.ceil(dims[0] / 4), Math.ceil(dims[1] / 4), Math.ceil(dims[2] / 4)];
    const enc = dev.createCommandEncoder();
    const p = enc.beginComputePass(); p.setPipeline(this.pipe); p.setBindGroup(0, bind); p.dispatchWorkgroups(gx, gy, gz); p.end();
    dev.queue.submit([enc.finish()]);
    this.seg.markDirty();
  }

  destroy() { this.uni.destroy(); this.polyBuf?.destroy(); }
}
