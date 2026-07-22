// SceneRenderer — composes N fields into one ray-march pipeline. Assigns per-kind
// slots, lays out the material UBO (scene block + per-field blocks), generates WGSL
// (struct + bindings + per-field sampling fns + the dispatch loop), and renders.
// TS/WebGPU port of slicer_wgpu.scene_renderer's build_for_fields.

import type { Gpu } from "./device.ts";
import type { Field } from "./fields.ts";
import { type Mat4, type Vec3, invert, lookAt, multiply, perspectiveZO } from "./mat4.ts";

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const SCENE_FLOATS = 16; // bmin(4) bmax(4) scene(4) bg(4)

interface Placed { field: Field; slot: number; uoff: number; bbase: number }

export class SceneRenderer {
  private dev: GPUDevice;
  private format: GPUTextureFormat;
  private placed: Placed[] = [];
  private pipeline!: GPURenderPipeline;
  private sampler: GPUSampler;
  private camBuf: GPUBuffer;
  private matBuf!: GPUBuffer;
  private mat!: Float32Array;
  private bind!: GPUBindGroup;

  constructor(gpu: Gpu, format: GPUTextureFormat = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.camBuf = this.dev.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** (Re)build the pipeline for a set of fields. */
  build(fields: Field[]) {
    const kindCount: Record<string, number> = {};
    let uoff = SCENE_FLOATS, bbase = 3; // bindings 0=cam,1=mat,2=sampler
    this.placed = fields.map((field) => {
      const slot = kindCount[field.kind] ?? 0;
      kindCount[field.kind] = slot + 1;
      const p: Placed = { field, slot, uoff, bbase };
      uoff += field.uniformFloats();
      bbase += field.bindingCount;
      return p;
    });
    this.mat = new Float32Array(uoff);
    this.matBuf = this.dev.createBuffer({ size: uoff * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.dev.createShaderModule({ code: this.wgsl() }), entryPoint: "vs_main" },
      fragment: { module: this.dev.createShaderModule({ code: this.wgsl() }), entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.camBuf } },
      { binding: 1, resource: { buffer: this.matBuf } },
      { binding: 2, resource: this.sampler },
    ];
    for (const p of this.placed) entries.push(...p.field.bindEntries(p.slot, p.bbase));
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });

    // scene defaults
    this.setBackground(0.07, 0.08, 0.12);
    const step = this.placed.length ? Math.min(...this.placed.map((p) => p.field.sampleStep())) : 1.0;
    this.setSampleStep(step * 0.7); // sub-voxel for smoother integration (anti-banding)
    this.recomputeBounds();
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
  }

  private wgsl(): string {
    const members = this.placed.map((p) => p.field.structMembers(p.slot)).join("\n");
    const decls = this.placed.map((p) => p.field.declareBindings(p.slot, p.bbase)).join("\n");
    const fns = this.placed.map((p) => p.field.samplingWGSL(p.slot)).join("\n");
    const dispatch = this.placed.map((p) => `    { let c = sample_field_${p.field.kind}${p.slot}(wp, rd); sum += c; }`).join("\n");
    return /* wgsl */ `
struct Camera { inv_view_proj : mat4x4<f32>, size : vec4<f32> };
struct Material {
  bmin : vec4<f32>,
  bmax : vec4<f32>,
  scene : vec4<f32>,   // sample_step, _, _, _
  bg : vec4<f32>,
${members}
};
@group(0) @binding(0) var<uniform> u_cam : Camera;
@group(0) @binding(1) var<uniform> u_material : Material;
@group(0) @binding(2) var s_lin : sampler;
${decls}

struct Varyings { @builtin(position) position : vec4<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> Varyings {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : Varyings; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
fn ndc_to_world(ndc : vec4<f32>) -> vec3<f32> { let w = u_cam.inv_view_proj * ndc; return w.xyz / w.w; }
fn ign(p : vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }
${fns}

@fragment
fn fs_main(v : Varyings) -> @location(0) vec4<f32> {
  let size = u_cam.size.xy;
  let ndc_x = (v.position.x / size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.position.y / size.y) * 2.0;
  let ro = ndc_to_world(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(ndc_x, ndc_y, 1.0, 1.0)) - ro);
  let bg = srgb2physical(u_material.bg.rgb);

  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(bg, 1.0); }

  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  if (t_far <= t_near) { return vec4<f32>(bg, 1.0); }
  let seed = ign(v.position.xy);
  var t = t_near;
  var integrated = vec4<f32>(0.0);
  var safety : i32 = 0;
  loop {
    if (t >= t_far || safety >= 5000 || integrated.a >= 0.99) { break; }
    let js = fract(sin(dot(v.position.xy + vec2<f32>(f32(safety) * 0.7548, f32(safety) * 0.5698), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5; // per-(pixel,sample) jitter
    let wp = ro + rd * (t + js * step);
    var sum = vec4<f32>(0.0);
${dispatch}
    if (sum.a > 0.0) { integrated = integrated + (1.0 - integrated.a) * vec4<f32>(sum.rgb, clamp(sum.a, 0.0, 1.0)); }
    t = t + step;
    safety = safety + 1;
  }
  return vec4<f32>(mix(bg, integrated.rgb, integrated.a), 1.0);
}`;
  }

  setBackground(r: number, g: number, b: number) { this.mat[12] = r; this.mat[13] = g; this.mat[14] = b; this.mat[15] = 1; }
  setSampleStep(step: number) { this.mat[8] = step; }

  /** Scene AABB = union of field AABBs; also picks a default sample step from the smallest field extent. */
  recomputeBounds() {
    if (!this.placed.length) return;
    let mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of this.placed) {
      const [a, b] = p.field.aabb();
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], a[i]); mx[i] = Math.max(mx[i], b[i]); }
    }
    this.mat[0] = mn[0]; this.mat[1] = mn[1]; this.mat[2] = mn[2];
    this.mat[4] = mx[0]; this.mat[5] = mx[1]; this.mat[6] = mx[2];
  }

  setCamera(eye: Vec3, center: Vec3, up: Vec3, fovyDeg: number, width: number, height: number) {
    const view = lookAt(eye, center, up);
    const proj = perspectiveZO((fovyDeg * Math.PI) / 180, width / height, 1, 100000);
    const invVP: Mat4 = invert(multiply(proj, view));
    const cam = new Float32Array(20);
    cam.set(invVP, 0); cam[16] = width; cam[17] = height;
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
  }

  private flush() { this.dev.queue.writeBuffer(this.matBuf, 0, this.mat); }

  renderToView(view: GPUTextureView, width: number, height: number) {
    this.flush();
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind); pass.draw(3); pass.end();
    this.dev.queue.submit([enc.finish()]);
  }

  async renderToRGBA(width: number, height: number): Promise<Uint8Array> {
    this.flush();
    const target = this.dev.createTexture({ size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind); pass.draw(3); pass.end();
    const bpr = Math.ceil((width * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }
}
