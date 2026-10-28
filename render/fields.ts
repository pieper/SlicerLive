// Composable ray-march fields — TS/WebGPU port of slicer_wgpu's Field abstraction.
// Each field emits slot-namespaced WGSL (sample_field_<kind><slot>) returning a
// PREMULTIPLIED vec4 (rgb*opacity, opacity); the SceneRenderer sums fields per
// sample and does one front-to-back OVER (matching wgpu_vtk_inject's model).
//
// Uniform discipline: every uniform member is a vec4 or mat4x4 (16-byte aligned),
// packed sequentially, so struct layout and CPU packing stay in sync by construction.

import {
  applyMat4,
  invert,
  type Mat4,
  multiply,
  type Vec3,
  patientToTexture,
  patientToTextureFromIjkToRAS,
  spacingFromIjkToRAS,
  volumeAABB,
  volumeAABBFromIjkToRAS,
} from "./mat4.ts";

/** AABB of a box [lo,hi] transformed by a 4x4 (its 8 corners re-bounded). */
function transformedAABB(m: Mat4, lo: Vec3, hi: Vec3): [Vec3, Vec3] {
  const mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = applyMat4(m, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c[a]); mx[a] = Math.max(mx[a], c[a]); }
  }
  return [mn, mx];
}

export interface Field {
  readonly kind: string;                 // WGSL family, e.g. "img"
  readonly bindingCount: number;         // texture/sampler bindings beyond the shared trio
  /** MODIFIER fields (e.g. TransformField) warp other fields' sampling and are never
   *  composited: the SceneRenderer emits their WGSL but leaves them out of the sum. */
  readonly modifier?: boolean;
  /** An attached modifier field whose displacement warps THIS field's sampling. The
   *  SceneRenderer turns this into the field's transform_point_<kind><slot>() body. */
  transform?: Field | null;
  /** Opt-in EMPTY-SPACE SKIPPING. When true, skipWGSL() must define
   *  `skip_<kind><slot>(wp) -> f32`: a conservative LOWER BOUND on the distance from wp
   *  within which this field is guaranteed to contribute nothing (0 = "no information",
   *  which forces the normal fine step). It must NEVER over-estimate or geometry is
   *  silently skipped over. The SceneRenderer caches the bound per field and coasts,
   *  so the (often O(N)) bound is evaluated only at horizon boundaries, not every step.
   *
   *  NOTE: the renderer disables skipping for any field carrying a `transform`, because a
   *  nonlinear warp invalidates a distance bound measured in un-warped space. */
  readonly providesSkip?: boolean;
  skipWGSL?(slot: number): string;
  /** Whether ROI clip planes crop this field (default true). Set false for interaction
   *  widgets (e.g. the ROI box wireframe) so they aren't clipped by their own planes. */
  readonly clippable?: boolean;
  /** GHOST fields (interaction handles) composite specially: entering one dims the
   *  already-accumulated colour so the handle shines through occluders. They are excluded
   *  from the normal sum and the empty-space-skip/leap machinery. */
  readonly ghost?: boolean;
  /** INTERVAL sampling, for surfaces thinner than the ray step (e.g. FiberField's tubes) that a point
   *  sample would step over. The sampling fn takes a third argument —
   *  `sample_field_<kind><slot>(wp, rd, seg)` — the ray distance since THIS field's previous sample,
   *  and returns everything it crosses on (wp - seg*rd, wp]. Successive intervals partition the ray
   *  (a clipped sample still consumes its interval), so each surface is counted exactly once whatever
   *  the step or jitter. After an empty-space skip `seg` spans the skipped stretch, so the field's
   *  skip bound must also cover any look-back it caps `seg` to. */
  readonly intervalSampling?: boolean;
  /** Whether the shader references the shared linear sampler (binding 2). Default bindingCount > 0;
   *  set false for a field whose bindings are all storage buffers. */
  readonly usesSampler?: boolean;
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
  private dev: GPUDevice;
  private p2t: Mat4;
  private clim: [number, number];
  private shade: [number, number, number, number];
  private unit: number;
  private stepMm: number;
  private box: [Vec3, Vec3];
  private normScale = 1;   // r8unorm samples return raw/255; clim is packed /normScale so shader math is unchanged

  private dims: Vec3;
  constructor(dev: GPUDevice, data: Float32Array | Uint8Array | Uint16Array, dims: Vec3, spacing: Vec3, lut: Uint8Array, opts: ImageFieldOpts) {
    this.dims = dims;
    const center = opts.center ?? [0, 0, 0];
    // Store the volume in its NATIVE dtype where possible — 4× less VRAM + upload than expanding to
    // f32. r8unorm/r32float are both `float` sample types (filterable), so the sampling WGSL and bind
    // layout are unchanged; only the clim is normalized (below) since r8unorm samples return v/255.
    // uint16 has no filterable core format (r16uint isn't linearly sampled), so it promotes to f32.
    let src: ArrayBufferView = data, fmt: GPUTextureFormat = "r32float", bpe = 4;
    this.normScale = 1;
    if (data instanceof Uint8Array) { fmt = "r8unorm"; bpe = 1; this.normScale = 255; }
    else if (data instanceof Uint16Array) { src = Float32Array.from(data); fmt = "r32float"; bpe = 4; }
    this.volTex = dev.createTexture({ size: dims as [number, number, number], dimension: "3d", format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    // Upload the 3D texture in Z-slabs. wgpu's writeTexture stages the whole write through ONE
    // buffer whose size can't exceed the device's maxBufferSize (~4 GB on an L4) — a single write
    // of a multi-GB volume crashes the backend. Chunking the depth keeps each staging buffer small,
    // so volumes are bounded only by total VRAM, not by one upload's size.
    {
      const bytesPerRow = dims[0] * bpe, rowsPerImage = dims[1], sliceBytes = bytesPerRow * rowsPerImage;
      const CHUNK = 256 * 1024 * 1024;   // ~256 MB per write — comfortably under any maxBufferSize
      const slab = Math.max(1, Math.min(dims[2], Math.floor(CHUNK / Math.max(1, sliceBytes))));
      // Copy each slab into a FRESH small buffer (offset 0) rather than passing the whole volume with
      // a byte offset. wgpu's writeTexture mishandles data offsets past ~2 GB (32-bit overflow), so a
      // multi-GB volume uploaded with a running offset corrupts every slab beyond 2 GB — the volume
      // renders as mostly-zero with a small valid fragment. A per-slab copy keeps every offset 0.
      const u8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      for (let z = 0; z < dims[2]; z += slab) {
        const depth = Math.min(slab, dims[2] - z);
        const slabBytes = depth * sliceBytes;
        const slabData = u8.slice(z * sliceBytes, z * sliceBytes + slabBytes);   // fresh buffer, offset 0
        dev.queue.writeTexture(
          { texture: this.volTex, origin: { x: 0, y: 0, z } },
          slabData,
          { offset: 0, bytesPerRow, rowsPerImage },
          [dims[0], dims[1], depth],
        );
      }
    }
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
    this.dev = dev;
  }

  /** Replace the 256-entry rgba8 color/opacity LUT in place (no texture/bind-group churn).
   *  The bind group holds a stable view of lutTex, so the next render uses the new LUT. */
  setLUT(lut: Uint8Array) {
    this.dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
  }

  /** The scalar range the LUT spans — window/level for the volume rendering. Re-packed into
   *  the material uniform on the next syncUniforms()/render, so no pipeline rebuild. */
  setClim(lo: number, hi: number) { this.clim = [lo, hi]; }
  getClim(): [number, number] { return [this.clim[0], this.clim[1]]; }
  /** Phong shading tuple [ka, kd, ks, shininess] — re-packed into the material uniform next
   *  render (VR presets carry their own lighting). [1,0,0,1] = flat emission (no shading). */
  setShade(shade: [number, number, number, number]) { this.shade = [shade[0], shade[1], shade[2], shade[3]]; }

  private origP2t?: Mat4;                // sampling matrix + box at identity, for setWorldTransform
  private origBox?: [Vec3, Vec3];

  uniformFloats() { return 28; }        // mat4(16) + clim(4) + shade(4) + params(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }
  /** The r32float 3D scalar texture (e.g. to share with a SliceRenderer for MPR). */
  volumeTexture(): GPUTexture { return this.volTex; }

  /** Overwrite `depth` z-slices of the volume starting at `z`, in place. The bind group holds a
   *  stable view of volTex, so a render after this picks the new voxels up with no rebuild —
   *  which is what lets a volume be allocated first and filled as its slices arrive. `data` is
   *  one slab in the texture's own dtype (f32 unless the volume was created from a Uint8Array). */
  updateSlab(z: number, data: Float32Array | Uint8Array, depth = 1) {
    const [nx, ny, nz] = this.dims;
    if (z < 0 || z + depth > nz) return;            // out of range: a slice we have no room for
    const bpe = data instanceof Uint8Array ? 1 : 4;
    this.dev.queue.writeTexture(
      { texture: this.volTex, origin: { x: 0, y: 0, z } },
      data,
      { offset: 0, bytesPerRow: nx * bpe, rowsPerImage: ny },
      [nx, ny, depth],
    );
  }
  /** r8unorm volumes sample /255, so clim is packed /normScale in the shader; a slice plane sharing this
   *  texture must use the same factor. 1 for f32 volumes. */
  normScaleOf(): number { return this.normScale; }

  /** Free this field's GPU textures (call when replacing it, e.g. a low-res proxy upgraded to full,
   *  or an LRU-evicted specimen) so VRAM isn't leaked across a menu of large volumes. */
  destroy() { this.volTex.destroy(); this.lutTex.destroy(); }

  /** Centre of the volume in world (RAS) at identity — a natural pivot for a transform widget. */
  worldCenter(): Vec3 {
    const [lo, hi] = this.origBox ?? this.box;
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  }

  /** Place the volume in the world by a rigid transform M (worldFromLocal): the ray samples
   *  at p2t·M⁻¹·wp, so the volume appears moved/rotated. A Tier-A interactive update — caller
   *  does scene.syncUniforms() (which re-packs p2t AND refreshes the ray-entry AABB). */
  setWorldTransform(m: Mat4) {
    if (!this.origP2t) { this.origP2t = this.p2t; this.origBox = this.box; }
    this.p2t = multiply(this.origP2t, invert(m));
    this.box = transformedAABB(m, this.origBox![0], this.origBox![1]);
  }
  /** RAS(patient) -> texture[0,1] matrix (encodes the real ijkToRAS geometry). */
  patientToTexture(): Mat4 { return this.p2t; }
  /** Re-place the volume in RAS without re-uploading voxels (a parent transform moved it). */
  setIjkToRAS(ijkToRAS: ArrayLike<number>) {
    this.p2t = patientToTextureFromIjkToRAS(ijkToRAS, this.dims);
    this.box = volumeAABBFromIjkToRAS(ijkToRAS, this.dims);
    this.stepMm = Math.min(...spacingFromIjkToRAS(ijkToRAS));
  }

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
    out[off + 16] = this.clim[0] / this.normScale; out[off + 17] = this.clim[1] / this.normScale;
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
  clippable?: boolean;                   // let ROI clip planes crop this segment (default true)
  mode?: "iso" | "surface" | "sdf";      // iso = crisp presence shell (default); surface = gradient-opacity translucent (Carve look); sdf = the JfaSdfBaker path — a SOLID whose surface is the 0.5 level set of the band-limited label field (attr.b), with the JFA distance driving the sphere-trace skip
  colorFromTexture?: boolean;            // iso/surface: take per-voxel colour from the texture's .rgb (multi-label) instead of the uniform colour. sdf always does.
  attrTexture?: GPUTexture;              // sdf: per-voxel attribute texture (.r = per-segment opacity). When set, opacity is per-label (translucent surface models) instead of the single uniform value.
  interfaceMode?: boolean;               // sdf: texture .a is an UNSIGNED distance to the nearest label CHANGE (multi-material, JfaSdfBaker "all"). The shell normal is derived on the fly by locally re-signing the distance from the region colour (so the unsigned field's interface — where |grad| collapses — still gets a clean normal), letting embedded/nested labels surface without one SDF per segment.
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
  readonly bindingCount: number;         // 1 (value texture) + 1 when an sdf attr (opacity) texture is bound
  readonly clippable: boolean;
  private tex: GPUTexture;
  private attrTex?: GPUTexture;           // sdf per-voxel attributes (.r = opacity)
  private p2t: Mat4;
  private box: [Vec3, Vec3];
  private color: [number, number, number];
  private opacity: number;
  private shade: [number, number, number, number];
  private bandMm: number;
  private stepMm: number;
  private mode: "iso" | "surface" | "sdf";
  private colorFromTex: boolean;
  private interfaceMode: boolean;
  private voxelMm = 1;
  readonly providesSkip: boolean;
  /** The band-limited SOLID path: sdf mode, outer boundary, with the attr texture that carries the
   *  band-limited label field. This is the only variant that uses the interval crossing test. */
  private outerSolid: boolean;
  /** Interval sampling (Field): the shader is handed the ray distance back to THIS field's previous
   *  sample, so consecutive intervals tile the ray exactly — what makes the crossing test immune to
   *  the per-step ray jitter and to an empty-space leap. */
  readonly intervalSampling: boolean;

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
    this.clippable = opts.clippable ?? true;
    this.voxelMm = voxelMm;
    this.mode = opts.mode ?? "iso";
    this.providesSkip = this.mode === "sdf";   // sdf: the texture .a is a true distance-to-surface → sphere-trace
    this.colorFromTex = opts.colorFromTexture ?? false;
    this.interfaceMode = this.mode === "sdf" && (opts.interfaceMode ?? false);
    this.attrTex = this.mode === "sdf" ? opts.attrTexture : undefined;
    this.bindingCount = this.attrTex ? 2 : 1;
    this.outerSolid = this.mode === "sdf" && !this.interfaceMode && !!this.attrTex;
    this.intervalSampling = this.outerSolid;
  }

  /** Field-level opacity (multiplies every segment's per-label opacity in the shader). Live global
   *  segmentation opacity — the caller does scene.syncUniforms() + redraw to apply. */
  setOpacity(o: number) { this.opacity = Math.max(0, Math.min(1, o)); }
  /** Render the sdf field as VOXEL CUBES instead of its smooth iso-surface (sdf mode only).
   *  What "no smoothing" should mean for a labelmap: one cube per voxel, flat-shaded per face. */
  setVoxelMode(on: boolean) { this.voxelMode = on; }
  voxelMode = false;
  /** Reconstruction width σ (VOXELS) of the band-limited label field the sdf surface is the 0.5
   *  level set of. The field itself is baked by JfaSdfBaker (attr.b); the renderer only needs σ to
   *  keep the sphere-trace skip from leaping over a surface that has moved off the sharp one.
   *  Caller does scene.syncUniforms(). */
  setSmoothingVox(sigmaVoxels: number) { this.sigmaVox = Math.max(0, sigmaVoxels); }
  private sigmaVox = 0;

  uniformFloats() { return 36; }        // mat4(16) + color(4) + shade(4) + params(4) + bmin(4) + bmax(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }
  setTexture(tex: GPUTexture, destroyPrev = true) { if (destroyPrev && this.tex !== tex) this.tex.destroy(); this.tex = tex; }

  /** Empty-space skip for "sdf" mode: the texture .a is a TRUE distance-to-surface (mm), so the ray can
   *  leap |sdf| minus the shell band toward the surface — sphere tracing. A one-voxel safety margin
   *  absorbs the JFA distance approximation so the leap never overshoots a thin shell (image unchanged,
   *  just far fewer march steps). Self-contained (no dependency on the sampling fns' emission order). */
  skipWGSL(s: number): string {
    return /* wgsl */ `
fn skip_seg${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) {
    // OUTSIDE the SDF grid: leap only to the seg's AABB (a contract-valid lower bound), never past it.
    let cen = (u_material.seg${s}_bmin.xyz + u_material.seg${s}_bmax.xyz) * 0.5;
    let ext = (u_material.seg${s}_bmax.xyz - u_material.seg${s}_bmin.xyz) * 0.5;
    let q = abs(transform_point_seg${s}(wp) - cen) - ext;
    return max(0.0, length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0));
  }
  let sd = textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;                      // SIGNED distance to the labelmap surface (mm)
  // An UNSEEDED voxel — one the jump flood never reached a seed from — reports 1e3 mm. That is not a
  // distance, it is "unknown", and leaping on it sails through whatever surface is really there,
  // which is how a partial re-flood used to come back as a flat cut across the shell. No real SDF
  // grid here spans 500 mm, so treat anything beyond that as unknown and march instead of leaping.
  if (abs(sd) > 500.0) { return 0.0; }
  // params.w = σ in mm. The rendered surface is the band-limited field's 0.5 level set, which sits
  // within ~σ of this sharp one, so the leap has to stop that much short of it or a σ-wide feature
  // can be jumped clean over.
  var leap = max(0.0, abs(sd) - u_material.seg${s}_params.x - u_material.seg${s}_params.y - u_material.seg${s}_params.w);
${this.clippable && this.outerSolid ? `  // INSIDE the solid, a clip plane is a surface too (the cut face). Leaping on |sd| alone would sail
  // past it — the ray enters through the clip, sees a big interior distance, and jumps to the far
  // wall, so the cap never gets sampled. Clamp the leap to the nearest plane while inside.
  if (sd < 0.0) {
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      leap = min(leap, abs(dot(wp, cp.xyz) + cp.w));
    }
  }` : ``}
  return leap;
}`;
  }

  structMembers(s: number): string {
    return [
      `  seg${s}_p2t : mat4x4<f32>,`,
      `  seg${s}_color : vec4<f32>,`,    // rgb, opacity
      `  seg${s}_shade : vec4<f32>,`,    // ka, kd, ks, shininess
      `  seg${s}_params : vec4<f32>,`,   // band_mm, voxel_mm, voxel_cubes, smoothing_mm
      `  seg${s}_bmin : vec4<f32>,`,     // aabb min (RAS) — for a contract-valid skip outside the texture
      `  seg${s}_bmax : vec4<f32>,`,
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    const value = `@group(0) @binding(${base}) var t_seg${s} : texture_3d<f32>;`;
    return this.attrTex ? `${value}\n@group(0) @binding(${base + 1}) var t_attr${s} : texture_3d<f32>;` : value;
  }

  samplingWGSL(s: number): string {
    // "sdf" mode: the input texture is a COLORIZED SIGNED-DISTANCE field (rgba16float) — .a = signed
    // distance mm (negative inside), .rgb = the per-label colour of the nearest region — and, in outer
    // mode, an attr texture whose .b is the BAND-LIMITED label field p = G_σ * 1(label != 0).
    //
    // The surface is p = 0.5: a band-limited rendition of the labels, where the smoothing control is
    // the reconstruction width σ, NOT a shading knob. The JFA distance is what the sphere-trace skip
    // and the colour flood use; it no longer decides where the surface is. The per-voxel colour lets
    // one merged surface show multiple labels with a colour seam where different-label neighbours
    // meet, and clip planes cut a real face (CSG) instead of opening the shell.
    if (this.mode === "sdf") {
      return /* wgsl */ `
fn v_seg${s}(wp : vec3<f32>) -> f32 {   // signed distance (mm)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 1e3; }   // far outside → culled
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;
}
fn vgrad_seg${s}(wp : vec3<f32>) -> f32 {   // signed distance for the NORMAL finite-difference
  // A gradient tap that steps just outside the (padded) SDF texture must read BACKGROUND, not the
  // out-of-volume cull sentinel (1e3) — a huge sentinel would fabricate an enormous fake gradient that
  // points out through the volume face and unlights the surface (black speckle at the seg/boundary
  // interface). Clamp to the texture edge: with the padded grid that edge IS background, so the normal
  // near a cap stays correct. This is the "artificial background boundary sample" for the normal.
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;
}
fn col_seg${s}(wp : vec3<f32>) -> vec3<f32> {   // per-label colour of the nearest region
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec3<f32>(0.0); }
  let pm = textureSampleLevel(t_seg${s}, s_lin, t, 0.0).rgb;   // PREMULTIPLIED (rgb·opacity)${this.attrTex ? `
  let a = textureSampleLevel(t_attr${s}, s_lin, t, 0.0).r;      // per-segment opacity (crisp) — un-premultiply to the true colour, so a hidden neighbour's colour doesn't bleed in
  return pm / max(a, 1e-3);` : `
  return pm;`}
}${this.attrTex ? `
fn attr_seg${s}(wp : vec3<f32>) -> vec2<f32> {   // per-segment (.x = opacity, .y = shading mode)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec2<f32>(0.0); }
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).rg;
}` : ""}${this.interfaceMode && this.attrTex ? `
fn bdist_seg${s}(wp : vec3<f32>) -> f32 {   // SMOOTHED interface distance from attr.b (interface mode)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).b;
}
fn pres_seg${s}(wp : vec3<f32>) -> f32 {   // CRISP in-segment presence (attr.a), linear-sampled for ~1-voxel AA
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 0.0; }
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).a;
}`: ""}${this.outerSolid ? `
fn pfield_seg${s}(wp : vec3<f32>) -> f32 {
  // THE BAND-LIMITED LABEL FIELD: p = G_σ * 1(label != 0), carried in attr.b (JfaSdfBaker finalize
  // writes the 0/1 indicator there, the attr blur low-passes it at the smoothing σ). Clamped to the
  // texture edge so a gradient tap just outside the padded grid reads real background instead of a
  // cull sentinel. The surface is the p = 0.5 level set of this, and nothing else.
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).b;
}`: ""}${this.interfaceMode ? `
fn g1_seg${s}(c : f32, wp : vec3<f32>, dir : vec3<f32>, h : f32) -> f32 {
  // One-sided difference of the SMOOTH interface distance along dir, picking the STEEPER side. The
  // unsigned distance has a V-crease at the surface: a central difference straddling it cancels (fake
  // zero gradient → degenerate normal). Taking the steeper one-sided difference follows the true ±1
  // slope AWAY from the interface, so the normal stays well-defined right at the shell — computed on
  // the fly only at shell samples, no stored normal. Uses the blurred distance (attr.b) so the normal
  // is smooth (no JFA facets); the SHARP sdfTex.a still drives shell membership (surface stays at 0).
  let dp = bdist_seg${s}(wp + dir * h) - c;
  let dm = c - bdist_seg${s}(wp - dir * h);
  return select(dm, dp, abs(dp) > abs(dm)) / h;
}` : ""}
// VOXEL CUBES (params.z): the labelmap AS SEGMENTED, one cube per voxel, flat-shaded per face.
//
// This exists because reading the distance field with LINEAR sampling cannot produce it. The zero
// level set of a Euclidean distance field is a smooth surface, and its gradient — the shading
// normal — has RIDGES along the medial lines where the distances from neighbouring source voxels
// meet. Turning the blur off therefore does not reveal voxels; it reveals those ridges, which is
// what "no smoothing" used to look like.
//
// So this path never interpolates: it reads the same texture with textureLoad at the voxel the
// sample falls in. That voxel is solid iff ITS OWN CENTRE is inside (.a < 0), the surface is the
// cube faces of the solid voxels, and the normal is the face normal — constant across each face,
// which is what makes a face read as a face. A face whose neighbour is also solid is interior and
// draws nothing, so the result is the outside of the voxel set, not a lattice.
//
// It is still the same ray-march through the same field: no geometry is built, and the opacity
// uses the same shell profile as the smooth path, measured to the cube face instead of to the
// iso-surface, so the opacity controls behave identically at every smoothing setting.
fn solid_seg${s}(ix : vec3<i32>) -> bool {
  // "Is this voxel part of the segmentation?" — which channel answers that depends on the field.
  // The signed (outer) field says it with the sign of the distance; the multi-material INTERFACE
  // field's distance is UNSIGNED (it measures to the nearest label change, not to the outside),
  // so there it is the crisp per-voxel presence in the attr texture that knows. Reading the sign
  // of an unsigned field is how voxel mode first came out completely empty on every nested
  // segmentation — which is every segmentation with a tumour inside an organ.
${this.interfaceMode && this.attrTex ? `  return textureLoad(t_attr${s}, ix, 0).a > 0.5;` : `  return textureLoad(t_seg${s}, ix, 0).a < 0.0;`}
}
fn voxels_seg${s}(wp : vec3<f32>, rd : vec3<f32>, band : f32, step : f32, seg_op : f32, op0 : f32) -> vec4<f32> {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let dimsf = vec3<f32>(textureDimensions(t_seg${s}));
  let ci = floor(t * dimsf - vec3<f32>(0.5) + vec3<f32>(0.5));   // the voxel this sample is in
  let idx = vec3<i32>(ci);
  let me = textureLoad(t_seg${s}, idx, 0);
  if (!solid_seg${s}(idx)) { return vec4<f32>(0.0); }  // this voxel's centre is outside the segmentation
  // A face perpendicular to texture axis k has texture-space normal e_k; a normal maps from
  // texture to world by the TRANSPOSE of the world→texture linear part (row k of p2t).
  let M = u_material.seg${s}_p2t;
  var rows = array<vec3<f32>, 3>(
    normalize(vec3<f32>(M[0][0], M[1][0], M[2][0])),
    normalize(vec3<f32>(M[0][1], M[1][1], M[2][1])),
    normalize(vec3<f32>(M[0][2], M[1][2], M[2][2])));
  var offs = array<vec3<i32>, 6>(
    vec3<i32>(1, 0, 0), vec3<i32>(-1, 0, 0), vec3<i32>(0, 1, 0),
    vec3<i32>(0, -1, 0), vec3<i32>(0, 0, 1), vec3<i32>(0, 0, -1));
  // Which faces of this cube are EXPOSED (their neighbour is outside)? Of those, shade the one
  // the ray meets most squarely. Picking the geometrically nearest face instead leaves the
  // surface stippled: a ray crossing near a cube's edge is often nearest an INTERIOR face, and
  // that sample then draws nothing even though the cube is visible there.
  let lim = vec3<i32>(dimsf) - vec3<i32>(1);
  var bestDot = -2.0;
  var n = vec3<f32>(0.0);
  var exposed = false;
  var open = array<bool, 6>(false, false, false, false, false, false);
  for (var f = 0; f < 6; f = f + 1) {
    if (solid_seg${s}(clamp(idx + offs[f], vec3<i32>(0), lim))) { continue; }   // interior face
    open[f] = true;
    exposed = true;
    let sgn = select(-1.0, 1.0, (f & 1) == 0);
    let nw = rows[f >> 1] * sgn;
    let dd = -dot(nw, rd);
    if (dd > bestDot) { bestDot = dd; n = nw; }
  }
  if (!exposed) { return vec4<f32>(0.0); }             // fully buried voxel — the shell is one cube thick
  // Which face did the ray actually come IN through? That — not the face most square to the
  // camera — is what makes a cube read as a cube: the step faces catch the light differently
  // from the faces around them, which is the whole visual signal that this is voxels. Slab
  // entry test in voxel space; if that face turns out to be interior (possible when the march
  // steps past a thin feature), fall back to the exposed face the ray meets most squarely.
  let rv = vec3<f32>(
    dot(vec3<f32>(M[0][0], M[1][0], M[2][0]), rd),
    dot(vec3<f32>(M[0][1], M[1][1], M[2][1]), rd),
    dot(vec3<f32>(M[0][2], M[1][2], M[2][2]), rd)) * dimsf;
  let r = t * dimsf - vec3<f32>(0.5) - ci;             // position within the voxel, [-0.5, 0.5]
  var tIn = -1e9;
  var face = -1;
  if (abs(rv.x) > 1e-6) { let tk = (-0.5 * sign(rv.x) - r.x) / rv.x; if (tk > tIn) { tIn = tk; face = select(1, 0, rv.x < 0.0); } }
  if (abs(rv.y) > 1e-6) { let tk = (-0.5 * sign(rv.y) - r.y) / rv.y; if (tk > tIn) { tIn = tk; face = select(3, 2, rv.y < 0.0); } }
  if (abs(rv.z) > 1e-6) { let tk = (-0.5 * sign(rv.z) - r.z) / rv.z; if (tk > tIn) { tIn = tk; face = select(5, 4, rv.z < 0.0); } }
  if (face >= 0 && open[face]) {
    n = rows[face >> 1] * select(-1.0, 1.0, (face & 1) == 0);
  }
${this.attrTex ? `  let at = textureLoad(t_attr${s}, idx, 0);
  let vop = at.r;                                      // per-segment opacity, this voxel's own
  let vcol = me.rgb / max(vop, 1e-3);                  // un-premultiply` : `  let vop = seg_op;
  let vcol = me.rgb;`}
  let T = clamp(op0 * vop, 0.0, 1.0);
  if (T <= 0.0) { return vec4<f32>(0.0); }
  // Optical depth calibrated so crossing ONE voxel accumulates exactly T — the cube-sized
  // equivalent of the shell profile the smooth path uses, so the opacity controls mean the same
  // thing at every smoothing setting.
  let vox = max(u_material.seg${s}_params.y, 1e-4);
  let rate = max(abs(dot(rd, n)), 1e-3);
  let tau = -log(1.0 - min(T, 0.9999)) * (step * rate) / vox;
  let op = 1.0 - exp(-tau);
  if (op <= 0.0004) { return vec4<f32>(0.0); }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ldn = max(dot(-rd, n), 0.0);
  // Faces need to differ in brightness by WHICH WAY THEY FACE, not by how square they are to the
  // camera. A head-lit cube surface viewed down one of its own axes has every visible face at the
  // same angle to the light, and with ka+kd ≈ 1 they all clip to the same flat colour — which is
  // exactly what "voxel mode" looked like before this: a flat silhouette with stepped edges.
  // A fixed overhead sky term (superior-facing brightest, inferior darkest, sides between) makes
  // each face of each cube read separately from any viewpoint, which is the whole point of the
  // mode. No specular: a highlight across flat faces reads as curvature.
  let sky = 0.55 + 0.45 * clamp(0.5 + 0.5 * n.z, 0.0, 1.0);
  var lit = vcol * sky * (ka + kd * ldn);
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);
}
// Surface contribution at wp: a crisp Phong surface. Weighted by (1-mode) so it morphs smoothly
// into the volume contribution across a blurred surface↔volume boundary.
fn surface_seg${s}(wp : vec3<f32>, rd : vec3<f32>, ds : f32, sdf : f32, band : f32, step : f32, seg_op : f32, op0 : f32) -> vec4<f32> {
  if (u_material.seg${s}_params.z > 0.5) { return voxels_seg${s}(wp, rd, band, step, seg_op, op0); }
${this.outerSolid ? `  // A BAND-LIMITED SOLID, found by an INTERVAL CROSSING TEST.
  //
  // A labelmap is a SAMPLED indicator function, and its voxel steps are above the grid's Nyquist
  // limit — they are aliasing, not anatomy. So the faithful surface is the 0.5 level set of that
  // indicator RECONSTRUCTED with a kernel at the limit: p = G_σ * 1(label != 0), which the baker
  // low-passes into attr.b and the smoothing control sets the σ of. Reconstructing with plain
  // trilinear interpolation instead (what σ→0 gives) reproduces the ALIASED surface — flat voxel
  // faces and chamfered edges, which is the chunk. Band-limited, the surface still passes through
  // the voxel faces but carries no energy above Nyquist, which is the smooth.
  //
  // This MOVES the geometry with σ, which earlier versions refused to do because smoothing the
  // signed DISTANCE closed the disc space between two vertebrae and fused them. A BOUNDED
  // indicator cannot: at the centre of a 4-voxel gap p ≈ 2·Φ(-2) ≈ 0.05, nowhere near 0.5. What it
  // does cost is the curvature term, ≈ σ²/2R inward on a convex ridge of radius R — a quarter of a
  // voxel at σ=1 on a 2-voxel vertebral process. Bounded and predictable, which is the trade a
  // smoothing control is supposed to offer.
  //
  // WHY A CROSSING TEST AND NOT A SHELL BAND. A band wants the PERPENDICULAR distance to the
  // surface, and the only way to get that from a scalar field is (0.5 - p)/|grad p| — which falls
  // apart exactly where |grad p| collapses: concave creases where two surfaces meet, and thin
  // features. There the estimated distance diverges, no sample falls inside the band, and an
  // OPAQUE segment renders dusty, with background showing through it. (Measured on a sphere with a
  // plate through it: 5-7% of interior pixels leaking, up to 31% on a single pixel; the shell-band
  // design leaked 8-15%.) The test p > 0.5 has no such failure: it is well defined everywhere, so
  // asking whether THIS interval contains the crossing cannot miss a surface, at any σ, curvature or
  // incidence. Field.intervalSampling hands us the exact distance back to this field's previous
  // sample, so consecutive intervals tile the ray with no gap and no overlap — which is what makes
  // the test exact under the per-step ray jitter, and across an empty-space leap.
  let p1 = pfield_seg${s}(wp);
  let back = wp - rd * max(ds, 1.0e-4);
  let p0 = pfield_seg${s}(back);
  let in1 = p1 > 0.5;
  let in0 = p0 > 0.5;
  var capNormal = vec3<f32>(0.0);
  var prevClipped = false;` : ``}${this.outerSolid && this.clippable ? `
  // SOLID: where a clip plane cuts the body, the body has a FACE there. The ray enters the kept
  // half-space already inside the solid — no surface crossing — so the cut would be a hole into a
  // bubble unless we treat that entry as a face of its own, with the plane's normal. The previous
  // sample is the test: if it was on the discarded side, this interval crossed the plane.
  let ccount = u32(u_material.clip_count.x);
  for (var ci = 0u; ci < ccount; ci = ci + 1u) {
    let cp = u_material.clip_planes[ci];
    if (dot(back, cp.xyz) + cp.w < 0.0) { prevClipped = true; capNormal = -cp.xyz; }
  }` : ``}${this.outerSolid ? `
  let surfaceCross = in1 != in0;
  if (!(surfaceCross || (in1 && prevClipped))) { return vec4<f32>(0.0); }
  // Where in the interval: linear in p, which is exact to first order and sub-voxel in practice.
  let u = select(1.0, clamp((0.5 - p0) / (p1 - p0), 0.0, 1.0), surfaceCross);
  let wc = back + (wp - back) * u;
  let T = clamp(op0 * seg_op, 0.0, 1.0);
  if (T <= 0.0) { return vec4<f32>(0.0); }
  // Normal from a FULL-VOXEL central difference of p. attr.b is read trilinearly, so the field is
  // only C0 and its gradient jumps at every voxel-face plane; differencing inside a single cell
  // (h = half a voxel) reports that cell's own gradient and the jumps show up as a rectangular
  // lattice of dark creases over the surface — a maze, worst at small σ where the field is
  // steepest. A full-voxel difference straddles the discontinuity and averages it out. Geometry
  // and normal now come from the SAME field, which is what stops a stepped silhouette from being
  // lit like a smooth one.
  let hg = max(u_material.seg${s}_params.y, step);
  let gp = vec3<f32>(
    pfield_seg${s}(wc + vec3<f32>(hg,0,0)) - pfield_seg${s}(wc - vec3<f32>(hg,0,0)),
    pfield_seg${s}(wc + vec3<f32>(0,hg,0)) - pfield_seg${s}(wc - vec3<f32>(0,hg,0)),
    pfield_seg${s}(wc + vec3<f32>(0,0,hg)) - pfield_seg${s}(wc - vec3<f32>(0,0,hg))) / (2.0 * hg);
  let glen = length(gp);
  // p increases INWARD, so the outward normal is -grad p. On a cap (entered through a clip plane
  // with no crossing) the face is the plane, so its normal is the plane's.
  var n = select(capNormal, -gp / max(glen, 1.0e-6), surfaceCross && glen > 1.0e-5);
  if (dot(n, n) < 0.25) { n = -rd; }     // degenerate: face the camera rather than drop the sample
  if (dot(n, -rd) < 0.0) { n = -n; }
  // ONE crossing = exactly the target opacity T, by construction — no band, no profile integral,
  // no dependence on the sample step or the incidence angle. Front and back faces of a translucent
  // segment still compose to 1-(1-T)², as a pair of polydata surfaces would.
  let op = T;
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = col_seg${s}(wc);
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);` : `
  let d_mm = abs(sdf);
  if (d_mm > band + step) { return vec4<f32>(0.0); }
  let T = clamp(op0 * seg_op, 0.0, 1.0);      // TARGET surface opacity (per-segment × field)
  if (T <= 0.0) { return vec4<f32>(0.0); }
  let h = step;
${this.interfaceMode ? `  let hg = 1.5 * step;
  let dc = bdist_seg${s}(wp);
  let g = vec3<f32>(
    g1_seg${s}(dc, wp, vec3<f32>(1,0,0), hg),
    g1_seg${s}(dc, wp, vec3<f32>(0,1,0), hg),
    g1_seg${s}(dc, wp, vec3<f32>(0,0,1), hg));` : `  let g = vec3<f32>(
    vgrad_seg${s}(wp + vec3<f32>(h,0,0)) - vgrad_seg${s}(wp - vec3<f32>(h,0,0)),
    vgrad_seg${s}(wp + vec3<f32>(0,h,0)) - vgrad_seg${s}(wp - vec3<f32>(0,h,0)),
    vgrad_seg${s}(wp + vec3<f32>(0,0,h)) - vgrad_seg${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);`}
  let glen = length(g);
  if (glen < 1.0e-5) { return vec4<f32>(0.0); }
  var n = g / glen;
  if (dot(n, -rd) < 0.0) { n = -n; }
  // SURFACE opacity (Slicer polydata parity): the shell is a THIN surface of opacity T, not a solid
  // band. A raymarch crosses it in several samples; giving each α=T lets the front-to-back OVER
  // saturate toward opaque (50% looked like ~100%). Instead accumulate OPTICAL DEPTH with a shell
  // profile ρ = a/band that integrates to 1 across the crossing, scaled by -ln(1-T): Σdτ = -ln(1-T),
  // so net opacity = 1-e^(-Σdτ) = T EXACTLY — independent of band thickness and sample rate, and T→1
  // stays crisply opaque. |dot(rd,n)| converts ray-step to shell-normal distance (→0 at grazing =
  // built-in silhouette AA).
  let a = max(1.0 - d_mm / band, 0.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  let rate = max(abs(dot(rd, ${this.interfaceMode ? "n" : "g"})), 1.0e-3);
  let tau = -log(1.0 - min(T, 0.9999)) * (a / band) * (step * rate);
  var op = 1.0 - exp(-tau);
${this.interfaceMode ? `  op = op * pres_seg${s}(wp);   // gate to GENUINELY in-segment voxels — kills the bled colour/opacity halo beyond the real edge` : ""}
  if (op <= 0.0004) { return vec4<f32>(0.0); }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = col_seg${s}(wp);
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);`}
}
fn sample_field_seg${s}(wp : vec3<f32>, rd : vec3<f32>${this.intervalSampling ? ", ds : f32" : ""}) -> vec4<f32> {
  let op0 = u_material.seg${s}_color.a;
  if (op0 <= 0.0) { return vec4<f32>(0.0); }
  let sdf = v_seg${s}(wp);
  let band = max(u_material.seg${s}_params.x, 1e-3);
  let step = max(u_material.scene.x, 1e-3);
${this.attrTex ? `  let at = attr_seg${s}(wp);        // (opacity, shading mode)
  let seg_op = at.x;
  if (seg_op <= 0.0) { return vec4<f32>(0.0); }
  let mode = clamp(at.y, 0.0, 1.0);
  // Surface and volume are BLENDED by the (seam-blurred, fractional) mode, so an opaque-surface
  // segment and a translucent-volume segment meet with a smooth transition instead of a jagged,
  // voxel-quantized classification edge.
  var acc = vec4<f32>(0.0);
  if (mode > 0.001 && sdf < 0.0) {
    // VOLUME: translucent DVR fill of the interior (~24 mm opacity-unit-distance).
    let vop = clamp(op0 * seg_op * step / 24.0, 0.0, 1.0);
    if (vop > 0.0) {
      let vcol = srgb2physical(clamp(col_seg${s}(wp), vec3<f32>(0.0), vec3<f32>(1.0)));
      acc += mode * vec4<f32>(vcol * vop, vop);
    }
  }
  if (mode < 0.999) {
    acc += (1.0 - mode) * surface_seg${s}(wp, rd, ${this.intervalSampling ? "ds" : "step"}, sdf, band, step, seg_op, op0);
  }
  return acc;` : `  return surface_seg${s}(wp, rd, step, sdf, band, step, 1.0, op0);`}
}`;
    }
    // The ONLY difference between iso and surface is the alpha rule (everything else — sampling,
    // gradient, Phong — is shared), matching wgpu_vtk_inject.py's _seg_field_wgsl vs
    // _seg_surface_field_wgsl (same helper, different α).
    //   iso     : crisp 1-voxel band around the v=0.5 isosurface → opaque shell.
    //   surface : α_step = opacity·|grad v|·step; integrated across the 0→1 presence transition it
    //             sums to opacity regardless of thickness → parity with Slicer's polydata surface
    //             (a 30%-opaque segment accumulates ~0.3 α per crossing, front+back faces add).
    // scene.x IS the ray-march dt (SceneRenderer.setSampleStep), so the emission integral is
    // correctly scaled by the actual step distance.
    const alphaWGSL = this.mode === "surface"
      ? /* wgsl */ `
  let step = max(u_material.scene.x, 1e-3);
  let op = clamp(op0 * glen * step, 0.0, 1.0);
  if (op <= 0.0) { return vec4<f32>(0.0); }`
      : /* wgsl */ `
  // Local first-order signed distance to the v=0.5 isosurface (mm), then a
  // 1-voxel opacity band around it: crisp opaque shell, sub-voxel anti-aliased.
  let d_mm = abs((v - 0.5) / glen);
  let band = max(u_material.seg${s}_params.x, 1e-3);
  let a = 1.0 - clamp(d_mm / band, 0.0, 1.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  let op = clamp(a * op0, 0.0, 1.0);`;
    // Colour source: the uniform (single-label, default) or the texture's .rgb (multi-label — the
    // colorize bake stores per-label colour in rgb, presence in .a). Only the colour differs.
    const colWGSL = this.colorFromTex
      ? /* wgsl */ `
fn col_seg${s}(wp : vec3<f32>) -> vec3<f32> {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec3<f32>(0.0); }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).rgb;
}`
      : "";
    const colExpr = this.colorFromTex ? `col_seg${s}(wp)` : `u_material.seg${s}_color.rgb`;
    return /* wgsl */ `
fn v_seg${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 0.0; }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;   // Gaussian-smoothed presence in .a
}${colWGSL}
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
  if (glen < 1e-5) { return vec4<f32>(0.0); }${alphaWGSL}
  // Phong from the same gradient, normal flipped to face the camera.
  var n = g / glen;
  if (dot(n, -rd) < 0.0) { n = -n; }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = ${colExpr};
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.color[0]; out[off + 17] = this.color[1]; out[off + 18] = this.color[2]; out[off + 19] = this.opacity;
    out[off + 20] = this.shade[0]; out[off + 21] = this.shade[1]; out[off + 22] = this.shade[2]; out[off + 23] = this.shade[3];
    out[off + 24] = this.bandMm; out[off + 25] = this.voxelMm;
    out[off + 26] = this.voxelMode ? 1 : 0;   // params.z — cube rendering (sdf mode)
    out[off + 27] = this.sigmaVox * this.voxelMm;   // params.w — band-limit σ in mm (skip-horizon margin)
    out[off + 28] = this.box[0][0]; out[off + 29] = this.box[0][1]; out[off + 30] = this.box[0][2];
    out[off + 32] = this.box[1][0]; out[off + 33] = this.box[1][1]; out[off + 34] = this.box[1][2];
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    const e = [{ binding: base, resource: this.tex.createView() }];
    if (this.attrTex) e.push({ binding: base + 1, resource: this.attrTex.createView() });
    return e;
  }
}

export interface RGBAFieldOpts {
  center?: Vec3;
  ijkToRAS?: ArrayLike<number>;          // real rotated/anisotropic geometry (aligns with an ImageField)
  opacityUnitDistance?: number;
  shade?: [number, number, number, number];
  clippable?: boolean;                   // let ROI clip planes crop this volume (default true)
}

/** A pre-baked rgba16float volume (color + smoothed presence-alpha), e.g. the
 *  ColorizeVolume bake of a segmentation. Density-mode DVR with headlight Phong. */
export class RGBAVolumeField implements Field {
  readonly kind = "rgba";
  readonly bindingCount = 1;            // baked rgba texture (sampler shared)
  readonly clippable: boolean;
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
    this.clippable = opts.clippable ?? true;
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
