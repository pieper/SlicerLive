// ColorizeField — Slicer's "Colorize Volume" (an RGBA volume rendering of a CT tinted by a
// segmentation), except the RGBA is composed IN THE SHADER rather than baked into a texture.
//
// Why not bake. A baked rgba16float volume (what RGBAVolumeField consumes) freezes every
// segment's opacity at bake time: changing one means re-running the bake over the whole volume
// and re-uploading it. Composing per sample instead costs one extra texture fetch and keeps
// each segment's opacity a live uniform — so a slider can fade "all vertebrae" while the ray
// march is running. It also halves the memory: a scalar r16float plus a u8 label volume is
// 3 bytes/voxel against 8 for rgba16float.
//
// The composition, per sample:
//
//     label = textureLoad(labels)           NEAREST — labels must never interpolate
//     if label > 0:  rgb = palette[label].rgb * brightness(ct)     <- segment colour, CT texture
//                    a   = palette[label].a                        <- the group slider
//     else:          rgb, a = ctLUT[ct]                            <- ordinary DVR, for context
//
// So the segment colour carries identity, the CT carries detail, and the two opacity paths are
// independent: group sliders always do something, whatever the CT transfer function is doing.
// Shading normals come from the CT gradient (smooth and detailed) rather than the label field
// (piecewise-constant, so its gradient is a staircase).

import type { Vec3, Mat4 } from "./mat4.ts";
import {
  patientToTexture, patientToTextureFromIjkToRAS, spacingFromIjkToRAS, volumeAABB,
  volumeAABBFromIjkToRAS,
} from "./mat4.ts";
import { toF16Array } from "./cine-field.ts";
import type { Field } from "./fields.ts";

export interface ColorizeFieldOpts {
  clim: [number, number];                 // HU range the CT LUT spans
  ijkToRAS?: ArrayLike<number>;
  center?: Vec3;
  spacing?: Vec3;
  opacityUnitDistance?: number;
  shade?: [number, number, number, number];
  clippable?: boolean;
  /** Opacity multiplier for UNLABELLED voxels — the surrounding body, drawn by the CT LUT. */
  contextOpacity?: number;
  /** How much the CT modulates a segment's brightness. 0 = flat colour, 1 = full CT texture. */
  ctModulation?: number;
}

export class ColorizeField implements Field {
  readonly kind = "clz";
  readonly bindingCount = 3;              // ct (3d f32) + labels (3d u32) + luts (2d)
  readonly clippable: boolean;
  private dev: GPUDevice;
  private ctTex: GPUTexture;
  private labTex: GPUTexture;
  private lutTex: GPUTexture;             // 256x2: row 0 = CT transfer function, row 1 = palette
  private p2t: Mat4;
  private box: [Vec3, Vec3];
  private stepMm: number;
  private dims: Vec3;
  private clim: [number, number];
  private shade: [number, number, number, number];
  private unit: number;
  private context: number;
  private ctMod: number;
  /** rgba8 palette rows kept CPU-side so a single segment's alpha can be patched cheaply. */
  private palette = new Uint8Array(256 * 4);

  constructor(
    dev: GPUDevice,
    ct: ArrayLike<number> | null,        // HU, z-major (nz*ny*nx); null = fill in later via setCT

    labels: ArrayLike<number>,           // segment numbers, same grid
    dims: Vec3,
    ctLut: Uint8Array,                   // 256*4 rgba8 from lutFromTransferFunctions
    opts: ColorizeFieldOpts,
  ) {
    this.dev = dev;
    this.dims = dims;
    const size = dims as [number, number, number];

    // r16float, not r32float: half the bytes and filterable in core WebGPU. float16 is exact
    // for integers to 2048, which covers every HU that matters (bone tops out well below).
    this.ctTex = dev.createTexture({
      size, dimension: "3d", format: "r16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (ct) this.setCT(ct);

    // r8uint: integer labels, sampled with textureLoad. A filterable format would let the
    // hardware blend segment 5 and segment 40 into segment 22 at every boundary.
    this.labTex = dev.createTexture({
      size, dimension: "3d", format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Copy BY VALUE into a real Uint8Array rather than trusting the caller's array type.
    // fetchZarrVolume returns a Float32Array whatever the stored dtype is — its `dtype` only
    // decodes the chunk — so a "|u1" label volume arrives as floats. Handing that straight to
    // writeTexture reinterprets 4-byte floats as 4 separate label bytes and the labelmap comes
    // out as scattered noise, while every value-based read of the same array looks correct.
    // A plain loop, NOT Uint8Array.from(labels, fn): the callback form measured 3979 ms for this
    // volume's 55.5 M elements against 80 ms here. Same trap as f32tof16 — per-element function
    // call overhead at this scale is seconds of blocked main thread.
    let lab8: Uint8Array;
    if (labels instanceof Uint8Array) {
      lab8 = labels;
    } else {
      lab8 = new Uint8Array(labels.length);
      for (let i = 0; i < labels.length; i++) lab8[i] = labels[i];
    }
    dev.queue.writeTexture({ texture: this.labTex }, lab8,
      { bytesPerRow: dims[0], rowsPerImage: dims[1] }, size);

    this.lutTex = dev.createTexture({
      size: [256, 2], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.setCtLUT(ctLut);

    if (opts.ijkToRAS) {
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      this.stepMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {
      const sp = opts.spacing ?? [1, 1, 1];
      this.p2t = patientToTexture(dims, sp, opts.center ?? [0, 0, 0]);
      this.box = volumeAABB(dims, sp, opts.center ?? [0, 0, 0]);
      this.stepMm = Math.min(...sp);
    }
    this.clim = opts.clim;
    this.shade = opts.shade ?? [0.25, 0.80, 0.30, 18];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
    this.clippable = opts.clippable ?? true;
    this.context = opts.contextOpacity ?? 1;
    this.ctMod = opts.ctModulation ?? 0.55;
  }

  /** Upload (or replace) the CT scalars. Separated from the constructor so the label volume —
   *  which compresses to under a megabyte — can be shown as flat coloured surfaces while the
   *  60 MB CT is still streaming. */
  setCT(ct: ArrayLike<number>) {
    this.dev.queue.writeTexture({ texture: this.ctTex }, toF16Array(ct),
      { bytesPerRow: this.dims[0] * 2, rowsPerImage: this.dims[1] }, this.dims as [number, number, number]);
    this.hasCt = true;
  }
  private hasCt = false;
  get ctLoaded(): boolean { return this.hasCt; }
  /** 0 = flat segment colour (surface look), 1 = full CT brightness modulation. */
  setCtModulation(m: number) { this.ctMod = m; }

  /** The 256x2 palette texture (row 1 = segment colour + opacity), shared with the 2D slice
   *  overlay so one group slider governs both views. */
  paletteTexture(): GPUTexture { return this.lutTex; }

  /** Swap the CT transfer function (row 0). Segment colours and opacities are untouched. */
  setCtLUT(lut: Uint8Array) {
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 0] }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
  }

  /** Set a segment's display colour (0..1 rgb). Call flushPalette() after a batch. */
  setSegmentColor(num: number, rgb: [number, number, number]) {
    const o = num * 4;
    this.palette[o] = Math.round(rgb[0] * 255);
    this.palette[o + 1] = Math.round(rgb[1] * 255);
    this.palette[o + 2] = Math.round(rgb[2] * 255);
  }
  /** Set a segment's opacity (0..1) — this is what a group slider drives. */
  setSegmentOpacity(num: number, a: number) {
    this.palette[num * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  getSegmentOpacity(num: number): number { return this.palette[num * 4 + 3] / 255; }
  /** Upload the palette row. One 1 KB write — cheap enough to call on every slider tick. */
  flushPalette() {
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 1] }, this.palette, { bytesPerRow: 256 * 4 }, [256, 1]);
  }

  setContextOpacity(v: number) { this.context = v; }
  getContextOpacity(): number { return this.context; }
  setClim(lo: number, hi: number) { this.clim = [lo, hi]; }
  getClim(): [number, number] { return [this.clim[0], this.clim[1]]; }
  setShade(s: [number, number, number, number]) { this.shade = s; }
  /** The CT scalar texture, so a SliceRenderer can show the same voxels in the 2D views. */
  volumeTexture(): GPUTexture { return this.ctTex; }
  /** RAS(patient) -> texture[0,1], the same matrix the 2D slice renderer needs. */
  patientToTexture(): Mat4 { return this.p2t; }
  labelTexture(): GPUTexture { return this.labTex; }

  uniformFloats() { return 32; }          // mat4(16) + clim(4) + shade(4) + params(4) + dims(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }

  structMembers(s: number): string {
    return [
      `  clz${s}_p2t : mat4x4<f32>,`,
      `  clz${s}_clim : vec4<f32>,`,      // lo, hi, _, _
      `  clz${s}_shade : vec4<f32>,`,     // ka, kd, ks, shininess
      `  clz${s}_params : vec4<f32>,`,    // opacity_unit_distance, contextOpacity, ctModulation, _
      `  clz${s}_dims : vec4<f32>,`,      // nx, ny, nz, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return [
      `@group(0) @binding(${base}) var t_ct_clz${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 1}) var t_lab_clz${s} : texture_3d<u32>;`,
      `@group(0) @binding(${base + 2}) var t_lut_clz${s} : texture_2d<f32>;`,
    ].join("\n");
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn tex_clz${s}(wp : vec3<f32>) -> vec3<f32> {
  let t4 = u_material.clz${s}_p2t * vec4<f32>(transform_point_clz${s}(wp), 1.0);
  return t4.xyz;
}
fn ct_clz${s}(wp : vec3<f32>) -> f32 {
  let t = clamp(tex_clz${s}(wp), vec3<f32>(0.0), vec3<f32>(1.0));
  return textureSampleLevel(t_ct_clz${s}, s_lin, t, 0.0).r;
}
/** Normalised CT position in the LUT, 0..1 across clim. */
fn ctnorm_clz${s}(hu : f32) -> f32 {
  let lo = u_material.clz${s}_clim.x; let hi = u_material.clz${s}_clim.y;
  return clamp((hu - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
}
/** The scalar used for the shading gradient: the normalised CT itself.
 *
 *  NOT the LUT alpha. Most CT presets are near step functions in opacity (CT-Soft-Tissue is
 *  flat 1.0 above -160 HU), so the alpha gradient is zero through the whole interior and
 *  enormous on one noisy isosurface — shading then flips between ambient-only and fully lit
 *  from voxel to voxel and the volume renders as banded moire. The CT scalar is smooth
 *  everywhere and its gradient is the real anatomical surface normal. */
fn galpha_clz${s}(wp : vec3<f32>) -> f32 {
  return ctnorm_clz${s}(ct_clz${s}(wp));
}
/** Trilinear occupancy of the given segment around a texture coordinate: the fraction of the eight
 *  surrounding voxels carrying that label, weighted as trilinear interpolation would.
 *
 *  Labels cannot be interpolated by the hardware (blending 5 and 40 gives 22), so the label
 *  fetch is NEAREST — which makes every organ boundary a voxel staircase. At 1.25 mm slice
 *  spacing a rib is only a few voxels thick, and marching a ray through hard 0/1 opacity across
 *  those steps produces the moire banding you see on thin structures. Interpolating the
 *  INDICATOR of the nearest label instead is exact at voxel centres, smooth in between, and
 *  antialiases the surface without ever inventing a label that is not there. */
fn occupancy_clz${s}(tex : vec3<f32>, d : vec3<f32>, lab : i32) -> f32 {
  let p = tex * d - vec3<f32>(0.5);
  let b = floor(p);
  let f = p - b;
  var occ = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let c = vec3<f32>(f32(i & 1), f32((i >> 1) & 1), f32((i >> 2) & 1));
    let w = ((1.0 - c.x) + (2.0 * c.x - 1.0) * f.x)
          * ((1.0 - c.y) + (2.0 * c.y - 1.0) * f.y)
          * ((1.0 - c.z) + (2.0 * c.z - 1.0) * f.z);
    let vi = vec3<i32>(clamp(b + c, vec3<f32>(0.0), d - vec3<f32>(1.0)));
    if (i32(textureLoad(t_lab_clz${s}, vi, 0).r) == lab) { occ = occ + w; }
  }
  return occ;
}
fn sample_field_clz${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let tex = tex_clz${s}(wp);
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let hu = textureSampleLevel(t_ct_clz${s}, s_lin, tex, 0.0).r;
  let tn = ctnorm_clz${s}(hu);
  let ctc = textureSampleLevel(t_lut_clz${s}, s_lin, vec2<f32>(tn, 0.25), 0.0);

  // NEAREST label fetch. textureLoad takes voxel indices, so scale out of [0,1].
  let d = u_material.clz${s}_dims.xyz;
  let vi = vec3<i32>(clamp(floor(tex * d), vec3<f32>(0.0), d - vec3<f32>(1.0)));
  let lab = i32(textureLoad(t_lab_clz${s}, vi, 0).r);

  var rgb : vec3<f32>;
  var dens : f32;
  if (lab > 0) {
    let pal = textureLoad(t_lut_clz${s}, vec2<i32>(lab, 1), 0);
    // CT modulates BRIGHTNESS so organs keep their internal texture, but not opacity — the
    // group slider alone owns that, so it still works under a bone-only transfer function.
    let m = u_material.clz${s}_params.z;
    rgb = pal.rgb * ((1.0 - m) + m * (0.35 + 1.30 * tn));
    dens = pal.a * occupancy_clz${s}(tex, d, lab);
  } else {
    rgb = ctc.rgb;
    dens = ctc.a * u_material.clz${s}_params.y;
  }
  if (dens <= 0.001) { return vec4<f32>(0.0); }

  let step = u_material.scene.x;
  let unit = max(u_material.clz${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(dens, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }

  let h = step * 2.0;
  let g = vec3<f32>(
    galpha_clz${s}(wp + vec3<f32>(h,0,0)) - galpha_clz${s}(wp - vec3<f32>(h,0,0)),
    galpha_clz${s}(wp + vec3<f32>(0,h,0)) - galpha_clz${s}(wp - vec3<f32>(0,h,0)),
    galpha_clz${s}(wp + vec3<f32>(0,0,h)) - galpha_clz${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  let ka = u_material.clz${s}_shade.x; let kd = u_material.clz${s}_shade.y;
  let ks = u_material.clz${s}_shade.z; let sh = u_material.clz${s}_shade.w;
  var lit_srgb = rgb * ka;
  if (glen > 1e-6) {
    var n = g / glen;
    if (dot(n, -rd) < 0.0) { n = -n; }
    let view_dir = normalize(-rd);
    let ldotn = dot(view_dir, n);
    if (ldotn > 0.0) {
      let refl = normalize(2.0 * ldotn * n - view_dir);
      let rdotv = max(0.0, dot(refl, view_dir));
      lit_srgb = rgb * (ka + kd * ldotn) + vec3<f32>(ks * pow(rdotv, sh));
    }
  }
  let lit = srgb2physical(clamp(lit_srgb, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * opacity, opacity);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.clim[0]; out[off + 17] = this.clim[1];
    out[off + 20] = this.shade[0]; out[off + 21] = this.shade[1];
    out[off + 22] = this.shade[2]; out[off + 23] = this.shade[3];
    out[off + 24] = this.unit; out[off + 25] = this.context; out[off + 26] = this.ctMod;
    out[off + 28] = this.dims[0]; out[off + 29] = this.dims[1]; out[off + 30] = this.dims[2];
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [
      { binding: base, resource: this.ctTex.createView() },
      { binding: base + 1, resource: this.labTex.createView() },
      { binding: base + 2, resource: this.lutTex.createView() },
    ];
  }
}
