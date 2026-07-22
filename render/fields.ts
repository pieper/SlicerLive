// Composable ray-march fields — TS/WebGPU port of slicer_wgpu's Field abstraction.
// Each field emits slot-namespaced WGSL (sample_field_<kind><slot>) returning a
// PREMULTIPLIED vec4 (rgb*opacity, opacity); the SceneRenderer sums fields per
// sample and does one front-to-back OVER (matching wgpu_vtk_inject's model).
//
// Uniform discipline: every uniform member is a vec4 or mat4x4 (16-byte aligned),
// packed sequentially, so struct layout and CPU packing stay in sync by construction.

import { type Mat4, type Vec3, patientToTexture, volumeAABB } from "./mat4.ts";

export interface Field {
  readonly kind: string;                 // WGSL family, e.g. "img"
  readonly bindingCount: number;         // texture/sampler bindings beyond the shared trio
  uniformFloats(): number;               // size of this field's uniform block (multiple of 4)
  structMembers(slot: number): string;   // WGSL struct member lines (slot-prefixed)
  declareBindings(slot: number, base: number): string;  // WGSL @binding decls
  samplingWGSL(slot: number): string;    // defines sample_field_<kind><slot>(wp, rd) -> vec4
  fillUniforms(out: Float32Array, off: number): void;   // write block at float offset `off`
  bindEntries(slot: number, base: number): GPUBindGroupEntry[];
  aabb(): [Vec3, Vec3];
}

export interface ImageFieldOpts {
  clim: [number, number];
  center?: Vec3;                         // world center (default origin)
  opacityUnitDistance?: number;          // default min(spacing)
  shade?: [number, number, number, number]; // ka, kd, ks, shininess
}

/** A scalar volume + color/opacity LUT rendered by DVR (the ImageField). */
export class ImageField implements Field {
  readonly kind = "img";
  readonly bindingCount = 2;             // volume (3d) + lut (2d)
  private volTex: GPUTexture;
  private lutTex: GPUTexture;
  private p2t: Mat4;
  private clim: [number, number];
  private shade: [number, number, number, number];
  private unit: number;
  private box: [Vec3, Vec3];

  constructor(dev: GPUDevice, data: Float32Array, dims: Vec3, spacing: Vec3, lut: Uint8Array, opts: ImageFieldOpts) {
    const center = opts.center ?? [0, 0, 0];
    this.volTex = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.volTex }, data, { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] }, dims as [number, number, number]);
    this.lutTex = dev.createTexture({ size: [256, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
    this.p2t = patientToTexture(dims, spacing, center);
    this.box = volumeAABB(dims, spacing, center);
    this.clim = opts.clim;
    this.shade = opts.shade ?? [0.35, 0.75, 0.35, 20];
    this.unit = opts.opacityUnitDistance ?? Math.min(...spacing);
  }

  uniformFloats() { return 28; }        // mat4(16) + clim(4) + shade(4) + params(4)
  aabb(): [Vec3, Vec3] { return this.box; }

  structMembers(s: number): string {
    return [
      `  img${s}_p2t : mat4x4<f32>,`,
      `  img${s}_clim : vec4<f32>,`,     // lo, hi, _, _
      `  img${s}_shade : vec4<f32>,`,    // ka, kd, ks, shininess
      `  img${s}_params : vec4<f32>,`,   // opacity_unit_distance, _, _, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return [
      `@group(0) @binding(${base}) var t_vol_img${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 1}) var t_lut_img${s} : texture_2d<f32>;`,
    ].join("\n");
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sampc_img${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.img${s}_p2t * vec4<f32>(wp, 1.0);
  return textureSampleLevel(t_vol_img${s}, s_lin, clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).r;
}
fn sample_field_img${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let t4 = u_material.img${s}_p2t * vec4<f32>(wp, 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let val = textureSampleLevel(t_vol_img${s}, s_lin, tex, 0.0).r;
  let lo = u_material.img${s}_clim.x; let hi = u_material.img${s}_clim.y;
  let tf = textureSampleLevel(t_lut_img${s}, s_lin, vec2<f32>(clamp((val - lo) / max(hi - lo, 1e-6), 0.0, 1.0), 0.5), 0.0);
  let step = u_material.scene.x;
  let unit = max(u_material.img${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(tf.a, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }
  let h = step;
  let g = vec3<f32>(
    sampc_img${s}(wp + vec3<f32>(h,0,0)) - sampc_img${s}(wp - vec3<f32>(h,0,0)),
    sampc_img${s}(wp + vec3<f32>(0,h,0)) - sampc_img${s}(wp - vec3<f32>(0,h,0)),
    sampc_img${s}(wp + vec3<f32>(0,0,h)) - sampc_img${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  let ka = u_material.img${s}_shade.x; let kd = u_material.img${s}_shade.y;
  let ks = u_material.img${s}_shade.z; let sh = u_material.img${s}_shade.w;
  var lit_srgb = tf.rgb * ka;
  if (glen > 1e-6) {
    var n = g / glen;
    if (dot(n, -rd) < 0.0) { n = -n; }
    let view_dir = normalize(-rd);
    let ldotn = dot(view_dir, n);
    if (ldotn > 0.0) {
      let refl = normalize(2.0 * ldotn * n - view_dir);
      let rdotv = max(0.0, dot(refl, view_dir));
      lit_srgb = tf.rgb * (ka + kd * ldotn) + vec3<f32>(ks * pow(rdotv, sh));
    }
  }
  let lit = srgb2physical(clamp(lit_srgb, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * opacity, opacity);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.clim[0]; out[off + 17] = this.clim[1];
    out[off + 20] = this.shade[0]; out[off + 21] = this.shade[1]; out[off + 22] = this.shade[2]; out[off + 23] = this.shade[3];
    out[off + 24] = this.unit;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [
      { binding: base, resource: this.volTex.createView() },
      { binding: base + 1, resource: this.lutTex.createView() },
    ];
  }
}

export interface RGBAFieldOpts {
  center?: Vec3;
  opacityUnitDistance?: number;
  shade?: [number, number, number, number];
}

/** A pre-baked rgba16float volume (color + smoothed presence-alpha), e.g. the
 *  ColorizeVolume bake of a segmentation. Density-mode DVR with headlight Phong. */
export class RGBAVolumeField implements Field {
  readonly kind = "rgba";
  readonly bindingCount = 1;            // baked rgba texture (sampler shared)
  private tex: GPUTexture;
  private p2t: Mat4;
  private shade: [number, number, number, number];
  private unit: number;
  private box: [Vec3, Vec3];

  constructor(tex: GPUTexture, dims: Vec3, spacing: Vec3, opts: RGBAFieldOpts = {}) {
    const center = opts.center ?? [0, 0, 0];
    this.tex = tex;
    this.p2t = patientToTexture(dims, spacing, center);
    this.box = volumeAABB(dims, spacing, center);
    this.shade = opts.shade ?? [0.30, 0.75, 0.45, 24];
    this.unit = opts.opacityUnitDistance ?? Math.min(...spacing);
  }

  uniformFloats() { return 24; }        // mat4(16) + params(4) + shade(4)
  aabb(): [Vec3, Vec3] { return this.box; }

  structMembers(s: number): string {
    return [
      `  rgba${s}_p2t : mat4x4<f32>,`,
      `  rgba${s}_params : vec4<f32>,`,  // opacity_unit_distance, _, _, _
      `  rgba${s}_shade : vec4<f32>,`,   // ka, kd, ks, shininess
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return `@group(0) @binding(${base}) var t_rgba${s} : texture_3d<f32>;`;
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn alpha_rgba${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.rgba${s}_p2t * vec4<f32>(wp, 1.0);
  return textureSampleLevel(t_rgba${s}, s_lin, clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).a;
}
fn sample_field_rgba${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let t4 = u_material.rgba${s}_p2t * vec4<f32>(wp, 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let c = textureSampleLevel(t_rgba${s}, s_lin, tex, 0.0);
  let step = u_material.scene.x;
  let unit = max(u_material.rgba${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(c.a, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }
  let h = step;
  let g = vec3<f32>(
    alpha_rgba${s}(wp + vec3<f32>(h,0,0)) - alpha_rgba${s}(wp - vec3<f32>(h,0,0)),
    alpha_rgba${s}(wp + vec3<f32>(0,h,0)) - alpha_rgba${s}(wp - vec3<f32>(0,h,0)),
    alpha_rgba${s}(wp + vec3<f32>(0,0,h)) - alpha_rgba${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  let ka = u_material.rgba${s}_shade.x; let kd = u_material.rgba${s}_shade.y;
  let ks = u_material.rgba${s}_shade.z; let sh = u_material.rgba${s}_shade.w;
  var lit_srgb = c.rgb * ka;
  if (glen > 1e-6) {
    var n = g / glen;
    if (dot(n, -rd) < 0.0) { n = -n; }
    let view_dir = normalize(-rd);
    let ldotn = dot(view_dir, n);
    if (ldotn > 0.0) {
      let refl = normalize(2.0 * ldotn * n - view_dir);
      let rdotv = max(0.0, dot(refl, view_dir));
      lit_srgb = c.rgb * (ka + kd * ldotn) + vec3<f32>(ks * pow(rdotv, sh));
    }
  }
  let lit = srgb2physical(clamp(lit_srgb, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * opacity, opacity);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.unit;
    out[off + 20] = this.shade[0]; out[off + 21] = this.shade[1]; out[off + 22] = this.shade[2]; out[off + 23] = this.shade[3];
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [{ binding: base, resource: this.tex.createView() }];
  }
}
