// Composable ray-march fields — TS/WebGPU port of slicer_wgpu's Field abstraction.
// Each field emits slot-namespaced WGSL (sample_field_<kind><slot>) returning a
// PREMULTIPLIED vec4 (rgb*opacity, opacity); the SceneRenderer sums fields per
// sample and does one front-to-back OVER (matching wgpu_vtk_inject's model).
//
// Uniform discipline: every uniform member is a vec4 or mat4x4 (16-byte aligned),
// packed sequentially, so struct layout and CPU packing stay in sync by construction.

import {
  type Mat4,
  type Vec3,
  patientToTexture,
  patientToTextureFromIjkToRAS,
  spacingFromIjkToRAS,
  volumeAABB,
  volumeAABBFromIjkToRAS,
} from "./mat4.ts";

export interface Field {
  readonly kind: string;                 // WGSL family, e.g. "img"
  readonly bindingCount: number;         // texture/sampler bindings beyond the shared trio
  /** MODIFIER fields (e.g. TransformField) warp other fields' sampling and are never
   *  composited: the SceneRenderer emits their WGSL but leaves them out of the sum. */
  readonly modifier?: boolean;
  /** An attached modifier field whose displacement warps THIS field's sampling. The
   *  SceneRenderer turns this into the field's transform_point_<kind><slot>() body. */
  transform?: Field | null;
  uniformFloats(): number;               // size of this field's uniform block (multiple of 4)
  structMembers(slot: number): string;   // WGSL struct member lines (slot-prefixed)
  declareBindings(slot: number, base: number): string;  // WGSL @binding decls
  samplingWGSL(slot: number): string;    // defines sample_field_<kind><slot>(wp, rd) -> vec4
  fillUniforms(out: Float32Array, off: number): void;   // write block at float offset `off`
  bindEntries(slot: number, base: number): GPUBindGroupEntry[];
  aabb(): [Vec3, Vec3];
  sampleStep(): number;                  // preferred ray-march step (mm); scene uses the min
}

export interface ImageFieldOpts {
  clim: [number, number];
  center?: Vec3;                         // world center (default origin); ignored when ijkToRAS is given
  ijkToRAS?: ArrayLike<number>;          // row-major 4x4 voxel-center->RAS (real, rotated/anisotropic geometry)
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
  private stepMm: number;
  private box: [Vec3, Vec3];

  constructor(dev: GPUDevice, data: Float32Array, dims: Vec3, spacing: Vec3, lut: Uint8Array, opts: ImageFieldOpts) {
    const center = opts.center ?? [0, 0, 0];
    this.volTex = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.volTex }, data, { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] }, dims as [number, number, number]);
    this.lutTex = dev.createTexture({ size: [256, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
    if (opts.ijkToRAS) {   // real (rotated/anisotropic) geometry straight from the scene
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      this.stepMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {               // synthetic axis-aligned box centered at `center`
      this.p2t = patientToTexture(dims, spacing, center);
      this.box = volumeAABB(dims, spacing, center);
      this.stepMm = Math.min(...spacing);
    }
    this.clim = opts.clim;
    this.shade = opts.shade ?? [0.35, 0.75, 0.35, 20];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
  }

  uniformFloats() { return 28; }        // mat4(16) + clim(4) + shade(4) + params(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }
  /** The r32float 3D scalar texture (e.g. to share with a SliceRenderer for MPR). */
  volumeTexture(): GPUTexture { return this.volTex; }
  /** RAS(patient) -> texture[0,1] matrix (encodes the real ijkToRAS geometry). */
  patientToTexture(): Mat4 { return this.p2t; }

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
  let t4 = u_material.img${s}_p2t * vec4<f32>(transform_point_img${s}(wp), 1.0);
  return textureSampleLevel(t_vol_img${s}, s_lin, clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).r;
}
fn sample_field_img${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let t4 = u_material.img${s}_p2t * vec4<f32>(transform_point_img${s}(wp), 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let val = textureSampleLevel(t_vol_img${s}, s_lin, tex, 0.0).r;
  let lo = u_material.img${s}_clim.x; let hi = u_material.img${s}_clim.y;
  let tf = textureSampleLevel(t_lut_img${s}, s_lin, vec2<f32>(clamp((val - lo) / max(hi - lo, 1e-6), 0.0, 1.0), 0.5), 0.0);
  let step = u_material.scene.x;
  let unit = max(u_material.img${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(tf.a, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }
  let h = step * 2.0;   // wider central difference -> smoother normals (less shading aliasing on coarse volumes)
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

export interface SegmentFieldOpts {
  color: [number, number, number];
  opacity?: number;                      // segment 3D opacity (default 1)
  ijkToRAS?: ArrayLike<number>;
  center?: Vec3;
  shade?: [number, number, number, number]; // ka,kd,ks,shin — slicer_wgpu SegmentField default 0.20/0.85/0.30/32
  bandMm?: number;                       // iso-shell half-thickness (mm); slicer_wgpu default = 1 voxel
  sampleStepMm?: number;
}

/** A single segment rendered exactly as slicer_wgpu's SegmentField in its DEFAULT
 *  `iso` mode (wgpu_vtk_inject.py `_seg_field_wgsl`, `_segment_render_mode = "iso"`).
 *
 *  The presence field is a binary labelmap pre-smoothed by a separable Gaussian
 *  (sigma 1.5 voxels) into `v` in [0,1]. At render we take a 6-tap central-difference
 *  gradient and treat `v` as a first-order signed-distance field:
 *      d(x) = |(v - 0.5) / |grad v||          (mm; |grad v| ~ 1/voxel near the boundary)
 *  Opacity is a 1-voxel band around the v=0.5 isosurface:
 *      a = 1 - clamp(d / band_mm, 0, 1),  op = a * opacity
 *  This yields a CRISP, OPAQUE, sub-voxel anti-aliased isosurface SHELL — a pure
 *  ray-marched surface of the smoothed field, no polygons/marching-cubes.
 *
 *  This is deliberately NOT the `surface` variant (gradient-opacity emission
 *  op = opacity*|grad v|*step), which is translucent and reads like a colorize volume;
 *  the selftest / paint demo uses `iso`. */
export class SegmentField implements Field {
  readonly kind = "seg";
  readonly bindingCount = 1;             // smoothed-presence texture (sampler shared)
  private tex: GPUTexture;
  private p2t: Mat4;
  private box: [Vec3, Vec3];
  private color: [number, number, number];
  private opacity: number;
  private shade: [number, number, number, number];
  private bandMm: number;
  private stepMm: number;

  constructor(tex: GPUTexture, dims: Vec3, spacing: Vec3, opts: SegmentFieldOpts) {
    this.tex = tex;
    const center = opts.center ?? [0, 0, 0];
    let voxelMm: number;
    if (opts.ijkToRAS) {
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      voxelMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {
      this.p2t = patientToTexture(dims, spacing, center);
      this.box = volumeAABB(dims, spacing, center);
      voxelMm = Math.min(...spacing);
    }
    this.color = opts.color;
    this.opacity = opts.opacity ?? 1;
    this.shade = opts.shade ?? [0.20, 0.85, 0.30, 32];
    // iso-shell band: 1 voxel-worth of thickness (slicer_wgpu SegmentField.band_mm = min spacing)
    this.bandMm = opts.bandMm ?? voxelMm;
    // slicer_wgpu SegmentField.sample_step_mm = max(0.5*voxel, 0.1)
    this.stepMm = opts.sampleStepMm ?? Math.max(0.5 * voxelMm, 0.1);
  }

  uniformFloats() { return 28; }        // mat4(16) + color(4) + shade(4) + params(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }
  setTexture(tex: GPUTexture, destroyPrev = true) { if (destroyPrev && this.tex !== tex) this.tex.destroy(); this.tex = tex; }

  structMembers(s: number): string {
    return [
      `  seg${s}_p2t : mat4x4<f32>,`,
      `  seg${s}_color : vec4<f32>,`,    // rgb, opacity
      `  seg${s}_shade : vec4<f32>,`,    // ka, kd, ks, shininess
      `  seg${s}_params : vec4<f32>,`,   // band_mm, _, _, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return `@group(0) @binding(${base}) var t_seg${s} : texture_3d<f32>;`;
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn v_seg${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 0.0; }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;   // Gaussian-smoothed presence in .a
}
fn sample_field_seg${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let op0 = u_material.seg${s}_color.a;
  if (op0 <= 0.0) { return vec4<f32>(0.0); }
  let v = v_seg${s}(wp);
  // Skip deep interior / exterior: |grad| ~ 0 there so no shell to emit.
  if (v <= 0.02 || v >= 0.98) { return vec4<f32>(0.0); }
  let h = max(u_material.scene.x, 1e-3);
  let g = vec3<f32>(
    v_seg${s}(wp + vec3<f32>(h,0,0)) - v_seg${s}(wp - vec3<f32>(h,0,0)),
    v_seg${s}(wp + vec3<f32>(0,h,0)) - v_seg${s}(wp - vec3<f32>(0,h,0)),
    v_seg${s}(wp + vec3<f32>(0,0,h)) - v_seg${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  if (glen < 1e-5) { return vec4<f32>(0.0); }
  // Local first-order signed distance to the v=0.5 isosurface (mm), then a
  // 1-voxel opacity band around it: crisp opaque shell, sub-voxel anti-aliased.
  let d_mm = abs((v - 0.5) / glen);
  let band = max(u_material.seg${s}_params.x, 1e-3);
  let a = 1.0 - clamp(d_mm / band, 0.0, 1.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  let op = clamp(a * op0, 0.0, 1.0);
  // Phong from the same gradient, normal flipped to face the camera.
  var n = g / glen;
  if (dot(n, -rd) < 0.0) { n = -n; }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = u_material.seg${s}_color.rgb;
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.color[0]; out[off + 17] = this.color[1]; out[off + 18] = this.color[2]; out[off + 19] = this.opacity;
    out[off + 20] = this.shade[0]; out[off + 21] = this.shade[1]; out[off + 22] = this.shade[2]; out[off + 23] = this.shade[3];
    out[off + 24] = this.bandMm;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [{ binding: base, resource: this.tex.createView() }];
  }
}

export interface RGBAFieldOpts {
  center?: Vec3;
  ijkToRAS?: ArrayLike<number>;          // real rotated/anisotropic geometry (aligns with an ImageField)
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
  private stepMm: number;
  private box: [Vec3, Vec3];

  constructor(tex: GPUTexture, dims: Vec3, spacing: Vec3, opts: RGBAFieldOpts = {}) {
    const center = opts.center ?? [0, 0, 0];
    this.tex = tex;
    if (opts.ijkToRAS) {
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      this.stepMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {
      this.p2t = patientToTexture(dims, spacing, center);
      this.box = volumeAABB(dims, spacing, center);
      this.stepMm = Math.min(...spacing);
    }
    this.shade = opts.shade ?? [0.30, 0.75, 0.45, 24];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
  }

  uniformFloats() { return 24; }        // mat4(16) + params(4) + shade(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }
  /** Swap the baked texture in place (e.g. after re-baking an updated mask). The
   *  geometry is unchanged; the caller refreshes the SceneRenderer bind group. */
  setTexture(tex: GPUTexture, destroyPrev = true) { if (destroyPrev && this.tex !== tex) this.tex.destroy(); this.tex = tex; }
  get texture(): GPUTexture { return this.tex; }

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
  let t4 = u_material.rgba${s}_p2t * vec4<f32>(transform_point_rgba${s}(wp), 1.0);
  return textureSampleLevel(t_rgba${s}, s_lin, clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).a;
}
fn sample_field_rgba${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let t4 = u_material.rgba${s}_p2t * vec4<f32>(transform_point_rgba${s}(wp), 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let c = textureSampleLevel(t_rgba${s}, s_lin, tex, 0.0);
  let step = u_material.scene.x;
  let unit = max(u_material.rgba${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(c.a, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }
  let h = step * 2.0;   // wider central difference -> smoother normals (less shading aliasing on coarse volumes)
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
