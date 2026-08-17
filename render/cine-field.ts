// CineField — a time-varying scalar volume (4D), rendered exactly like ImageField.
//
// Design and measurements: docs/SEQUENCES-CINE.md. Three facts drive the implementation:
//
//   1. WGSL has NO texture_3d_array (verified: the module fails to compile), so the frame
//      set must be N separate 3D textures selected by BIND GROUP, not an arrayed texture.
//   2. Z-stacking frames into one 3D texture is not viable either: maxTextureDimension3D is
//      2048, and even a 20-phase 192x192x128 cine needs 2560.
//   3. Keeping every frame resident costs ZERO per-frame data movement, versus 9.3 ms to
//      re-upload a 44 MB frame from the host. So: all frames resident, swap the bound view,
//      and let SceneRenderer.refreshBindings() rebuild the bind group (no pipeline rebuild).
//
// Frames are r16float rather than r32float: half the memory, and — unlike r32float — it is
// filterable in CORE WebGPU with no optional feature. float16 is exact for integers to 2048,
// which covers cardiac CT Hounsfield units.
//
// Two frames are bound at once (A and B) with a blend weight, so playback can interpolate
// between phases instead of stepping. Set blend=0 to show frame A exactly.

import {
  applyMat4,
  invert,
  type Mat4,
  multiply,
  type Vec3,
  patientToTextureFromIjkToRAS,
  spacingFromIjkToRAS,
  volumeAABBFromIjkToRAS,
} from "./mat4.ts";
import type { Field } from "./fields.ts";

function transformedAABB(m: Mat4, lo: Vec3, hi: Vec3): [Vec3, Vec3] {
  const mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = applyMat4(m, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c[a]); mx[a] = Math.max(mx[a], c[a]); }
  }
  return [mn, mx];
}

/** IEEE-754 binary16 encode. Exact for integers to 2048; step 2 to 4096, 4 to 8192. */
export function f32tof16(v: number): number {
  const f = new Float32Array(1); f[0] = v;
  const u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000;
  let exp = ((u >>> 23) & 0xff) - 127 + 15;
  const man = u & 0x7fffff;
  if (exp <= 0) return sign;                      // underflow -> signed zero
  if (exp >= 31) return sign | 0x7c00;            // overflow  -> signed inf
  return sign | (exp << 10) | (man >>> 13);
}

export function toF16Array(src: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = f32tof16(src[i]);
  return out;
}

export interface CineFieldOpts {
  clim: [number, number];
  ijkToRAS: ArrayLike<number>;
  opacityUnitDistance?: number;
  shade?: [number, number, number, number];
}

export class CineField implements Field {
  readonly kind = "cine";
  readonly bindingCount = 3;              // volA (3d) + volB (3d) + lut (2d)
  private texes: GPUTexture[] = [];
  private filled: boolean[] = [];
  private dims: Vec3 = [0, 0, 0];
  private lutTex: GPUTexture;
  private dev: GPUDevice;
  private p2t: Mat4;
  private clim: [number, number];
  private shade: [number, number, number, number];
  private unit: number;
  private stepMm: number;
  private box: [Vec3, Vec3];
  private a = 0;                          // index of frame A
  private b = 0;                          // index of frame B
  private blend = 0;                      // 0 => pure A

  /** Allocates `frameCount` empty frame textures; fill them with setFrameData(i, data) as
   *  they arrive. Progressive loading matters: the first phase can be shown (and the scene
   *  built) after ~1 MB instead of waiting for the whole sequence. Frames not yet supplied
   *  read as zero, so always show a frame you have actually filled. */
  constructor(
    dev: GPUDevice,
    frames: ArrayLike<number>[] | number,
    dims: Vec3,
    lut: Uint8Array,
    opts: CineFieldOpts,
  ) {
    const count = typeof frames === "number" ? frames : frames.length;
    if (!count) throw new Error("CineField needs at least one frame");
    const size = dims as [number, number, number];
    this.dims = dims;
    for (let i = 0; i < count; i++) {
      this.texes.push(dev.createTexture({
        size, dimension: "3d", format: "r16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }));
    }
    this.filled = new Array(count).fill(false);
    this.dev = dev;
    if (typeof frames !== "number") frames.forEach((f, i) => this.setFrameData(i, f));

    this.lutTex = dev.createTexture({ size: [256, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);

    this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
    this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
    this.stepMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    this.clim = opts.clim;
    this.shade = opts.shade ?? [0.25, 0.75, 0.5, 24];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
  }

  /** Upload one phase's voxels (C-order z,y,x) into its preallocated texture. */
  setFrameData(i: number, data: ArrayLike<number>): void {
    const [nx, ny, nz] = this.dims;
    this.dev.queue.writeTexture({ texture: this.texes[i] }, toF16Array(data),
      { bytesPerRow: nx * 2, rowsPerImage: ny }, [nx, ny, nz]);
    this.filled[i] = true;
  }
  /** True once setFrameData has been called for this phase. */
  hasFrame(i: number): boolean { return !!this.filled[i]; }
  get framesLoaded(): number { return this.filled.reduce((n, f) => n + (f ? 1 : 0), 0); }

  get frameCount(): number { return this.texes.length; }
  get frame(): number { return this.a; }

  /** Select the displayed frame. Fractional values interpolate toward the next frame.
   *  Caller then does scene.refreshBindings() (bind group only — no pipeline rebuild)
   *  and scene.syncUniforms() for the blend weight. */
  setFrame(t: number, loop = true) {
    const n = this.texes.length;
    const wrap = (i: number) => loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    this.a = wrap(Math.floor(t));
    this.b = wrap(Math.floor(t) + 1);
    this.blend = t - Math.floor(t);
  }

  setLUT(lut: Uint8Array) {
    this.dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
  }

  private origP2t?: Mat4;
  private origBox?: [Vec3, Vec3];

  uniformFloats() { return 28; }          // mat4(16) + clim(4) + shade(4) + params(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }
  /** The currently displayed frame's texture (e.g. to share with a SliceRenderer for MPR). */
  volumeTexture(): GPUTexture { return this.texes[this.a]; }

  worldCenter(): Vec3 {
    const [lo, hi] = this.origBox ?? this.box;
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  }

  setWorldTransform(m: Mat4) {
    if (!this.origP2t) { this.origP2t = this.p2t; this.origBox = this.box; }
    this.p2t = multiply(this.origP2t, invert(m));
    this.box = transformedAABB(m, this.origBox![0], this.origBox![1]);
  }
  patientToTexture(): Mat4 { return this.p2t; }

  structMembers(s: number): string {
    return [
      `  cine${s}_p2t : mat4x4<f32>,`,
      `  cine${s}_clim : vec4<f32>,`,     // lo, hi, _, _
      `  cine${s}_shade : vec4<f32>,`,    // ka, kd, ks, shininess
      `  cine${s}_params : vec4<f32>,`,   // opacity_unit_distance, blend, _, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return [
      `@group(0) @binding(${base}) var t_volA_cine${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 1}) var t_volB_cine${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 2}) var t_lut_cine${s} : texture_2d<f32>;`,
    ].join("\n");
  }

  // Mirrors ImageField.samplingWGSL exactly, except the scalar is a lerp of two frames.
  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sampc_cine${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.cine${s}_p2t * vec4<f32>(transform_point_cine${s}(wp), 1.0);
  let tex = clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  let va = textureSampleLevel(t_volA_cine${s}, s_lin, tex, 0.0).r;
  let vb = textureSampleLevel(t_volB_cine${s}, s_lin, tex, 0.0).r;
  return mix(va, vb, u_material.cine${s}_params.y);
}
fn sample_field_cine${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let t4 = u_material.cine${s}_p2t * vec4<f32>(transform_point_cine${s}(wp), 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let va = textureSampleLevel(t_volA_cine${s}, s_lin, tex, 0.0).r;
  let vb = textureSampleLevel(t_volB_cine${s}, s_lin, tex, 0.0).r;
  let val = mix(va, vb, u_material.cine${s}_params.y);
  let lo = u_material.cine${s}_clim.x; let hi = u_material.cine${s}_clim.y;
  let tf = textureSampleLevel(t_lut_cine${s}, s_lin, vec2<f32>(clamp((val - lo) / max(hi - lo, 1e-6), 0.0, 1.0), 0.5), 0.0);
  let step = u_material.scene.x;
  let unit = max(u_material.cine${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(tf.a, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }
  let h = step * 2.0;
  let g = vec3<f32>(
    sampc_cine${s}(wp + vec3<f32>(h,0,0)) - sampc_cine${s}(wp - vec3<f32>(h,0,0)),
    sampc_cine${s}(wp + vec3<f32>(0,h,0)) - sampc_cine${s}(wp - vec3<f32>(0,h,0)),
    sampc_cine${s}(wp + vec3<f32>(0,0,h)) - sampc_cine${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  let ka = u_material.cine${s}_shade.x; let kd = u_material.cine${s}_shade.y;
  let ks = u_material.cine${s}_shade.z; let sh = u_material.cine${s}_shade.w;
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
    out[off + 24] = this.unit; out[off + 25] = this.blend;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [
      { binding: base, resource: this.texes[this.a].createView() },
      { binding: base + 1, resource: this.texes[this.b].createView() },
      { binding: base + 2, resource: this.lutTex.createView() },
    ];
  }
}
