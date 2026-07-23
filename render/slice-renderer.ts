// MPR slice renderer — an ANATOMICALLY CORRECT orthographic reslice of a scalar
// volume (+ optional colored overlay). The plane is defined in RAS (patient) space;
// each output pixel maps view(u,v) -> RAS -> texture[0,1] via the volume's
// patientToTexture, which folds in the real ijkToRAS (rotation + anisotropic spacing).
// This is the WebGPU equivalent of Slicer's vtkImageReslice / the legacy viewer's
// xyToIJK = inv(ijkToRAS)*xyToRAS. Voxel-index (IJK) planes are NOT anatomical planes
// for an oblique/anisotropic acquisition, so we never slice in texture space directly.
//
// Aspect: the view is isotropic in mm (letterboxed) so proportions are never distorted;
// a plane axis with fewer/thicker slices (e.g. a sagittally-acquired volume's R axis)
// still shows at its true physical size. One draw = one plane; the 4-up uses three.

import type { Gpu } from "./device.ts";
import { applyMat4, type Mat4, type Vec3 } from "./mat4.ts";

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";

export type Orientation = "axial" | "coronal" | "sagittal";

const SHADER = /* wgsl */ `
struct U {
  p2t : mat4x4<f32>,     // RAS -> texture[0,1] (folds in ijkToRAS: rotation + anisotropy)
  origin : vec4<f32>,    // RAS of the plane center (for the current scrub offset)
  uvec : vec4<f32>,      // RAS vector spanning the view width  (isotropic mm)
  vvec : vec4<f32>,      // RAS vector spanning the view height (isotropic mm)
  params : vec4<f32>,    // win, lev, overlayOpacity, _
  size : vec4<f32>,      // sizeX, sizeY, _, _
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var t_scalar : texture_3d<f32>;
@group(0) @binding(3) var t_overlay : texture_3d<f32>;

struct V { @builtin(position) position : vec4<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> V {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : V; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92; let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
@fragment
fn fs_main(v : V) -> @location(0) vec4<f32> {
  let uv = v.position.xy / u.size.xy;                 // [0,1], y down
  let ras = u.origin.xyz + u.uvec.xyz * (uv.x - 0.5) + u.vvec.xyz * (0.5 - uv.y);
  let t4 = u.p2t * vec4<f32>(ras, 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let val = textureSampleLevel(t_scalar, s_lin, tex, 0.0).r;
  let win = max(u.params.x, 1e-6);
  let g = clamp((val - (u.params.y - win * 0.5)) / win, 0.0, 1.0);
  var col = vec3<f32>(g);
  let ov = textureSampleLevel(t_overlay, s_lin, tex, 0.0);
  col = mix(col, ov.rgb, clamp(ov.a * u.params.z, 0.0, 1.0));
  return vec4<f32>(srgb2physical(col), 1.0);
}
`;

// Standard anatomical plane bases (RAS). uDir/vDir span the view; nAxis is the RAS
// axis the plane scrubs along. Screen-up = +vDir (superior for cor/sag, anterior for
// axial); screen-right = uDir. Geometry/aspect are exact; L/R display convention is
// neurological (+R to the right) — a display preference, not a geometry choice.
const BASES: Record<Orientation, { uDir: Vec3; vDir: Vec3; uAxis: number; vAxis: number; nAxis: number }> = {
  axial: { uDir: [1, 0, 0], vDir: [0, 1, 0], uAxis: 0, vAxis: 1, nAxis: 2 },
  coronal: { uDir: [1, 0, 0], vDir: [0, 0, 1], uAxis: 0, vAxis: 2, nAxis: 1 },
  sagittal: { uDir: [0, 1, 0], vDir: [0, 0, 1], uAxis: 1, vAxis: 2, nAxis: 0 },
};

export class SliceRenderer {
  private dev: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private ubuf: GPUBuffer;
  private u = new Float32Array(36);  // p2t(16) + origin(4) + uvec(4) + vvec(4) + params(4) + size(4)
  private bind?: GPUBindGroup;
  private overlay?: GPUTexture;

  // volume geometry + current plane
  private p2t: Mat4 = new Float32Array(16);
  private rasLo: Vec3 = [-1, -1, -1];
  private rasHi: Vec3 = [1, 1, 1];
  private orient: Orientation = "axial";
  private offset01 = 0.5;

  constructor(gpu: Gpu, format: GPUTextureFormat = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    const m = this.dev.createShaderModule({ code: SHADER });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs_main" },
      fragment: { module: m, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.ubuf = this.dev.createBuffer({ size: this.u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.setWindowLevel(255, 127);
    this.setOverlayOpacity(0.55);
  }

  private emptyOverlay?: GPUTexture;
  private transparentOverlay(): GPUTexture {
    if (!this.emptyOverlay) {
      this.emptyOverlay = this.dev.createTexture({ size: [1, 1, 1], dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyOverlay }, new Uint16Array(4), { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.emptyOverlay;
  }

  /** Volume geometry: patientToTexture (RAS->tex[0,1], encodes ijkToRAS) + the RAS
   *  bounding box (for plane extents/scrub range). Get both from the ImageField. */
  setVolume(p2t: Mat4, rasLo: Vec3, rasHi: Vec3) {
    this.p2t = p2t; this.rasLo = rasLo; this.rasHi = rasHi;
    this.u.set(p2t, 0);
  }

  /** Set the grayscale scalar (r32float 3d) and, optionally, a colored overlay
   *  (rgba16float 3d) — which MUST share the same geometry (ijkToRAS/dims) so the
   *  same RAS->tex mapping addresses both. Omit overlay for a plain MPR. */
  setTextures(scalar: GPUTexture, overlay?: GPUTexture) {
    this.overlay = overlay ?? this.transparentOverlay();
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: scalar.createView() },
        { binding: 3, resource: this.overlay.createView() },
      ],
    });
  }

  // Uniform float layout: p2t[0..15] origin[16..19] uvec[20..23] vvec[24..27] params[28..31] size[32..35]
  /** Select the anatomical plane and scrub position (0..1 along the plane normal, RAS bbox). */
  setPlane(orient: Orientation, offset01: number) {
    this.orient = orient;
    this.offset01 = Math.max(0, Math.min(1, offset01));
  }
  setWindowLevel(win: number, lev: number) { this.u[28] = win; this.u[29] = lev; }
  setOverlayOpacity(o: number) { this.u[30] = o; }

  /** Physical size (mm) of the square view for the current plane (isotropic, letterboxed). */
  private viewSpanMm(): number {
    const b = BASES[this.orient];
    const uExt = this.rasHi[b.uAxis] - this.rasLo[b.uAxis];
    const vExt = this.rasHi[b.vAxis] - this.rasLo[b.vAxis];
    return Math.max(uExt, vExt) * 1.02; // small border
  }

  /** Plane center in RAS for the current scrub offset. */
  private planeCenter(): Vec3 {
    const b = BASES[this.orient];
    const c: Vec3 = [
      (this.rasLo[0] + this.rasHi[0]) / 2,
      (this.rasLo[1] + this.rasHi[1]) / 2,
      (this.rasLo[2] + this.rasHi[2]) / 2,
    ];
    c[b.nAxis] = this.rasLo[b.nAxis] + this.offset01 * (this.rasHi[b.nAxis] - this.rasLo[b.nAxis]);
    return c;
  }

  /** Map a view (u,v) in [0,1] (y down) to normalized texture coords for the current
   *  plane — for click picking. Returns the tex coord; the caller converts to IJK via
   *  ijk = tex*dims - 0.5. Anisotropy/rotation are handled by the same p2t the shader uses. */
  viewToTex(u: number, v: number): Vec3 {
    const b = BASES[this.orient];
    const span = this.viewSpanMm();
    const c = this.planeCenter();
    const ras: Vec3 = [
      c[0] + b.uDir[0] * (u - 0.5) * span + b.vDir[0] * (0.5 - v) * span,
      c[1] + b.uDir[1] * (u - 0.5) * span + b.vDir[1] * (0.5 - v) * span,
      c[2] + b.uDir[2] * (u - 0.5) * span + b.vDir[2] * (0.5 - v) * span,
    ];
    return applyMat4(this.p2t, ras);
  }

  private drawInto(view: GPUTextureView, w: number, h: number) {
    const b = BASES[this.orient];
    const span = this.viewSpanMm();
    const c = this.planeCenter();
    this.u.set(this.p2t, 0);                                                                  // p2t   [0..15]
    this.u[16] = c[0]; this.u[17] = c[1]; this.u[18] = c[2]; this.u[19] = 0;                   // origin[16..19]
    this.u[20] = b.uDir[0] * span; this.u[21] = b.uDir[1] * span; this.u[22] = b.uDir[2] * span; this.u[23] = 0; // uvec [20..23]
    this.u[24] = b.vDir[0] * span; this.u[25] = b.vDir[1] * span; this.u[26] = b.vDir[2] * span; this.u[27] = 0; // vvec [24..27]
    // params[28..30] set via setWindowLevel/setOverlayOpacity
    this.u[32] = w; this.u[33] = h;                                                            // size [32..35]
    this.dev.queue.writeBuffer(this.ubuf, 0, this.u);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind!); pass.draw(3); pass.end();
    this.dev.queue.submit([enc.finish()]);
  }

  renderToView(view: GPUTextureView, w: number, h: number) { this.drawInto(view, w, h); }

  async renderToRGBA(w: number, h: number): Promise<Uint8Array> {
    const target = this.dev.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.drawInto(target.createView(), w, h);
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, [w, h]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(padded.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }
}
