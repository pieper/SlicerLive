// Stage-1 single-volume DVR — TS/WebGPU port of slicer_wgpu/demos/single_volume.py
// (itself a STEP-derived ray-march). Fullscreen-triangle ray march: ray/AABB slab,
// RAS->texture sampling, VTK-exact opacity-distance correction, gradient (headlight)
// Phong, front-to-back OVER. pygfx's std helpers are replaced by an explicit camera UBO.
//
// Runs identically in the browser and in Deno (same WebGPU API).

import type { Gpu } from "./device.ts";
import { type Mat4, type Vec3, identity, invert, lookAt, multiply, patientToTextureCentered, perspectiveZO } from "./mat4.ts";

// Default offscreen/PNG target; browser canvas passes its (srgb) preferred format.
const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm-srgb"; // auto linear->sRGB on write

const SHADER = /* wgsl */ `
struct Camera {
  inv_view_proj : mat4x4<f32>,
  size          : vec4<f32>,   // physical_size.x, .y, _, _
};
struct Material {
  patient_to_texture : mat4x4<f32>,
  clim               : vec4<f32>,   // lo, hi
  gradient_range     : vec4<f32>,   // gmin, gmax
  bounds_min         : vec4<f32>,
  bounds_max         : vec4<f32>,
  background         : vec4<f32>,   // sRGB rgb, a
  shade              : vec4<f32>,   // k_a, k_d, k_s, shininess
  steps              : vec4<f32>,   // sample_step, opacity_unit_distance, grad_opacity_on, sample_budget
  dither             : vec4<f32>,   // dither_scale, ox, oy, frame_seed
};

@group(0) @binding(0) var<uniform> u_cam : Camera;
@group(0) @binding(1) var<uniform> u_material : Material;
@group(0) @binding(2) var s_lin : sampler;
@group(0) @binding(3) var t_volume : texture_3d<f32>;
@group(0) @binding(4) var t_lut : texture_2d<f32>;
@group(0) @binding(5) var t_grad : texture_2d<f32>;

struct Varyings { @builtin(position) position : vec4<f32> };

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> Varyings {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : Varyings;
  o.position = vec4<f32>(x, y, 0.0, 1.0);
  return o;
}

fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
fn ndc_to_world(ndc : vec4<f32>) -> vec3<f32> {
  let w = u_cam.inv_view_proj * ndc;
  return w.xyz / w.w;
}
fn sample_lut(value : f32) -> vec4<f32> {
  let t = clamp((value - u_material.clim.x) / max(u_material.clim.y - u_material.clim.x, 1e-6), 0.0, 1.0);
  return textureSampleLevel(t_lut, s_lin, vec2<f32>(t, 0.5), 0.0);
}
fn sample_volume_world(wp : vec3<f32>) -> vec2<f32> {
  let tex4 = u_material.patient_to_texture * vec4<f32>(wp, 1.0);
  let tex = tex4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec2<f32>(0.0, 0.0); }
  return vec2<f32>(textureSampleLevel(t_volume, s_lin, tex, 0.0).r, 1.0);
}
fn sample_volume_clamped(wp : vec3<f32>) -> f32 {
  let tex4 = u_material.patient_to_texture * vec4<f32>(wp, 1.0);
  return textureSampleLevel(t_volume, s_lin, clamp(tex4.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).r;
}
fn gradient_world(wp : vec3<f32>, h : f32) -> vec3<f32> {
  let gx = sample_volume_clamped(wp + vec3<f32>(h,0,0)) - sample_volume_clamped(wp - vec3<f32>(h,0,0));
  let gy = sample_volume_clamped(wp + vec3<f32>(0,h,0)) - sample_volume_clamped(wp - vec3<f32>(0,h,0));
  let gz = sample_volume_clamped(wp + vec3<f32>(0,0,h)) - sample_volume_clamped(wp - vec3<f32>(0,0,h));
  return vec3<f32>(gx, gy, gz) / (2.0 * h);
}

@fragment
fn fs_main(v : Varyings) -> @location(0) vec4<f32> {
  let size = u_cam.size.xy;
  let ndc_x = (v.position.x / size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.position.y / size.y) * 2.0;
  let ro = ndc_to_world(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0));   // WebGPU near z=0
  let rd = normalize(ndc_to_world(vec4<f32>(ndc_x, ndc_y, 1.0, 1.0)) - ro);

  let bmin = u_material.bounds_min.xyz;
  let bmax = u_material.bounds_max.xyz;
  let inv = vec3<f32>(1.0) / rd;
  let tb = (bmin - ro) * inv;
  let tt = (bmax - ro) * inv;
  let tmn = min(tt, tb);
  let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  let bg = srgb2physical(u_material.background.rgb);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(bg, 1.0); }

  let step = max(u_material.steps.x, 1e-3);
  let unit = max(u_material.steps.y, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  if (t_far <= t_near) { return vec4<f32>(bg, 1.0); }

  let dpos = v.position.xy * u_material.dither.x + vec2<f32>(u_material.dither.y, u_material.dither.z);
  let seed = fract(sin(dot(vec3<f32>(dpos, 0.0), vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
  var t = t_near + seed * step;

  let k_a = u_material.shade.x; let k_d = u_material.shade.y;
  let k_s = u_material.shade.z; let sh = u_material.shade.w;
  let grad_on = u_material.steps.z;

  var integrated = vec4<f32>(0.0);
  var safety : i32 = 0;
  loop {
    if (t >= t_far || safety >= 5000 || integrated.a >= 0.99) { break; }
    let wp = ro + rd * t;
    let s = sample_volume_world(wp);
    if (s.y > 0.5) {
      let tf = sample_lut(s.x);
      let grad = gradient_world(wp, step);
      let glen = length(grad);
      var opacity = 1.0 - pow(1.0 - clamp(tf.a, 0.0, 1.0), step / unit);
      if (grad_on > 0.5) {
        let gmin = u_material.gradient_range.x;
        let gmax = max(u_material.gradient_range.y, gmin + 1e-6);
        let gn = clamp((glen - gmin) / (gmax - gmin), 0.0, 1.0);
        opacity = opacity * textureSampleLevel(t_grad, s_lin, vec2<f32>(gn, 0.5), 0.0).r;
      }
      opacity = clamp(opacity, 0.0, 1.0);
      if (opacity > 0.001) {
        var lit_srgb = tf.rgb * k_a;
        if (glen > 1e-6) {
          var n = grad / glen;
          if (dot(n, -rd) < 0.0) { n = -n; }
          let view_dir = normalize(ro - wp);
          let ldotn = dot(view_dir, n);      // headlight: light == eye
          if (ldotn > 0.0) {
            let refl = normalize(2.0 * ldotn * n - view_dir);
            let rdotv = max(0.0, dot(refl, view_dir));
            lit_srgb = tf.rgb * (k_a + k_d * ldotn) + vec3<f32>(k_s * pow(rdotv, sh));
          }
        }
        let lit = srgb2physical(clamp(lit_srgb, vec3<f32>(0.0), vec3<f32>(1.0)));
        integrated = integrated + (1.0 - integrated.a) * vec4<f32>(opacity * lit, opacity);
      }
    }
    t = t + step;
    safety = safety + 1;
  }
  let final_linear = mix(bg, integrated.rgb, integrated.a);
  return vec4<f32>(final_linear, 1.0);
}
`;

export interface VolumeSpec {
  data: Float32Array;      // length dx*dy*dz, z-major (index = (z*dy + y)*dx + x)
  dims: Vec3;              // [dx, dy, dz]
  spacing: Vec3;           // mm per voxel [sx, sy, sz]
}

export class VolumeRenderer {
  private dev: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private camBuf: GPUBuffer;
  private matBuf: GPUBuffer;
  private volTex?: GPUTexture;
  private lutTex: GPUTexture;
  private gradTex: GPUTexture;
  private bind?: GPUBindGroup;

  private mat = new Float32Array(48);  // 192-byte Material UBO = 48 f32
  private dims: Vec3 = [1, 1, 1];
  private format: GPUTextureFormat;

  constructor(gpu: Gpu, format: GPUTextureFormat = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    const module = this.dev.createShaderModule({ code: SHADER });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.camBuf = this.dev.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.matBuf = this.dev.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // default LUT + grad LUT (grad = all 1.0)
    this.lutTex = this.makeLUT2D(defaultLUT());
    this.gradTex = this.makeLUT2D(new Uint8Array(256 * 4).fill(255));
    // sensible material defaults
    this.mat.set(identity(), 0);
    this.setClim(0, 255);
    this.setShade(0.4, 0.7, 0.2, 10);
    this.setBackground(0.08, 0.09, 0.13);
    this.mat[40] = 1; this.mat[41] = 1; this.mat[42] = 0; this.mat[43] = 1; // steps: step,unit,gradOn,budget
    this.mat[44] = 1; this.mat[45] = 0; this.mat[46] = 0; this.mat[47] = 0; // dither identity
  }

  private makeLUT2D(rgba: Uint8Array): GPUTexture {
    const tex = this.dev.createTexture({ size: [256, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.dev.queue.writeTexture({ texture: tex }, rgba, { bytesPerRow: 256 * 4 }, [256, 1]);
    return tex;
  }

  setVolume(v: VolumeSpec) {
    const [dx, dy, dz] = v.dims;
    this.dims = v.dims;
    this.volTex = this.dev.createTexture({
      size: [dx, dy, dz], dimension: "3d", format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dev.queue.writeTexture({ texture: this.volTex }, v.data.buffer, { bytesPerRow: dx * 4, rowsPerImage: dy }, [dx, dy, dz]);
    // centered axis-aligned geometry
    this.mat.set(patientToTextureCentered(v.dims, v.spacing), 0);
    const ext: Vec3 = [dx * v.spacing[0] / 2, dy * v.spacing[1] / 2, dz * v.spacing[2] / 2];
    this.setBoundsMinMax([-ext[0], -ext[1], -ext[2]], [ext[0], ext[1], ext[2]]);
    const minSp = Math.min(...v.spacing);
    this.mat[40] = minSp; this.mat[41] = minSp; // sample_step, opacity_unit_distance
    this.bind = undefined; // volume texture changed -> rebuild bind group
  }

  setLUT(rgba: Uint8Array) { this.lutTex = this.makeLUT2D(rgba); this.bind = undefined; }
  setClim(lo: number, hi: number) { this.mat[16] = lo; this.mat[17] = hi; }
  setShade(a: number, d: number, s: number, sh: number) { this.mat[36] = a; this.mat[37] = d; this.mat[38] = s; this.mat[39] = sh; }
  setBackground(r: number, g: number, b: number) { this.mat[32] = r; this.mat[33] = g; this.mat[34] = b; this.mat[35] = 1; }
  setSampleStep(step: number, unit?: number) { this.mat[40] = step; if (unit !== undefined) this.mat[41] = unit; }
  private setBoundsMinMax(mn: Vec3, mx: Vec3) { this.mat[24] = mn[0]; this.mat[25] = mn[1]; this.mat[26] = mn[2]; this.mat[28] = mx[0]; this.mat[29] = mx[1]; this.mat[30] = mx[2]; }

  setCamera(eye: Vec3, center: Vec3, up: Vec3, fovyDeg: number, width: number, height: number) {
    const view = lookAt(eye, center, up);
    const proj = perspectiveZO((fovyDeg * Math.PI) / 180, width / height, 1, 100000);
    const invVP = invert(multiply(proj, view));
    const cam = new Float32Array(20);
    cam.set(invVP, 0);
    cam[16] = width; cam[17] = height;
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
  }

  private ensureBind() {
    if (this.bind) return;
    if (!this.volTex) throw new Error("setVolume() first");
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: this.matBuf } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.volTex.createView() },
        { binding: 4, resource: this.lutTex.createView() },
        { binding: 5, resource: this.gradTex.createView() },
      ],
    });
  }

  /** Render into a caller-supplied view (e.g. a browser canvas texture). */
  renderToView(view: GPUTextureView, width: number, height: number) {
    this.dev.queue.writeBuffer(this.matBuf, 0, this.mat);
    this.ensureBind();
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
    this.dev.queue.submit([enc.finish()]);
  }

  /** Render to an offscreen texture and read back tightly-packed RGBA (width*height*4). */
  async renderToRGBA(width: number, height: number): Promise<Uint8Array> {
    this.dev.queue.writeBuffer(this.matBuf, 0, this.mat);
    this.ensureBind();
    const target = this.dev.createTexture({ size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();

    const bpr = Math.ceil((width * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap();
    target.destroy(); buf.destroy();
    return out;
  }
}

// A neutral default color/opacity LUT (grayscale ramp, opacity ramp).
function defaultLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const g = i;
    lut[i * 4] = g; lut[i * 4 + 1] = g; lut[i * 4 + 2] = g; lut[i * 4 + 3] = i;
  }
  return lut;
}
