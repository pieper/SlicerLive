// render/device.ts
async function initDevice() {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error("WebGPU not available (need Chrome/Edge/Safari or Deno --unstable-webgpu)");
  const adapter = await gpu.requestAdapter({
    powerPreference: "high-performance"
  });
  if (!adapter) throw new Error("no WebGPU adapter");
  const want = [
    "float32-filterable",
    "timestamp-query"
  ].filter((f) => adapter.features.has(f));
  const lim = adapter.limits;
  const requiredLimits = {};
  const raise = (k) => {
    const v = lim[k];
    if (typeof v === "number") requiredLimits[k] = v;
  };
  raise("maxBufferSize");
  raise("maxStorageBufferBindingSize");
  raise("maxTextureDimension3D");
  const device = await adapter.requestDevice({
    requiredFeatures: want,
    requiredLimits
  });
  return {
    adapter,
    device,
    features: new Set(want)
  };
}

// render/mat4.ts
function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function perspectiveZO(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  m[10] = far / (near - far);
  m[14] = far * near / (near - far);
  return m;
}
function lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  let xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx;
  m[4] = xy;
  m[8] = xz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[1] = yx;
  m[5] = yy;
  m[9] = yz;
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[2] = zx;
  m[6] = zy;
  m[10] = zz;
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}
function invert(a) {
  const m = a;
  const b00 = m[0] * m[5] - m[1] * m[4], b01 = m[0] * m[6] - m[2] * m[4];
  const b02 = m[0] * m[7] - m[3] * m[4], b03 = m[1] * m[6] - m[2] * m[5];
  const b04 = m[1] * m[7] - m[3] * m[5], b05 = m[2] * m[7] - m[3] * m[6];
  const b06 = m[8] * m[13] - m[9] * m[12], b07 = m[8] * m[14] - m[10] * m[12];
  const b08 = m[8] * m[15] - m[11] * m[12], b09 = m[9] * m[14] - m[10] * m[13];
  const b10 = m[9] * m[15] - m[11] * m[13], b11 = m[10] * m[15] - m[11] * m[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity();
  det = 1 / det;
  const o = new Float32Array(16);
  o[0] = (m[5] * b11 - m[6] * b10 + m[7] * b09) * det;
  o[1] = (m[2] * b10 - m[1] * b11 - m[3] * b09) * det;
  o[2] = (m[13] * b05 - m[14] * b04 + m[15] * b03) * det;
  o[3] = (m[10] * b04 - m[9] * b05 - m[11] * b03) * det;
  o[4] = (m[6] * b08 - m[4] * b11 - m[7] * b07) * det;
  o[5] = (m[0] * b11 - m[2] * b08 + m[3] * b07) * det;
  o[6] = (m[14] * b02 - m[12] * b05 - m[15] * b01) * det;
  o[7] = (m[8] * b05 - m[10] * b02 + m[11] * b01) * det;
  o[8] = (m[4] * b10 - m[5] * b08 + m[7] * b06) * det;
  o[9] = (m[1] * b08 - m[0] * b10 - m[3] * b06) * det;
  o[10] = (m[12] * b04 - m[13] * b02 + m[15] * b00) * det;
  o[11] = (m[9] * b02 - m[8] * b04 - m[11] * b00) * det;
  o[12] = (m[5] * b07 - m[4] * b09 - m[6] * b06) * det;
  o[13] = (m[0] * b09 - m[1] * b07 + m[2] * b06) * det;
  o[14] = (m[13] * b01 - m[12] * b03 - m[14] * b00) * det;
  o[15] = (m[8] * b03 - m[9] * b01 + m[10] * b00) * det;
  return o;
}
function patientToTexture(dims, spacing, center = [
  0,
  0,
  0
]) {
  const m = new Float32Array(16);
  for (let a = 0; a < 3; a++) {
    const s = 1 / (spacing[a] * dims[a]);
    m[a * 4 + a] = s;
    m[12 + a] = 0.5 - center[a] * s;
  }
  m[15] = 1;
  return m;
}
function volumeAABB(dims, spacing, center = [
  0,
  0,
  0
]) {
  const ext = [
    dims[0] * spacing[0] / 2,
    dims[1] * spacing[1] / 2,
    dims[2] * spacing[2] / 2
  ];
  return [
    [
      center[0] - ext[0],
      center[1] - ext[1],
      center[2] - ext[2]
    ],
    [
      center[0] + ext[0],
      center[1] + ext[1],
      center[2] + ext[2]
    ]
  ];
}
function transpose4(m) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}
function patientToTextureFromIjkToRAS(ijkToRAS, dims) {
  return invert(texToRASFromIjkToRAS(ijkToRAS, dims));
}
function texToRASFromIjkToRAS(ijkToRAS, dims) {
  const M = transpose4(ijkToRAS);
  const A = new Float32Array(16);
  for (let a = 0; a < 3; a++) {
    A[a * 4 + a] = dims[a];
    A[12 + a] = -0.5;
  }
  A[15] = 1;
  return multiply(M, A);
}
function volumeAABBFromIjkToRAS(ijkToRAS, dims) {
  const t2r = texToRASFromIjkToRAS(ijkToRAS, dims);
  const lo = [
    Infinity,
    Infinity,
    Infinity
  ], hi = [
    -Infinity,
    -Infinity,
    -Infinity
  ];
  for (let c = 0; c < 8; c++) {
    const u = c & 1, v = c >> 1 & 1, w = c >> 2 & 1;
    for (let r = 0; r < 3; r++) {
      const p = t2r[r] * u + t2r[4 + r] * v + t2r[8 + r] * w + t2r[12 + r];
      if (p < lo[r]) lo[r] = p;
      if (p > hi[r]) hi[r] = p;
    }
  }
  return [
    lo,
    hi
  ];
}
function applyMat4(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] || 1;
  return [
    x / w,
    y / w,
    z / w
  ];
}
function spacingFromIjkToRAS(ijkToRAS) {
  const col = (c) => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [
    col(0),
    col(1),
    col(2)
  ];
}

// render/slice-renderer.ts
var DEFAULT_FORMAT = "rgba8unorm-srgb";
var SHADER = (
  /* wgsl */
  `
struct U {
  p2t : mat4x4<f32>,     // RAS -> texture[0,1] (folds in ijkToRAS: rotation + anisotropy)
  origin : vec4<f32>,    // RAS of the plane center (for the current scrub offset)
  uvec : vec4<f32>,      // RAS vector spanning the view width  (isotropic mm)
  vvec : vec4<f32>,      // RAS vector spanning the view height (isotropic mm)
  params : vec4<f32>,    // win, lev, fillOpacity, outlineOpacity
  size : vec4<f32>,      // sizeX, sizeY, _, _
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var t_scalar : texture_3d<f32>;
@group(0) @binding(3) var t_overlay : texture_3d<f32>;
@group(0) @binding(4) var s_nn : sampler;   // NEAREST \u2014 labelmap overlay is per-voxel crisp (matches Slicer)

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
fn ov_at(ras : vec3<f32>) -> vec4<f32> {   // overlay at a RAS point (0 outside the volume)
  let t = (u.p2t * vec4<f32>(ras, 1.0)).xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  return textureSampleLevel(t_overlay, s_nn, t, 0.0);
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
  let ov = textureSampleLevel(t_overlay, s_nn, tex, 0.0);
  // Slicer-style 2D segmentation: a semi-transparent per-voxel FILL plus a brighter boundary
  // OUTLINE, with independent opacities (params.z = fill, params.w = outline). The outline is
  // screen-space (constant pixel width under zoom), drawn in the segment's own colour along its
  // inner edge \u2014 at both label\u2194label and label\u2194background boundaries.
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
`
);
var BASES = {
  axial: {
    uDir: [
      -1,
      0,
      0
    ],
    vDir: [
      0,
      1,
      0
    ],
    uAxis: 0,
    vAxis: 1,
    nAxis: 2
  },
  coronal: {
    uDir: [
      -1,
      0,
      0
    ],
    vDir: [
      0,
      0,
      1
    ],
    uAxis: 0,
    vAxis: 2,
    nAxis: 1
  },
  sagittal: {
    uDir: [
      0,
      -1,
      0
    ],
    vDir: [
      0,
      0,
      1
    ],
    uAxis: 1,
    vAxis: 2,
    nAxis: 0
  }
};
function ijkAxisForRasAxis(ijkToRAS, rasAxis) {
  let best = 0, bestMag = -1;
  for (let c = 0; c < 3; c++) {
    const mag = Math.abs(ijkToRAS[rasAxis * 4 + c]);
    if (mag > bestMag) {
      bestMag = mag;
      best = c;
    }
  }
  return best;
}
function slicerDefaultOffset01(orient, dims, ijkToRAS, rasLo, rasHi) {
  const b = BASES[orient];
  const n = b.nAxis;
  const a = ijkAxisForRasAxis(ijkToRAS, n);
  const m = Math.floor((dims[a] - 1) / 2);
  const ijk = [
    (dims[0] - 1) / 2,
    (dims[1] - 1) / 2,
    (dims[2] - 1) / 2
  ];
  ijk[a] = m;
  const ras = ijkToRAS[n * 4 + 0] * ijk[0] + ijkToRAS[n * 4 + 1] * ijk[1] + ijkToRAS[n * 4 + 2] * ijk[2] + ijkToRAS[n * 4 + 3];
  const span = rasHi[n] - rasLo[n];
  return span === 0 ? 0.5 : (ras - rasLo[n]) / span;
}
var SliceRenderer = class {
  dev;
  format;
  pipeline;
  sampler;
  nnSampler;
  ubuf;
  u = new Float32Array(36);
  bind;
  overlay;
  // actual in-plane extents (mm) spanned by the LAST rendered viewport, aspect-corrected so
  // pixels stay isotropic on a non-square view (0 until first render → fall back to the square span).
  uSpanMm = 0;
  vSpanMm = 0;
  // volume geometry + current plane
  p2t = new Float32Array(16);
  rasLo = [
    -1,
    -1,
    -1
  ];
  rasHi = [
    1,
    1,
    1
  ];
  orient = "axial";
  offset01 = 0.5;
  // Per-orientation pan (mm along the plane's uDir/vDir) + zoom (1 = fitted). Slicer-style
  // slice navigation: pan translates the in-plane view centre, zoom scales the field of view.
  viewState = {
    axial: {
      panU: 0,
      panV: 0,
      zoom: 1
    },
    coronal: {
      panU: 0,
      panV: 0,
      zoom: 1
    },
    sagittal: {
      panU: 0,
      panV: 0,
      zoom: 1
    }
  };
  cX = [
    0,
    0,
    0
  ];
  constructor(gpu, format = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    const m = this.dev.createShaderModule({
      code: SHADER
    });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: m,
        entryPoint: "vs_main"
      },
      fragment: {
        module: m,
        entryPoint: "fs_main",
        targets: [
          {
            format
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
    this.sampler = this.dev.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge"
    });
    this.nnSampler = this.dev.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge"
    });
    this.ubuf = this.dev.createBuffer({
      size: this.u.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.setWindowLevel(255, 127);
    this.setOverlayOpacity(0.55);
  }
  emptyOverlay;
  transparentOverlay() {
    if (!this.emptyOverlay) {
      this.emptyOverlay = this.dev.createTexture({
        size: [
          1,
          1,
          1
        ],
        dimension: "3d",
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      this.dev.queue.writeTexture({
        texture: this.emptyOverlay
      }, new Uint16Array(4), {
        bytesPerRow: 8,
        rowsPerImage: 1
      }, [
        1,
        1,
        1
      ]);
    }
    return this.emptyOverlay;
  }
  /** Volume geometry: patientToTexture (RAS->tex[0,1], encodes ijkToRAS) + the RAS
   *  bounding box (for plane extents/scrub range). Get both from the ImageField. */
  setVolume(p2t, rasLo, rasHi) {
    this.p2t = p2t;
    this.rasLo = rasLo;
    this.rasHi = rasHi;
    this.u.set(p2t, 0);
  }
  /** Set the grayscale scalar (r32float 3d) and, optionally, a colored overlay
   *  (rgba16float 3d) — which MUST share the same geometry (ijkToRAS/dims) so the
   *  same RAS->tex mapping addresses both. Omit overlay for a plain MPR. */
  setTextures(scalar, overlay) {
    this.overlay = overlay ?? this.transparentOverlay();
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.ubuf
          }
        },
        {
          binding: 1,
          resource: this.sampler
        },
        {
          binding: 2,
          resource: scalar.createView()
        },
        {
          binding: 3,
          resource: this.overlay.createView()
        },
        {
          binding: 4,
          resource: this.nnSampler
        }
      ]
    });
  }
  // Uniform float layout: p2t[0..15] origin[16..19] uvec[20..23] vvec[24..27] params[28..31] size[32..35]
  /** Select the anatomical plane and scrub position (0..1 along the plane normal, RAS bbox). */
  setPlane(orient, offset01) {
    this.orient = orient;
    this.offset01 = Math.max(0, Math.min(1, offset01));
  }
  setWindowLevel(win, lev) {
    this.u[28] = win;
    this.u[29] = lev;
  }
  /** Overlay FILL opacity (per-voxel coloured regions). 0 hides the fill. */
  setOverlayOpacity(o) {
    this.u[30] = o;
  }
  /** Overlay OUTLINE opacity (boundary line, composited over the fill). 0 hides the outline. */
  setOutlineOpacity(o) {
    this.u[31] = o;
  }
  /** Convenience toggle: outline on (opacity 1) / off (0). Composites over the fill. */
  setOverlayOutline(on) {
    this.u[31] = on ? 1 : 0;
  }
  /** Physical size (mm) of the square view for the current plane (isotropic, letterboxed).
   *  Matches Slicer's FitSliceToBackground: the field of view is exactly the volume's
   *  extent along the limiting in-plane axis — NO extra margin. (Verified against
   *  Slicer: Red FOV=[891.78,256] at viewport 634x182 -> vertical FOV == the 256mm
   *  A-extent, horizontal follows viewport aspect.) */
  viewSpanMm() {
    const b = BASES[this.orient];
    const uExt = this.rasHi[b.uAxis] - this.rasLo[b.uAxis];
    const vExt = this.rasHi[b.vAxis] - this.rasLo[b.vAxis];
    return Math.max(uExt, vExt);
  }
  /** The fitted in-plane extent (mm) used for a given orientation — the value directly
   *  comparable to a Slicer slice node's fitted fieldOfView. */
  spanMmFor(orient) {
    const prev = this.orient;
    this.orient = orient;
    const s = this.viewSpanMm();
    this.orient = prev;
    return s;
  }
  /** Fitted (zoom=1) in-plane extent for an orientation. */
  baseSpan(orient) {
    const b = BASES[orient];
    return Math.max(this.rasHi[b.uAxis] - this.rasLo[b.uAxis], this.rasHi[b.vAxis] - this.rasLo[b.vAxis]);
  }
  /** The complete in-plane view frame for an orientation at a given viewport aspect, folding
   *  in pan (mm along uDir/vDir) + zoom. Single source of truth shared by drawInto, rasToView,
   *  viewToRas — so the rendered image and the markup projection stay pixel-aligned under
   *  pan/zoom. Returns the plane centre `c` (RAS, incl. scrub offset + pan) and the half-... no:
   *  uS/vS are the FULL in-plane extents mapped across the viewport width/height. */
  frameFor(orient, offset01, aspectWH) {
    const b = BASES[orient];
    const vs = this.viewState[orient];
    const span = this.baseSpan(orient) / vs.zoom;
    const uS = span * Math.max(1, aspectWH), vS = span * Math.max(1, 1 / aspectWH);
    const c = [
      (this.rasLo[0] + this.rasHi[0]) / 2,
      (this.rasLo[1] + this.rasHi[1]) / 2,
      (this.rasLo[2] + this.rasHi[2]) / 2
    ];
    c[b.nAxis] = this.rasLo[b.nAxis] + Math.max(0, Math.min(1, offset01)) * (this.rasHi[b.nAxis] - this.rasLo[b.nAxis]);
    c[0] += b.uDir[0] * vs.panU + b.vDir[0] * vs.panV;
    c[1] += b.uDir[1] * vs.panU + b.vDir[1] * vs.panV;
    c[2] += b.uDir[2] * vs.panU + b.vDir[2] * vs.panV;
    return {
      b,
      c,
      uS,
      vS
    };
  }
  /** Zoom factor for an orientation (1 = fitted). */
  zoom(orient) {
    return this.viewState[orient].zoom;
  }
  /** Pan the in-plane view by a pixel delta (drag): the anatomy under the cursor follows it. */
  panByPixels(orient, dxPx, dyPx, w, h) {
    const span = this.baseSpan(orient) / this.viewState[orient].zoom;
    const uS = span * Math.max(1, w / h), vS = span * Math.max(1, h / w);
    this.viewState[orient].panU -= dxPx / w * uS;
    this.viewState[orient].panV += dyPx / h * vS;
  }
  /** Zoom by `factor` (>1 zooms in) about a pivot (u,v in [0,1]); the pivot point stays fixed. */
  zoomAbout(orient, factor, pu, pv, w, h) {
    const vs = this.viewState[orient];
    const base = this.baseSpan(orient);
    const spanOld = base / vs.zoom;
    const z = Math.max(0.2, Math.min(50, vs.zoom * factor));
    const spanNew = base / z;
    const au = Math.max(1, w / h), av = Math.max(1, h / w);
    vs.panU += (pu - 0.5) * (spanOld - spanNew) * au;
    vs.panV += (0.5 - pv) * (spanOld - spanNew) * av;
    vs.zoom = z;
  }
  /** Reset pan/zoom for an orientation to the fitted view. */
  resetView(orient) {
    this.viewState[orient] = {
      panU: 0,
      panV: 0,
      zoom: 1
    };
  }
  /** Mirror Slicer's in-plane navigation for an orientation: drive pan + zoom from the slice
   *  node's RAS centre and field of view (mm). zoom = extent/FOV on the limiting axis (== 1 when
   *  Slicer is fitted, per FitSliceToBackground's no-margin fit), so SlicerLive tracks Slicer's
   *  zoom proportionally; pan is the centre's offset from the volume centre projected onto the
   *  plane's in-plane axes. The out-of-plane offset is applied separately via setPlane. */
  setMirrorFrame(orient, centerRAS, fovX, fovY) {
    const b = BASES[orient];
    const uExt = this.rasHi[b.uAxis] - this.rasLo[b.uAxis];
    const vExt = this.rasHi[b.vAxis] - this.rasLo[b.vAxis];
    const zoom = Math.max(uExt / Math.max(fovX, 1e-6), vExt / Math.max(fovY, 1e-6));
    const volC = [
      (this.rasLo[0] + this.rasHi[0]) / 2,
      (this.rasLo[1] + this.rasHi[1]) / 2,
      (this.rasLo[2] + this.rasHi[2]) / 2
    ];
    const d = [
      centerRAS[0] - volC[0],
      centerRAS[1] - volC[1],
      centerRAS[2] - volC[2]
    ];
    const panU = d[0] * b.uDir[0] + d[1] * b.uDir[1] + d[2] * b.uDir[2];
    const panV = d[0] * b.vDir[0] + d[1] * b.vDir[1] + d[2] * b.vDir[2];
    this.viewState[orient] = {
      panU,
      panV,
      zoom: Math.max(1e-3, zoom)
    };
  }
  /** Map a view (u,v) in [0,1] (y down) to normalized texture coords for the current
   *  plane — for click picking. Returns the tex coord; the caller converts to IJK via
   *  ijk = tex*dims - 0.5. Anisotropy/rotation are handled by the same p2t the shader uses. */
  viewToTex(u, v) {
    const b = BASES[this.orient];
    const uS = this.uSpanMm || this.viewSpanMm();
    const vS = this.vSpanMm || this.viewSpanMm();
    const c = this.cX;
    const ras = [
      c[0] + b.uDir[0] * (u - 0.5) * uS + b.vDir[0] * (0.5 - v) * vS,
      c[1] + b.uDir[1] * (u - 0.5) * uS + b.vDir[1] * (0.5 - v) * vS,
      c[2] + b.uDir[2] * (u - 0.5) * uS + b.vDir[2] * (0.5 - v) * vS
    ];
    return applyMat4(this.p2t, ras);
  }
  /** Project a RAS point onto a plane's view: returns u,v in [0,1] (y down, matching the
   *  rendered pixels for a viewport of aspect w/h) and the signed distance (mm) from the
   *  point to the plane along its normal. Inverse of viewToTex; used to place 2D markup
   *  glyphs and hit-test clicks on them. */
  rasToView(orient, offset01, ras, aspectWH) {
    const { b, c, uS, vS } = this.frameFor(orient, offset01, aspectWH);
    const d = [
      ras[0] - c[0],
      ras[1] - c[1],
      ras[2] - c[2]
    ];
    const u = 0.5 + (d[0] * b.uDir[0] + d[1] * b.uDir[1] + d[2] * b.uDir[2]) / uS;
    const v = 0.5 - (d[0] * b.vDir[0] + d[1] * b.vDir[1] + d[2] * b.vDir[2]) / vS;
    return {
      u,
      v,
      distMm: d[b.nAxis]
    };
  }
  /** Map a view (u,v in [0,1], y down) on a plane back to a RAS point ON that plane —
   *  the exact inverse of rasToView (same pan/zoom/aspect). Used to drag a 2D markup:
   *  the point lands on the current slice (its out-of-plane coord becomes the plane offset). */
  viewToRas(orient, offset01, u, v, aspectWH) {
    const { b, c, uS, vS } = this.frameFor(orient, offset01, aspectWH);
    const du = (u - 0.5) * uS, dv = (0.5 - v) * vS;
    return [
      c[0] + b.uDir[0] * du + b.vDir[0] * dv,
      c[1] + b.uDir[1] * du + b.vDir[1] * dv,
      c[2] + b.uDir[2] * du + b.vDir[2] * dv
    ];
  }
  drawInto(view, w, h) {
    const { b, c, uS, vS } = this.frameFor(this.orient, this.offset01, w / h);
    this.uSpanMm = uS;
    this.vSpanMm = vS;
    this.cX = c;
    this.u.set(this.p2t, 0);
    this.u[16] = c[0];
    this.u[17] = c[1];
    this.u[18] = c[2];
    this.u[19] = 0;
    this.u[20] = b.uDir[0] * uS;
    this.u[21] = b.uDir[1] * uS;
    this.u[22] = b.uDir[2] * uS;
    this.u[23] = 0;
    this.u[24] = b.vDir[0] * vS;
    this.u[25] = b.vDir[1] * vS;
    this.u[26] = b.vDir[2] * vS;
    this.u[27] = 0;
    this.u[32] = w;
    this.u[33] = h;
    this.dev.queue.writeBuffer(this.ubuf, 0, this.u);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 1
          }
        }
      ]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
    this.dev.queue.submit([
      enc.finish()
    ]);
  }
  renderToView(view, w, h) {
    this.drawInto(view, w, h);
  }
  async renderToRGBA(w, h) {
    const target = this.dev.createTexture({
      size: [
        w,
        h
      ],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    this.drawInto(target.createView(), w, h);
    const bpr = Math.ceil(w * 4 / 256) * 256;
    const buf = this.dev.createBuffer({
      size: bpr * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({
      texture: target
    }, {
      buffer: buf,
      bytesPerRow: bpr,
      rowsPerImage: h
    }, [
      w,
      h
    ]);
    this.dev.queue.submit([
      enc.finish()
    ]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(padded.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap();
    target.destroy();
    buf.destroy();
    return out;
  }
};

// render/slice-interactor.ts
var NORMAL = {
  axial: {
    axis: 2,
    sign: 1
  },
  coronal: {
    axis: 1,
    sign: 1
  },
  sagittal: {
    axis: 0,
    sign: -1
  }
};
function ijkAxisForRasAxis2(ijkToRAS, rasAxis) {
  let best = 0, bestMag = -1;
  for (let c = 0; c < 3; c++) {
    const mag = Math.abs(ijkToRAS[rasAxis * 4 + c]);
    if (mag > bestMag) {
      bestMag = mag;
      best = c;
    }
  }
  return best;
}
function sliceSpacingFor(orient, ijkToRAS) {
  const n = NORMAL[orient].axis;
  const a = ijkAxisForRasAxis2(ijkToRAS, n);
  return Math.hypot(ijkToRAS[a], ijkToRAS[4 + a], ijkToRAS[8 + a]);
}
function sliceBoundsFor(orient, rasLo, rasHi) {
  const { axis, sign } = NORMAL[orient];
  return sign > 0 ? [
    rasLo[axis],
    rasHi[axis]
  ] : [
    -rasHi[axis],
    -rasLo[axis]
  ];
}
function offset01ToMm(orient, offset01, rasLo, rasHi) {
  const { axis, sign } = NORMAL[orient];
  return sign * (rasLo[axis] + offset01 * (rasHi[axis] - rasLo[axis]));
}
function mmToOffset01(orient, mm, rasLo, rasHi) {
  const { axis, sign } = NORMAL[orient];
  const ras = sign * mm;
  const span = rasHi[axis] - rasLo[axis];
  return span === 0 ? 0.5 : (ras - rasLo[axis]) / span;
}
var SliceInteractor = class {
  geom;
  constructor(geom) {
    this.geom = geom;
  }
  setGeometry(g) {
    this.geom = g;
  }
  spacing(orient) {
    return sliceSpacingFor(orient, this.geom.ijkToRAS);
  }
  bounds(orient) {
    return sliceBoundsFor(orient, this.geom.rasLo, this.geom.rasHi);
  }
  /** vtkMRMLSliceIntersectionWidget::MoveSlice — returns the NEW offset01, or the
   *  unchanged one if the step would leave the slice bounds (Slicer rejects, not clamps). */
  moveSlice(orient, offset01, deltaMm) {
    const { rasLo, rasHi } = this.geom;
    const cur = offset01ToMm(orient, offset01, rasLo, rasHi);
    const next = cur + deltaMm;
    const [lo, hi] = this.bounds(orient);
    if (next < lo || next > hi) return offset01;
    return mmToOffset01(orient, next, rasLo, rasHi);
  }
  incrementSlice(orient, offset01) {
    return this.moveSlice(orient, offset01, this.spacing(orient));
  }
  decrementSlice(orient, offset01) {
    return this.moveSlice(orient, offset01, -this.spacing(orient));
  }
  /** Map a wheel event to a step. Returns the new offset01. */
  wheel(orient, offset01, forward) {
    return forward ? this.incrementSlice(orient, offset01) : this.decrementSlice(orient, offset01);
  }
  /** Slicer's slice-view keyboard bindings. Returns the new offset01 (unchanged if the
   *  key isn't a stepping key). `key` is a DOM KeyboardEvent.key value. */
  key(orient, offset01, key) {
    switch (key) {
      case "f":
      case "F":
      case "ArrowRight":
      case "ArrowUp":
        return this.incrementSlice(orient, offset01);
      case "b":
      case "B":
      case "ArrowLeft":
      case "ArrowDown":
        return this.decrementSlice(orient, offset01);
      default:
        return offset01;
    }
  }
  /** True if this key is one Slicer's slice view consumes for stepping. */
  static isStepKey(key) {
    return [
      "f",
      "F",
      "b",
      "B",
      "ArrowRight",
      "ArrowLeft",
      "ArrowUp",
      "ArrowDown"
    ].includes(key);
  }
};

// render/demos/slice-control.ts
function attachSliceControls(canvas, cfg) {
  const SCROLL_PX = cfg.scrollPx ?? 7;
  const h = cfg.hooks ?? {};
  const uv = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      u: (e.clientX - r.left) / r.width,
      v: (e.clientY - r.top) / r.height,
      w: r.width,
      h: r.height
    };
  };
  let lastDown = 0, lastX = 0, lastY = 0;
  let view = null;
  let scroll = null;
  let grabbed = null;
  const onContext = (e) => e.preventDefault();
  const onWheel = (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const { u, v, w, h: hh } = uv(e);
      cfg.getSlice().zoomAbout(cfg.orient, Math.exp(-e.deltaY * 15e-4), u, v, w, hh);
      cfg.redraw();
      h.onZoom?.();
      return;
    }
    cfg.step(e.deltaY < 0);
    cfg.redraw();
    h.onScroll?.(e.deltaY < 0);
  };
  const onDown = (e) => {
    if (e.button === 0) {
      const now = e.timeStamp, dbl = now - lastDown < 350 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 6;
      lastDown = dbl ? 0 : now;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dbl && h.onDoubleClick?.()) {
        e.preventDefault();
        return;
      }
    }
    const wantPan = e.button === 1 || e.button === 0 && e.shiftKey;
    const wantZoom = e.button === 2;
    if (wantPan || wantZoom) {
      e.preventDefault();
      const { u: u2, v: v2 } = uv(e);
      view = {
        mode: wantZoom ? "zoom" : "pan",
        x: e.clientX,
        y: e.clientY,
        pu: u2,
        pv: v2
      };
      canvas.style.cursor = wantZoom ? "ns-resize" : "grabbing";
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const { u, v, w, h: hh } = uv(e);
    if (h.onLeftGrab?.(u, v, w, hh)) {
      grabbed = {
        moved: 0
      };
    } else scroll = {
      x: e.clientX,
      y: e.clientY,
      acc: 0
    };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (view) {
      const dx = e.clientX - view.x, dy = e.clientY - view.y;
      const r = canvas.getBoundingClientRect();
      if (view.mode === "pan") cfg.getSlice().panByPixels(cfg.orient, dx, dy, r.width, r.height);
      else cfg.getSlice().zoomAbout(cfg.orient, Math.exp(dy * 6e-3), view.pu, view.pv, r.width, r.height);
      view.x = e.clientX;
      view.y = e.clientY;
      cfg.redraw();
      return;
    }
    if (grabbed) {
      grabbed.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      const { u, v, w, h: hh } = uv(e);
      h.onLeftDrag?.(u, v, w, hh);
      return;
    }
    if (scroll) {
      scroll.acc += e.clientX - scroll.x - (e.clientY - scroll.y);
      scroll.x = e.clientX;
      scroll.y = e.clientY;
      while (Math.abs(scroll.acc) >= SCROLL_PX) {
        const f = scroll.acc > 0;
        cfg.step(f);
        scroll.acc -= f ? SCROLL_PX : -SCROLL_PX;
      }
      cfg.redraw();
      return;
    }
    if (e.buttons === 0 && h.onHover) {
      const { u, v, w, h: hh } = uv(e);
      h.onHover(u, v, w, hh);
    }
  };
  const onUp = (e) => {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
    }
    if (view) {
      view = null;
      canvas.style.cursor = "default";
      return;
    }
    if (grabbed) {
      const m = grabbed.moved;
      grabbed = null;
      h.onLeftDrop?.(m);
      return;
    }
    scroll = null;
  };
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("wheel", onWheel, {
    passive: false
  });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  return {
    resetView() {
      cfg.getSlice().resetView(cfg.orient);
      cfg.redraw();
    },
    detach() {
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    }
  };
}

// render/vtk-camera.ts
var sub = (a, b) => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2]
];
var add = (a, b) => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2]
];
var scale = (a, s) => [
  a[0] * s,
  a[1] * s,
  a[2] * s
];
var cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
var dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var norm = (a) => Math.hypot(a[0], a[1], a[2]);
var normalize = (a) => {
  const n = norm(a) || 1;
  return [
    a[0] / n,
    a[1] / n,
    a[2] / n
  ];
};
function rotateAboutAxis(v, axis, deg) {
  const k = normalize(axis);
  const t = deg * Math.PI / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c)
  ];
}
var VtkCamera = class _VtkCamera {
  position;
  focalPoint;
  viewUp;
  viewAngle;
  parallelProjection = false;
  parallelScale = 1;
  constructor(position = [
    0,
    0,
    1
  ], focalPoint = [
    0,
    0,
    0
  ], viewUp = [
    0,
    1,
    0
  ], viewAngle = 30) {
    this.position = [
      ...position
    ];
    this.focalPoint = [
      ...focalPoint
    ];
    this.viewUp = [
      ...viewUp
    ];
    this.viewAngle = viewAngle;
  }
  /** Slicer's default 3D camera (vtkMRMLCameraNode): (0,500,0) -> origin, +S up, 30 deg. */
  static slicerDefault() {
    return new _VtkCamera([
      0,
      500,
      0
    ], [
      0,
      0,
      0
    ], [
      0,
      0,
      1
    ], 30);
  }
  clone() {
    const c = new _VtkCamera(this.position, this.focalPoint, this.viewUp, this.viewAngle);
    c.parallelProjection = this.parallelProjection;
    c.parallelScale = this.parallelScale;
    return c;
  }
  get distance() {
    return norm(sub(this.focalPoint, this.position));
  }
  /** normalize(focalPoint - position) — vtkCamera::DirectionOfProjection. */
  get directionOfProjection() {
    return normalize(sub(this.focalPoint, this.position));
  }
  /** Rows of the view transform, per vtkTransform::SetupCamera. */
  basis(viewUp = this.viewUp) {
    const back = normalize(sub(this.position, this.focalPoint));
    const right = normalize(cross(viewUp, back));
    const up = cross(back, right);
    return {
      right,
      up,
      back
    };
  }
  /** vtkCamera::Azimuth — rotate position about viewUp through the focal point. */
  azimuth(deg) {
    const rel = sub(this.position, this.focalPoint);
    this.position = add(this.focalPoint, rotateAboutAxis(rel, this.viewUp, deg));
  }
  /** vtkCamera::Elevation — rotate position about -right through the focal point.
   *  Returns the rotated view-up VTK uses internally (see class comment); callers that
   *  mirror Slicer follow with orthogonalizeViewUp(rotatedUp). */
  elevation(deg) {
    const axis = scale(this.basis().right, -1);
    const rotatedUp = rotateAboutAxis(this.viewUp, axis, deg);
    const rel = sub(this.position, this.focalPoint);
    this.position = add(this.focalPoint, rotateAboutAxis(rel, axis, deg));
    return rotatedUp;
  }
  /** vtkCamera::OrthogonalizeViewUp — viewUp = row1 of the view transform. */
  orthogonalizeViewUp(usingUp = this.viewUp) {
    this.viewUp = this.basis(usingUp).up;
  }
  /** vtkCamera::Dolly — factor > 1 moves the camera toward the focal point. */
  dolly(factor) {
    if (factor <= 0) return;
    if (this.parallelProjection) {
      this.parallelScale = this.parallelScale / factor;
      return;
    }
    const d = this.distance / factor;
    const dop = this.directionOfProjection;
    this.position = sub(this.focalPoint, scale(dop, d));
  }
  /** Translate both position and focal point (used by pan). */
  translate(v) {
    this.position = add(this.position, v);
    this.focalPoint = add(this.focalPoint, v);
  }
  /** Half-height of the view plane at the focal point (perspective). */
  focalPlaneHalfHeight() {
    return this.parallelProjection ? this.parallelScale : this.distance * Math.tan(this.viewAngle * Math.PI / 360);
  }
  /** Pan by a display-space delta, moving the world under the cursor 1:1 at focal depth.
   *  Equivalent to vtkMRMLCameraWidget::ProcessTranslate's focal-depth unprojection, but
   *  expressed directly in the camera basis (exact for a centred perspective view).
   *  dxDisplay/dyDisplay are in VTK display convention (y UP). */
  panByDisplayDelta(dxDisplay, dyDisplay, viewportWidth, viewportHeight) {
    const halfH = this.focalPlaneHalfHeight();
    const mmPerPixel = 2 * halfH / viewportHeight;
    const { right, up } = this.basis();
    const motion = add(scale(right, -dxDisplay * mmPerPixel), scale(up, -dyDisplay * mmPerPixel));
    this.translate(motion);
  }
  /** Project a world (RAS) point to display pixels (y DOWN, origin top-left) for a w×h viewport.
   *  Vertical-FOV perspective matching SceneRenderer.setCamera (perspectiveZO(fovy, w/h)). `depth`
   *  is the distance along the view direction (>0 in front of the camera). Used to hit-test
   *  screen-space markup glyphs. */
  worldToDisplay(p, w, h) {
    const { right, up } = this.basis();
    const dop = this.directionOfProjection;
    const rel = sub(p, this.position);
    const depth = dot(rel, dop);
    const halfH = Math.max(1e-6, depth) * Math.tan(this.viewAngle * Math.PI / 360);
    const aspect = w / h;
    const ndcx = dot(rel, right) / (halfH * aspect);
    const ndcy = dot(rel, up) / halfH;
    return {
      x: (ndcx * 0.5 + 0.5) * w,
      y: (0.5 - ndcy * 0.5) * h,
      depth
    };
  }
  /** Inverse of worldToDisplay at a FIXED view-depth: the world point under display pixel (x,y)
   *  lying in the plane perpendicular to the view at `depth`. Dragging a 3D handle in this plane
   *  keeps its distance from the camera, so it tracks the cursor without depth ambiguity. */
  displayToWorldAtDepth(x, y, depth, w, h) {
    const { right, up } = this.basis();
    const dop = this.directionOfProjection;
    const halfH = Math.max(1e-6, depth) * Math.tan(this.viewAngle * Math.PI / 360);
    const aspect = w / h;
    const ndcx = x / w * 2 - 1;
    const ndcy = 1 - y / h * 2;
    const offset = add(scale(right, ndcx * halfH * aspect), scale(up, ndcy * halfH));
    return add(add(this.position, scale(dop, depth)), offset);
  }
  /** vtkCamera-comparable snapshot for the harness. */
  state() {
    return {
      position: [
        ...this.position
      ],
      focalPoint: [
        ...this.focalPoint
      ],
      viewUp: [
        ...this.viewUp
      ],
      viewAngle: this.viewAngle,
      distance: this.distance
    };
  }
};

// render/vtk-interactor.ts
var MOTION_FACTOR = 10;
var MOUSE_WHEEL_MOTION_FACTOR = 1;
function actionForButton(button, m = {}) {
  const shift = !!m.shift, ctrl = !!m.ctrl, alt = !!m.alt;
  if (button === 0) {
    if (shift && ctrl) return "scale";
    if (ctrl) return "spin";
    if (shift) return "translate";
    return "rotate";
  }
  if (button === 1) return "translate";
  if (button === 2) return "scale";
  return "none";
}
var CameraInteractor = class _CameraInteractor {
  camera;
  action = "none";
  prev = null;
  onChange;
  constructor(camera, onChange) {
    this.camera = camera;
    this.onChange = onChange;
  }
  /** Convert browser (cssX, cssY within the view) to VTK display coords (y up). */
  static toDisplay(cssX, cssY, height) {
    return [
      cssX,
      height - cssY
    ];
  }
  start(button, cssX, cssY, height, m = {}) {
    this.action = actionForButton(button, m);
    this.prev = _CameraInteractor.toDisplay(cssX, cssY, height);
  }
  end() {
    this.action = "none";
    this.prev = null;
  }
  /** Mouse move while dragging. width/height are the view size in CSS pixels. */
  move(cssX, cssY, width, height) {
    if (this.action === "none" || !this.prev) return;
    const [x, y] = _CameraInteractor.toDisplay(cssX, cssY, height);
    const dx = x - this.prev[0];
    const dy = y - this.prev[1];
    if (dx === 0 && dy === 0) return;
    switch (this.action) {
      case "rotate":
        this.rotate(dx, dy, width, height);
        break;
      case "translate":
        this.camera.panByDisplayDelta(dx, dy, width, height);
        break;
      case "scale":
        this.scale(dy, height);
        break;
      case "spin":
        this.spin(x, y, this.prev[0], this.prev[1], width, height);
        break;
    }
    this.prev = [
      x,
      y
    ];
    this.onChange?.();
  }
  /** vtkMRMLCameraWidget::ProcessRotate */
  rotate(dx, dy, width, height) {
    const deltaAzimuth = -20 / width;
    const deltaElevation = -20 / height;
    const rxf = dx * deltaAzimuth * MOTION_FACTOR;
    const ryf = dy * deltaElevation * MOTION_FACTOR;
    this.camera.azimuth(rxf);
    const rotatedUp = this.camera.elevation(ryf);
    this.camera.orthogonalizeViewUp(rotatedUp);
  }
  /** vtkMRMLCameraWidget::ProcessScale — note the sign flip vs plain VTK. */
  scale(dy, height) {
    const centerY = height / 2;
    const dyf = MOTION_FACTOR * dy / centerY;
    this.camera.dolly(Math.pow(1.1, -dyf));
  }
  /** vtkMRMLCameraWidget::ProcessSpin — roll about the view plane normal. */
  spin(x, y, px, py, width, height) {
    const cx = width / 2, cy = height / 2;
    const newAngle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
    const oldAngle = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
    this.roll(newAngle - oldAngle);
  }
  /** vtkCamera::Roll — rotate viewUp about the direction of projection. */
  roll(deg) {
    const cam = this.camera;
    const axis = cam.directionOfProjection;
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const v = cam.viewUp;
    const k = axis;
    const kv = [
      k[1] * v[2] - k[2] * v[1],
      k[2] * v[0] - k[0] * v[2],
      k[0] * v[1] - k[1] * v[0]
    ];
    const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    cam.viewUp = [
      v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
      v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
      v[2] * c + kv[2] * s + k[2] * kd * (1 - c)
    ];
    cam.orthogonalizeViewUp();
    this.onChange?.();
  }
  /** Mouse wheel. `forward` = wheel away from the user = zoom in. */
  wheel(forward) {
    const e = 0.2 * MOTION_FACTOR * MOUSE_WHEEL_MOTION_FACTOR;
    this.camera.dolly(Math.pow(1.1, forward ? e : -e));
    this.onChange?.();
  }
};

// render/demos/camera-control.ts
function attachCameraControls(canvas, camera, opts = {}) {
  const interactor = new CameraInteractor(camera, opts.onChange);
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top
    };
  };
  canvas.style.touchAction = "none";
  const docEl = (canvas.ownerDocument ?? document).documentElement;
  if (docEl) docEl.style.overscrollBehavior = "none";
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), {
    passive: false
  });
  const pointers = /* @__PURE__ */ new Map();
  let pinch = null;
  const pinchState = () => {
    const [a, b] = [
      ...pointers.values()
    ];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2
    };
  };
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = local(e);
    pointers.set(e.pointerId, {
      x,
      y
    });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      interactor.start(e.button, x, y, canvas.clientHeight, {
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey
      });
      opts.onLog?.("cameraStart", {
        action: interactor.action,
        x,
        y,
        button: e.button,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey
      });
    } else if (pointers.size === 2) {
      interactor.end();
      pinch = pinchState();
    }
  });
  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const p = [
        ...pointers.values()
      ][0];
      interactor.start(0, p.x, p.y, canvas.clientHeight, {
        shift: false,
        ctrl: false,
        alt: false
      });
    } else if (pointers.size === 0) {
      interactor.end();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const { x, y } = local(e);
    pointers.set(e.pointerId, {
      x,
      y
    });
    if (pointers.size >= 2) {
      const p = pinchState();
      if (pinch) {
        if (p.dist > 0 && pinch.dist > 0) camera.dolly(p.dist / pinch.dist);
        camera.panByDisplayDelta(p.mx - pinch.mx, pinch.my - p.my, canvas.clientWidth, canvas.clientHeight);
        opts.onChange?.();
      }
      pinch = p;
    } else if (interactor.action !== "none") {
      interactor.move(x, y, canvas.clientWidth, canvas.clientHeight);
    }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    interactor.wheel(e.deltaY < 0);
    opts.onLog?.("cameraWheel", {
      deltaY: e.deltaY,
      distance: camera.distance
    });
  }, {
    passive: false
  });
  return interactor;
}
function framedCamera(center, radius, distMul = 2.6) {
  return new VtkCamera([
    center[0],
    center[1] + radius * distMul,
    center[2]
  ], [
    ...center
  ], [
    0,
    0,
    1
  ], 30);
}

// render/demos/view-grid.ts
function attachDoubleClick(canvas, onDbl) {
  let last = 0, lx = 0, ly = 0;
  canvas.addEventListener("pointerdown", (e) => {
    const dbl = e.timeStamp - last < 350 && Math.hypot(e.clientX - lx, e.clientY - ly) < 6;
    last = dbl ? 0 : e.timeStamp;
    lx = e.clientX;
    ly = e.clientY;
    if (dbl) {
      e.preventDefault();
      onDbl();
    }
  });
}

// render/demos/crosshair.ts
function createCrosshair(visible = true) {
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  const st = {
    ras: null,
    visible,
    set(ras) {
      this.ras = ras;
      notify();
    },
    toggle(on) {
      this.visible = on ?? !this.visible;
      notify();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
  return st;
}
function drawCross(ctx, x, y, opts = {}) {
  const size = opts.size ?? 11, gap = opts.gap ?? 3;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = opts.color ?? "rgba(120,220,255,0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 2;
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + size);
  ctx.stroke();
  ctx.restore();
}
function rasToScreen3D(cam, ras, w, h) {
  const vp = multiply(perspectiveZO(cam.viewAngle * Math.PI / 180, w / h, 1, 1e5), lookAt(cam.position, cam.focalPoint, cam.viewUp));
  const cw = vp[3] * ras[0] + vp[7] * ras[1] + vp[11] * ras[2] + vp[15];
  if (cw <= 0) return null;
  return {
    x: (vp[0] * ras[0] + vp[4] * ras[1] + vp[8] * ras[2] + vp[12]) / cw * 0.5 + 0.5,
    y: 1 - ((vp[1] * ras[0] + vp[5] * ras[1] + vp[9] * ras[2] + vp[13]) / cw * 0.5 + 0.5)
  };
}

// render/demos/sl-logo.ts
var SL_LOGO = "data:image/png;base64,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";

// render/demos/sl-chrome.ts
var DEFAULT_HELP = [
  {
    title: "3D view",
    rows: [
      [
        "Left-drag",
        "Rotate"
      ],
      [
        "Right-drag",
        "Zoom"
      ],
      [
        "Middle / Shift+Left-drag",
        "Pan"
      ],
      [
        "Wheel / two-finger",
        "Zoom (dolly)"
      ],
      [
        "Double-click",
        "Maximize / restore"
      ],
      [
        "Shift + move",
        "Pick \u2192 jump slices to the point"
      ]
    ]
  },
  {
    title: "Slice views",
    rows: [
      [
        "Wheel / Left-drag",
        "Scroll through slices"
      ],
      [
        "Right-drag / \u2318-wheel",
        "Zoom this slice"
      ],
      [
        "Middle / Shift+Left-drag",
        "Pan"
      ],
      [
        "Double-click",
        "Maximize / restore"
      ],
      [
        "R",
        "Reset pan/zoom"
      ],
      [
        "Shift + move",
        "Jump the other views to the point under the cursor"
      ]
    ]
  }
];
function glass(el2, extra = "") {
  el2.style.cssText += ";background:linear-gradient(135deg,rgba(58,64,88,.55),rgba(20,24,38,.66));backdrop-filter:blur(20px) saturate(1.6);-webkit-backdrop-filter:blur(20px) saturate(1.6);border:1px solid rgba(255,255,255,.2);box-shadow:0 18px 50px rgba(0,0,0,.55);" + extra;
}
function installChrome(opts) {
  const controls = opts.controls ?? [];
  const help = opts.help ?? DEFAULT_HELP;
  const helpBtn = document.createElement("button");
  helpBtn.textContent = "?";
  helpBtn.title = "Controls & key bindings";
  helpBtn.style.cssText = "position:fixed;top:12px;left:12px;z-index:74;width:32px;height:32px;padding:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#cfe6ff;font:700 15px -apple-system,system-ui,sans-serif;";
  glass(helpBtn);
  helpBtn.onclick = openHelp;
  document.body.appendChild(helpBtn);
  let helpEl = null;
  function openHelp() {
    if (helpEl) return;
    helpEl = document.createElement("div");
    helpEl.style.cssText = "position:fixed;inset:0;z-index:96;display:flex;align-items:center;justify-content:center;background:rgba(6,8,14,.55);font:13px/1.5 -apple-system,system-ui,sans-serif;color:#e8eeff;";
    helpEl.addEventListener("mousedown", (e) => {
      if (e.target === helpEl) closeHelp();
    });
    const panel = document.createElement("div");
    panel.style.cssText = "max-width:min(640px,92vw);max-height:86vh;overflow-y:auto;padding:22px 26px;border-radius:16px;color:#eaf0ff;";
    glass(panel);
    panel.innerHTML = `<div style="font:800 20px -apple-system,system-ui,sans-serif;margin-bottom:4px">SlicerLive \u2014 controls</div>`;
    for (const sec of help) {
      const rows2 = sec.rows.map(([k, d]) => `<div style="font:600 12px ui-monospace,Menlo,monospace;color:#fff5d6;white-space:nowrap">${k}</div><div style="color:rgba(232,238,255,.85)">${d}</div>`).join("");
      panel.innerHTML += `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)"><div style="font:700 11px -apple-system,system-ui,sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#9fe9ff;margin-bottom:9px">${sec.title}</div><div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;align-items:baseline">${rows2}</div></div>`;
    }
    panel.innerHTML += `<div style="margin-top:16px;font-size:12px;color:rgba(232,238,255,.55)">Press <b style="color:#fff5d6">esc</b> or click outside to dismiss.</div>`;
    helpEl.appendChild(panel);
    document.body.appendChild(helpEl);
    document.addEventListener("keydown", escClose, true);
  }
  function escClose(e) {
    if (e.key === "Escape") closeHelp();
  }
  function closeHelp() {
    if (helpEl) {
      helpEl.remove();
      helpEl = null;
      document.removeEventListener("keydown", escClose, true);
    }
  }
  const logo = document.createElement("div");
  logo.title = "SlicerLive \u2014 visualization";
  logo.style.cssText = "position:fixed;z-index:74;cursor:pointer;user-select:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 12px 6px;border-radius:14px;background:#121826;border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);transition:transform 120ms ease-out;";
  const mark = document.createElement("img");
  mark.src = SL_LOGO;
  mark.alt = "SlicerLive";
  mark.style.cssText = "height:40px;width:auto;display:block;filter:drop-shadow(0 0 5px rgba(255,200,80,.5));";
  const word = document.createElement("div");
  word.innerHTML = 'Slicer<b style="color:#ffd34d">Live</b>';
  word.style.cssText = "font:800 12px/1 -apple-system,system-ui,sans-serif;letter-spacing:.5px;color:#eef7ff;text-shadow:0 0 14px rgba(255,210,90,.4);";
  logo.appendChild(mark);
  logo.appendChild(word);
  document.body.appendChild(logo);
  const place = () => {
    const a = opts.anchor;
    const r = a && a.getClientRects().length ? a.getBoundingClientRect() : null;
    if (r && r.width > 2 && r.height > 2) {
      logo.style.top = Math.round(r.top + 8) + "px";
      logo.style.right = Math.round(window.innerWidth - r.right + 8) + "px";
    } else {
      logo.style.top = "10px";
      logo.style.right = "12px";
    }
  };
  place();
  requestAnimationFrame(place);
  globalThis.addEventListener("resize", place);
  if (opts.anchor && "ResizeObserver" in globalThis) new ResizeObserver(place).observe(opts.anchor);
  const pop = document.createElement("div");
  pop.style.cssText = "position:fixed;z-index:73;min-width:210px;max-width:300px;max-height:84vh;overflow-y:auto;padding:10px 12px;border-radius:12px;color:#eaf0ff;font:13px -apple-system,system-ui,sans-serif;opacity:0;pointer-events:none;transform:translateY(-6px);transition:opacity 120ms ease-out,transform 120ms ease-out;";
  glass(pop);
  document.body.appendChild(pop);
  const paintSw = (sw, on) => {
    sw.style.background = on ? "linear-gradient(180deg,#9fe9ff,#54c6f0)" : "rgba(255,255,255,.18)";
    sw.innerHTML = `<span style="position:absolute;top:2px;left:${on ? 17 : 2}px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left 120ms;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>`;
  };
  const afterPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
  const paintTri = (box, level, color) => {
    const pct = Math.round(level * 100);
    const c = `rgb(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)})`;
    box.style.opacity = level < 0.02 ? "0.75" : "1";
    box.innerHTML = `<span style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:${c};opacity:.9"></span><span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 10px -apple-system,system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.75)">${pct}%</span>`;
  };
  const triNext = (v) => v > 0.66 ? 0.5 : v > 0.04 ? 0 : 1;
  const attachOpacity = (box, get, set, color, onChange) => {
    box.style.cursor = "ew-resize";
    box.title = "Click: 100% \u2192 50% \u2192 off \xB7 Drag sideways for a live opacity slider";
    const paint = () => paintTri(box, get(), color);
    paint();
    let startX = 0, startV = 0, dragged = false, id = -1;
    box.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startV = get();
      dragged = false;
      id = e.pointerId;
      try {
        box.setPointerCapture(id);
      } catch {
      }
    });
    box.addEventListener("pointermove", (e) => {
      if (id < 0) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) dragged = true;
      if (dragged) {
        set(Math.max(0, Math.min(1, startV + dx / 130)));
        paint();
        onChange();
      }
    });
    const end = () => {
      if (id < 0) return;
      if (!dragged) {
        set(triNext(get()));
        paint();
        onChange();
      }
      try {
        box.releasePointerCapture(id);
      } catch {
      }
      id = -1;
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    return paint;
  };
  const OPBOX_CSS = "width:44px;height:18px;border-radius:6px;position:relative;overflow:hidden;flex:0 0 auto;background:rgba(255,255,255,.14);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);touch-action:none;";
  const rows = [];
  if (controls.length) {
    const head = document.createElement("div");
    head.textContent = "Visualization";
    head.style.cssText = "font:700 10px -apple-system,system-ui,sans-serif;letter-spacing:1.1px;text-transform:uppercase;color:#9fe9ff;margin:0 0 8px;";
    pop.appendChild(head);
    for (const c of controls) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:14px;padding:5px 0;";
      const lab = document.createElement("span");
      lab.textContent = c.label;
      row.appendChild(lab);
      if (c.getOpacity && c.setOpacity) {
        const box = document.createElement("span");
        box.style.cssText = OPBOX_CSS;
        row.appendChild(box);
        const paint = attachOpacity(box, c.getOpacity, (o) => c.setOpacity(o), c.color ?? [
          0.62,
          0.9,
          1
        ], () => opts.onChange?.());
        rows.push({
          c,
          row,
          repaint: paint
        });
      } else {
        row.style.cursor = "pointer";
        const sw = document.createElement("span");
        sw.style.cssText = "width:34px;height:19px;border-radius:999px;position:relative;transition:background 120ms;flex:0 0 auto;";
        row.appendChild(sw);
        row.onclick = () => {
          if (c.disabled?.()) return;
          const next = !c.get();
          paintSw(sw, next);
          afterPaint(() => {
            c.set(next);
            opts.onChange?.();
            refresh();
          });
        };
        rows.push({
          c,
          row,
          sw
        });
      }
      pop.appendChild(row);
    }
  } else if (opts.about === false && !opts.segments) {
    pop.textContent = "SlicerLive \u2014 WebGPU renderer";
  }
  const segHost = document.createElement("div");
  pop.appendChild(segHost);
  const segRows = [];
  function buildSegments() {
    const S = opts.segments;
    segRows.length = 0;
    segHost.innerHTML = "";
    if (!S) return;
    const list = S.list();
    if (!list.length) return;
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:6px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px;" + (list.length > 6 ? "max-height:210px;overflow-y:auto;" : "");
    for (const s of list) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 2px;";
      const left = document.createElement("span");
      left.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";
      const swatch = document.createElement("span");
      swatch.style.cssText = `flex:0 0 auto;width:11px;height:11px;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.25);background:rgb(${Math.round(s.color[0] * 255)},${Math.round(s.color[1] * 255)},${Math.round(s.color[2] * 255)})`;
      const lab = document.createElement("span");
      lab.textContent = s.name;
      lab.style.cssText = "font:500 12.5px -apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      left.appendChild(swatch);
      left.appendChild(lab);
      const box = document.createElement("span");
      box.style.cssText = OPBOX_CSS;
      row.appendChild(left);
      row.appendChild(box);
      const paint = attachOpacity(box, () => S.get(s.num), (o) => {
        if (!(S.enabled && !S.enabled())) S.set(s.num, o);
      }, s.color, () => opts.onChange?.());
      wrap.appendChild(row);
      segRows.push({
        num: s.num,
        box,
        color: s.color,
        paint
      });
    }
    segHost.appendChild(wrap);
    paintSegments();
  }
  function paintSegments() {
    const S = opts.segments;
    if (!S) return;
    const dis = S.enabled ? !S.enabled() : false;
    segHost.style.opacity = dis ? "0.4" : "1";
    for (const r of segRows) r.paint();
  }
  if (opts.about !== false) {
    const about = document.createElement("div");
    const aLabel = opts.about?.label ?? "About SlicerLive";
    const aURL = opts.about?.url ?? "https://github.com/pieper/SlicerLive";
    about.textContent = aLabel;
    about.style.cssText = "cursor:pointer;border-radius:9px;padding:9px 8px 3px;margin-top:4px;" + (controls.length || opts.segments ? "border-top:1px solid rgba(255,255,255,.12);" : "") + "font:600 13px -apple-system,system-ui,sans-serif;color:#9fe9ff;";
    about.onmouseenter = () => {
      about.style.background = "rgba(255,255,255,.07)";
    };
    about.onmouseleave = () => {
      about.style.background = "transparent";
    };
    about.onclick = (e) => {
      e.stopPropagation();
      globalThis.open(aURL, "_blank", "noopener");
    };
    pop.appendChild(about);
  }
  function refresh() {
    for (const { c, row, sw, repaint } of rows) {
      const dis = c.disabled?.() ?? false;
      row.style.opacity = dis ? "0.4" : "1";
      if (repaint) {
        repaint();
        continue;
      }
      const on = c.get();
      row.style.cursor = dis ? "default" : "pointer";
      sw.style.background = on ? "linear-gradient(180deg,#9fe9ff,#54c6f0)" : "rgba(255,255,255,.18)";
      sw.innerHTML = `<span style="position:absolute;top:2px;left:${on ? 17 : 2}px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left 120ms;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>`;
    }
    paintSegments();
  }
  refresh();
  const show = () => {
    buildSegments();
    refresh();
    const b = logo.getBoundingClientRect();
    pop.style.top = Math.round(b.bottom + 6) + "px";
    pop.style.right = Math.round(window.innerWidth - b.right) + "px";
    pop.style.opacity = "1";
    pop.style.pointerEvents = "auto";
    pop.style.transform = "translateY(0)";
  };
  const hide = () => {
    pop.style.opacity = "0";
    pop.style.pointerEvents = "none";
    pop.style.transform = "translateY(-6px)";
  };
  let pinned = false;
  logo.onmouseenter = () => {
    logo.style.transform = "scale(1.08)";
    show();
  };
  logo.onclick = () => {
    pinned = !pinned;
    pinned ? show() : hide();
  };
  logo.onmouseleave = () => {
    logo.style.transform = "scale(1)";
    if (!pinned) setTimeout(() => {
      if (!pop.matches(":hover") && !pinned) hide();
    }, 120);
  };
  pop.onmouseleave = () => {
    if (!pinned) hide();
  };
  return {
    refresh
  };
}

// render/scene-renderer.ts
var DEFAULT_FORMAT2 = "rgba8unorm-srgb";
var SCENE_FLOATS = 16;
var CLIP_FLOATS = 36;
var SceneRenderer = class _SceneRenderer {
  dev;
  format;
  placed = [];
  pipeline;
  sampler;
  camBuf;
  matBuf;
  mat;
  bind;
  // PICK pass: a 1x1 ray-trace that reuses the field compositing to find the RAS point where
  // front-to-back opacity first crosses 50% (Slicer's 3D volume pick). Ghost handles excluded.
  pickPipeline;
  pickBind;
  pickOff = 0;
  pickTarget;
  pickReadBuf;
  // PRODUCER→RECONSTRUCTOR seam (docs/UNIFIED-RENDERING-PLAN.md M1). The ray-march writes the
  // premultiplied composited sample into `traceTex` (rgba32float, lossless); `resolvePipeline`
  // composites it over the background into the output view. 1:1 for now (byte-identical); the
  // resolve pass is where spatial upsample + temporal accumulation (time-averaged AA) will live.
  resolvePipeline;
  resolveBind;
  resolveBgBuf;
  traceTex;
  traceView;
  traceW = 0;
  traceH = 0;
  // TEMPORAL ACCUMULATION (M2a, docs/UNIFIED-RENDERING-PLAN.md §3). When the view is still, each
  // frame jitters the CAMERA sub-pixel (Halton, via a clip-space translation of invVP — the shader
  // is untouched, so a non-jittered frame is byte-identical) and the Reconstructor folds it into a
  // running mean, converging to a supersampled, time-averaged-AA image. Ping-pong accum + running n.
  baseInvVP = new Float32Array(16);
  focalPx = 1;
  accumPipeline;
  accumBind = [
    void 0,
    void 0
  ];
  accumUniformBuf;
  accumTex = [
    void 0,
    void 0
  ];
  accumView = [
    void 0,
    void 0
  ];
  accumPing = 0;
  accumN = 0;
  lastAccumCam = new Float32Array(16);
  lastAccumValid = false;
  streamPipeline;
  streamBind;
  // RESOLUTION-SCALED reconstruction (M2b): while interacting, trace at a fraction of the view
  // (BudgetController) and Catmull-Rom UPSAMPLE the low-res trace to the view — the client-superres
  // ported from the Python spike. A settled view renders native + accumulates instead.
  superresPipeline;
  superresBind;
  superresBuf;
  // The moving/upscale path traces into its OWN low-res target so it never resizes/destroys the
  // full-size traceTex the accumulation bind groups reference (that sharing caused destroyed-texture
  // submits + MRT attachment-size mismatches → 3D flicker/blank during interaction).
  lowTex;
  lowView;
  lowW = 0;
  lowH = 0;
  accumW = 0;
  accumH = 0;
  /** Emit a default AABB-distance skip for fields that don't supply their own bound.
   *
   *  OFF because it MEASURED AS A NET LOSS (render/test/profile-boxskip.ts, 448², M-series):
   *      MultiVolume +8.7%   Volume+Fiducials +7.3%   Segmentation +96.5%   SingleVolume -15.5%
   *  The appealing theory — "Panoramix sits +200mm R of CTACardio, so rays spend much of the
   *  scene box outside one volume" — is true but worthless: ImageField's out-of-box sample was
   *  ALREADY nearly free (it early-returns on the texture-bounds test), so there was no per-step
   *  cost to remove. Meanwhile every field pays a box distance + horizon bookkeeping at every
   *  step it is INSIDE its box, which is most of the march since the scene box is the union of
   *  the field boxes. Fields with their own cheap early-out are hurt worst — SegmentField
   *  (`v<=0.02||v>=0.98`) nearly doubles. The lone SingleVolume win survives warm-up but has no
   *  algorithmic explanation (the box IS the scene box there, so the bound is 0 at every sample)
   *  and is almost certainly a shader-compiler/occupancy artifact — not something to bank on.
   *
   *  Kept behind a flag rather than deleted so the negative result stays reproducible, and
   *  because it may behave differently on other GPUs (NVIDIA/AMD) — re-measure before enabling.
   *  The real win for dense volumes is an occupancy grid over air INSIDE the box, not the box. */
  static boxSkip = false;
  canTime;
  clipOff = 0;
  constructor(gpu, format = DEFAULT_FORMAT2) {
    this.dev = gpu.device;
    this.format = format;
    this.canTime = gpu.features.has("timestamp-query");
    this.sampler = this.dev.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge"
    });
    this.camBuf = this.dev.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.resolveBgBuf = this.dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const rmod = this.dev.createShaderModule({
      code: this.resolveWgsl()
    });
    this.resolvePipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: rmod,
        entryPoint: "vs_resolve"
      },
      fragment: {
        module: rmod,
        entryPoint: "fs_resolve",
        targets: [
          {
            format: this.format
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
    this.accumUniformBuf = this.dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const amod = this.dev.createShaderModule({
      code: this.accumWgsl()
    });
    this.accumPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: amod,
        entryPoint: "vs_resolve"
      },
      fragment: {
        module: amod,
        entryPoint: "fs_accum",
        targets: [
          {
            format: "rgba32float"
          },
          {
            format: this.format
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
    this.superresBuf = this.dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const smod = this.dev.createShaderModule({
      code: this.superresWgsl()
    });
    this.superresPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: smod,
        entryPoint: "vs_resolve"
      },
      fragment: {
        module: smod,
        entryPoint: "fs_superres",
        targets: [
          {
            format: this.format
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
  }
  /** RECONSTRUCTOR (upsampling): Catmull-Rom (bicubic, 9 bilinear taps) reconstruction of the
   *  low-res premultiplied trace, composited over the background — the client-superres from the
   *  Python spike (435b28d), on WebGPU. Slight edge sharpening from the negative lobes; premultiplied
   *  so the alpha reconstructs correctly. Used only when the trace is smaller than the view. */
  superresWgsl() {
    return (
      /* wgsl */
      `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var<uniform> u_sr : vec4<f32>;   // (traceW, traceH, viewW, viewH)
@group(0) @binding(3) var<uniform> u_bg : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
// Catmull-Rom via 9 bilinear taps (Sigg/Hadwiger form).
fn cr(uv : vec2<f32>, texSize : vec2<f32>) -> vec4<f32> {
  let sp = uv * texSize;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let off12 = w2 / w12;
  let inv = 1.0 / texSize;
  let p0 = (tp1 - 1.0) * inv;
  let p3 = (tp1 + 2.0) * inv;
  let p12 = (tp1 + off12) * inv;
  var r = vec4<f32>(0.0);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p0.y),  0.0) * (w0.x  * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p0.y),  0.0) * (w12.x * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p0.y),  0.0) * (w3.x  * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p12.y), 0.0) * (w0.x  * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p12.y), 0.0) * (w3.x  * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p3.y),  0.0) * (w0.x  * w3.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p3.y),  0.0) * (w12.x * w3.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p3.y),  0.0) * (w3.x  * w3.y);
  return r;
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs_superres(v : RV) -> @location(0) vec4<f32> {
  let uv = v.position.xy / u_sr.zw;
  let s = cr(uv, u_sr.xy);
  let a = clamp(s.a, 0.0, 1.0);
  let bg = srgb2physical(u_bg.rgb);
  return vec4<f32>(mix(bg, s.rgb, a), 1.0);
}`
    );
  }
  /** Accumulating RECONSTRUCTOR: fold this frame's traced sample into the running mean (blend =
   *  1/n; blend=1 on reset → mean=this frame) and present it over the background. MRT so one pass
   *  updates the accumulation texture AND the swap-chain view. Frame N jitters the ray sub-pixel,
   *  so the mean over N frames is a supersampled, time-averaged-AA image (still camera). */
  accumWgsl() {
    return (
      /* wgsl */
      `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var t_accum : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u_ra : vec4<f32>;   // (bg.r, bg.g, bg.b, blend)
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
struct FO { @location(0) accum : vec4<f32>, @location(1) present : vec4<f32> };
@fragment
fn fs_accum(v : RV) -> FO {
  let p = vec2<i32>(v.position.xy);
  let cur = textureLoad(t_trace, p, 0);
  let prev = textureLoad(t_accum, p, 0);
  let acc = mix(prev, cur, u_ra.w);        // blend=1 on reset -> acc = cur
  let bg = srgb2physical(u_ra.rgb);
  var o : FO;
  o.accum = acc;
  o.present = vec4<f32>(mix(bg, acc.rgb, acc.a), 1.0);
  return o;
}`
    );
  }
  /** RECONSTRUCTOR (M1: identity resolve). Composites the traced premultiplied sample over the
   *  background — the exact `mix(bg, rgb, a)` the fused fs_main used. `textureLoad` at integer
   *  coords is a 1:1 fetch (no filtering), so the output is byte-identical to the fused path.
   *  M2 replaces this with a spatial-upsample + temporal-accumulate resolve. */
  resolveWgsl() {
    return (
      /* wgsl */
      `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u_bg : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs_resolve(v : RV) -> @location(0) vec4<f32> {
  let s = textureLoad(t_trace, vec2<i32>(v.position.xy), 0);
  let bg = srgb2physical(u_bg.rgb);
  return vec4<f32>(mix(bg, s.rgb, s.a), 1.0);
}`
    );
  }
  /** (Re)allocate the trace target + resolve bind group when the view size changes. */
  ensureTrace(width, height) {
    if (this.traceTex && this.traceW === width && this.traceH === height) return;
    this.traceTex?.destroy();
    this.traceTex = this.dev.createTexture({
      size: [
        width,
        height
      ],
      format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.traceView = this.traceTex.createView();
    this.traceW = width;
    this.traceH = height;
    this.resolveBind = this.dev.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.traceView
        },
        {
          binding: 1,
          resource: {
            buffer: this.resolveBgBuf
          }
        }
      ]
    });
  }
  /** (Re)allocate the low-res trace target + superres bind group when the moving render size changes.
   *  Separate from traceTex so a moving frame never disturbs the accumulation textures. */
  ensureLow(width, height) {
    if (this.lowTex && this.lowW === width && this.lowH === height) return;
    this.lowTex?.destroy();
    this.lowTex = this.dev.createTexture({
      size: [
        width,
        height
      ],
      format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.lowView = this.lowTex.createView();
    this.lowW = width;
    this.lowH = height;
    this.superresBind = this.dev.createBindGroup({
      layout: this.superresPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.lowView
        },
        {
          binding: 1,
          resource: this.sampler
        },
        {
          binding: 2,
          resource: {
            buffer: this.superresBuf
          }
        },
        {
          binding: 3,
          resource: {
            buffer: this.resolveBgBuf
          }
        }
      ]
    });
  }
  /** Adaptive (moving-frame) render: trace at `renderW×renderH` and Catmull-Rom upsample to the
   *  `viewW×viewH` output. The caller MUST have set the camera size to renderW×renderH (so the
   *  low-res rays fill the same frustum). Single frame, no accumulation — use while interacting;
   *  switch to renderAccum when the view settles. */
  renderUpscaled(view, renderW, renderH, viewW, viewH) {
    this.ensureLow(renderW, renderH);
    this.flush();
    this.dev.queue.writeBuffer(this.camBuf, 72, new Float32Array([
      this.focalPx * (viewH / renderH)
    ]));
    this.dev.queue.writeBuffer(this.superresBuf, 0, new Float32Array([
      renderW,
      renderH,
      viewW,
      viewH
    ]));
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.lowView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          }
        }
      ]
    });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const sp = enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 1
          }
        }
      ]
    });
    sp.setPipeline(this.superresPipeline);
    sp.setBindGroup(0, this.superresBind);
    sp.draw(3);
    sp.end();
    this.dev.queue.submit([
      enc.finish()
    ]);
  }
  /** Encode trace (producer) + resolve (reconstructor) into `enc`, output to `outView`. */
  encodeFrame(enc, outView) {
    const tp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.traceView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          }
        }
      ]
    });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const rp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: outView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 1
          }
        }
      ]
    });
    rp.setPipeline(this.resolvePipeline);
    rp.setBindGroup(0, this.resolveBind);
    rp.draw(3);
    rp.end();
  }
  /** (Re)allocate the ping-pong accumulation targets + their bind groups on a size change. Tracks its
   *  OWN size and always rebuilds accumBind against the current traceView (which ensureTrace, called
   *  first in renderAccum, has just refreshed) — so the bind never dangles on a destroyed trace. */
  ensureAccum(width, height) {
    if (this.accumTex[0] && this.accumW === width && this.accumH === height) return;
    this.accumW = width;
    this.accumH = height;
    for (let k = 0; k < 2; k++) {
      this.accumTex[k]?.destroy();
      this.accumTex[k] = this.dev.createTexture({
        size: [
          width,
          height
        ],
        format: "rgba32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      this.accumView[k] = this.accumTex[k].createView();
    }
    for (let k = 0; k < 2; k++) {
      this.accumBind[k] = this.dev.createBindGroup({
        layout: this.accumPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: this.traceView
          },
          {
            binding: 1,
            resource: this.accumView[k]
          },
          {
            binding: 2,
            resource: {
              buffer: this.accumUniformBuf
            }
          }
        ]
      });
    }
    this.accumN = 0;
    this.accumPing = 0;
  }
  /** Reset temporal accumulation — call when the view changes (camera move, scene edit, resize). */
  resetAccumulation() {
    this.accumN = 0;
  }
  /** Frames accumulated since the last reset (0 before the first accumulated frame). */
  accumCount() {
    return this.accumN;
  }
  /** Accumulating render: trace this frame (sub-pixel jittered) and fold it into the running mean,
   *  presenting the mean over the background. `reset` (or a view change) restarts the mean at this
   *  frame (n=1, no jitter — byte-identical to renderToView). Call repeatedly while the view is
   *  still to converge to a supersampled, time-averaged-AA image. */
  renderAccum(view, width, height, reset) {
    this.ensureTrace(width, height);
    this.ensureAccum(width, height);
    let camChanged = !this.lastAccumValid;
    const cam = this.baseInvVP;
    for (let i = 0; i < 16 && !camChanged; i++) if (cam[i] !== this.lastAccumCam[i]) camChanged = true;
    if (camChanged) reset = true;
    this.lastAccumCam.set(cam);
    this.lastAccumValid = true;
    if (reset) this.accumN = 0;
    this.accumN += 1;
    const n = this.accumN;
    if (n > 1) {
      const jx = _SceneRenderer.halton(n, 2) - 0.5, jy = _SceneRenderer.halton(n, 3) - 0.5;
      const T = new Float32Array(16);
      T[0] = T[5] = T[10] = T[15] = 1;
      T[12] = 2 * jx / width;
      T[13] = -2 * jy / height;
      this.dev.queue.writeBuffer(this.camBuf, 0, multiply(this.baseInvVP, T));
    } else {
      this.dev.queue.writeBuffer(this.camBuf, 0, this.baseInvVP);
    }
    this.flush();
    this.dev.queue.writeBuffer(this.accumUniformBuf, 0, new Float32Array([
      this.mat[12],
      this.mat[13],
      this.mat[14],
      1 / n
    ]));
    const prev = this.accumPing, next = 1 - this.accumPing;
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.traceView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          }
        }
      ]
    });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const ap = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.accumView[next],
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          }
        },
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 1
          }
        }
      ]
    });
    ap.setPipeline(this.accumPipeline);
    ap.setBindGroup(0, this.accumBind[prev]);
    ap.draw(3);
    ap.end();
    this.dev.queue.submit([
      enc.finish()
    ]);
    this.accumPing = next;
  }
  /** (Re)build the pipeline for a set of fields. */
  build(fields) {
    const kindCount = {};
    let uoff = SCENE_FLOATS, bbase = 3;
    this.placed = fields.map((field) => {
      const slot = kindCount[field.kind] ?? 0;
      kindCount[field.kind] = slot + 1;
      const p = {
        field,
        slot,
        uoff,
        bbase
      };
      uoff += field.uniformFloats();
      bbase += field.bindingCount;
      return p;
    });
    this.clipOff = uoff;
    this.pickOff = uoff + CLIP_FLOATS;
    this.mat = new Float32Array(uoff + CLIP_FLOATS + 4);
    this.matBuf = this.dev.createBuffer({
      size: (uoff + CLIP_FLOATS + 4) * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const module = this.dev.createShaderModule({
      code: this.wgsl()
    });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs_main"
      },
      fragment: {
        module,
        entryPoint: "fs_trace",
        targets: [
          {
            format: "rgba32float"
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
    this.pickPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs_main"
      },
      fragment: {
        module,
        entryPoint: "fs_pick",
        targets: [
          {
            format: "rgba32float"
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
    this.streamPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs_main"
      },
      fragment: {
        module,
        entryPoint: "fs_trace",
        targets: [
          {
            format: "rgba8unorm"
          }
        ]
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "none"
      }
    });
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: this.bindGroupEntries()
    });
    this.streamBind = this.dev.createBindGroup({
      layout: this.streamPipeline.getBindGroupLayout(0),
      entries: this.bindGroupEntries()
    });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({
      layout: this.pickPipeline.getBindGroupLayout(0),
      entries: this.bindGroupEntries()
    });
    this.setBackground(0.07, 0.08, 0.12);
    const step = this.placed.length ? Math.min(...this.placed.map((p) => p.field.sampleStep())) : 1;
    this.setSampleStep(step * 0.7);
    this.recomputeBounds();
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
    this.accumN = 0;
    this.lastAccumValid = false;
  }
  wgsl() {
    const members = this.placed.map((p) => p.field.structMembers(p.slot)).join("\n");
    const decls = this.placed.map((p) => p.field.declareBindings(p.slot, p.bbase)).join("\n");
    const modifiers = this.placed.filter((p) => p.field.modifier);
    const receivers = this.placed.filter((p) => !p.field.modifier);
    const modFns = modifiers.map((p) => p.field.samplingWGSL(p.slot)).join("\n");
    const slotOf = new Map(this.placed.map((p) => [
      p.field,
      p.slot
    ]));
    const tpFns = receivers.map((p) => {
      const tf = p.field.transform;
      const tfSlot = tf && tf.modifier ? slotOf.get(tf) : void 0;
      const body = tfSlot === void 0 ? "  return wp;" : `  return wp + displacement_grid${tfSlot}(wp);`;
      return `fn transform_point_${p.field.kind}${p.slot}(wp : vec3<f32>) -> vec3<f32> {
${body}
}`;
    }).join("\n");
    const fieldFns = receivers.map((p) => p.field.samplingWGSL(p.slot)).join("\n");
    const wf = (v) => (Number.isFinite(v) ? v : 0).toFixed(6);
    const boxSkipWGSL = (p) => {
      const [lo, hi] = p.field.aabb();
      return `
fn skip_${p.field.kind}${p.slot}(wp : vec3<f32>) -> f32 {
  let q = max(vec3<f32>(${wf(lo[0])}, ${wf(lo[1])}, ${wf(lo[2])}) - wp,
              wp - vec3<f32>(${wf(hi[0])}, ${wf(hi[1])}, ${wf(hi[2])}));
  return length(max(q, vec3<f32>(0.0)));   // 0 inside the box, exact distance outside
}`;
    };
    const ghostFields = receivers.filter((p) => p.field.ghost);
    const normalReceivers = receivers.filter((p) => !p.field.ghost);
    const clipGuard = (p, expr) => p.field.clippable === false ? expr : `if (!clipped) { ${expr} }`;
    const sampleInto = (nm, ghost) => ghost ? `let c = sample_field_${nm}(wp, rd); if (c.a > g_op) { g_op = c.a; g_col = c.rgb / max(c.a, 1e-4); }` : `let c = sample_field_${nm}(wp, rd); sum += c;`;
    const skipBranch = (p, clip, ghost = false) => {
      const nm = `${p.field.kind}${p.slot}`;
      const smp = sampleInto(nm, ghost);
      return `    if (t >= resume_${nm}) {
      let d_${nm} = max(skip_${nm}(wp) - step, 0.0);
      if (d_${nm} > 0.0) { resume_${nm} = t + d_${nm}; }
      else { ${clip ? clipGuard(p, smp) : smp} }
    }
    if (t < resume_${nm}) { jump_t = min(jump_t, resume_${nm}); } else { all_defer = false; }`;
    };
    const plainBranch = (p, clip, ghost = false) => {
      const nm = `${p.field.kind}${p.slot}`;
      const smp = sampleInto(nm, ghost);
      return `    { ${clip ? clipGuard(p, smp) : smp} all_defer = false; }`;
    };
    const normalSkippers = normalReceivers.filter((p) => !p.field.transform).filter((p) => _SceneRenderer.boxSkip || p.field.providesSkip && p.field.skipWGSL);
    const ghostSkippers = ghostFields.filter((p) => p.field.providesSkip && p.field.skipWGSL);
    const canSkip = new Set(normalSkippers.map((p) => p.field));
    const ghostCanSkip = new Set(ghostSkippers.map((p) => p.field));
    const skipFns = [
      ...normalSkippers.map((p) => p.field.providesSkip && p.field.skipWGSL ? p.field.skipWGSL(p.slot) : boxSkipWGSL(p)),
      ...ghostSkippers.map((p) => p.field.skipWGSL(p.slot))
    ].join("\n");
    const fns = [
      modFns,
      tpFns,
      fieldFns,
      skipFns
    ].filter((s) => s.trim()).join("\n");
    const skipInit = [
      ...normalSkippers,
      ...ghostSkippers
    ].map((p) => `  var resume_${p.field.kind}${p.slot} : f32 = -1.0e30;`).join("\n");
    const dispatch = normalReceivers.map((p) => canSkip.has(p.field) ? skipBranch(p, true) : plainBranch(p, true)).join("\n");
    const ghostDispatch = ghostFields.map((p) => ghostCanSkip.has(p.field) ? skipBranch(p, false, true) : plainBranch(p, false, true)).join("\n");
    const hasGhost = ghostFields.length > 0;
    const pickDispatch = normalReceivers.map((p) => `    ${clipGuard(p, `{ let c = sample_field_${p.field.kind}${p.slot}(wp, rd); sum += c; }`)}`).join("\n");
    return (
      /* wgsl */
      `
struct Camera { inv_view_proj : mat4x4<f32>, size : vec4<f32>, eye : vec4<f32> };
struct Material {
  bmin : vec4<f32>,
  bmax : vec4<f32>,
  scene : vec4<f32>,   // sample_step, _, _, _
  bg : vec4<f32>,
${members}
  clip_planes : array<vec4<f32>, 8>,   // (nx, ny, nz, offset) inward; tail so field offsets are stable
  clip_count : vec4<f32>,              // (count, _, _, _)
  pick_cursor : vec4<f32>,             // (ndc_x, ndc_y, _, _) \u2014 the ray for fs_pick
};
@group(0) @binding(0) var<uniform> u_cam : Camera;
@group(0) @binding(1) var<uniform> u_material : Material;
${this.usesSampler() ? "@group(0) @binding(2) var s_lin : sampler;" : ""}
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

// PRODUCER (fs_trace): march the ray and return the composited PREMULTIPLIED sample
// (integrated.rgb, integrated.a) BEFORE the background composite \u2014 a "traced pixel". The
// Reconstructor (fs_resolve / reconstructor.ts) composites it over the background. Splitting
// trace from assemble is the seam the unified local/remote pipeline turns on (see
// docs/UNIFIED-RENDERING-PLAN.md); the background composite is identical to the fused path, so
// output is byte-identical at full density. An empty slab returns transparent (0) \u2192 resolve = bg.
@fragment
fn fs_trace(v : Varyings) -> @location(0) vec4<f32> {
  let size = u_cam.size.xy;
  let ndc_x = (v.position.x / size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.position.y / size.y) * 2.0;
  let ro = ndc_to_world(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(ndc_x, ndc_y, 1.0, 1.0)) - ro);

  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(0.0); }

  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  if (t_far <= t_near) { return vec4<f32>(0.0); }
  let seed = ign(v.position.xy);
  var t = t_near;
  var integrated = vec4<f32>(0.0);
  var safety : i32 = 0;
  var saturated = false;   // LATCH: once opaque, normal fields stay off even after a ghost
                           // handle dims the accumulation (else the volume behind the handle
                           // would re-opaque over it and re-bury the shine-through).
  var g_op = 0.0;          // ghost (handle) surface: max opacity along the ray (0.5 inactive /
  var g_col = vec3<f32>(0.0);  // 1.0 active) and its colour \u2014 tracked, never accumulated.
${skipInit}
  loop {
    if (t >= t_far || safety >= 5000${hasGhost ? "" : " || integrated.a >= 0.99"}) { break; }
    let js = fract(sin(dot(v.position.xy + vec2<f32>(f32(safety) * 0.7548, f32(safety) * 0.5698), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5; // per-(pixel,sample) jitter \u2014 frame-invariant; temporal AA rides on the sub-pixel NDC jitter (frame.xy), which is exact identity at 0
    let wp = ro + rd * (t + js * step);
    var sum = vec4<f32>(0.0);
    var all_defer = true;        // every field guarantees emptiness here -> we may leap
    var jump_t = 1.0e30;         // nearest field horizon
    var clipped = false;         // ROI clip: sample on the negative side of any active plane
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    // Normal fields stop being sampled once the ray is opaque (latched); GHOST fields keep
    // their skip horizons and keep going, so a handle behind an opaque region still shines
    // through and the ray LEAPS between handles on the ghost skip (early-termination kept).
${hasGhost ? "    if (integrated.a >= 0.99) { saturated = true; }\n    if (!saturated) {" : ""}
${dispatch}
      if (sum.a > 0.0) { integrated = integrated + (1.0 - integrated.a) * vec4<f32>(sum.rgb, clamp(sum.a, 0.0, 1.0)); }
${hasGhost ? "    }" : ""}
${ghostDispatch}
    if (all_defer && jump_t > t + step) { t = jump_t; } else { t = t + step; }
    safety = safety + 1;
  }
  // GHOST x-ray, applied ONCE (never compounding): the volume IN FRONT of a handle is shown
  // at residual = 1 - handle_opacity (50% for an inactive handle at opacity 0.5, 0% for an
  // active/hovered handle at opacity 1.0), then the handle (colour g_col at opacity g_op)
  // draws over it.
  if (g_op > 0.001) {
    let ga = clamp(g_op, 0.0, 1.0);
    let residual = 1.0 - ga;
    let fA = integrated.a * residual;
    integrated = vec4<f32>(integrated.rgb * residual + (1.0 - fA) * g_col * ga, fA + (1.0 - fA) * ga);
  }
  return integrated;   // premultiplied (rgb, a); resolve composites over the background
}

// PICK: trace the cursor ray (pick_cursor NDC) through the SAME field compositing and return the
// world (RAS) position where front-to-back opacity first crosses 50% \u2014 Slicer's 3D volume pick.
// Output: (wp.x, wp.y, wp.z, hit). hit=0 means the ray never reached 50% (empty/miss).
@fragment
fn fs_pick() -> @location(0) vec4<f32> {
  let ro = ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 1.0, 1.0)) - ro);
  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(0.0); }
  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  var t = t_near;
  var acc = 0.0;
  var safety : i32 = 0;
  loop {
    if (t >= t_far || safety >= 5000 || acc >= 0.5) { break; }
    let wp = ro + rd * t;
    var clipped = false;
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    var sum = vec4<f32>(0.0);
${pickDispatch}
    if (sum.a > 0.0) {
      let a_new = acc + (1.0 - acc) * clamp(sum.a, 0.0, 1.0);
      if (a_new >= 0.5) { return vec4<f32>(wp, 1.0); }   // 50% crossing -> the pick point
      acc = a_new;
    }
    t = t + step;
  }
  return vec4<f32>(0.0);
}`
    );
  }
  setBackground(r, g, b) {
    this.mat[12] = r;
    this.mat[13] = g;
    this.mat[14] = b;
    this.mat[15] = 1;
  }
  setSampleStep(step) {
    this.mat[8] = step;
  }
  /** Van der Corput / Halton radical inverse in `base`. */
  static halton(i, base) {
    let f = 1, r = 0;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  }
  /** Set up to 8 clip planes (nx,ny,nz,offset), inward-normal, keep-side `dot(wp,n)+offset>=0`.
   *  Written into the uniform tail — a Tier-A update the next flush() uploads; no rebuild. */
  setClipPlanes(planes) {
    const n = Math.min(planes.length, 8);
    for (let i = 0; i < n; i++) this.mat.set(planes[i], this.clipOff + i * 4);
    this.mat[this.clipOff + 32] = n;
  }
  clearClip() {
    this.mat[this.clipOff + 32] = 0;
  }
  /** Axis-aligned RAS crop box [lo,hi] → 6 inward planes. offset = -dot(faceOrigin, n). */
  setClipBox(lo, hi) {
    this.setClipPlanes([
      [
        1,
        0,
        0,
        -lo[0]
      ],
      [
        -1,
        0,
        0,
        hi[0]
      ],
      [
        0,
        1,
        0,
        -lo[1]
      ],
      [
        0,
        -1,
        0,
        hi[1]
      ],
      [
        0,
        0,
        1,
        -lo[2]
      ],
      [
        0,
        0,
        -1,
        hi[2]
      ]
    ]);
  }
  /** Scene AABB = union of field AABBs; also picks a default sample step from the smallest field extent. */
  recomputeBounds() {
    if (!this.placed.length) return;
    let mn = [
      Infinity,
      Infinity,
      Infinity
    ], mx = [
      -Infinity,
      -Infinity,
      -Infinity
    ];
    for (const p of this.placed) {
      const [a, b] = p.field.aabb();
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], a[i]);
        mx[i] = Math.max(mx[i], b[i]);
      }
    }
    this.mat[0] = mn[0];
    this.mat[1] = mn[1];
    this.mat[2] = mn[2];
    this.mat[4] = mx[0];
    this.mat[5] = mx[1];
    this.mat[6] = mx[2];
  }
  /** Tier-A interactive update: re-pack every field's uniform block into the resident
   *  material buffer WITHOUT recompiling the pipeline or rebuilding the bind group. This is
   *  the render-side of the interaction architecture (ARCHITECTURE-2026-07-24 §7): a
   *  lightweight drag — clip planes, ROI box geometry, fiducial position, TPS displacement
   *  grid — mutates node state, the field re-derives its uniforms, and the SAME per-frame
   *  flush() the renderer already does uploads them. Cost is a CPU re-pack; no shader build.
   *
   *  Also refreshes the scene AABB (which is uniform-resident), so a moved field's ray-clip
   *  bounds stay correct. REQUIRES the field SET and each field's uniformFloats() to be
   *  unchanged since build() — geometry/appearance may change, STRUCTURE may not. A structural
   *  change (add/remove a field, a field that resizes its uniform block, or a texture swap
   *  needing refreshBindings) still goes through build()/refreshBindings(). This is exactly
   *  why moving geometry must be uniform-resident, never baked into generated WGSL — see the
   *  box-skip note above and RENDER-PERFORMANCE.md. */
  syncUniforms() {
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
    this.recomputeBounds();
  }
  /** Rebuild the bind group from the fields' current resources (e.g. after a field
   *  swapped a texture) without recompiling the pipeline. Field set/structure must be unchanged. */
  refreshBindings() {
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: this.bindGroupEntries()
    });
    this.streamBind = this.dev.createBindGroup({
      layout: this.streamPipeline.getBindGroupLayout(0),
      entries: this.bindGroupEntries()
    });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({
      layout: this.pickPipeline.getBindGroupLayout(0),
      entries: this.bindGroupEntries()
    });
  }
  /** Only fields with texture bindings use the shared sampler. `layout: "auto"` derives the
   *  layout from what the shader ACTUALLY references, so in a scene of purely procedural
   *  fields (e.g. fiducials/markups only) binding 2 is absent from the layout — supplying it
   *  anyway fails validation and the whole view silently renders nothing. Emit the sampler
   *  declaration and its bind entry under the SAME condition so the two can't drift. */
  usesSampler() {
    return this.placed.some((p) => p.field.bindingCount > 0);
  }
  bindGroupEntries() {
    const entries = [
      {
        binding: 0,
        resource: {
          buffer: this.camBuf
        }
      },
      {
        binding: 1,
        resource: {
          buffer: this.matBuf
        }
      }
    ];
    if (this.usesSampler()) entries.push({
      binding: 2,
      resource: this.sampler
    });
    for (const p of this.placed) entries.push(...p.field.bindEntries(p.slot, p.bbase));
    return entries;
  }
  setCamera(eye, center, up, fovyDeg, width, height) {
    const view = lookAt(eye, center, up);
    const proj = perspectiveZO(fovyDeg * Math.PI / 180, width / height, 1, 1e5);
    const invVP = invert(multiply(proj, view));
    this.baseInvVP = invVP;
    const cam = new Float32Array(24);
    cam.set(invVP, 0);
    this.focalPx = height / 2 / Math.tan(fovyDeg * Math.PI / 360);
    cam[16] = width;
    cam[17] = height;
    cam[18] = height / 2 / Math.tan(fovyDeg * Math.PI / 360);
    cam[20] = eye[0];
    cam[21] = eye[1];
    cam[22] = eye[2];
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
  }
  flush() {
    this.dev.queue.writeBuffer(this.matBuf, 0, this.mat);
  }
  /** Ray-trace the cursor (u,v in [0,1], y down) through the composited fields and return the
   *  RAS point where front-to-back opacity first reaches 50% — Slicer's 3D volume pick. Traces
   *  whatever renders (DVR volumes, SegmentField iso shells, RGBA), EXCLUDING ghost handles.
   *  Uses the camera set by the last setCamera(); returns null if the ray never reaches 50%. */
  async pick(u, v) {
    if (!this.pickPipeline || !this.pickBind || !this.placed.length) return null;
    this.mat[this.pickOff] = u * 2 - 1;
    this.mat[this.pickOff + 1] = 1 - v * 2;
    this.flush();
    if (!this.pickTarget) {
      this.pickTarget = this.dev.createTexture({
        size: [
          1,
          1
        ],
        format: "rgba32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });
      this.pickReadBuf = this.dev.createBuffer({
        size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
    }
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.pickTarget.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          }
        }
      ]
    });
    pass.setPipeline(this.pickPipeline);
    pass.setBindGroup(0, this.pickBind);
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({
      texture: this.pickTarget
    }, {
      buffer: this.pickReadBuf,
      bytesPerRow: 256,
      rowsPerImage: 1
    }, [
      1,
      1
    ]);
    this.dev.queue.submit([
      enc.finish()
    ]);
    await this.pickReadBuf.mapAsync(GPUMapMode.READ);
    const r = new Float32Array(this.pickReadBuf.getMappedRange().slice(0, 16));
    this.pickReadBuf.unmap();
    return r[3] > 0.5 ? [
      r[0],
      r[1],
      r[2]
    ] : null;
  }
  renderToView(view, width, height) {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const enc = this.dev.createCommandEncoder();
    this.encodeFrame(enc, view);
    this.dev.queue.submit([
      enc.finish()
    ]);
  }
  /** Exact GPU time of the ray-march pass (median ms over `iters`), via timestamp-query.
   *  Times ONLY the render pass — no texture copy/readback — so it reflects shader cost.
   *  Returns NaN if the device lacks timestamp-query. Deno gives full-resolution timestamps;
   *  Chrome quantizes them unless cross-origin isolated, so profile headless for sharp numbers. */
  async timePass(width, height, iters = 40) {
    if (!this.canTime) return NaN;
    this.flush();
    const target = this.dev.createTexture({
      size: [
        width,
        height
      ],
      format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    const view = target.createView();
    const qs = this.dev.createQuerySet({
      type: "timestamp",
      count: 2
    });
    const resolve = this.dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    });
    const read = this.dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const enc = this.dev.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: "clear",
            storeOp: "store",
            clearValue: {
              r: 0,
              g: 0,
              b: 0,
              a: 1
            }
          }
        ],
        timestampWrites: {
          querySet: qs,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1
        }
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bind);
      pass.draw(3);
      pass.end();
      enc.resolveQuerySet(qs, 0, 2, resolve, 0);
      enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
      this.dev.queue.submit([
        enc.finish()
      ]);
      await read.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(read.getMappedRange());
      const ms = Number(t[1] - t[0]) / 1e6;
      read.unmap();
      if (ms > 0 && Number.isFinite(ms)) samples.push(ms);
    }
    target.destroy();
    qs.destroy();
    resolve.destroy();
    read.destroy();
    if (!samples.length) return NaN;
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];
  }
  async renderToRGBA(width, height) {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const target = this.dev.createTexture({
      size: [
        width,
        height
      ],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    const enc = this.dev.createCommandEncoder();
    this.encodeFrame(enc, target.createView());
    const bpr = Math.ceil(width * 4 / 256) * 256;
    const buf = this.dev.createBuffer({
      size: bpr * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    enc.copyTextureToBuffer({
      texture: target
    }, {
      buffer: buf,
      bytesPerRow: bpr,
      rowsPerImage: height
    }, [
      width,
      height
    ]);
    this.dev.queue.submit([
      enc.finish()
    ]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap();
    target.destroy();
    buf.destroy();
    return out;
  }
  /** REMOTE PRODUCER (M3): trace at width×height and read back the PREMULTIPLIED sample (pre-
   *  background) as tightly-packed rgba8 — the bytes streamed to the remote client, which runs the
   *  same reconstruction (upsample + background composite) the local resolve does. The caller sets
   *  the camera to width×height first (like renderUpscaled). Returns width*height*4 bytes. */
  async traceSamples(width, height) {
    this.flush();
    const target = this.dev.createTexture({
      size: [
        width,
        height
      ],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: 0,
            g: 0,
            b: 0,
            a: 0
          }
        }
      ]
    });
    tp.setPipeline(this.streamPipeline);
    tp.setBindGroup(0, this.streamBind);
    tp.draw(3);
    tp.end();
    const bpr = Math.ceil(width * 4 / 256) * 256;
    const buf = this.dev.createBuffer({
      size: bpr * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    enc.copyTextureToBuffer({
      texture: target
    }, {
      buffer: buf,
      bytesPerRow: bpr,
      rowsPerImage: height
    }, [
      width,
      height
    ]);
    this.dev.queue.submit([
      enc.finish()
    ]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap();
    target.destroy();
    buf.destroy();
    return out;
  }
};

// render/fields.ts
function transformedAABB(m, lo, hi) {
  const mn = [
    Infinity,
    Infinity,
    Infinity
  ], mx = [
    -Infinity,
    -Infinity,
    -Infinity
  ];
  for (let i = 0; i < 8; i++) {
    const c = applyMat4(m, [
      i & 1 ? hi[0] : lo[0],
      i & 2 ? hi[1] : lo[1],
      i & 4 ? hi[2] : lo[2]
    ]);
    for (let a = 0; a < 3; a++) {
      mn[a] = Math.min(mn[a], c[a]);
      mx[a] = Math.max(mx[a], c[a]);
    }
  }
  return [
    mn,
    mx
  ];
}
var ImageField = class {
  kind = "img";
  bindingCount = 2;
  volTex;
  lutTex;
  dev;
  p2t;
  clim;
  shade;
  unit;
  stepMm;
  box;
  constructor(dev, data, dims, spacing, lut, opts) {
    const center = opts.center ?? [
      0,
      0,
      0
    ];
    this.volTex = dev.createTexture({
      size: dims,
      dimension: "3d",
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    dev.queue.writeTexture({
      texture: this.volTex
    }, data, {
      bytesPerRow: dims[0] * 4,
      rowsPerImage: dims[1]
    }, dims);
    this.lutTex = dev.createTexture({
      size: [
        256,
        1
      ],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    dev.queue.writeTexture({
      texture: this.lutTex
    }, lut, {
      bytesPerRow: 256 * 4
    }, [
      256,
      1
    ]);
    if (opts.ijkToRAS) {
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      this.stepMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {
      this.p2t = patientToTexture(dims, spacing, center);
      this.box = volumeAABB(dims, spacing, center);
      this.stepMm = Math.min(...spacing);
    }
    this.clim = opts.clim;
    this.shade = opts.shade ?? [
      0.35,
      0.75,
      0.35,
      20
    ];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
    this.dev = dev;
  }
  /** Replace the 256-entry rgba8 color/opacity LUT in place (no texture/bind-group churn).
   *  The bind group holds a stable view of lutTex, so the next render uses the new LUT. */
  setLUT(lut) {
    this.dev.queue.writeTexture({
      texture: this.lutTex
    }, lut, {
      bytesPerRow: 256 * 4
    }, [
      256,
      1
    ]);
  }
  origP2t;
  origBox;
  uniformFloats() {
    return 28;
  }
  aabb() {
    return this.box;
  }
  sampleStep() {
    return this.stepMm;
  }
  /** The r32float 3D scalar texture (e.g. to share with a SliceRenderer for MPR). */
  volumeTexture() {
    return this.volTex;
  }
  /** Centre of the volume in world (RAS) at identity — a natural pivot for a transform widget. */
  worldCenter() {
    const [lo, hi] = this.origBox ?? this.box;
    return [
      (lo[0] + hi[0]) / 2,
      (lo[1] + hi[1]) / 2,
      (lo[2] + hi[2]) / 2
    ];
  }
  /** Place the volume in the world by a rigid transform M (worldFromLocal): the ray samples
   *  at p2t·M⁻¹·wp, so the volume appears moved/rotated. A Tier-A interactive update — caller
   *  does scene.syncUniforms() (which re-packs p2t AND refreshes the ray-entry AABB). */
  setWorldTransform(m) {
    if (!this.origP2t) {
      this.origP2t = this.p2t;
      this.origBox = this.box;
    }
    this.p2t = multiply(this.origP2t, invert(m));
    this.box = transformedAABB(m, this.origBox[0], this.origBox[1]);
  }
  /** RAS(patient) -> texture[0,1] matrix (encodes the real ijkToRAS geometry). */
  patientToTexture() {
    return this.p2t;
  }
  structMembers(s) {
    return [
      `  img${s}_p2t : mat4x4<f32>,`,
      `  img${s}_clim : vec4<f32>,`,
      `  img${s}_shade : vec4<f32>,`,
      `  img${s}_params : vec4<f32>,`
    ].join("\n");
  }
  declareBindings(s, base) {
    return [
      `@group(0) @binding(${base}) var t_vol_img${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 1}) var t_lut_img${s} : texture_2d<f32>;`
    ].join("\n");
  }
  samplingWGSL(s) {
    return (
      /* wgsl */
      `
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
}`
    );
  }
  fillUniforms(out, off) {
    out.set(this.p2t, off);
    out[off + 16] = this.clim[0];
    out[off + 17] = this.clim[1];
    out[off + 20] = this.shade[0];
    out[off + 21] = this.shade[1];
    out[off + 22] = this.shade[2];
    out[off + 23] = this.shade[3];
    out[off + 24] = this.unit;
  }
  bindEntries(_s, base) {
    return [
      {
        binding: base,
        resource: this.volTex.createView()
      },
      {
        binding: base + 1,
        resource: this.lutTex.createView()
      }
    ];
  }
};
var SegmentField = class {
  kind = "seg";
  bindingCount;
  clippable;
  tex;
  attrTex;
  p2t;
  box;
  color;
  opacity;
  shade;
  bandMm;
  stepMm;
  mode;
  colorFromTex;
  interfaceMode;
  constructor(tex, dims, spacing, opts) {
    this.tex = tex;
    const center = opts.center ?? [
      0,
      0,
      0
    ];
    let voxelMm;
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
    this.shade = opts.shade ?? [
      0.2,
      0.85,
      0.3,
      32
    ];
    this.bandMm = opts.bandMm ?? voxelMm;
    this.stepMm = opts.sampleStepMm ?? Math.max(0.5 * voxelMm, 0.1);
    this.clippable = opts.clippable ?? true;
    this.mode = opts.mode ?? "iso";
    this.colorFromTex = opts.colorFromTexture ?? false;
    this.interfaceMode = this.mode === "sdf" && (opts.interfaceMode ?? false);
    this.attrTex = this.mode === "sdf" ? opts.attrTexture : void 0;
    this.bindingCount = this.attrTex ? 2 : 1;
  }
  /** Field-level opacity (multiplies every segment's per-label opacity in the shader). Live global
   *  segmentation opacity — the caller does scene.syncUniforms() + redraw to apply. */
  setOpacity(o) {
    this.opacity = Math.max(0, Math.min(1, o));
  }
  uniformFloats() {
    return 28;
  }
  aabb() {
    return this.box;
  }
  sampleStep() {
    return this.stepMm;
  }
  setTexture(tex, destroyPrev = true) {
    if (destroyPrev && this.tex !== tex) this.tex.destroy();
    this.tex = tex;
  }
  structMembers(s) {
    return [
      `  seg${s}_p2t : mat4x4<f32>,`,
      `  seg${s}_color : vec4<f32>,`,
      `  seg${s}_shade : vec4<f32>,`,
      `  seg${s}_params : vec4<f32>,`
    ].join("\n");
  }
  declareBindings(s, base) {
    const value = `@group(0) @binding(${base}) var t_seg${s} : texture_3d<f32>;`;
    return this.attrTex ? `${value}
@group(0) @binding(${base + 1}) var t_attr${s} : texture_3d<f32>;` : value;
  }
  samplingWGSL(s) {
    if (this.mode === "sdf") {
      return (
        /* wgsl */
        `
fn v_seg${s}(wp : vec3<f32>) -> f32 {   // signed distance (mm)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 1e3; }   // far outside \u2192 culled
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;
}
fn vgrad_seg${s}(wp : vec3<f32>) -> f32 {   // signed distance for the NORMAL finite-difference
  // A gradient tap that steps just outside the (padded) SDF texture must read BACKGROUND, not the
  // out-of-volume cull sentinel (1e3) \u2014 a huge sentinel would fabricate an enormous fake gradient that
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
  let pm = textureSampleLevel(t_seg${s}, s_lin, t, 0.0).rgb;   // PREMULTIPLIED (rgb\xB7opacity)${this.attrTex ? `
  let a = textureSampleLevel(t_attr${s}, s_lin, t, 0.0).r;      // per-segment opacity (crisp) \u2014 un-premultiply to the true colour, so a hidden neighbour's colour doesn't bleed in
  return pm / max(a, 1e-3);` : `
  return pm;`}
}${this.attrTex ? `
fn attr_seg${s}(wp : vec3<f32>) -> vec2<f32> {   // per-segment (.x = opacity, .y = shading mode)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec2<f32>(0.0); }
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).rg;
}` : ""}${this.interfaceMode ? `
fn bdist_seg${s}(wp : vec3<f32>) -> f32 {   // SMOOTH (seam-blurred) interface distance from attr.b \u2014 for the normal only
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = clamp(t4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).b;
}
fn pres_seg${s}(wp : vec3<f32>) -> f32 {   // CRISP in-segment presence (attr.a), linear-sampled for ~1-voxel AA
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 0.0; }
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).a;
}
fn g1_seg${s}(c : f32, wp : vec3<f32>, dir : vec3<f32>, h : f32) -> f32 {
  // One-sided difference of the SMOOTH interface distance along dir, picking the STEEPER side. The
  // unsigned distance has a V-crease at the surface: a central difference straddling it cancels (fake
  // zero gradient \u2192 degenerate normal). Taking the steeper one-sided difference follows the true \xB11
  // slope AWAY from the interface, so the normal stays well-defined right at the shell \u2014 computed on
  // the fly only at shell samples, no stored normal. Uses the blurred distance (attr.b) so the normal
  // is smooth (no JFA facets); the SHARP sdfTex.a still drives shell membership (surface stays at 0).
  let dp = bdist_seg${s}(wp + dir * h) - c;
  let dm = c - bdist_seg${s}(wp - dir * h);
  return select(dm, dp, abs(dp) > abs(dm)) / h;
}` : ""}
// Shell (surface) contribution at wp: crisp Phong shell around sdf=0. Weighted by (1-mode) so it
// morphs smoothly into the volume contribution across a blurred surface\u2194volume boundary.
fn surface_seg${s}(wp : vec3<f32>, rd : vec3<f32>, sdf : f32, band : f32, step : f32, seg_op : f32, op0 : f32) -> vec4<f32> {
  let d_mm = abs(sdf);
  if (d_mm > band + step) { return vec4<f32>(0.0); }
  let T = clamp(op0 * seg_op, 0.0, 1.0);      // TARGET surface opacity (per-segment \xD7 field)
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
  if (glen < 1e-5) { return vec4<f32>(0.0); }
  var n = g / glen;
  if (dot(n, -rd) < 0.0) { n = -n; }
  // SURFACE opacity (Slicer polydata parity): the shell is a THIN surface of opacity T, not a solid
  // band. A raymarch crosses it in several samples; giving each \u03B1=T lets the front-to-back OVER
  // saturate toward opaque (50% looked like ~100%). Instead accumulate OPTICAL DEPTH with a shell
  // profile \u03C1 = a/band that integrates to 1 across the crossing, scaled by -ln(1-T): \u03A3d\u03C4 = -ln(1-T),
  // so net opacity = 1-e^(-\u03A3d\u03C4) = T EXACTLY \u2014 independent of band thickness and sample rate, and T\u21921
  // stays crisply opaque. |dot(rd,n)| converts ray-step to shell-normal distance (\u21920 at grazing =
  // built-in silhouette AA).
  let a = max(1.0 - d_mm / band, 0.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  // Convert ray-step to d_mm-distance. Outer: RAW gradient projection |dot(rd,g)| = |d(d_mm)/ds|
  // (includes |grad sdf|, which the distance blur pulls below 1). Interface: the re-signed gradient has
  // an arbitrary magnitude (a sign jump at the interface), so use the UNIT normal cosine |dot(rd,n)| \u2014
  // still \u21920 at grazing (silhouette AA), and keeps opacity thickness-consistent.
  let rate = max(abs(dot(rd, ${this.interfaceMode ? "n" : "g"})), 1e-3);
  let tau = -log(1.0 - min(T, 0.9999)) * (a / band) * (step * rate);
  var op = 1.0 - exp(-tau);
${this.interfaceMode ? `  op = op * pres_seg${s}(wp);   // gate to GENUINELY in-segment voxels \u2014 kills the bled colour/opacity halo beyond the real edge` : ""}
  if (op <= 0.0004) { return vec4<f32>(0.0); }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = col_seg${s}(wp);
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);
}
fn sample_field_seg${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
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
    acc += (1.0 - mode) * surface_seg${s}(wp, rd, sdf, band, step, seg_op, op0);
  }
  return acc;` : `  return surface_seg${s}(wp, rd, sdf, band, step, 1.0, op0);`}
}`
      );
    }
    const alphaWGSL = this.mode === "surface" ? (
      /* wgsl */
      `
  let step = max(u_material.scene.x, 1e-3);
  let op = clamp(op0 * glen * step, 0.0, 1.0);
  if (op <= 0.0) { return vec4<f32>(0.0); }`
    ) : (
      /* wgsl */
      `
  // Local first-order signed distance to the v=0.5 isosurface (mm), then a
  // 1-voxel opacity band around it: crisp opaque shell, sub-voxel anti-aliased.
  let d_mm = abs((v - 0.5) / glen);
  let band = max(u_material.seg${s}_params.x, 1e-3);
  let a = 1.0 - clamp(d_mm / band, 0.0, 1.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  let op = clamp(a * op0, 0.0, 1.0);`
    );
    const colWGSL = this.colorFromTex ? (
      /* wgsl */
      `
fn col_seg${s}(wp : vec3<f32>) -> vec3<f32> {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec3<f32>(0.0); }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).rgb;
}`
    ) : "";
    const colExpr = this.colorFromTex ? `col_seg${s}(wp)` : `u_material.seg${s}_color.rgb`;
    return (
      /* wgsl */
      `
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
}`
    );
  }
  fillUniforms(out, off) {
    out.set(this.p2t, off);
    out[off + 16] = this.color[0];
    out[off + 17] = this.color[1];
    out[off + 18] = this.color[2];
    out[off + 19] = this.opacity;
    out[off + 20] = this.shade[0];
    out[off + 21] = this.shade[1];
    out[off + 22] = this.shade[2];
    out[off + 23] = this.shade[3];
    out[off + 24] = this.bandMm;
  }
  bindEntries(_s, base) {
    const e = [
      {
        binding: base,
        resource: this.tex.createView()
      }
    ];
    if (this.attrTex) e.push({
      binding: base + 1,
      resource: this.attrTex.createView()
    });
    return e;
  }
};

// render/bake.ts
var INIT_WGSL = (
  /* wgsl */
  `
struct U { dims : vec4<u32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(3) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let label = textureLoad(t_label, vec3<i32>(gid), 0).r;
  let pal = u_pal[label & 255u];
  let present = select(0.0, 1.0, label != 0u);
  textureStore(t_out, vec3<i32>(gid), vec4<f32>(pal.rgb, present * pal.a));
}`
);
var BLUR_WGSL = (
  /* wgsl */
  `
struct U { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };  // axis, radius; half-kernel weights
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : U;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var asum = center.a * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    let o = av * i;
    let p1 = clamp(c + o, vec3<i32>(0), dmax);
    let p2 = clamp(c - o, vec3<i32>(0), dmax);
    asum = asum + wt(u32(i)) * (textureLoad(t_in, p1, 0).a + textureLoad(t_in, p2, 0).a);
  }
  textureStore(t_out, c, vec4<f32>(center.rgb, asum));
}`
);
function gaussHalfKernel(sigma) {
  const radius = Math.max(1, Math.min(15, Math.ceil(3 * sigma)));
  const raw = new Float32Array(radius + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) {
    raw[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += (i === 0 ? 1 : 2) * raw[i];
  }
  const w = new Float32Array(16);
  for (let i = 0; i <= radius; i++) w[i] = raw[i] / total;
  return {
    radius,
    w
  };
}
function bakeColorizeRGBA(dev, labelmap, dims, palette, sigmaVoxels = 1.5) {
  const [dx, dy, dz] = dims;
  const storageUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
  const labelTex = dev.createTexture({
    size: dims,
    dimension: "3d",
    format: "r8uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  dev.queue.writeTexture({
    texture: labelTex
  }, labelmap, {
    bytesPerRow: dx,
    rowsPerImage: dy
  }, dims);
  const texA = dev.createTexture({
    size: dims,
    dimension: "3d",
    format: "rgba16float",
    usage: storageUsage
  });
  const texB = dev.createTexture({
    size: dims,
    dimension: "3d",
    format: "rgba16float",
    usage: storageUsage
  });
  const palBuf = dev.createBuffer({
    size: 256 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const palData = new Float32Array(256 * 4);
  palData.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
  dev.queue.writeBuffer(palBuf, 0, palData);
  const dimsBuf = dev.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  dev.queue.writeBuffer(dimsBuf, 0, new Uint32Array([
    dx,
    dy,
    dz,
    0
  ]));
  const gx = Math.ceil(dx / 4), gy = Math.ceil(dy / 4), gz = Math.ceil(dz / 4);
  const initPipe = dev.createComputePipeline({
    layout: "auto",
    compute: {
      module: dev.createShaderModule({
        code: INIT_WGSL
      }),
      entryPoint: "main"
    }
  });
  const initBind = dev.createBindGroup({
    layout: initPipe.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: labelTex.createView()
      },
      {
        binding: 1,
        resource: texA.createView()
      },
      {
        binding: 2,
        resource: {
          buffer: palBuf
        }
      },
      {
        binding: 3,
        resource: {
          buffer: dimsBuf
        }
      }
    ]
  });
  const enc = dev.createCommandEncoder();
  {
    const p = enc.beginComputePass();
    p.setPipeline(initPipe);
    p.setBindGroup(0, initBind);
    p.dispatchWorkgroups(gx, gy, gz);
    p.end();
  }
  if (sigmaVoxels <= 0) {
    dev.queue.submit([
      enc.finish()
    ]);
    labelTex.destroy();
    texB.destroy();
    return texA;
  }
  const { radius, w } = gaussHalfKernel(sigmaVoxels);
  const blurPipe = dev.createComputePipeline({
    layout: "auto",
    compute: {
      module: dev.createShaderModule({
        code: BLUR_WGSL
      }),
      entryPoint: "main"
    }
  });
  const passes = [
    [
      texA,
      texB,
      0
    ],
    [
      texB,
      texA,
      1
    ],
    [
      texA,
      texB,
      2
    ]
  ];
  for (const [src, dst, axis] of passes) {
    const ub = dev.createBuffer({
      size: 16 + 16 + 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    dev.queue.writeBuffer(ub, 0, new Uint32Array([
      dx,
      dy,
      dz,
      0,
      axis,
      radius,
      0,
      0
    ]));
    dev.queue.writeBuffer(ub, 32, w);
    const b = dev.createBindGroup({
      layout: blurPipe.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: src.createView()
        },
        {
          binding: 1,
          resource: dst.createView()
        },
        {
          binding: 2,
          resource: {
            buffer: ub
          }
        }
      ]
    });
    const p = enc.beginComputePass();
    p.setPipeline(blurPipe);
    p.setBindGroup(0, b);
    p.dispatchWorkgroups(gx, gy, gz);
    p.end();
  }
  dev.queue.submit([
    enc.finish()
  ]);
  labelTex.destroy();
  texA.destroy();
  return texB;
}
var ColorizeBaker = class {
  dev;
  dims;
  labelTex;
  ownsLabel;
  scratch;
  palBuf;
  dimsBuf;
  initPipe;
  blurPipe;
  g;
  /** `label` is either a CPU labelmap (baker allocates + uploads its own r8uint texture, the classic
   *  path) OR an EXTERNAL r8uint 3D texture the baker only READS (the shared-buffer path used by
   *  `algorithms/EditableSegmentation` — a compute effect writes the label texture on-GPU and the baker
   *  re-colorizes from it, no CPU round-trip). An external texture must be `r8uint` with at least
   *  TEXTURE_BINDING usage; the baker never writes or destroys it. */
  constructor(dev, label, dims) {
    this.dev = dev;
    this.dims = dims;
    const [dx, dy, dz] = dims;
    if (label instanceof GPUTexture) {
      this.labelTex = label;
      this.ownsLabel = false;
    } else {
      this.labelTex = dev.createTexture({
        size: dims,
        dimension: "3d",
        format: "r8uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      dev.queue.writeTexture({
        texture: this.labelTex
      }, label, {
        bytesPerRow: dx,
        rowsPerImage: dy
      }, dims);
      this.ownsLabel = true;
    }
    this.palBuf = dev.createBuffer({
      size: 256 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.dimsBuf = dev.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    dev.queue.writeBuffer(this.dimsBuf, 0, new Uint32Array([
      dx,
      dy,
      dz,
      0
    ]));
    this.initPipe = dev.createComputePipeline({
      layout: "auto",
      compute: {
        module: dev.createShaderModule({
          code: INIT_WGSL
        }),
        entryPoint: "main"
      }
    });
    this.blurPipe = dev.createComputePipeline({
      layout: "auto",
      compute: {
        module: dev.createShaderModule({
          code: BLUR_WGSL
        }),
        entryPoint: "main"
      }
    });
    this.g = [
      Math.ceil(dx / 4),
      Math.ceil(dy / 4),
      Math.ceil(dz / 4)
    ];
  }
  /** Re-upload an EDITED labelmap (same dims). Follow with bakeInto() to re-colorize into the caller's
   *  existing output textures — an in-place replace (no re-allocation, so a segmentation edit updates
   *  smoothly with no flash). */
  updateLabelmap(labelmap) {
    if (!this.ownsLabel) throw new Error("ColorizeBaker.updateLabelmap: label texture is external (write it via the owner, e.g. a compute effect), then call bakeInto()");
    const [dx, dy] = this.dims;
    this.dev.queue.writeTexture({
      texture: this.labelTex
    }, labelmap, {
      bytesPerRow: dx,
      rowsPerImage: dy
    }, this.dims);
  }
  /** Allocate an output texture sized/typed for this baker's labelmap (caller owns it). */
  output() {
    return this.dev.createTexture({
      size: this.dims,
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
  }
  /** (Re)colorize into `out` with `palette` (256*4 f32: rgb + presence*opacity) and Gaussian
   *  `sigmaVoxels` (0 = crisp, for the 2D slice overlay). In place — reuses everything resident. */
  bakeInto(out, palette, sigmaVoxels = 1.5) {
    const dev = this.dev, [gx, gy, gz] = this.g, [dx, dy, dz] = this.dims;
    const palData = new Float32Array(256 * 4);
    palData.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
    dev.queue.writeBuffer(this.palBuf, 0, palData);
    const enc = dev.createCommandEncoder();
    const smooth = sigmaVoxels > 0;
    if (smooth && !this.scratch) this.scratch = this.output();
    const initDst = smooth ? this.scratch : out;
    const initBind = dev.createBindGroup({
      layout: this.initPipe.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.labelTex.createView()
        },
        {
          binding: 1,
          resource: initDst.createView()
        },
        {
          binding: 2,
          resource: {
            buffer: this.palBuf
          }
        },
        {
          binding: 3,
          resource: {
            buffer: this.dimsBuf
          }
        }
      ]
    });
    {
      const p = enc.beginComputePass();
      p.setPipeline(this.initPipe);
      p.setBindGroup(0, initBind);
      p.dispatchWorkgroups(gx, gy, gz);
      p.end();
    }
    if (smooth) {
      const s = this.scratch;
      const { radius, w } = gaussHalfKernel(sigmaVoxels);
      const passes = [
        [
          s,
          out,
          0
        ],
        [
          out,
          s,
          1
        ],
        [
          s,
          out,
          2
        ]
      ];
      for (const [src, dst, axis] of passes) {
        const ub = dev.createBuffer({
          size: 16 + 16 + 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        dev.queue.writeBuffer(ub, 0, new Uint32Array([
          dx,
          dy,
          dz,
          0,
          axis,
          radius,
          0,
          0
        ]));
        dev.queue.writeBuffer(ub, 32, w);
        const b = dev.createBindGroup({
          layout: this.blurPipe.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: src.createView()
            },
            {
              binding: 1,
              resource: dst.createView()
            },
            {
              binding: 2,
              resource: {
                buffer: ub
              }
            }
          ]
        });
        const p = enc.beginComputePass();
        p.setPipeline(this.blurPipe);
        p.setBindGroup(0, b);
        p.dispatchWorkgroups(gx, gy, gz);
        p.end();
      }
    }
    dev.queue.submit([
      enc.finish()
    ]);
  }
  destroy() {
    if (this.ownsLabel) this.labelTex.destroy();
    this.scratch?.destroy();
    this.palBuf.destroy();
    this.dimsBuf.destroy();
  }
};

// render/zarr.ts
var ZDT = {
  "<f4": Float32Array,
  "<f8": Float64Array,
  "<i4": Int32Array,
  "<u4": Uint32Array,
  "<i2": Int16Array,
  "<u2": Uint16Array,
  "|i1": Int8Array,
  "|u1": Uint8Array,
  "<i1": Int8Array,
  "<u1": Uint8Array
};
async function inflateDeflate(buf) {
  const ds = new DecompressionStream("deflate");
  return await new Response(new Response(buf).body.pipeThrough(ds)).arrayBuffer();
}
async function fetchZarrVolume(blobBase, z, onBytes, concurrency = 12) {
  const Ctor = ZDT[z.dtype] ?? Int16Array;
  const [nz, ny, nx] = z.shape, [cz, cy, cx] = z.chunks, [ncz, ncy, ncx] = z.chunkGrid;
  const hashes = z.chunkHashes;
  const posBase = blobBase + z.dir + "/" + z.dataset + "/";
  const chunkUrl = (kk, jj, ii) => hashes ? blobBase + hashes[kk + "." + jj + "." + ii] : posBase + kk + "." + jj + "." + ii;
  const out = new Float32Array(nz * ny * nx);
  let lo = Infinity, hi = -Infinity;
  const jobs = [];
  for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) jobs.push([
    kk,
    jj,
    ii
  ]);
  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const [kk, jj, ii] = jobs[idx++];
      const resp = await fetch(chunkUrl(kk, jj, ii));
      let gz;
      if (resp.body && onBytes) {
        const parts = [];
        const rd = resp.body.getReader();
        let total = 0;
        for (; ; ) {
          const { done, value } = await rd.read();
          if (done) break;
          parts.push(value);
          total += value.byteLength;
          onBytes(value.byteLength);
        }
        const all = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.byteLength;
        }
        gz = all.buffer;
      } else {
        gz = await resp.arrayBuffer();
        onBytes?.(gz.byteLength);
      }
      const chunk = new Ctor(await inflateDeflate(gz));
      const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
      const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
      for (let zz = 0; zz < zw; zz++) {
        for (let yy = 0; yy < yw; yy++) {
          const src = (zz * cy + yy) * cx;
          const dst = ((z0 + zz) * ny + (y0 + yy)) * nx + x0;
          for (let xx = 0; xx < xw; xx++) {
            const v = chunk[src + xx];
            out[dst + xx] = v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({
    length: Math.min(concurrency, jobs.length)
  }, worker));
  return {
    data: out,
    dims: [
      nx,
      ny,
      nz
    ],
    range: [
      lo,
      hi
    ]
  };
}

// algorithms/geom.ts
function resampleIsotropic(lab, dims, ijkToRAS, maxDim, maxVoxels = Infinity) {
  const sp = spacingFromIjkToRAS2(ijkToRAS);
  const ext = [
    dims[0] * sp[0],
    dims[1] * sp[1],
    dims[2] * sp[2]
  ];
  let vox = Math.max(...ext) / maxDim;
  const count = (v) => Math.max(1, Math.round(ext[0] / v)) * Math.max(1, Math.round(ext[1] / v)) * Math.max(1, Math.round(ext[2] / v));
  let coarsened = false;
  if (count(vox) > maxVoxels) {
    vox = Math.cbrt(ext[0] * ext[1] * ext[2] / maxVoxels);
    coarsened = true;
  }
  const cd = [
    Math.max(1, Math.round(ext[0] / vox)),
    Math.max(1, Math.round(ext[1] / vox)),
    Math.max(1, Math.round(ext[2] / vox))
  ];
  const [nx, ny, nz] = dims, [cx, cy, cz] = cd;
  const out = new Uint32Array(cx * cy * cz);
  if (cx === nx && cy === ny && cz === nz) {
    for (let i = 0; i < out.length; i++) out[i] = lab[i];
    return {
      lab: out,
      dims,
      ijkToRAS,
      vox,
      coarsened
    };
  }
  for (let z = 0; z < cz; z++) {
    const sz = Math.min(nz - 1, Math.floor((z + 0.5) * nz / cz));
    for (let y = 0; y < cy; y++) {
      const sy = Math.min(ny - 1, Math.floor((y + 0.5) * ny / cy));
      for (let x = 0; x < cx; x++) {
        const sx = Math.min(nx - 1, Math.floor((x + 0.5) * nx / cx));
        out[(z * cy + y) * cx + x] = lab[(sz * ny + sy) * nx + sx];
      }
    }
  }
  const r = [
    nx / cx,
    ny / cy,
    nz / cz
  ], m = ijkToRAS.slice();
  for (let row = 0; row < 3; row++) {
    m[row * 4] *= r[0];
    m[row * 4 + 1] *= r[1];
    m[row * 4 + 2] *= r[2];
  }
  return {
    lab: out,
    dims: cd,
    ijkToRAS: m,
    vox,
    coarsened
  };
}
function spacingFromIjkToRAS2(ijkToRAS) {
  const col = (c) => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [
    col(0),
    col(1),
    col(2)
  ];
}

// algorithms/editable-segmentation.ts
var EditableSegmentation = class {
  dims;
  ijkToRAS;
  device;
  labelTex;
  dirtyCbs = [];
  constructor(device, dims, opts) {
    this.device = device;
    this.dims = dims;
    this.ijkToRAS = Array.from(opts.ijkToRAS);
    this.labelTex = device.createTexture({
      size: dims,
      dimension: "3d",
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    });
  }
  /** The master labelmap (r32uint storage). The logic layer reads it (to derive a presence texture);
   *  editing effects write it on-GPU (A-1+). */
  masterTexture() {
    return this.labelTex;
  }
  /** Register a callback fired after any edit — the logic layer rebakes + redraws. Returns an
   *  unsubscribe (so a logic can be swapped/disposed without leaking a stale rebake). */
  onDirty(cb) {
    this.dirtyCbs.push(cb);
    return () => {
      const i = this.dirtyCbs.indexOf(cb);
      if (i >= 0) this.dirtyCbs.splice(i, 1);
    };
  }
  /** Signal that the master was edited (effects call this after writing the label texture on-GPU). */
  markDirty() {
    for (const cb of this.dirtyCbs) cb();
  }
  /** Voxel spacing (mm) from the geometry — for mm↔voxel effect params. */
  spacingMm() {
    return spacingFromIjkToRAS2(this.ijkToRAS);
  }
  /** Load a full labelmap (ids 0..255) from CPU into the master, then notify. */
  loadLabelmap(data) {
    const [dx, dy, dz] = this.dims;
    const u32 = data instanceof Uint32Array ? data : Uint32Array.from(data);
    this.device.queue.writeTexture({
      texture: this.labelTex
    }, u32, {
      bytesPerRow: dx * 4,
      rowsPerImage: dy
    }, [
      dx,
      dy,
      dz
    ]);
    this.markDirty();
  }
  /** Read the master labelmap back to CPU (ids per voxel, x-fastest). Handles WebGPU's 256-byte
   *  bytesPerRow alignment. For tests + zarr serialization (A-7); not on the interactive path. */
  async readLabelmap() {
    const [dx, dy, dz] = this.dims;
    const bpr = Math.ceil(dx * 4 / 256) * 256;
    const rowU32 = bpr / 4;
    const buf = this.device.createBuffer({
      size: bpr * dy * dz,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({
      texture: this.labelTex
    }, {
      buffer: buf,
      bytesPerRow: bpr,
      rowsPerImage: dy
    }, [
      dx,
      dy,
      dz
    ]);
    this.device.queue.submit([
      enc.finish()
    ]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint32Array(buf.getMappedRange());
    const out = new Uint32Array(dx * dy * dz);
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) {
      const src = (z * dy + y) * rowU32, dst = (z * dy + y) * dx;
      for (let x = 0; x < dx; x++) out[dst + x] = padded[src + x];
    }
    buf.unmap();
    buf.destroy();
    return out;
  }
  destroy() {
    this.labelTex.destroy();
  }
};

// render/sdf-bake.ts
var INIT_WGSL2 = (
  /* wgsl */
  `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
// PADDED SDF GRID: the seed/SDF textures are LARGER than the labelmap by 'pad' voxels on every side
// (dims.w). Coord c is a padded-grid coord; the label lives at c-pad, and everything outside the label
// range is background (0). This gives a real spatial margin of background BEYOND the segmentation, so
// a segment touching the labelmap edge closes as a genuine capped surface with room for the SDF to go
// positive \u2014 and gradient/finite-difference samples near that cap stay in-bounds (they read real
// background) instead of hitting the out-of-volume cull sentinel, which used to poison the normal.
fn labelAt(c : vec3<i32>) -> u32 {
  let pad = i32(u.dims.w);
  let ld = vec3<i32>(u.dims.xyz) - vec3<i32>(2 * pad);   // label dims = padded dims - 2\xB7pad
  let lc = c - vec3<i32>(pad);
  if (any(lc < vec3<i32>(0)) || any(lc >= ld)) { return 0u; }
  return textureLoad(t_label, lc, 0).r;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let my = labelAt(c);
  let meIn = my != 0u;
  let allMode = u.params.y > 0.5;                   // 0 = outer boundary only; 1 = ANY label change (multi-material interfaces)
  var boundary = false;
  var region = my;                                  // inside voxel \u2192 own label
  let offs = array<vec3<i32>, 6>(vec3<i32>(1,0,0), vec3<i32>(-1,0,0), vec3<i32>(0,1,0), vec3<i32>(0,-1,0), vec3<i32>(0,0,1), vec3<i32>(0,0,-1));
  for (var i = 0; i < 6; i = i + 1) {
    let nl = labelAt(c + offs[i]);
    // outer mode: boundary at inside\u2194outside (segment\u2194background). all mode: boundary at ANY label change
    // (segment\u2194background AND segment\u2194segment) so embedded/nested structures get an interface shell too.
    let isChange = select((nl != 0u) != meIn, nl != my, allMode);
    // outer: a background boundary voxel adopts the neighbour's label (so the outer shell renders on both
    // sides). all: every voxel keeps its OWN label (background stays 0 = transparent), so the region
    // COLOUR changes across EVERY interface \u2014 including the outer one \u2014 which the shader's on-the-fly
    // re-signing needs to recover a clean inside/outside normal there too.
    if (isChange) { boundary = true; if (my == 0u && !allMode) { region = nl; } }
  }
  var seed = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (boundary) { seed = vec4<f32>((u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz, f32(region)); }
  textureStore(t_seed_out, c, seed);
}`
);
var JFA_WGSL = (
  /* wgsl */
  `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let step = i32(u.params.x);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var best = textureLoad(t_seed_in, c, 0);
  var bestD = select(1e30, distance(p, best.xyz), best.w > 0.5);
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        if (dx == 0 && dy == 0 && dz == 0) { continue; }
        let nc = clamp(c + vec3<i32>(dx, dy, dz) * step, vec3<i32>(0), dmax);
        let s = textureLoad(t_seed_in, nc, 0);
        if (s.w > 0.5) {
          let d = distance(p, s.xyz);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
  }
  textureStore(t_seed_out, c, best);
}`
);
var FINAL_WGSL = (
  /* wgsl */
  `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32>, origin : vec4<i32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_label : texture_3d<u32>;
@group(0) @binding(2) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> u : U;
@group(0) @binding(4) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(5) var t_attr : texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var<uniform> u_mode : array<vec4<f32>, 256>;   // .x = shading mode (0 surface, 1 volume)
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;   // region-limited dispatch offsets into the grid
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(c), 1.0)).xyz;
  let s = textureLoad(t_seed_in, c, 0);
  let valid = s.w > 0.5;
  let dist = select(1e3, distance(p, s.xyz), valid);
  let pad = i32(u.dims.w);                                       // label is offset by pad; pad region = background (outside)
  let lc = c - vec3<i32>(pad);
  let ld = vec3<i32>(u.dims.xyz) - vec3<i32>(2 * pad);
  let inRange = all(lc >= vec3<i32>(0)) && all(lc < ld);
  let ins = inRange && textureLoad(t_label, lc, 0).r != 0u;
  // outer mode: SIGNED (neg inside the union) \u2014 smooth zero-crossing = clean normals. all mode:
  // UNSIGNED distance to the nearest interface (every label change is a wall; no global inside/outside).
  let sdf = select(select(dist, -dist, ins), dist, u.params.y > 0.5);
  let lbl = u32(s.w + 0.5) & 255u;
  let pal = select(vec4<f32>(0.0), u_pal[lbl], valid);
  let mode = select(0.0, u_mode[lbl].x, valid);
  // PREMULTIPLIED colour (rgb\xB7opacity): the colour-seam blur then can't bleed a HIDDEN (opacity 0)
  // segment's colour into a visible neighbour \u2014 an invisible organ was still tinting the organ it
  // abutted (looked like half-opacity). The shader divides by the per-segment opacity to recover the
  // true colour, so a 0-opacity region contributes nothing to the blend.
  textureStore(t_out, c, vec4<f32>(pal.rgb * pal.a, sdf));
  // .r = opacity, .g = shading mode, .b = distance (seam-blurred \u2192 SMOOTH distance for the interface-mode
  // normal; sdfTex.a stays sharp for shell membership), .a = CRISP presence (1 inside a real segment, 0
  // background) \u2014 the FULLBLUR carries it unblurred so the shader can tell a genuine in-segment voxel
  // from one that merely caught BLED colour/opacity outside any segment, and gate the shell to the real edge.
  textureStore(t_attr, c, vec4<f32>(pal.a, mode, sdf, select(0.0, 1.0, ins)));
}`
);
var BLUR_WGSL2 = (
  /* wgsl */
  `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4>, origin : vec4<i32> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var sum = center.a * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).a
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).a);
  }
  textureStore(t_out, c, vec4<f32>(center.rgb, sum));
}`
);
var COLBLUR_WGSL = (
  /* wgsl */
  `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4>, origin : vec4<i32> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var sum = center.rgb * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).rgb
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).rgb);
  }
  textureStore(t_out, c, vec4<f32>(sum, center.a));
}`
);
var FULLBLUR_WGSL = (
  /* wgsl */
  `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4>, origin : vec4<i32> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let c = vec3<i32>(gid) + u.origin.xyz;
  if (any(c >= vec3<i32>(u.dims.xyz))) { return; }
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var gb = center.gb * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    gb = gb + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).gb
                          + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).gb);
  }
  textureStore(t_out, c, vec4<f32>(center.r, gb.x, gb.y, center.a));
}`
);
function gaussHalfKernel2(sigma) {
  const radius = Math.max(1, Math.min(15, Math.ceil(3 * sigma)));
  const raw = new Float32Array(radius + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) {
    raw[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += (i === 0 ? 1 : 2) * raw[i];
  }
  const w = new Float32Array(16);
  for (let i = 0; i <= radius; i++) w[i] = raw[i] / total;
  return {
    radius,
    w
  };
}
var JfaSdfBaker = class {
  labelTex;
  dims;
  ijkToRAS;
  dev;
  seed;
  sdfTex;
  attrTex;
  attrScratch;
  lastSeed;
  sdfScratch;
  uni;
  palBuf;
  modeBuf;
  initPipe;
  jfaPipe;
  finalPipe;
  blurPipe;
  colBlurPipe;
  fullBlurPipe;
  g;
  steps;
  smoothSigma;
  pad;
  labelDims;
  // `pad` voxels of background are added on every side so segments touching the labelmap edge get a
  // real cap + in-bounds gradient neighbourhood (docs/ALGORITHMS.md border artifact). The SDF textures,
  // dispatch, seeds, blur and readback all run on the PADDED grid; `dims`/`ijkToRAS` become the padded
  // grid's, and `sdfDims()`/`sdfIjkToRAS()` expose them to the SegmentField.
  bmode;
  constructor(dev, labelTex, dims, ijkToRAS, smoothSigmaVoxels = 1, pad = 2, boundaryMode = "outer") {
    this.labelTex = labelTex;
    this.dims = dims;
    this.ijkToRAS = ijkToRAS;
    this.lastSeed = 0;
    this.dev = dev;
    this.smoothSigma = smoothSigmaVoxels;
    this.bmode = boundaryMode === "all" ? 1 : 0;
    this.pad = pad;
    this.labelDims = [
      dims[0],
      dims[1],
      dims[2]
    ];
    this.dims = [
      dims[0] + 2 * pad,
      dims[1] + 2 * pad,
      dims[2] + 2 * pad
    ];
    const m = ijkToRAS.slice();
    for (let r = 0; r < 3; r++) m[r * 4 + 3] -= pad * (m[r * 4] + m[r * 4 + 1] + m[r * 4 + 2]);
    this.ijkToRAS = m;
    const [dx, dy, dz] = this.dims;
    const mk = (fmt, extra = 0) => dev.createTexture({
      size: this.dims,
      dimension: "3d",
      format: fmt,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | extra
    });
    this.seed = [
      mk("rgba32float"),
      mk("rgba32float")
    ];
    this.sdfTex = mk("rgba16float", GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC);
    this.attrTex = mk("rgba16float", GPUTextureUsage.COPY_DST);
    this.attrScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.sdfScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.uni = dev.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.palBuf = dev.createBuffer({
      size: 256 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.modeBuf = dev.createBuffer({
      size: 256 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const mod = (code) => dev.createComputePipeline({
      layout: "auto",
      compute: {
        module: dev.createShaderModule({
          code
        }),
        entryPoint: "main"
      }
    });
    this.initPipe = mod(INIT_WGSL2);
    this.jfaPipe = mod(JFA_WGSL);
    this.finalPipe = mod(FINAL_WGSL);
    this.blurPipe = mod(BLUR_WGSL2);
    this.colBlurPipe = mod(COLBLUR_WGSL);
    this.fullBlurPipe = mod(FULLBLUR_WGSL);
    this.g = [
      Math.ceil(dx / 4),
      Math.ceil(dy / 4),
      Math.ceil(dz / 4)
    ];
    const maxDim = Math.max(dx, dy, dz);
    const steps = [];
    for (let s = 1 << Math.floor(Math.log2(maxDim - 1)); s >= 1; s >>= 1) steps.push(s);
    this.steps = steps;
  }
  /** The resident colorized-SDF texture (rgba16float: .rgb = per-label colour, .a = signed mm).
   *  Identity stable across bakes → the SceneRenderer bind group stays valid; a live edit updates in
   *  place. */
  sdfTexture() {
    return this.sdfTex;
  }
  /** The resident per-segment attribute texture (rgba16float; .r = opacity). Identity stable. */
  attrTexture() {
    return this.attrTex;
  }
  /** The PADDED grid the SDF/attr textures live on (labelDims + 2·pad), and the ijkToRAS that maps it
   *  to RAS — hand these to the SegmentField so its patient→texture transform covers the padded extent. */
  sdfDims() {
    return this.dims;
  }
  sdfIjkToRAS() {
    return this.ijkToRAS;
  }
  /** Background margin (voxels) padded on each side; readDistance() is on the padded grid, so a label
   *  voxel (x,y,z) is at padded (x+pad, y+pad, z+pad). */
  padVoxels() {
    return this.pad;
  }
  /** Read back the per-voxel signed distance (sdfTex .a, mm) to CPU. For accuracy comparison/tests. */
  async readDistance() {
    const [dx, dy, dz] = this.dims;
    const bpr = Math.ceil(dx * 8 / 256) * 256;
    const rowU16 = bpr / 2;
    const buf = this.dev.createBuffer({
      size: bpr * dy * dz,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({
      texture: this.sdfTex
    }, {
      buffer: buf,
      bytesPerRow: bpr,
      rowsPerImage: dy
    }, [
      dx,
      dy,
      dz
    ]);
    this.dev.queue.submit([
      enc.finish()
    ]);
    await buf.mapAsync(GPUMapMode.READ);
    const u16 = new Uint16Array(buf.getMappedRange());
    const h2f = (h) => {
      const s = h & 32768 ? -1 : 1, e = (h & 31744) >> 10, f = h & 1023;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const out = new Float32Array(dx * dy * dz);
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) for (let x = 0; x < dx; x++) {
      out[(z * dy + y) * dx + x] = h2f(u16[(z * dy + y) * rowU16 + x * 4 + 3]);
    }
    buf.unmap();
    buf.destroy();
    return out;
  }
  /** Set the label→colour palette (256 × rgba f32: rgb = colour, a = opacity). Call before bake(). */
  setPalette(palette) {
    const pal = new Float32Array(256 * 4);
    pal.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.palBuf, 0, pal);
  }
  /** Set the per-label shading mode palette (256 × vec4; .x = 0 surface shell / 1 volume DVR fill). */
  setModePalette(modes) {
    const m = new Float32Array(256 * 4);
    m.set(modes.subarray(0, Math.min(modes.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.modeBuf, 0, m);
  }
  writeUni(step, origin = [
    0,
    0,
    0
  ]) {
    const ab = new ArrayBuffer(112);
    const f = new Float32Array(ab), u = new Uint32Array(ab);
    f.set(transpose4(this.ijkToRAS), 0);
    u[16] = this.dims[0];
    u[17] = this.dims[1];
    u[18] = this.dims[2];
    u[19] = this.pad;
    f[20] = step;
    f[21] = this.bmode;
    f[22] = 0;
    f[23] = 0;
    const i32v = new Int32Array(ab);
    i32v[24] = origin[0];
    i32v[25] = origin[1];
    i32v[26] = origin[2];
    i32v[27] = 0;
    this.dev.queue.writeBuffer(this.uni, 0, ab);
  }
  /** FAST bake for LIVE editing: plain JFA (approximate) + a light distance-only blur (crisp colour
   *  seams). Cheap, so it keeps up with an in-progress stroke; the seams stay voxel-jagged until the
   *  edit settles and refine() runs. */
  bake() {
    this.sweep([], this.smoothSigma, 0);
  }
  /** REFINE for a STATIC labelmap (run once the edit settles): JFA+2 extra passes → a near-exact
   *  Voronoi/SDF (fixes the small JFA mistakes near close/overlapping segments) and a colour-seam blur
   *  so neighbouring-label boundaries are smooth, not a voxel staircase. Distance blur stays at the
   *  same σ (dropping it re-introduces Voronoi facets — crispness comes from the render band, not from
   *  under-smoothing). Higher quality lives in the resident texture, so camera renders stay cheap. */
  refine() {
    this.sweep([
      2,
      1
    ], this.smoothSigma, 1);
  }
  /** ATTR-ONLY rebake for palette/opacity changes (per-segment visibility): the distance field
   *  doesn't move, so re-run ONLY the finalize (from the last sweep's seed) with its sdf writes
   *  routed to the scratch texture (discarded — the blurred resident sdfTex stays pristine) and
   *  re-blur the attribute seams. ~4 passes instead of the ~20-pass init+JFA+blur sweep, which is
   *  what makes per-vertebra focus switching real-time. */
  rebakeAttr(blurSeams = false, regionIjk) {
    const dev = this.dev, [dx, dy, dz] = this.dims;
    const region = regionIjk && {
      lo: [
        Math.max(0, regionIjk.lo[0]),
        Math.max(0, regionIjk.lo[1]),
        Math.max(0, regionIjk.lo[2])
      ],
      hi: [
        Math.min(dx, regionIjk.hi[0]),
        Math.min(dy, regionIjk.hi[1]),
        Math.min(dz, regionIjk.hi[2])
      ]
    };
    const [gx, gy, gz] = region ? [
      Math.ceil((region.hi[0] - region.lo[0]) / 4),
      Math.ceil((region.hi[1] - region.lo[1]) / 4),
      Math.ceil((region.hi[2] - region.lo[2]) / 4)
    ] : this.g;
    if (region && (gx <= 0 || gy <= 0 || gz <= 0)) return;
    this.writeUni(0, region ? region.lo : [
      0,
      0,
      0
    ]);
    const enc = dev.createCommandEncoder();
    const bf = dev.createBindGroup({
      layout: this.finalPipe.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.seed[this.lastSeed].createView()
        },
        {
          binding: 1,
          resource: this.labelTex.createView()
        },
        {
          binding: 2,
          resource: this.sdfScratch.createView()
        },
        {
          binding: 3,
          resource: {
            buffer: this.uni
          }
        },
        {
          binding: 4,
          resource: {
            buffer: this.palBuf
          }
        },
        {
          binding: 5,
          resource: this.attrTex.createView()
        },
        {
          binding: 6,
          resource: {
            buffer: this.modeBuf
          }
        }
      ]
    });
    const p = enc.beginComputePass();
    p.setPipeline(this.finalPipe);
    p.setBindGroup(0, bf);
    p.dispatchWorkgroups(gx, gy, gz);
    p.end();
    dev.queue.submit([
      enc.finish()
    ]);
    if (blurSeams) this.blurStage(this.fullBlurPipe, 1, this.attrTex, this.attrScratch, region);
  }
  /** Blur the attribute seams of the CURRENT attr texture in place (no re-finalize) — the
   *  cheapest possible settle after a run of rebakeAttr(false) visibility steps. */
  blurAttrOnly() {
    this.blurStage(this.fullBlurPipe, 1, this.attrTex, this.attrScratch);
  }
  /** One full sweep: init → JFA (schedule + extra) → finalize → blur .a → optional blur .rgb. */
  sweep(extraSteps, distSigma, colorSigma) {
    const dev = this.dev, [gx, gy, gz] = this.g;
    this.writeUni(0);
    let enc = dev.createCommandEncoder();
    {
      const b = dev.createBindGroup({
        layout: this.initPipe.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: this.labelTex.createView()
          },
          {
            binding: 1,
            resource: this.seed[0].createView()
          },
          {
            binding: 2,
            resource: {
              buffer: this.uni
            }
          }
        ]
      });
      const p2 = enc.beginComputePass();
      p2.setPipeline(this.initPipe);
      p2.setBindGroup(0, b);
      p2.dispatchWorkgroups(gx, gy, gz);
      p2.end();
    }
    dev.queue.submit([
      enc.finish()
    ]);
    let src = 0;
    for (const step of [
      ...this.steps,
      ...extraSteps
    ]) {
      this.writeUni(step);
      const dst = src ^ 1;
      enc = dev.createCommandEncoder();
      const b = dev.createBindGroup({
        layout: this.jfaPipe.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: this.seed[src].createView()
          },
          {
            binding: 1,
            resource: this.seed[dst].createView()
          },
          {
            binding: 2,
            resource: {
              buffer: this.uni
            }
          }
        ]
      });
      const p2 = enc.beginComputePass();
      p2.setPipeline(this.jfaPipe);
      p2.setBindGroup(0, b);
      p2.dispatchWorkgroups(gx, gy, gz);
      p2.end();
      dev.queue.submit([
        enc.finish()
      ]);
      src = dst;
    }
    this.lastSeed = src;
    enc = dev.createCommandEncoder();
    const bf = dev.createBindGroup({
      layout: this.finalPipe.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.seed[src].createView()
        },
        {
          binding: 1,
          resource: this.labelTex.createView()
        },
        {
          binding: 2,
          resource: this.sdfTex.createView()
        },
        {
          binding: 3,
          resource: {
            buffer: this.uni
          }
        },
        {
          binding: 4,
          resource: {
            buffer: this.palBuf
          }
        },
        {
          binding: 5,
          resource: this.attrTex.createView()
        },
        {
          binding: 6,
          resource: {
            buffer: this.modeBuf
          }
        }
      ]
    });
    const p = enc.beginComputePass();
    p.setPipeline(this.finalPipe);
    p.setBindGroup(0, bf);
    p.dispatchWorkgroups(gx, gy, gz);
    p.end();
    dev.queue.submit([
      enc.finish()
    ]);
    if (distSigma > 0) this.blurStage(this.blurPipe, distSigma, this.sdfTex, this.sdfScratch);
    if (colorSigma > 0) this.blurStage(this.colBlurPipe, colorSigma, this.sdfTex, this.sdfScratch);
    if (colorSigma > 0) this.blurStage(this.fullBlurPipe, colorSigma, this.attrTex, this.attrScratch);
  }
  /** 3 separable Gaussian passes with the given pipeline (which channels it blurs), tex↔scratch,
   *  ending in scratch → copied back to `tex` so its identity stays stable for the renderer. */
  blurStage(pipe, sigma, tex, scratch, region) {
    const dev = this.dev, [dx, dy, dz] = this.dims;
    const { radius, w } = gaussHalfKernel2(sigma);
    const passes = [
      [
        tex,
        scratch,
        0
      ],
      [
        scratch,
        tex,
        1
      ],
      [
        tex,
        scratch,
        2
      ]
    ];
    const enc = dev.createCommandEncoder();
    let passIdx = 0;
    for (const [srcT, dstT, axis] of passes) {
      const expand = region ? (2 - passIdx) * radius : 0;
      const lo = region ? [
        Math.max(0, region.lo[0] - expand),
        Math.max(0, region.lo[1] - expand),
        Math.max(0, region.lo[2] - expand)
      ] : [
        0,
        0,
        0
      ];
      const hi = region ? [
        Math.min(dx, region.hi[0] + expand),
        Math.min(dy, region.hi[1] + expand),
        Math.min(dz, region.hi[2] + expand)
      ] : [
        dx,
        dy,
        dz
      ];
      const ab = new ArrayBuffer(112);
      const u32 = new Uint32Array(ab), f32 = new Float32Array(ab), i32 = new Int32Array(ab);
      u32[0] = dx;
      u32[1] = dy;
      u32[2] = dz;
      u32[4] = axis;
      u32[5] = radius;
      f32.set(w, 8);
      i32[24] = lo[0];
      i32[25] = lo[1];
      i32[26] = lo[2];
      const ub = dev.createBuffer({
        size: 112,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      dev.queue.writeBuffer(ub, 0, ab);
      const b = dev.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: srcT.createView()
          },
          {
            binding: 1,
            resource: dstT.createView()
          },
          {
            binding: 2,
            resource: {
              buffer: ub
            }
          }
        ]
      });
      const bp = enc.beginComputePass();
      bp.setPipeline(pipe);
      bp.setBindGroup(0, b);
      bp.dispatchWorkgroups(Math.ceil((hi[0] - lo[0]) / 4), Math.ceil((hi[1] - lo[1]) / 4), Math.ceil((hi[2] - lo[2]) / 4));
      bp.end();
      passIdx++;
    }
    if (region) {
      const sz = [
        region.hi[0] - region.lo[0],
        region.hi[1] - region.lo[1],
        region.hi[2] - region.lo[2]
      ];
      enc.copyTextureToTexture({
        texture: scratch,
        origin: region.lo
      }, {
        texture: tex,
        origin: region.lo
      }, sz);
    } else {
      enc.copyTextureToTexture({
        texture: scratch
      }, {
        texture: tex
      }, this.dims);
    }
    dev.queue.submit([
      enc.finish()
    ]);
  }
  destroy() {
    this.seed[0].destroy();
    this.seed[1].destroy();
    this.sdfTex.destroy();
    this.attrTex.destroy();
    this.attrScratch.destroy();
    this.sdfScratch.destroy();
    this.uni.destroy();
    this.palBuf.destroy();
    this.modeBuf.destroy();
  }
};

// logic/segmentation-logic.ts
function invertAffine(m) {
  const r = [
    m[0],
    m[1],
    m[2],
    m[4],
    m[5],
    m[6],
    m[8],
    m[9],
    m[10]
  ];
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  const i = [
    (r[4] * r[8] - r[5] * r[7]) / det,
    (r[2] * r[7] - r[1] * r[8]) / det,
    (r[1] * r[5] - r[2] * r[4]) / det,
    (r[5] * r[6] - r[3] * r[8]) / det,
    (r[0] * r[8] - r[2] * r[6]) / det,
    (r[2] * r[3] - r[0] * r[5]) / det,
    (r[3] * r[7] - r[4] * r[6]) / det,
    (r[1] * r[6] - r[0] * r[7]) / det,
    (r[0] * r[4] - r[1] * r[3]) / det
  ];
  const t = [
    m[3],
    m[7],
    m[11]
  ];
  return [
    i[0],
    i[1],
    i[2],
    -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2]),
    i[3],
    i[4],
    i[5],
    -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2]),
    i[6],
    i[7],
    i[8],
    -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2]),
    0,
    0,
    0,
    1
  ];
}
var SegmentationLogic = class {
  seg;
  renderMode;
  clippable;
  attrSettleTimer;
  sdf;
  baker;
  presenceTex;
  sigma;
  bandMm;
  opacity;
  palette;
  modePalette;
  segField;
  redrawCbs;
  unsubDirty;
  refineTimer;
  refineDelayMs;
  boundaryMode;
  constructor(device, seg, opts = {}) {
    this.seg = seg;
    this.palette = new Float32Array(256 * 4);
    this.modePalette = new Float32Array(256 * 4);
    this.redrawCbs = [];
    this.renderMode = opts.renderMode ?? "sdf";
    this.sigma = opts.sigmaVoxels ?? 1;
    this.bandMm = opts.bandMm;
    this.opacity = opts.opacity ?? 1;
    this.refineDelayMs = opts.refineDelayMs ?? 180;
    this.boundaryMode = opts.boundaryMode ?? "outer";
    this.clippable = opts.clippable ?? false;
    this.setLabelColor(1, opts.color ?? [
      0.3,
      0.85,
      0.55
    ]);
    if (this.renderMode === "sdf") {
      this.sdf = new JfaSdfBaker(device, seg.masterTexture(), seg.dims, seg.ijkToRAS, 1, 2, this.boundaryMode);
    } else {
      this.baker = new ColorizeBaker(device, seg.masterTexture(), seg.dims);
      this.presenceTex = this.baker.output();
    }
    this.rebake();
    this.scheduleRefine();
    this.unsubDirty = seg.onDirty(() => {
      this.rebake();
      for (const cb of this.redrawCbs) cb();
      this.scheduleRefine();
    });
  }
  /** Assign a display colour to a label id (0..255). Keeps the current opacity (defaults to 1 =
   *  opaque). Takes effect on the next rebake. */
  setLabelColor(id, rgb) {
    if (id < 1 || id > 255) return;
    const o = id * 4;
    this.palette[o] = rgb[0];
    this.palette[o + 1] = rgb[1];
    this.palette[o + 2] = rgb[2];
    if (this.palette[o + 3] === 0) this.palette[o + 3] = 1;
  }
  /** Per-segment opacity (0 = hidden, 1 = opaque) — palette alpha. Enables translucent surface-model
   *  rendering (see through outer segments to inner ones). Rebake/refine to apply. */
  setLabelOpacity(id, opacity) {
    if (id < 1 || id > 255) return;
    this.palette[id * 4 + 3] = Math.max(0, Math.min(1, opacity));
  }
  /** Per-segment shading (sdf mode): "surface" = crisp SDF shell (surface model), "volume" = DVR fill
   *  of the interior (translucent cloud). Rebake/refine to apply. */
  setLabelShading(id, shading) {
    if (id < 1 || id > 255) return;
    this.modePalette[id * 4] = shading === "volume" ? 1 : 0;
  }
  /** Re-derive the render texture from the current master + palette (FAST, in place). */
  rebake() {
    if (this.sdf) {
      this.sdf.setPalette(this.palette);
      this.sdf.setModePalette(this.modePalette);
      this.sdf.bake();
    } else this.baker.bakeInto(this.presenceTex, this.palette, this.sigma);
  }
  /** Schedule the settle-refine after quiescence (debounced; sdf mode only). */
  scheduleRefine() {
    if (!this.sdf) return;
    if (this.refineTimer !== void 0) clearTimeout(this.refineTimer);
    this.refineTimer = setTimeout(() => {
      this.refineTimer = void 0;
      this.refineNow();
    }, this.refineDelayMs);
  }
  /** Run the settle-refine now (JFA+2 + tighter distance blur + colour-seam blur), then redraw.
   *  Public so a test — or an app that knows the edit is done — can force the high-quality bake. */
  refineNow() {
    if (this.refineTimer !== void 0) {
      clearTimeout(this.refineTimer);
      this.refineTimer = void 0;
    }
    if (this.sdf) {
      this.sdf.setPalette(this.palette);
      this.sdf.setModePalette(this.modePalette);
      this.sdf.refine();
      for (const cb of this.redrawCbs) cb();
    }
  }
  /** FAST per-segment opacity refresh: attr-only rebake (no JFA re-sweep) — for visibility
   *  toggles where the labelmap and colours are unchanged.
   *
   *  With `regionRAS` (the bbox of the labels whose opacity changed): the finalize AND the
   *  seam blur run region-limited in one shot — full settled quality lands immediately, no
   *  two-phase. Without it: full-volume fast pass + a debounced full-volume seam blur. */
  refreshOpacity(regionRAS) {
    if (!this.sdf) {
      this.rebake();
      return;
    }
    this.sdf.setPalette(this.palette);
    if (regionRAS) {
      const dims = this.sdf.sdfDims();
      const inv = invertAffine(this.sdf.sdfIjkToRAS());
      const lo = [
        Infinity,
        Infinity,
        Infinity
      ];
      const hi = [
        -Infinity,
        -Infinity,
        -Infinity
      ];
      for (const x of [
        regionRAS.lo[0],
        regionRAS.hi[0]
      ]) for (const y of [
        regionRAS.lo[1],
        regionRAS.hi[1]
      ]) for (const z of [
        regionRAS.lo[2],
        regionRAS.hi[2]
      ]) {
        const i = inv[0] * x + inv[1] * y + inv[2] * z + inv[3];
        const j = inv[4] * x + inv[5] * y + inv[6] * z + inv[7];
        const k = inv[8] * x + inv[9] * y + inv[10] * z + inv[11];
        lo[0] = Math.min(lo[0], i);
        lo[1] = Math.min(lo[1], j);
        lo[2] = Math.min(lo[2], k);
        hi[0] = Math.max(hi[0], i);
        hi[1] = Math.max(hi[1], j);
        hi[2] = Math.max(hi[2], k);
      }
      const M = 8;
      const region = {
        lo: [
          Math.floor(lo[0]) - M,
          Math.floor(lo[1]) - M,
          Math.floor(lo[2]) - M
        ],
        hi: [
          Math.ceil(hi[0]) + M,
          Math.ceil(hi[1]) + M,
          Math.ceil(hi[2]) + M
        ]
      };
      void dims;
      this.sdf.rebakeAttr(true, region);
      for (const cb of this.redrawCbs) cb();
      return;
    }
    this.sdf.rebakeAttr(false);
    for (const cb of this.redrawCbs) cb();
    if (this.attrSettleTimer !== void 0) clearTimeout(this.attrSettleTimer);
    this.attrSettleTimer = setTimeout(() => {
      this.attrSettleTimer = void 0;
      if (this.sdf) {
        this.sdf.blurAttrOnly();
        for (const cb of this.redrawCbs) cb();
      }
    }, 600);
  }
  /** A SegmentField bound to the shared render texture — hand this to the SceneRenderer once; edits
   *  update it in place. Colour comes from the texture (per-label); the uniform supplies opacity. */
  field() {
    if (!this.segField) {
      const tex = this.sdf ? this.sdf.sdfTexture() : this.presenceTex;
      const voxelMm = Math.min(...this.seg.spacingMm());
      const interfaceMode = this.renderMode === "sdf" && this.boundaryMode === "all";
      const band = this.bandMm ?? (this.renderMode === "sdf" ? (interfaceMode ? 1.5 : 0.65) * voxelMm : void 0);
      const fdims = this.sdf ? this.sdf.sdfDims() : this.seg.dims;
      const fijk = this.sdf ? this.sdf.sdfIjkToRAS() : this.seg.ijkToRAS;
      this.segField = new SegmentField(tex, fdims, [
        1,
        1,
        1
      ], {
        color: [
          1,
          1,
          1
        ],
        opacity: this.opacity,
        ijkToRAS: fijk,
        mode: this.renderMode === "sdf" ? "sdf" : "surface",
        colorFromTexture: true,
        bandMm: band,
        clippable: this.clippable,
        attrTexture: this.sdf ? this.sdf.attrTexture() : void 0,
        interfaceMode
      });
    }
    return this.segField;
  }
  /** Live GLOBAL segmentation opacity (0..1) — the field-level multiplier over every segment's own
   *  opacity. Caller does scene.syncUniforms() + redraw. */
  setGlobalOpacity(o) {
    this.opacity = o;
    this.segField?.setOpacity(o);
  }
  /** Notified after every edit (post-rebake) so the app can redraw. */
  onRedraw(cb) {
    this.redrawCbs.push(cb);
  }
  destroy() {
    if (this.refineTimer !== void 0) clearTimeout(this.refineTimer);
    this.unsubDirty();
    this.sdf?.destroy();
    this.baker?.destroy();
    this.presenceTex?.destroy();
  }
};

// examples/spine/spine-compare-scene.ts
var BUCKET = "https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/";
var LEVEL_NAME = {
  1: "C1",
  2: "C2",
  3: "C3",
  4: "C4",
  5: "C5",
  6: "C6",
  7: "C7",
  8: "T1",
  9: "T2",
  10: "T3",
  11: "T4",
  12: "T5",
  13: "T6",
  14: "T7",
  15: "T8",
  16: "T9",
  17: "T10",
  18: "T11",
  19: "T12",
  20: "L1",
  21: "L2",
  22: "L3",
  23: "L4",
  24: "L5",
  25: "L6",
  26: "S1",
  27: "Cocc",
  28: "T13",
  29: "S2",
  30: "S3"
};
var LEVEL_COLORS = [
  [
    0.85,
    0.42,
    0.42
  ],
  [
    0.42,
    0.75,
    0.42
  ],
  [
    0.42,
    0.55,
    0.9
  ],
  [
    0.9,
    0.78,
    0.35
  ],
  [
    0.72,
    0.45,
    0.85
  ],
  [
    0.35,
    0.8,
    0.8
  ],
  [
    0.9,
    0.55,
    0.25
  ],
  [
    0.55,
    0.72,
    0.3
  ],
  [
    0.85,
    0.45,
    0.7
  ],
  [
    0.4,
    0.65,
    0.6
  ],
  [
    0.65,
    0.55,
    0.9
  ],
  [
    0.8,
    0.68,
    0.5
  ]
];
var levelColor = (label) => LEVEL_COLORS[label % LEVEL_COLORS.length];
var METHOD_COLORS = {
  spineps: [
    0.95,
    0.6,
    0.2
  ],
  ref: [
    0.3,
    0.65,
    0.95
  ]
};
var flat = (m) => Array.isArray(m[0]) ? m.flat() : m;
function invertAffine2(m) {
  const r = [
    m[0],
    m[1],
    m[2],
    m[4],
    m[5],
    m[6],
    m[8],
    m[9],
    m[10]
  ];
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  const i = [
    (r[4] * r[8] - r[5] * r[7]) / det,
    (r[2] * r[7] - r[1] * r[8]) / det,
    (r[1] * r[5] - r[2] * r[4]) / det,
    (r[5] * r[6] - r[3] * r[8]) / det,
    (r[0] * r[8] - r[2] * r[6]) / det,
    (r[2] * r[3] - r[0] * r[5]) / det,
    (r[3] * r[7] - r[4] * r[6]) / det,
    (r[1] * r[6] - r[0] * r[7]) / det,
    (r[0] * r[4] - r[1] * r[3]) / det
  ];
  const t = [
    m[3],
    m[7],
    m[11]
  ];
  return [
    i[0],
    i[1],
    i[2],
    -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2]),
    i[3],
    i[4],
    i[5],
    -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2]),
    i[6],
    i[7],
    i[8],
    -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2]),
    0,
    0,
    0,
    1
  ];
}
function resampleLabels(lab, dims, ijkToRAS, outDims, outIjkToRAS) {
  const [nx, ny, nz] = dims, [ox, oy, oz] = outDims;
  const m = invertAffine2(ijkToRAS);
  const g = outIjkToRAS;
  const out = new Uint8Array(ox * oy * oz);
  for (let k = 0; k < oz; k++) {
    for (let j = 0; j < oy; j++) {
      for (let i = 0; i < ox; i++) {
        const rx = g[0] * i + g[1] * j + g[2] * k + g[3];
        const ry = g[4] * i + g[5] * j + g[6] * k + g[7];
        const rz = g[8] * i + g[9] * j + g[10] * k + g[11];
        const si = Math.round(m[0] * rx + m[1] * ry + m[2] * rz + m[3]);
        const sj = Math.round(m[4] * rx + m[5] * ry + m[6] * rz + m[7]);
        const sk = Math.round(m[8] * rx + m[9] * ry + m[10] * rz + m[11]);
        if (si >= 0 && si < nx && sj >= 0 && sj < ny && sk >= 0 && sk < nz) {
          out[(k * oy + j) * ox + i] = lab[(sk * ny + sj) * nx + si];
        }
      }
    }
  }
  return out;
}
function levelGeometry(lab, dims, ijkToRAS) {
  const [nx, ny, nz] = dims;
  const acc = /* @__PURE__ */ new Map();
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const base = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const v = lab[base + i];
        if (!v) continue;
        let a = acc.get(v);
        if (!a) {
          a = {
            n: 0,
            s: [
              0,
              0,
              0
            ],
            lo: [
              i,
              j,
              k
            ],
            hi: [
              i,
              j,
              k
            ]
          };
          acc.set(v, a);
        }
        a.n++;
        a.s[0] += i;
        a.s[1] += j;
        a.s[2] += k;
        if (i < a.lo[0]) a.lo[0] = i;
        if (j < a.lo[1]) a.lo[1] = j;
        if (k < a.lo[2]) a.lo[2] = k;
        if (i > a.hi[0]) a.hi[0] = i;
        if (j > a.hi[1]) a.hi[1] = j;
        if (k > a.hi[2]) a.hi[2] = k;
      }
    }
  }
  const m = ijkToRAS;
  const xf = (p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]
  ];
  const out = /* @__PURE__ */ new Map();
  for (const [label, a] of acc) {
    const c = xf([
      a.s[0] / a.n,
      a.s[1] / a.n,
      a.s[2] / a.n
    ]);
    const lo = [
      Infinity,
      Infinity,
      Infinity
    ], hi = [
      -Infinity,
      -Infinity,
      -Infinity
    ];
    for (const ci of [
      a.lo[0],
      a.hi[0]
    ]) for (const cj of [
      a.lo[1],
      a.hi[1]
    ]) for (const ck of [
      a.lo[2],
      a.hi[2]
    ]) {
      const r = xf([
        ci,
        cj,
        ck
      ]);
      for (let d = 0; d < 3; d++) {
        if (r[d] < lo[d]) lo[d] = r[d];
        if (r[d] > hi[d]) hi[d] = r[d];
      }
    }
    out.set(label, {
      label,
      name: LEVEL_NAME[label] ?? String(label),
      voxels: a.n,
      centroid: c,
      lo,
      hi
    });
  }
  return out;
}
var DISC_COLOR = [
  0.72,
  0.72,
  0.66
];
var isDisc = (label) => label > 100;
var CT_WIN = 1400;
var CT_LEV = 400;
function ctLUT(maxAlpha = 0.32) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = Math.max(0, (t - 0.42) / 0.58);
    a *= a;
    lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = Math.round(t * 255);
    lut[i * 4 + 3] = Math.round(Math.min(maxAlpha, a) * 255);
  }
  return lut;
}
async function buildSpineCompareScene(gpu, format, meta, base, onProgress) {
  const dev = gpu.device;
  const vol = meta.volumes;
  const track = (msg) => (n) => onProgress?.(msg, n);
  const [ctLow, sp, ref] = await Promise.all([
    fetchZarrVolume(base, {
      ...vol.ct_low,
      dataset: "."
    }, track("CT preview")),
    fetchZarrVolume(base, {
      ...vol.spineps_med,
      dataset: "."
    }, track("SPINEPS labels")),
    fetchZarrVolume(base, {
      ...vol.ref_med,
      dataset: "."
    }, track("reference labels"))
  ]);
  const medDims = sp.dims;
  const medRAS = flat(meta.ijkToRAS_med);
  const lowRAS = flat(meta.ijkToRAS_low);
  const spMed = Uint8Array.from(sp.data);
  const refMed = Uint8Array.from(ref.data);
  const levelPalette = new Float32Array(256 * 4);
  for (let l = 1; l < 256; l++) {
    const [r, g, b] = isDisc(l) ? DISC_COLOR : levelColor(l);
    levelPalette[l * 4] = r;
    levelPalette[l * 4 + 1] = g;
    levelPalette[l * 4 + 2] = b;
    levelPalette[l * 4 + 3] = 1;
  }
  let volOpacity = 1;
  const scaledLut = (o) => {
    const l = ctLUT().slice();
    for (let i = 0; i < 256; i++) l[i * 4 + 3] = Math.round(l[i * 4 + 3] * o);
    return l;
  };
  const mkCtField = (v, ijk) => new ImageField(dev, v.data, v.dims, [
    1,
    1,
    1
  ], scaledLut(volOpacity), {
    clim: [
      CT_LEV - CT_WIN / 2,
      CT_LEV + CT_WIN / 2
    ],
    ijkToRAS: ijk,
    shade: [
      0.25,
      0.7,
      0.45,
      20
    ]
  });
  let ctField = mkCtField(ctLow, lowRAS);
  let ctDims = ctLow.dims, ctRAS = lowRAS;
  const [rasLo0, rasHi0] = ctField.aabb();
  const bakeOverlay = (lab) => {
    const l = ctDims === medDims ? lab : resampleLabels(lab, medDims, medRAS, ctDims, ctRAS);
    return bakeColorizeRGBA(dev, l, ctDims, levelPalette, 0);
  };
  const slice = new SliceRenderer(gpu, format);
  slice.setVolume(ctField.patientToTexture(), rasLo0, rasHi0);
  slice.setWindowLevel(CT_WIN, CT_LEV);
  slice.setOverlayOpacity(0.5);
  const methodOp = {
    spineps: 1,
    ref: 1
  };
  let discOp = 1;
  let clip = null;
  let extentState = {
    label: null,
    count: 99
  };
  const makeRow = (key, lab) => {
    const overlayTex = bakeOverlay(lab);
    const cap = resampleIsotropic(lab, medDims, medRAS, 256);
    const editable = new EditableSegmentation(dev, cap.dims, {
      ijkToRAS: cap.ijkToRAS
    });
    const logic = new SegmentationLogic(dev, editable, {
      renderMode: "sdf",
      boundaryMode: "all",
      opacity: 1,
      clippable: true
    });
    const levels = levelGeometry(lab, medDims, medRAS);
    for (const [l] of levels) {
      logic.setLabelColor(l, isDisc(l) ? DISC_COLOR : levelColor(l));
      logic.setLabelOpacity(l, 1);
    }
    editable.loadLabelmap(cap.lab);
    logic.refineNow();
    const scene = new SceneRenderer(gpu, format);
    const shown = /* @__PURE__ */ new Map();
    for (const [l] of levels) shown.set(l, 1);
    const row = {
      key,
      overlayTex,
      scene,
      logic,
      levels,
      lab,
      shown,
      rebuild() {
        const f = [];
        if (volOpacity > 1e-3) f.push(ctField);
        if (methodOp[key] > 1e-3) f.push(logic.field());
        scene.build(f);
        scene.setBackground(0.05, 0.06, 0.09);
        if (clip) scene.setClipBox(clip.lo, clip.hi);
        else scene.clearClip();
      },
      destroy() {
        logic.destroy();
        editable.destroy();
        this.overlayTex.destroy();
      }
    };
    row.rebuild();
    return row;
  };
  onProgress?.("baking SPINEPS shell", 0);
  const rowSp = makeRow("spineps", spMed);
  onProgress?.("baking reference shell", 0);
  const rowRef = makeRow("ref", refMed);
  const rowOf = (key) => key === "spineps" ? rowSp : rowRef;
  const scObj = {
    meta,
    dims: ctDims,
    ijkToRAS: ctRAS,
    rasLo: rasLo0,
    rasHi: rasHi0,
    center: [
      (rasLo0[0] + rasHi0[0]) / 2,
      (rasLo0[1] + rasHi0[1]) / 2,
      (rasLo0[2] + rasHi0[2]) / 2
    ],
    radius: Math.hypot(rasHi0[0] - rasLo0[0], rasHi0[1] - rasLo0[1], rasHi0[2] - rasLo0[2]) / 2,
    win: CT_WIN,
    lev: CT_LEV,
    slice,
    rows: [
      rowSp,
      rowRef
    ],
    bindRowSlice(key) {
      slice.setTextures(ctField.volumeTexture(), rowOf(key).overlayTex);
    },
    upgraded: Promise.resolve(),
    setMethodOpacity(key, o) {
      const was = methodOp[key] > 1e-3;
      methodOp[key] = Math.max(0, Math.min(1, o));
      rowOf(key).logic.setGlobalOpacity(methodOp[key]);
      if (was !== methodOp[key] > 1e-3) rowOf(key).rebuild();
      else rowOf(key).scene.syncUniforms();
    },
    methodOpacity: (key) => methodOp[key],
    setVolumeOpacity(o) {
      const was = volOpacity > 1e-3;
      volOpacity = Math.max(0, Math.min(1, o));
      ctField.setLUT(scaledLut(volOpacity));
      if (was !== volOpacity > 1e-3) {
        rowSp.rebuild();
        rowRef.rebuild();
      }
    },
    volumeOpacity: () => volOpacity,
    setExtent(label, count) {
      extentState = {
        label,
        count
      };
      const applyVisibility = (inRange) => {
        for (const row of [
          rowSp,
          rowRef
        ]) {
          const changed = [];
          for (const [l] of row.levels) {
            const vis = isDisc(l) ? inRange(l - 100) || inRange(l - 100 + 1) : inRange(l);
            const o = vis ? isDisc(l) ? discOp : 1 : 0;
            if (row.shown.get(l) !== o) {
              row.logic.setLabelOpacity(l, o);
              row.shown.set(l, o);
              changed.push(l);
            }
          }
          if (!changed.length) continue;
          if (changed.length <= row.levels.size / 2) {
            const lo2 = [
              Infinity,
              Infinity,
              Infinity
            ], hi2 = [
              -Infinity,
              -Infinity,
              -Infinity
            ];
            for (const l of changed) {
              const g = row.levels.get(l);
              for (let d = 0; d < 3; d++) {
                if (g.lo[d] < lo2[d]) lo2[d] = g.lo[d];
                if (g.hi[d] > hi2[d]) hi2[d] = g.hi[d];
              }
            }
            row.logic.refreshOpacity({
              lo: [
                lo2[0],
                lo2[1],
                lo2[2]
              ],
              hi: [
                hi2[0],
                hi2[1],
                hi2[2]
              ]
            });
          } else {
            row.logic.refreshOpacity();
          }
        }
      };
      const applyClip = () => {
        for (const row of [
          rowSp,
          rowRef
        ]) {
          if (clip) row.scene.setClipBox(clip.lo, clip.hi);
          else row.scene.clearClip();
          row.scene.syncUniforms();
        }
      };
      if (label == null || count >= 99) {
        applyVisibility(() => true);
        clip = null;
        applyClip();
        return null;
      }
      const lo = [
        Infinity,
        Infinity,
        Infinity
      ], hi = [
        -Infinity,
        -Infinity,
        -Infinity
      ];
      let any = false;
      for (const levels of [
        rowSp.levels,
        rowRef.levels
      ]) {
        for (const [l, g] of levels) {
          if (isDisc(l) || Math.abs(l - label) > count) continue;
          any = true;
          for (let d = 0; d < 3; d++) {
            if (g.lo[d] < lo[d]) lo[d] = g.lo[d];
            if (g.hi[d] > hi[d]) hi[d] = g.hi[d];
          }
        }
      }
      if (!any) {
        applyVisibility(() => true);
        clip = null;
        applyClip();
        return null;
      }
      applyVisibility((l) => Math.abs(l - label) <= count);
      for (let d = 0; d < 3; d++) {
        lo[d] -= 12;
        hi[d] += 12;
      }
      clip = {
        lo,
        hi
      };
      applyClip();
      return {
        lo,
        hi
      };
    },
    visibleLevels: (key) => [
      ...rowOf(key).levels.keys()
    ].filter((l) => !isDisc(l) && (rowOf(key).shown.get(l) ?? 1) > 0),
    setDiscOpacity(o) {
      discOp = Math.max(0, Math.min(1, o));
      for (let l = 101; l < 256; l++) levelPalette[l * 4 + 3] = discOp;
      for (const row of [
        rowSp,
        rowRef
      ]) {
        const nt = bakeOverlay(row.lab);
        row.overlayTex.destroy();
        row.overlayTex = nt;
      }
      this.setExtent(extentState.label, extentState.count);
    },
    discOpacity: () => discOp,
    destroy() {
      rowSp.destroy();
      rowRef.destroy();
    }
  };
  scObj.upgraded = (async () => {
    const ctMed = await fetchZarrVolume(base, {
      ...vol.ct_med,
      dataset: "."
    }, track("full-res CT"));
    ctField = mkCtField(ctMed, medRAS);
    ctDims = ctMed.dims;
    ctRAS = medRAS;
    const [lo, hi] = ctField.aabb();
    scObj.dims = ctDims;
    scObj.ijkToRAS = ctRAS;
    scObj.rasLo = lo;
    scObj.rasHi = hi;
    slice.setVolume(ctField.patientToTexture(), lo, hi);
    for (const row of [
      rowSp,
      rowRef
    ]) {
      const nt = bakeOverlay(row.lab);
      row.overlayTex.destroy();
      row.overlayTex = nt;
      row.rebuild();
    }
    onProgress?.("full-res CT in", 0);
  })();
  return scObj;
}
async function loadCaseMeta(coll, pid) {
  const base = `${BUCKET}${coll}/${pid}/zarr/`;
  const r = await fetch(base + "meta.json");
  if (!r.ok) throw new Error(`no zarr bundle yet for ${coll}/${pid} (HTTP ${r.status}) \u2014 the worker may not have reached this case`);
  return {
    meta: await r.json(),
    base
  };
}

// examples/spine/spine-compare-browser.ts
var ORIENTS = [
  "axial",
  "sagittal",
  "coronal"
];
var PARAMS = new URLSearchParams(location.search);
var el = (id) => document.getElementById(id);
var status = (msg, err = false) => {
  const s = el("status");
  if (s) {
    s.textContent = msg;
    s.style.color = err ? "#ff6b74" : "#9fb3d0";
  }
};
async function main() {
  if (!navigator.gpu) {
    status("WebGPU not available \u2014 try Chrome/Edge 113+ or Safari 18+.", true);
    return;
  }
  const gpu = await initDevice();
  const preferred = navigator.gpu.getPreferredCanvasFormat();
  const srgb = preferred + "-srgb";
  status("loading case list\u2026");
  const casesDoc = await (await fetch(BUCKET + "cases.json", {
    cache: "no-cache"
  })).json();
  let pid = PARAMS.get("case") ?? "";
  let coll = PARAMS.get("coll") ?? "";
  if (!pid) {
    for (const c of casesDoc.cases) {
      const r = await fetch(`${BUCKET}${c.collection}/${c.pid}/zarr/meta.json`, {
        method: "HEAD"
      });
      if (r.ok) {
        pid = c.pid;
        coll = c.collection;
        break;
      }
    }
    if (!pid) {
      status("no zarr-ready cases in the bucket yet \u2014 the worker is still running", true);
      return;
    }
  }
  const entry = casesDoc.cases.find((c) => c.pid === pid && (!coll || c.collection === coll));
  coll = entry?.collection ?? coll;
  el("case-btn").textContent = `${coll}/${pid} \u25BE`;
  status(`loading ${coll}/${pid}\u2026`);
  const { meta, base } = await loadCaseMeta(coll, pid);
  let bytes = 0;
  const sc = await buildSpineCompareScene(gpu, srgb, meta, base, (msg, n) => {
    bytes += n;
    status(`${coll}/${pid}: ${msg} \u2014 ${(bytes / 1e6).toFixed(1)} MB`);
  });
  sc.upgraded.then(() => {
    drawAll();
    status(`${coll}/${pid} \u2014 full-res CT loaded`);
  }).catch(() => status(`${coll}/${pid} \u2014 full-res CT failed to load (showing preview res)`, true));
  const keys = [
    "spineps",
    "ref"
  ];
  const cellNames = [
    ...ORIENTS,
    "threeD"
  ];
  const cv = {};
  const cx = {};
  for (const k of keys) {
    for (const c of cellNames) {
      const id = `c-${k}-${c}`;
      cv[id] = document.getElementById(id);
      cx[id] = cv[id].getContext("webgpu");
      cx[id].configure({
        device: gpu.device,
        format: preferred,
        viewFormats: [
          srgb
        ],
        alphaMode: "opaque"
      });
    }
  }
  const rowOf = (k) => sc.rows[k === "spineps" ? 0 : 1];
  const off = {
    axial: slicerDefaultOffset01("axial", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    coronal: slicerDefaultOffset01("coronal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    sagittal: slicerDefaultOffset01("sagittal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi)
  };
  const sliceIx = new SliceInteractor({
    ijkToRAS: sc.ijkToRAS,
    rasLo: sc.rasLo,
    rasHi: sc.rasHi
  });
  const camera = framedCamera(sc.center, sc.radius);
  const drawSlice = (k, o) => {
    const c = cv[`c-${k}-${o}`];
    if (!c || !c.width) return;
    sc.bindRowSlice(k);
    sc.slice.setPlane(o, off[o]);
    sc.slice.renderToView(cx[`c-${k}-${o}`].getCurrentTexture().createView({
      format: srgb
    }), c.width, c.height);
  };
  let fast3d = false;
  let settle3dTimer = 0;
  const draw3dCell = (k) => {
    const c = cv[`c-${k}-threeD`];
    if (!c || !c.width) return;
    const scene = rowOf(k).scene;
    const view = cx[`c-${k}-threeD`].getCurrentTexture().createView({
      format: srgb
    });
    if (fast3d) {
      const rw = Math.max(16, Math.round(c.width * 0.5)), rh = Math.max(16, Math.round(c.height * 0.5));
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, rw, rh);
      scene.renderUpscaled(view, rw, rh, c.width, c.height);
    } else {
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, c.width, c.height);
      scene.renderToView(view, c.width, c.height);
    }
  };
  const touch3d = () => {
    fast3d = true;
    clearTimeout(settle3dTimer);
    settle3dTimer = setTimeout(() => {
      fast3d = false;
      drawAll3d();
    }, 350);
  };
  const drawAll3d = () => {
    for (const k of keys) draw3dCell(k);
    xhairRedraw();
  };
  const drawSlices = () => {
    for (const k of keys) for (const o of ORIENTS) drawSlice(k, o);
    xhairRedraw();
  };
  const drawAll = () => {
    drawSlices();
    drawAll3d();
  };
  let drawRaf = 0;
  const requestDraw = () => {
    touch3d();
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      drawAll();
    });
  };
  for (const k of keys) rowOf(k).logic.onRedraw(requestDraw);
  const xhair = createCrosshair(true);
  const overlays = {};
  for (const id of keys.flatMap((k) => cellNames.map((c) => `c-${k}-${c}`))) {
    const o = document.createElement("canvas");
    o.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;background:transparent;";
    cv[id].parentElement.appendChild(o);
    overlays[id] = {
      c: o,
      g: o.getContext("2d")
    };
  }
  const xhairRedraw = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const [id, { c, g }] of Object.entries(overlays)) {
      const w = cv[id].clientWidth, h = cv[id].clientHeight;
      if (!w || !h) continue;
      if (c.width !== Math.floor(w * dpr)) {
        c.width = Math.floor(w * dpr);
        c.height = Math.floor(h * dpr);
      }
      g.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!xhair.visible || !xhair.ras) continue;
      if (id.endsWith("threeD")) {
        const s = rasToScreen3D(camera, xhair.ras, w, h);
        if (s) drawCross(g, s.x * w, s.y * h);
      } else {
        const o = id.split("-").pop();
        const pr = sc.slice.rasToView(o, off[o], xhair.ras, w / h);
        if (pr.u >= 0 && pr.u <= 1 && pr.v >= 0 && pr.v <= 1) drawCross(g, pr.u * w, pr.v * h);
      }
    }
  };
  const jumpAll = (ras) => {
    for (const o of ORIENTS) {
      const a = o === "axial" ? 2 : o === "coronal" ? 1 : 0;
      off[o] = Math.max(0, Math.min(1, (ras[a] - sc.rasLo[a]) / (sc.rasHi[a] - sc.rasLo[a])));
    }
    requestDraw();
  };
  const isShiftHover = (e) => e.shiftKey && e.buttons === 0;
  const uvOf = (c, e) => {
    const r = c.getBoundingClientRect();
    return {
      u: (e.clientX - r.left) / r.width,
      v: (e.clientY - r.top) / r.height,
      aspect: r.width / r.height
    };
  };
  for (const k of keys) {
    for (const o of ORIENTS) {
      cv[`c-${k}-${o}`].addEventListener("pointermove", (e) => {
        if (!isShiftHover(e)) return;
        const { u, v, aspect } = uvOf(cv[`c-${k}-${o}`], e);
        const ras = sc.slice.viewToRas(o, off[o], u, v, aspect);
        xhair.set(ras);
        jumpAll(ras);
      });
    }
  }
  for (const k of keys) {
    let inFlight = false, queued = null;
    const pick = async (u, v) => {
      inFlight = true;
      const ras = await rowOf(k).scene.pick(u, v);
      inFlight = false;
      if (ras) {
        xhair.set(ras);
        jumpAll(ras);
      }
      if (queued) {
        const q = queued;
        queued = null;
        pick(q.u, q.v);
      }
    };
    cv[`c-${k}-threeD`].addEventListener("pointermove", (e) => {
      if (!isShiftHover(e)) return;
      const { u, v } = uvOf(cv[`c-${k}-threeD`], e);
      if (inFlight) queued = {
        u,
        v
      };
      else pick(u, v);
    });
  }
  for (const k of keys) {
    for (const o of ORIENTS) {
      attachSliceControls(cv[`c-${k}-${o}`], {
        orient: o,
        getSlice: () => sc.slice,
        step: (fwd) => {
          off[o] = sliceIx.wheel(o, off[o], fwd);
        },
        redraw: () => {
          for (const kk of keys) drawSlice(kk, o);
          xhairRedraw();
        },
        hooks: {
          onDoubleClick: () => {
            toggleMax(`c-${k}-${o}`);
            return true;
          }
        }
      });
    }
  }
  for (const k of keys) attachCameraControls(cv[`c-${k}-threeD`], camera, {
    onChange: () => {
      touch3d();
      drawAll3d();
    }
  });
  let maxed = null;
  const toggleMax = (id) => {
    maxed = maxed === id ? null : id;
    const rowsEl = el("rows");
    rowsEl.classList.toggle("maxmode", !!maxed);
    for (const k of keys) {
      for (const c of cellNames) {
        const cell = cv[`c-${k}-${c}`].parentElement;
        cell.classList.toggle("max", maxed === `c-${k}-${c}`);
      }
    }
    for (const r of rowsEl.querySelectorAll(".mrow")) {
      r.classList.toggle("hasmax", !!maxed && !!r.querySelector(".cell.max"));
    }
    resize();
  };
  for (const k of keys) attachDoubleClick(cv[`c-${k}-threeD`], () => toggleMax(`c-${k}-threeD`));
  const shown = {
    axial: true,
    sagittal: true,
    coronal: true,
    threeD: true
  };
  const applyColumns = () => {
    for (const k of keys) for (const c of cellNames) cv[`c-${k}-${c}`].parentElement.classList.toggle("hidden", !shown[c]);
    resize();
  };
  for (const c of cellNames) {
    const b = el(`col-${c}`);
    b?.addEventListener("click", () => {
      shown[c] = !shown[c];
      b.classList.toggle("on", shown[c]);
      applyColumns();
    });
  }
  let currentLevel = null;
  let extent = 99;
  const extents = [
    [
      "ext-one",
      0
    ],
    [
      "ext-pm1",
      1
    ],
    [
      "ext-pm3",
      3
    ],
    [
      "ext-full",
      99
    ]
  ];
  const SLICE_MARGIN = 1.5;
  const frameCamera = (center, radius) => {
    const d = [
      camera.focalPoint[0] - camera.position[0],
      camera.focalPoint[1] - camera.position[1],
      camera.focalPoint[2] - camera.position[2]
    ];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const dist = radius / Math.tan(camera.viewAngle / 2 * Math.PI / 180);
    camera.focalPoint = [
      ...center
    ];
    camera.position = [
      center[0] - d[0] / len * dist,
      center[1] - d[1] / len * dist,
      center[2] - d[2] / len * dist
    ];
  };
  const applyFocus = () => {
    const box = sc.setExtent(extent >= 99 ? null : currentLevel, extent);
    for (const [id, n] of extents) el(id)?.classList.toggle("on", extent === n);
    if (box) {
      const c = [
        (box.lo[0] + box.hi[0]) / 2,
        (box.lo[1] + box.hi[1]) / 2,
        (box.lo[2] + box.hi[2]) / 2
      ];
      const ext = [
        box.hi[0] - box.lo[0],
        box.hi[1] - box.lo[1],
        box.hi[2] - box.lo[2]
      ];
      const fov = (a, b) => [
        Math.max(30, ext[a] * SLICE_MARGIN),
        Math.max(30, ext[b] * SLICE_MARGIN)
      ];
      const [axU, axV] = fov(0, 1);
      sc.slice.setMirrorFrame("axial", c, axU, axV);
      const [coU, coV] = fov(0, 2);
      sc.slice.setMirrorFrame("coronal", c, coU, coV);
      const [saU, saV] = fov(1, 2);
      sc.slice.setMirrorFrame("sagittal", c, saU, saV);
      frameCamera(c, Math.hypot(ext[0], ext[1], ext[2]) / 2 * 1.15);
    } else {
      for (const o of ORIENTS) sc.slice.resetView(o);
      frameCamera(sc.center, sc.radius);
    }
    requestDraw();
  };
  for (const [id, n] of extents) el(id)?.addEventListener("click", () => {
    extent = n;
    applyFocus();
  });
  const nameToLabel = Object.fromEntries(Object.entries(LEVEL_NAME).map(([n, s]) => [
    s,
    Number(n)
  ]));
  const strip = el("levels");
  const selectLevel = (label) => {
    currentLevel = label;
    if (extent >= 99) extent = 0;
    const g = sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label);
    if (g) {
      xhair.set(g.centroid);
      jumpAll(g.centroid);
    }
    applyFocus();
    for (const bb of strip.querySelectorAll("button")) {
      bb.classList.toggle("sel", bb.dataset.label === String(label));
    }
  };
  const detail = entry?.levels ?? {};
  const order = Object.keys(LEVEL_NAME).map(Number).sort((a, b) => {
    const rank = (l) => l === 28 ? 19.5 : l;
    return rank(a) - rank(b);
  });
  const levelSeq = [];
  const stepLevel = (delta) => {
    if (!levelSeq.length) return;
    const i = currentLevel == null ? delta > 0 ? 0 : levelSeq.length - 1 : Math.max(0, Math.min(levelSeq.length - 1, levelSeq.indexOf(currentLevel) + delta));
    if (levelSeq[i] !== currentLevel) selectLevel(levelSeq[i]);
  };
  const navBtn = (txt, delta, title) => {
    const b = document.createElement("button");
    b.className = "lvlnav";
    b.textContent = txt;
    b.title = title;
    b.addEventListener("click", () => stepLevel(delta));
    strip.appendChild(b);
    return b;
  };
  navBtn("\u25C0", -1, "previous level (\u2190)");
  for (const label of order) {
    const name = LEVEL_NAME[label];
    const d = detail[name];
    const g = sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label);
    if (!d && !g) continue;
    const b = document.createElement("button");
    const dice = d?.d;
    b.className = "lvl " + (dice == null ? "nodata" : dice >= 0.7 ? "good" : dice >= 0.3 ? "warn" : "bad");
    b.dataset.label = String(label);
    const best = d && d.b !== name && d.db != null ? ` ${d.db.toFixed(2)}` : "";
    b.innerHTML = `${name}${dice != null ? `<span>${dice.toFixed(2)}</span>` : ""}${d && d.b !== name ? `<em>\u2192${d.b}${best}</em>` : ""}`;
    b.title = d ? d.b !== name ? `Dice ${dice?.toFixed(3)} vs same-named reference \u2014 but as ${d.b} it matches with Dice ${d.db?.toFixed(3) ?? "?"} (label shift)` : `Dice ${dice?.toFixed(3)} vs the same-named reference level` : "no reference at this level";
    b.addEventListener("click", () => selectLevel(label));
    strip.appendChild(b);
    levelSeq.push(label);
  }
  navBtn("\u25B6", 1, "next level (\u2192)");
  const startLevel = PARAMS.get("level");
  if (startLevel != null && nameToLabel[startLevel] != null) {
    const l = nameToLabel[startLevel];
    if (sc.rows[0].levels.get(l) ?? sc.rows[1].levels.get(l)) selectLevel(l);
  }
  document.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT") return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepLevel(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepLevel(1);
    } else if (e.key === "Escape" && globalThis.parent !== globalThis) {
      globalThis.parent.postMessage({
        type: "closeDrill"
      }, "*");
    }
  });
  const controls = [
    {
      label: "SPINEPS shell",
      getOpacity: () => sc.methodOpacity("spineps"),
      setOpacity: (o) => {
        sc.setMethodOpacity("spineps", o);
        drawAll3d();
      },
      color: METHOD_COLORS.spineps
    },
    {
      label: "Reference shell",
      getOpacity: () => sc.methodOpacity("ref"),
      setOpacity: (o) => {
        sc.setMethodOpacity("ref", o);
        drawAll3d();
      },
      color: METHOD_COLORS.ref
    },
    {
      label: "CT volume (3D)",
      getOpacity: () => sc.volumeOpacity(),
      setOpacity: (o) => {
        sc.setVolumeOpacity(o);
        drawAll3d();
      },
      color: [
        0.75,
        0.78,
        0.85
      ]
    },
    {
      label: "Discs (SPINEPS)",
      getOpacity: () => sc.discOpacity(),
      setOpacity: (o) => {
        sc.setDiscOpacity(o);
        requestDraw();
      },
      color: [
        0.72,
        0.72,
        0.66
      ]
    }
  ];
  installChrome({
    controls,
    anchor: cv["c-ref-threeD"].parentElement ?? void 0
  });
  const cmp = entry?.compare;
  el("info").textContent = `${coll}/${pid} \xB7 ${cmp ? `${cmp.n_agree}/${cmp.n_ref_labels} agree \xB7 ${cmp.n_shifted} shifted \xB7 mean Dice ${cmp.mean_dice_same?.toFixed(3)}` : "no compare record"}`;
  const caseBtn = el("case-btn");
  const panel = el("case-panel");
  const listEl = el("case-list");
  const search = el("case-search");
  caseBtn.textContent = `${coll}/${pid} \u25BE`;
  const sorted = [
    ...casesDoc.cases
  ].sort((a, b) => (a.compare?.mean_dice_same ?? 2) - (b.compare?.mean_dice_same ?? 2));
  const renderList = (filter = "") => {
    const f = filter.trim().toLowerCase();
    listEl.innerHTML = "";
    for (const c of sorted) {
      if (f && !c.pid.toLowerCase().includes(f) && !c.collection.includes(f)) continue;
      const m = c.compare;
      const dice = m?.mean_dice_same;
      const cls = dice == null ? "" : dice < 0.3 ? "bad" : dice < 0.7 ? "warn" : "good";
      const b = document.createElement("button");
      b.className = "crow" + (c.pid === pid && c.collection === coll ? " cur" : "");
      b.innerHTML = `<span class="pid">${c.pid}</span><span class="pill ${c.collection}">${c.collection}</span><span class="st ${cls}">${m ? `${m.n_agree}/${m.n_ref_labels} \xB7 ${m.n_shifted}\u21C5 \xB7 ${dice?.toFixed(2)}` : "\u2014"}</span>`;
      b.title = m ? `${m.n_agree}/${m.n_ref_labels} levels agree \xB7 ${m.n_shifted} shifted \xB7 mean Dice ${dice?.toFixed(3)}` : "no compare record";
      b.addEventListener("click", () => {
        location.search = `?case=${c.pid}&coll=${c.collection}`;
      });
      listEl.appendChild(b);
    }
  };
  const togglePanel = (show) => {
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on) {
      renderList(search.value);
      search.focus();
    }
  };
  caseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
  search.addEventListener("input", () => renderList(search.value));
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target)) togglePanel(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") togglePanel(false);
  });
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const c of Object.values(cv)) {
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
    }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  resize();
  status(`${coll}/${pid} ready \u2014 click a vertebra to focus it, scroll a slice, drag any 3D to orbit (linked), shift+move to crosshair`);
  globalThis.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d?.type === "stepLevel" && typeof d.delta === "number") {
      stepLevel(d.delta);
      return;
    }
    if (d?.type !== "jumpLevel" || !d.name) return;
    const label = nameToLabel[d.name];
    if (label != null && (sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label))) selectLevel(label);
  });
  globalThis.__cmpDbg = {
    ready: () => true,
    dims: () => sc.dims,
    center: () => sc.center,
    offsets: () => ({
      ...off
    }),
    crosshair: () => xhair.ras,
    camera: () => ({
      position: [
        ...camera.position
      ],
      focalPoint: [
        ...camera.focalPoint
      ]
    }),
    levels: (k) => [
      ...rowOf(k).levels.values()
    ].filter((g) => g.label < 100).map((g) => ({
      label: g.label,
      name: g.name,
      voxels: g.voxels,
      centroid: g.centroid
    })),
    jumpLevel: (name) => {
      const label = nameToLabel[name];
      if (label == null) return null;
      const g = sc.rows[0].levels.get(label) ?? sc.rows[1].levels.get(label);
      if (g) selectLevel(label);
      return g?.centroid ?? null;
    },
    zoom: (o) => sc.slice.zoom(o),
    visibleLevels: (k) => sc.visibleLevels(k),
    currentLevel: () => currentLevel,
    stepLevel: (d) => stepLevel(d),
    extent: () => extent,
    setExtent: (n) => {
      extent = n;
      applyFocus();
    },
    methodOpacity: (k) => sc.methodOpacity(k),
    setMethodOpacity: (k, o) => {
      sc.setMethodOpacity(k, o);
      drawAll3d();
    }
  };
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
