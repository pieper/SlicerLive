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
  params : vec4<f32>,    // win, lev, fillOpacity, outlineOpacity
  size : vec4<f32>,      // sizeX, sizeY, labelOverlayMode, _
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var t_scalar : texture_3d<f32>;
@group(0) @binding(3) var t_overlay : texture_3d<f32>;
@group(0) @binding(4) var s_nn : sampler;   // NEAREST — labelmap overlay is per-voxel crisp (matches Slicer)
// Label-overlay mode (size.z > 0.5): instead of a pre-coloured rgba volume, take the segment
// number from a u8 label volume and its colour+opacity from the same 256x2 palette the
// ColorizeField uses. A coloured overlay of a 509x365x299 CT would be 222 MB; label + palette
// is 55 MB and, because it shares the palette, hiding an organ group in 3D hides it here too.
@group(0) @binding(5) var t_labels : texture_3d<u32>;
@group(0) @binding(6) var t_palette : texture_2d<f32>;

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
/** The overlay colour at a texture coordinate, from whichever source is configured. */
fn ov_tex(t : vec3<f32>) -> vec4<f32> {
  if (u.size.z > 0.5) {
    let d = vec3<f32>(textureDimensions(t_labels));
    let vi = vec3<i32>(clamp(floor(t * d), vec3<f32>(0.0), d - vec3<f32>(1.0)));
    let lab = i32(textureLoad(t_labels, vi, 0).r);
    if (lab == 0) { return vec4<f32>(0.0); }
    return textureLoad(t_palette, vec2<i32>(lab, 1), 0);
  }
  return textureSampleLevel(t_overlay, s_nn, t, 0.0);
}
fn ov_at(ras : vec3<f32>) -> vec4<f32> {   // overlay at a RAS point (0 outside the volume)
  let t = (u.p2t * vec4<f32>(ras, 1.0)).xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  return ov_tex(t);
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
  let ov = ov_tex(tex);
  // Slicer-style 2D segmentation: a semi-transparent per-voxel FILL plus a brighter boundary
  // OUTLINE, with independent opacities (params.z = fill, params.w = outline). The outline is
  // screen-space (constant pixel width under zoom), drawn in the segment's own colour along its
  // inner edge — at both label↔label and label↔background boundaries.
  let fillA = clamp(ov.a * u.params.z, 0.0, 1.0);
  var outA = 0.0;
  if (u.params.w > 0.0) {
    let du = u.uvec.xyz / u.size.x * 1.5;   // ~1.5 px right, in RAS
    let dv = u.vvec.xyz / u.size.y * 1.5;   // ~1.5 px up
    let n0 = ov_at(ras + du); let n1 = ov_at(ras - du); let n2 = ov_at(ras + dv); let n3 = ov_at(ras - dv);
    let e = max(max(distance(n0.rgb, ov.rgb) + abs(n0.a - ov.a), distance(n1.rgb, ov.rgb) + abs(n1.a - ov.a)),
                max(distance(n2.rgb, ov.rgb) + abs(n2.a - ov.a), distance(n3.rgb, ov.rgb) + abs(n3.a - ov.a)));
    let edge = clamp((e - 0.03) * 12.0, 0.0, 1.0);   // 0 in the interior, 1 at a colour/label edge
    outA = clamp(ov.a * u.params.w * edge, 0.0, 1.0);
  }
  col = mix(col, ov.rgb, max(fillA, outA));
  return vec4<f32>(srgb2physical(col), 1.0);
}
`;

// Standard anatomical plane bases (RAS), matching Slicer's default Axial/Coronal/Sagittal
// sliceToRAS presets EXACTLY (RADIOLOGICAL convention). uDir = screen-right in RAS,
// vDir = screen-up, nAxis = the RAS axis the plane scrubs along:
//   Axial    screen-right = -R (patient LEFT on the right),   up = +A   (sliceToRAS col0=-R, col1=+A)
//   Coronal  screen-right = -R,                               up = +S   (col0=-R, col1=+S)
//   Sagittal screen-right = -A (posterior on the right),      up = +S   (col0=-A, col1=+S)
// These signs are NOT a free display preference: RAS data shown with +R-to-the-right reads
// as a left-right (LPS/RAS) flip vs every Slicer view. Never diverge from Slicer's presets.
//
// The three anatomical presets are the DEFAULT basis, not the only one: a basis is just a
// (uDir, vDir, nDir) triple in RAS, and setBasis() accepts an arbitrary one so a view can be
// resliced along a volume's own acquisition axes (see PlaneBasis / setBasis). Everything
// downstream — span, scrub, projection — works off those vectors, so the anatomical cases
// reduce to exactly the arithmetic they always used.
export interface PlaneBasis { uDir: Vec3; vDir: Vec3; nDir: Vec3 }

const BASES: Record<Orientation, PlaneBasis> = {
  axial: { uDir: [-1, 0, 0], vDir: [0, 1, 0], nDir: [0, 0, 1] },
  coronal: { uDir: [-1, 0, 0], vDir: [0, 0, 1], nDir: [0, 1, 0] },
  sagittal: { uDir: [0, -1, 0], vDir: [0, 0, 1], nDir: [1, 0, 0] },
};
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Which IJK axis is most aligned with a given RAS axis, per the volume's ijkToRAS
 *  (row-major). Returns the column index of the 3x3 whose |component| on `rasAxis` is largest. */
function ijkAxisForRasAxis(ijkToRAS: ArrayLike<number>, rasAxis: 0 | 1 | 2): number {
  let best = 0, bestMag = -1;
  for (let c = 0; c < 3; c++) {
    const mag = Math.abs(ijkToRAS[rasAxis * 4 + c]);
    if (mag > bestMag) { bestMag = mag; best = c; }
  }
  return best;
}

/** Slicer's DEFAULT slice position for a freshly-loaded volume, as offset01 in the RAS bbox.
 *
 *  Slicer does not park the slice at the bounding-box centre — it snaps to the voxel-centre
 *  plane at index floor((N-1)/2) on the IJK axis aligned with the slice normal. Verified
 *  against a real Slicer session (MRHead): axial j=127 -> S=-10.2143, coronal i=127 ->
 *  A=6.9286, sagittal k=64 -> R=-3.4452, all exact. The bbox centre is a half-voxel off. */
export function slicerDefaultOffset01(
  orient: Orientation,
  dims: [number, number, number],
  ijkToRAS: ArrayLike<number>,
  rasLo: Vec3,
  rasHi: Vec3,
): number {
  const b = BASES[orient];
  const nAbs = b.nDir.map(Math.abs);
  const n = (nAbs[0] >= nAbs[1] && nAbs[0] >= nAbs[2] ? 0 : nAbs[1] >= nAbs[2] ? 1 : 2) as 0 | 1 | 2;
  const a = ijkAxisForRasAxis(ijkToRAS, n);
  const m = Math.floor((dims[a] - 1) / 2);
  // RAS component along the normal for a voxel with index a = m (other axes at their centres)
  const ijk = [(dims[0] - 1) / 2, (dims[1] - 1) / 2, (dims[2] - 1) / 2];
  ijk[a] = m;
  const ras = ijkToRAS[n * 4 + 0] * ijk[0] + ijkToRAS[n * 4 + 1] * ijk[1] + ijkToRAS[n * 4 + 2] * ijk[2] + ijkToRAS[n * 4 + 3];
  const span = rasHi[n] - rasLo[n];
  return span === 0 ? 0.5 : (ras - rasLo[n]) / span;
}

export class SliceRenderer {
  private dev: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private nnSampler: GPUSampler;
  private ubuf: GPUBuffer;
  private u = new Float32Array(36);  // p2t(16) + origin(4) + uvec(4) + vvec(4) + params(4) + size(4)
  private bind?: GPUBindGroup;
  private overlay?: GPUTexture;
  private labels?: GPUTexture;
  private palette?: GPUTexture;
  private scalarTex?: GPUTexture;
  // actual in-plane extents (mm) spanned by the LAST rendered viewport, aspect-corrected so
  // pixels stay isotropic on a non-square view (0 until first render → fall back to the square span).
  private uSpanMm = 0;
  private vSpanMm = 0;

  // volume geometry + current plane
  private p2t: Mat4 = new Float32Array(16);
  private rasLo: Vec3 = [-1, -1, -1];
  private rasHi: Vec3 = [1, 1, 1];
  private orient: Orientation = "axial";
  private offset01 = 0.5;
  // Per-orientation pan (mm along the plane's uDir/vDir) + zoom (1 = fitted). Slicer-style
  // slice navigation: pan translates the in-plane view centre, zoom scales the field of view.
  private viewState: Record<Orientation, { panU: number; panV: number; zoom: number }> = {
    axial: { panU: 0, panV: 0, zoom: 1 },
    coronal: { panU: 0, panV: 0, zoom: 1 },
    sagittal: { panU: 0, panV: 0, zoom: 1 },
  };
  private cX: Vec3 = [0, 0, 0];   // in-plane centre of the LAST rendered frame (for viewToTex picking)
  // Optional per-orientation basis override (reslice along a volume's own axes). null = the
  // anatomical preset.
  private basisOverride: Partial<Record<Orientation, PlaneBasis | null>> = {};

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
    this.nnSampler = this.dev.createSampler({ magFilter: "nearest", minFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.ubuf = this.dev.createBuffer({ size: this.u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.setWindowLevel(255, 127);
    this.setOverlayOpacity(0.55);
  }

  /** 1x1x1 stand-ins so the label-overlay bindings always exist. The pipeline layout is fixed,
   *  so every caller must bind them even when it only wants a plain MPR. */
  private emptyLabels?: GPUTexture;
  private emptyPalette?: GPUTexture;
  private noLabels(): GPUTexture {
    if (!this.emptyLabels) {
      this.emptyLabels = this.dev.createTexture({ size: [1, 1, 1], dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyLabels }, new Uint8Array(1), { bytesPerRow: 1, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.emptyLabels;
  }
  private noPalette(): GPUTexture {
    if (!this.emptyPalette) {
      this.emptyPalette = this.dev.createTexture({ size: [256, 2], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyPalette }, new Uint8Array(256 * 2 * 4), { bytesPerRow: 256 * 4 }, [256, 2]);
    }
    return this.emptyPalette;
  }

  private emptyOverlay?: GPUTexture;
  private transparentOverlay(): GPUTexture {
    if (!this.emptyOverlay) {
      this.emptyOverlay = this.dev.createTexture({ size: [1, 1, 1], dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyOverlay }, new Uint16Array(4), { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.emptyOverlay;
  }

  /** Reslice this orientation along an arbitrary RAS basis instead of the anatomical preset.
   *  Pass null to restore. The vectors should be unit length and mutually orthogonal; they are
   *  used verbatim, so the caller owns the display convention for a non-anatomical frame. */
  setBasis(orient: Orientation, basis: PlaneBasis | null) { this.basisOverride[orient] = basis; }
  basisOf(orient: Orientation): PlaneBasis { return this.basisOverride[orient] ?? BASES[orient]; }

  /** Extent of the volume's RAS bounding box projected onto a direction — the generalisation
   *  of "rasHi[axis] - rasLo[axis]" to an oblique axis. Reduces to exactly that for the
   *  anatomical bases, since projecting an axis-aligned box on its own axis is the axis span. */
  private extentAlong(d: Vec3): { lo: number; hi: number } {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [
        i & 1 ? this.rasHi[0] : this.rasLo[0],
        i & 2 ? this.rasHi[1] : this.rasLo[1],
        i & 4 ? this.rasHi[2] : this.rasLo[2],
      ];
      const t = dot3(c, d);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return { lo, hi };
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
    this.scalarTex = scalar;
    this.rebind();
  }

  /** Colour the overlay from a u8 label volume + the 256x2 palette (row 1 = colour/opacity),
   *  instead of a pre-coloured rgba volume. Same geometry requirement as setTextures. Pass
   *  nulls to go back to the rgba overlay. */
  setLabelOverlay(labels: GPUTexture | null, palette: GPUTexture | null) {
    this.labels = labels ?? undefined;
    this.palette = palette ?? undefined;
    this.u[34] = labels && palette ? 1 : 0;      // size.z = label-overlay mode
    if (this.scalarTex) this.rebind();
  }

  private rebind() {
    if (!this.scalarTex) return;
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.scalarTex.createView() },
        { binding: 3, resource: (this.overlay ?? this.transparentOverlay()).createView() },
        { binding: 4, resource: this.nnSampler },
        { binding: 5, resource: (this.labels ?? this.noLabels()).createView() },
        { binding: 6, resource: (this.palette ?? this.noPalette()).createView() },
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
  /** Overlay FILL opacity (per-voxel coloured regions). 0 hides the fill. */
  setOverlayOpacity(o: number) { this.u[30] = o; }
  /** Overlay OUTLINE opacity (boundary line, composited over the fill). 0 hides the outline. */
  setOutlineOpacity(o: number) { this.u[31] = o; }
  /** Convenience toggle: outline on (opacity 1) / off (0). Composites over the fill. */
  setOverlayOutline(on: boolean) { this.u[31] = on ? 1 : 0; }

  /** Physical size (mm) of the square view for the current plane (isotropic, letterboxed).
   *  Matches Slicer's FitSliceToBackground: the field of view is exactly the volume's
   *  extent along the limiting in-plane axis — NO extra margin. (Verified against
   *  Slicer: Red FOV=[891.78,256] at viewport 634x182 -> vertical FOV == the 256mm
   *  A-extent, horizontal follows viewport aspect.) */
  private viewSpanMm(): number {
    const b = this.basisOf(this.orient);
    const u = this.extentAlong(b.uDir), v = this.extentAlong(b.vDir);
    return Math.max(u.hi - u.lo, v.hi - v.lo);
  }

  /** The fitted in-plane extent (mm) used for a given orientation — the value directly
   *  comparable to a Slicer slice node's fitted fieldOfView. */
  spanMmFor(orient: Orientation): number {
    const prev = this.orient;
    this.orient = orient;
    const s = this.viewSpanMm();
    this.orient = prev;
    return s;
  }

  /** Letterbox fit at zoom=1 (Slicer's FitSliceToVolume): the in-plane FOV (uS0×vS0) that
   *  exactly contains the slice's bounding box in a viewport of the given aspect — the whole
   *  slice is visible and the LIMITING axis touches the window edge (so the largest fitting
   *  axis fills the window, no needless margin). Replaces the old max(uExt,vExt) span, which
   *  under-zoomed whenever the larger extent wasn't on the viewport's limiting axis. */
  private fitUV(orient: Orientation, aspectWH: number): { uS0: number; vS0: number } {
    const b = this.basisOf(orient);
    const u = this.extentAlong(b.uDir), v = this.extentAlong(b.vDir);
    const uExt = u.hi - u.lo, vExt = v.hi - v.lo;
    const uS0 = Math.max(uExt, vExt * aspectWH);
    return { uS0, vS0: uS0 / aspectWH };
  }

  /** The complete in-plane view frame for an orientation at a given viewport aspect, folding
   *  in pan (mm along uDir/vDir) + zoom. Single source of truth shared by drawInto, rasToView,
   *  viewToRas — so the rendered image and the markup projection stay pixel-aligned under
   *  pan/zoom. Returns the plane centre `c` (RAS, incl. scrub offset + pan) and the half-... no:
   *  uS/vS are the FULL in-plane extents mapped across the viewport width/height. */
  private frameFor(orient: Orientation, offset01: number, aspectWH: number): { b: PlaneBasis; c: Vec3; uS: number; vS: number } {
    const b = this.basisOf(orient);
    const vs = this.viewState[orient];
    const { uS0, vS0 } = this.fitUV(orient, aspectWH);
    const uS = uS0 / vs.zoom, vS = vS0 / vs.zoom;
    const c: Vec3 = [(this.rasLo[0] + this.rasHi[0]) / 2, (this.rasLo[1] + this.rasHi[1]) / 2, (this.rasLo[2] + this.rasHi[2]) / 2];
    // slide the centre along the plane NORMAL: replace its normal component with the scrubbed
    // one. For an anatomical basis this is identical to assigning c[nAxis] directly.
    const nx = this.extentAlong(b.nDir);
    const want = nx.lo + Math.max(0, Math.min(1, offset01)) * (nx.hi - nx.lo);
    const have = dot3(c, b.nDir);
    c[0] += b.nDir[0] * (want - have);
    c[1] += b.nDir[1] * (want - have);
    c[2] += b.nDir[2] * (want - have);
    c[0] += b.uDir[0] * vs.panU + b.vDir[0] * vs.panV;
    c[1] += b.uDir[1] * vs.panU + b.vDir[1] * vs.panV;
    c[2] += b.uDir[2] * vs.panU + b.vDir[2] * vs.panV;
    return { b, c, uS, vS };
  }

  /** Zoom factor for an orientation (1 = fitted). */
  zoom(orient: Orientation): number { return this.viewState[orient].zoom; }

  /** Pan the in-plane view by a pixel delta (drag): the anatomy under the cursor follows it. */
  panByPixels(orient: Orientation, dxPx: number, dyPx: number, w: number, h: number) {
    const z = this.viewState[orient].zoom;
    const { uS0, vS0 } = this.fitUV(orient, w / h);
    const uS = uS0 / z, vS = vS0 / z;
    this.viewState[orient].panU -= (dxPx / w) * uS;   // drag right -> centre moves left -> image follows
    this.viewState[orient].panV += (dyPx / h) * vS;   // drag down  -> centre moves up   -> image follows
  }

  /** Zoom by `factor` (>1 zooms in) about a pivot (u,v in [0,1]); the pivot point stays fixed. */
  zoomAbout(orient: Orientation, factor: number, pu: number, pv: number, w: number, h: number) {
    const vs = this.viewState[orient];
    const { uS0, vS0 } = this.fitUV(orient, w / h);
    const z = Math.max(0.2, Math.min(50, vs.zoom * factor));
    vs.panU += (pu - 0.5) * (uS0 / vs.zoom - uS0 / z);   // keep the pivot's RAS point under the cursor
    vs.panV += (0.5 - pv) * (vS0 / vs.zoom - vS0 / z);
    vs.zoom = z;
  }

  /** Reset pan/zoom for an orientation to the fitted view. */
  resetView(orient: Orientation) { this.viewState[orient] = { panU: 0, panV: 0, zoom: 1 }; }

  /** Snapshot per-orientation pan+zoom (e.g. to persist a view across reloads). */
  getViewState(): Record<Orientation, { panU: number; panV: number; zoom: number }> {
    return structuredClone(this.viewState);
  }

  /** Restore a (possibly partial) snapshot from getViewState(). */
  setViewState(vs: Partial<Record<Orientation, { panU: number; panV: number; zoom: number }>>): void {
    for (const k of Object.keys(vs) as Orientation[]) {
      const v = vs[k];
      if (v && Number.isFinite(v.zoom) && v.zoom > 0) this.viewState[k] = { ...v };
    }
  }

  /** Mirror Slicer's in-plane navigation for an orientation: drive pan + zoom from the slice
   *  node's RAS centre and field of view (mm). zoom = extent/FOV on the limiting axis (== 1 when
   *  Slicer is fitted, per FitSliceToBackground's no-margin fit), so SlicerLive tracks Slicer's
   *  zoom proportionally; pan is the centre's offset from the volume centre projected onto the
   *  plane's in-plane axes. The out-of-plane offset is applied separately via setPlane. */
  setMirrorFrame(orient: Orientation, centerRAS: Vec3, fovX: number, fovY: number) {
    const b = this.basisOf(orient);
    const ux = this.extentAlong(b.uDir), vx = this.extentAlong(b.vDir);
    const uExt = ux.hi - ux.lo, vExt = vx.hi - vx.lo;
    const zoom = Math.max(uExt / Math.max(fovX, 1e-6), vExt / Math.max(fovY, 1e-6));
    const volC: Vec3 = [(this.rasLo[0] + this.rasHi[0]) / 2, (this.rasLo[1] + this.rasHi[1]) / 2, (this.rasLo[2] + this.rasHi[2]) / 2];
    const d: Vec3 = [centerRAS[0] - volC[0], centerRAS[1] - volC[1], centerRAS[2] - volC[2]];
    const panU = d[0] * b.uDir[0] + d[1] * b.uDir[1] + d[2] * b.uDir[2];
    const panV = d[0] * b.vDir[0] + d[1] * b.vDir[1] + d[2] * b.vDir[2];
    this.viewState[orient] = { panU, panV, zoom: Math.max(1e-3, zoom) };
  }

  /** Map a view (u,v) in [0,1] (y down) to normalized texture coords for the current
   *  plane — for click picking. Returns the tex coord; the caller converts to IJK via
   *  ijk = tex*dims - 0.5. Anisotropy/rotation are handled by the same p2t the shader uses. */
  viewToTex(u: number, v: number): Vec3 {
    const b = this.basisOf(this.orient);
    const uS = this.uSpanMm || this.viewSpanMm();   // match the last render's aspect + zoom
    const vS = this.vSpanMm || this.viewSpanMm();
    const c = this.cX;                              // last render's centre (incl. pan + scrub offset)
    const ras: Vec3 = [
      c[0] + b.uDir[0] * (u - 0.5) * uS + b.vDir[0] * (0.5 - v) * vS,
      c[1] + b.uDir[1] * (u - 0.5) * uS + b.vDir[1] * (0.5 - v) * vS,
      c[2] + b.uDir[2] * (u - 0.5) * uS + b.vDir[2] * (0.5 - v) * vS,
    ];
    return applyMat4(this.p2t, ras);
  }

  /** Project a RAS point onto a plane's view: returns u,v in [0,1] (y down, matching the
   *  rendered pixels for a viewport of aspect w/h) and the signed distance (mm) from the
   *  point to the plane along its normal. Inverse of viewToTex; used to place 2D markup
   *  glyphs and hit-test clicks on them. */
  rasToView(orient: Orientation, offset01: number, ras: Vec3, aspectWH: number): { u: number; v: number; distMm: number } {
    const { b, c, uS, vS } = this.frameFor(orient, offset01, aspectWH);
    const d: Vec3 = [ras[0] - c[0], ras[1] - c[1], ras[2] - c[2]];
    const u = 0.5 + (d[0] * b.uDir[0] + d[1] * b.uDir[1] + d[2] * b.uDir[2]) / uS;
    const v = 0.5 - (d[0] * b.vDir[0] + d[1] * b.vDir[1] + d[2] * b.vDir[2]) / vS;
    return { u, v, distMm: dot3(d, b.nDir) };
  }

  /** Map a view (u,v in [0,1], y down) on a plane back to a RAS point ON that plane —
   *  the exact inverse of rasToView (same pan/zoom/aspect). Used to drag a 2D markup:
   *  the point lands on the current slice (its out-of-plane coord becomes the plane offset). */
  viewToRas(orient: Orientation, offset01: number, u: number, v: number, aspectWH: number): Vec3 {
    const { b, c, uS, vS } = this.frameFor(orient, offset01, aspectWH);
    const du = (u - 0.5) * uS, dv = (0.5 - v) * vS;
    return [
      c[0] + b.uDir[0] * du + b.vDir[0] * dv,
      c[1] + b.uDir[1] * du + b.vDir[1] * dv,
      c[2] + b.uDir[2] * du + b.vDir[2] * dv,
    ];
  }

  private drawInto(view: GPUTextureView, w: number, h: number) {
    // Aspect-correct so pixels are ISOTROPIC on a non-square viewport: the fitted span fills
    // the SMALLER dimension, the larger dimension shows more (letterbox). Pan/zoom fold in via
    // frameFor. Square viewports at zoom=1 with no pan reproduce the original fitted view exactly.
    const { b, c, uS, vS } = this.frameFor(this.orient, this.offset01, w / h);
    this.uSpanMm = uS; this.vSpanMm = vS; this.cX = c;
    this.u.set(this.p2t, 0);                                                                  // p2t   [0..15]
    this.u[16] = c[0]; this.u[17] = c[1]; this.u[18] = c[2]; this.u[19] = 0;                   // origin[16..19]
    this.u[20] = b.uDir[0] * uS; this.u[21] = b.uDir[1] * uS; this.u[22] = b.uDir[2] * uS; this.u[23] = 0; // uvec [20..23]
    this.u[24] = b.vDir[0] * vS; this.u[25] = b.vDir[1] * vS; this.u[26] = b.vDir[2] * vS; this.u[27] = 0; // vvec [24..27]
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
