// render/device.ts
async function initDevice() {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error("WebGPU not available (need Chrome/Edge/Safari or Deno --unstable-webgpu)");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const want = ["float32-filterable", "timestamp-query", "shader-f16"].filter((f) => adapter.features.has(f));
  const lim = adapter.limits;
  const requiredLimits = {};
  const raise = (k) => {
    const v = lim[k];
    if (typeof v === "number") requiredLimits[k] = v;
  };
  raise("maxBufferSize");
  raise("maxStorageBufferBindingSize");
  raise("maxTextureDimension3D");
  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits });
  return { adapter, device, features: new Set(want) };
}

// render/mat4.ts
function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function translation(t) {
  const m = identity();
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  return m;
}
function rotationAboutAxis(axis, angle) {
  let x = axis[0], y = axis[1], z = axis[2];
  const l = Math.hypot(x, y, z) || 1;
  x /= l;
  y /= l;
  z /= l;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const m = new Float32Array(16);
  m[0] = c + x * x * t;
  m[1] = y * x * t + z * s;
  m[2] = z * x * t - y * s;
  m[4] = x * y * t - z * s;
  m[5] = c + y * y * t;
  m[6] = z * y * t + x * s;
  m[8] = x * z * t + y * s;
  m[9] = y * z * t - x * s;
  m[10] = c + z * z * t;
  m[15] = 1;
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
function perspectiveZOTile(fovy, viewW, viewH, x, y, w, h, near, far) {
  const t = near * Math.tan(fovy / 2), b = -t;
  const r = t * (viewW / viewH), l = -r;
  const l2 = l + (r - l) * x / viewW, r2 = l + (r - l) * (x + w) / viewW;
  const t2 = t - (t - b) * y / viewH, b2 = t - (t - b) * (y + h) / viewH;
  const m = new Float32Array(16);
  m[0] = 2 * near / (r2 - l2);
  m[5] = 2 * near / (t2 - b2);
  m[8] = (r2 + l2) / (r2 - l2);
  m[9] = (t2 + b2) / (t2 - b2);
  m[10] = far / (near - far);
  m[11] = -1;
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
function patientToTexture(dims, spacing, center = [0, 0, 0]) {
  const m = new Float32Array(16);
  for (let a = 0; a < 3; a++) {
    const s = 1 / (spacing[a] * dims[a]);
    m[a * 4 + a] = s;
    m[12 + a] = 0.5 - center[a] * s;
  }
  m[15] = 1;
  return m;
}
function volumeAABB(dims, spacing, center = [0, 0, 0]) {
  const ext = [dims[0] * spacing[0] / 2, dims[1] * spacing[1] / 2, dims[2] * spacing[2] / 2];
  return [
    [center[0] - ext[0], center[1] - ext[1], center[2] - ext[2]],
    [center[0] + ext[0], center[1] + ext[1], center[2] + ext[2]]
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
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const u = c & 1, v = c >> 1 & 1, w = c >> 2 & 1;
    for (let r = 0; r < 3; r++) {
      const p = t2r[r] * u + t2r[4 + r] * v + t2r[8 + r] * w + t2r[12 + r];
      if (p < lo[r]) lo[r] = p;
      if (p > hi[r]) hi[r] = p;
    }
  }
  return [lo, hi];
}
function applyMat4(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] || 1;
  return [x / w, y / w, z / w];
}
function spacingFromIjkToRAS(ijkToRAS) {
  const col = (c) => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}

// render/scene-renderer.ts
var DEFAULT_FORMAT = "rgba8unorm-srgb";
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
  // mat[] offset of the pick_cursor uniform (NDC)
  pickTarget;
  // 1x1 rgba32float (wp.xyz, hit)
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
  // last setCamera invVP (unjittered)
  focalPx = 1;
  // last setCamera focal (view→pixels); used to keep screen-space handles view-sized under low-res trace
  accumPipeline;
  // MRT: trace + prev-accum -> new-accum + presented view
  accumBind = [void 0, void 0];
  accumUniformBuf;
  // (bg.rgb, blend)
  accumTex = [void 0, void 0];
  accumView = [void 0, void 0];
  accumPing = 0;
  accumN = 0;
  lastAccumCam = new Float32Array(16);
  // camera (invVP) of the last accumulated frame
  lastAccumValid = false;
  // false forces a reset (after a rebuild / first frame)
  streamPipeline;
  // trace -> rgba8unorm, for compact sample readback (remote)
  streamBind;
  // its OWN bind group (auto-layout differs from this.pipeline's)
  // RESOLUTION-SCALED reconstruction (M2b): while interacting, trace at a fraction of the view
  // (BudgetController) and Catmull-Rom UPSAMPLE the low-res trace to the view — the client-superres
  // ported from the Python spike. A settled view renders native + accumulates instead.
  superresPipeline;
  superresBind;
  superresBuf;
  // (traceW, traceH, viewW, viewH)
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
  constructor(gpu, format = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    this.canTime = gpu.features.has("timestamp-query");
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.camBuf = this.dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resolveBgBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const rmod = this.dev.createShaderModule({ code: this.resolveWgsl() });
    this.resolvePipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: rmod, entryPoint: "vs_resolve" },
      fragment: { module: rmod, entryPoint: "fs_resolve", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.accumUniformBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const amod = this.dev.createShaderModule({ code: this.accumWgsl() });
    this.accumPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: amod, entryPoint: "vs_resolve" },
      fragment: { module: amod, entryPoint: "fs_accum", targets: [{ format: "rgba32float" }, { format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.superresBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const smod = this.dev.createShaderModule({ code: this.superresWgsl() });
    this.superresPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: smod, entryPoint: "vs_resolve" },
      fragment: { module: smod, entryPoint: "fs_superres", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
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
      size: [width, height],
      format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.traceView = this.traceTex.createView();
    this.traceW = width;
    this.traceH = height;
    this.resolveBind = this.dev.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.traceView }, { binding: 1, resource: { buffer: this.resolveBgBuf } }]
    });
  }
  /** (Re)allocate the low-res trace target + superres bind group when the moving render size changes.
   *  Separate from traceTex so a moving frame never disturbs the accumulation textures. */
  ensureLow(width, height) {
    if (this.lowTex && this.lowW === width && this.lowH === height) return;
    this.lowTex?.destroy();
    this.lowTex = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.lowView = this.lowTex.createView();
    this.lowW = width;
    this.lowH = height;
    this.superresBind = this.dev.createBindGroup({
      layout: this.superresPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.lowView },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.superresBuf } },
        { binding: 3, resource: { buffer: this.resolveBgBuf } }
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
    this.dev.queue.writeBuffer(this.camBuf, 72, new Float32Array([this.focalPx * (viewH / renderH)]));
    this.dev.queue.writeBuffer(this.superresBuf, 0, new Float32Array([renderW, renderH, viewW, viewH]));
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: this.lowView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const sp = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    sp.setPipeline(this.superresPipeline);
    sp.setBindGroup(0, this.superresBind);
    sp.draw(3);
    sp.end();
    this.dev.queue.submit([enc.finish()]);
  }
  /** Encode trace (producer) + resolve (reconstructor) into `enc`, output to `outView`. */
  encodeFrame(enc, outView) {
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: this.traceView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: outView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
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
      this.accumTex[k] = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.accumView[k] = this.accumTex[k].createView();
    }
    for (let k = 0; k < 2; k++) {
      this.accumBind[k] = this.dev.createBindGroup({
        layout: this.accumPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.traceView },
          { binding: 1, resource: this.accumView[k] },
          { binding: 2, resource: { buffer: this.accumUniformBuf } }
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
    this.dev.queue.writeBuffer(this.camBuf, 76, new Float32Array([n - 1]));
    this.flush();
    this.dev.queue.writeBuffer(this.accumUniformBuf, 0, new Float32Array([this.mat[12], this.mat[13], this.mat[14], 1 / n]));
    const prev = this.accumPing, next = 1 - this.accumPing;
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: this.traceView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const ap = enc.beginRenderPass({ colorAttachments: [
      { view: this.accumView[next], loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      { view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }
    ] });
    ap.setPipeline(this.accumPipeline);
    ap.setBindGroup(0, this.accumBind[prev]);
    ap.draw(3);
    ap.end();
    this.dev.queue.submit([enc.finish()]);
    this.accumPing = next;
  }
  /** (Re)build the pipeline for a set of fields. */
  build(fields) {
    const kindCount = {};
    let uoff = SCENE_FLOATS, bbase = 3;
    this.placed = fields.map((field) => {
      const slot = kindCount[field.kind] ?? 0;
      kindCount[field.kind] = slot + 1;
      const p = { field, slot, uoff, bbase };
      uoff += field.uniformFloats();
      bbase += field.bindingCount;
      return p;
    });
    this.clipOff = uoff;
    this.pickOff = uoff + CLIP_FLOATS;
    this.mat = new Float32Array(uoff + CLIP_FLOATS + 12);
    this.matBuf = this.dev.createBuffer({ size: (uoff + CLIP_FLOATS + 12) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = this.dev.createShaderModule({ code: this.wgsl() });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_trace", targets: [{ format: "rgba32float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.pickPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_pick", targets: [{ format: "rgba32float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.streamPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_trace", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.streamBind = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
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
    const slotOf = new Map(this.placed.map((p) => [p.field, p.slot]));
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
    const fns = [modFns, tpFns, fieldFns, skipFns].filter((s) => s.trim()).join("\n");
    const skipInit = [...normalSkippers, ...ghostSkippers].map((p) => `  var resume_${p.field.kind}${p.slot} : f32 = -1.0e30;`).join("\n");
    const dispatch = normalReceivers.map(
      (p) => canSkip.has(p.field) ? skipBranch(p, true) : plainBranch(p, true)
    ).join("\n");
    const ghostDispatch = ghostFields.map(
      (p) => ghostCanSkip.has(p.field) ? skipBranch(p, false, true) : plainBranch(p, false, true)
    ).join("\n");
    const hasGhost = ghostFields.length > 0;
    const pickDispatch = normalReceivers.map(
      (p) => `    ${clipGuard(p, `{ let c = sample_field_${p.field.kind}${p.slot}(wp, rd); sum += c; }`)}`
    ).join("\n");
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
  probe_origin : vec4<f32>,            // explicit-ray probe: world origin
  probe_dir : vec4<f32>,               // (dx, dy, dz, enabled) \u2014 w>0 uses this ray instead of the cursor
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
    // Per-(pixel, step, ACCUM FRAME) ray-offset jitter. The frame term (u_cam.size.w, the
    // accumulation index) is what makes temporal AA actually converge: with a frame-invariant
    // offset the jitter turns banding into FIXED-PATTERN noise that averaging can never remove
    // (measured: 32 samples was as grainy as 1). Varying it per frame decorrelates the samples
    // so the mean approaches the true integral \u2014 no banding AND no noise. size.w is 0 for every
    // non-accumulating path, so frame 1 stays byte-identical to a plain renderToView.
    // Base offset: decorrelated per (pixel, step) so a single frame shows noise, not banding.
    let jbase = fract(sin(dot(v.position.xy + vec2<f32>(f32(safety) * 0.7548, f32(safety) * 0.5698), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    // Advance it across accumulation frames by the golden-ratio additive recurrence
    // (Cranley-Patterson rotation). MEASURED: this converges at the same 1/sqrt(n) rate as an
    // independent random offset per frame (high-freq energy 1.36 vs 1.31 at n=64) \u2014 the low-
    // discrepancy walk is NOT faster here, because the variance is dominated by the step size
    // against a sharp transfer function, not by the sequence. Kept because it is deterministic
    // and costs nothing; reduce sampleStep if you need less residual speckle.
    // At size.w = 0 this is exactly jbase, so the first accumulated frame stays byte-identical
    // to a plain renderToView \u2014 the property render/test baselines depend on.
    let js = fract(jbase + u_cam.size.w * 0.6180339887) - 0.5;
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
  // Two ray sources: the screen cursor (pick) or an explicit world ray (probe). The explicit
  // form exists because the cursor ray can only ever probe what is ON SCREEN \u2014 useless for
  // "how much room is BEHIND me?", which endovascular navigation needs for reverse and for
  // lateral clearance.
  var ro = ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 0.0, 1.0));
  var rd = normalize(ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 1.0, 1.0)) - ro);
  if (u_material.probe_dir.w > 0.5) {
    ro = u_material.probe_origin.xyz;
    rd = normalize(u_material.probe_dir.xyz);
  }
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
      [1, 0, 0, -lo[0]],
      [-1, 0, 0, hi[0]],
      // keep lo.x <= x <= hi.x
      [0, 1, 0, -lo[1]],
      [0, -1, 0, hi[1]],
      [0, 0, 1, -lo[2]],
      [0, 0, -1, hi[2]]
    ]);
  }
  /** Scene AABB = union of field AABBs; also picks a default sample step from the smallest field extent. */
  recomputeBounds() {
    if (!this.placed.length) return;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
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
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.streamBind = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
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
      { binding: 0, resource: { buffer: this.camBuf } },
      { binding: 1, resource: { buffer: this.matBuf } }
    ];
    if (this.usesSampler()) entries.push({ binding: 2, resource: this.sampler });
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
    cam[19] = 0;
    cam[20] = eye[0];
    cam[21] = eye[1];
    cam[22] = eye[2];
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
  }
  /** Camera for ONE TILE of the view: the same rays the full frame would cast for `rect`, into a
   *  rect.w×rect.h target. Screen-space glyph sizing stays keyed to the FULL view height, so a
   *  patch of the gizmo is drawn at exactly the size the full frame drew it. Pair with
   *  traceSamples(rect.w, rect.h) — its focal rewrite is then a no-op. */
  setCameraTile(eye, center, up, fovyDeg, viewW, viewH, rect) {
    const view = lookAt(eye, center, up);
    const proj = perspectiveZOTile(fovyDeg * Math.PI / 180, viewW, viewH, rect.x, rect.y, rect.w, rect.h, 1, 1e5);
    const invVP = invert(multiply(proj, view));
    this.baseInvVP = invVP;
    const cam = new Float32Array(24);
    cam.set(invVP, 0);
    this.focalPx = viewH / 2 / Math.tan(fovyDeg * Math.PI / 360);
    cam[16] = rect.w;
    cam[17] = rect.h;
    cam[18] = this.focalPx;
    cam[19] = 0;
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
    return this.serialise(async () => {
      this.mat[this.pickOff] = u * 2 - 1;
      this.mat[this.pickOff + 1] = 1 - v * 2;
      this.mat[this.pickOff + 11] = 0;
      this.flush();
      return await this.tracePick();
    });
  }
  /** Trace an EXPLICIT world ray and return the distance (mm) to the first point where
   *  front-to-back opacity reaches 50%, or Infinity if it never does. Unlike pick(), the ray
   *  is independent of the camera, so it can look backwards and sideways — which is what makes
   *  collision "rails" possible in a first-person flythrough. */
  async probe(origin, dir) {
    if (!this.pickPipeline || !this.pickBind || !this.placed.length) return Infinity;
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return this.serialise(async () => {
      this.mat[this.pickOff + 4] = origin[0];
      this.mat[this.pickOff + 5] = origin[1];
      this.mat[this.pickOff + 6] = origin[2];
      this.mat[this.pickOff + 8] = dir[0] / l;
      this.mat[this.pickOff + 9] = dir[1] / l;
      this.mat[this.pickOff + 10] = dir[2] / l;
      this.mat[this.pickOff + 11] = 1;
      this.flush();
      const hit = await this.tracePick();
      this.mat[this.pickOff + 11] = 0;
      this.flush();
      if (!hit) return Infinity;
      return Math.hypot(hit[0] - origin[0], hit[1] - origin[1], hit[2] - origin[2]);
    });
  }
  /** Serialises pick/probe. They share ONE uniform buffer and ONE readback buffer, so
   *  concurrent calls would overwrite each other's ray and double-map the buffer — a
   *  Promise.all of probes silently returns garbage. Callers may fire as many as they like;
   *  they queue here. */
  pickChain = Promise.resolve();
  serialise(fn) {
    const next = this.pickChain.then(fn, fn);
    this.pickChain = next.catch(() => {
    });
    return next;
  }
  /** The shared 1x1 render + readback behind pick() and probe(). */
  async tracePick() {
    if (!this.pickTarget) {
      this.pickTarget = this.dev.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.pickReadBuf = this.dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.pickTarget.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(this.pickPipeline);
    pass.setBindGroup(0, this.pickBind);
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({ texture: this.pickTarget }, { buffer: this.pickReadBuf, bytesPerRow: 256, rowsPerImage: 1 }, [1, 1]);
    this.dev.queue.submit([enc.finish()]);
    await this.pickReadBuf.mapAsync(GPUMapMode.READ);
    const r = new Float32Array(this.pickReadBuf.getMappedRange().slice(0, 16));
    this.pickReadBuf.unmap();
    return r[3] > 0.5 ? [r[0], r[1], r[2]] : null;
  }
  renderToView(view, width, height) {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const enc = this.dev.createCommandEncoder();
    this.encodeFrame(enc, view);
    this.dev.queue.submit([enc.finish()]);
  }
  /** Exact GPU time of the ray-march pass (median ms over `iters`), via timestamp-query.
   *  Times ONLY the render pass — no texture copy/readback — so it reflects shader cost.
   *  Returns NaN if the device lacks timestamp-query. Deno gives full-resolution timestamps;
   *  Chrome quantizes them unless cross-origin isolated, so profile headless for sharp numbers. */
  async timePass(width, height, iters = 40) {
    if (!this.canTime) return NaN;
    this.flush();
    const target = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = target.createView();
    const qs = this.dev.createQuerySet({ type: "timestamp", count: 2 });
    const resolve = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const enc = this.dev.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bind);
      pass.draw(3);
      pass.end();
      enc.resolveQuerySet(qs, 0, 2, resolve, 0);
      enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
      this.dev.queue.submit([enc.finish()]);
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
    const target = this.dev.createTexture({ size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    this.encodeFrame(enc, target.createView());
    const bpr = Math.ceil(width * 4 / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
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
  async traceSamples(width, height, viewH = height) {
    this.flush();
    this.dev.queue.writeBuffer(this.camBuf, 64, new Float32Array([width, height]));
    this.dev.queue.writeBuffer(this.camBuf, 72, new Float32Array([this.focalPx * (viewH / height)]));
    const target = this.dev.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.streamPipeline);
    tp.setBindGroup(0, this.streamBind);
    tp.draw(3);
    tp.end();
    const bpr = Math.ceil(width * 4 / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
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
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = applyMat4(m, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    for (let a = 0; a < 3; a++) {
      mn[a] = Math.min(mn[a], c[a]);
      mx[a] = Math.max(mx[a], c[a]);
    }
  }
  return [mn, mx];
}
var ImageField = class {
  kind = "img";
  bindingCount = 2;
  // volume (3d) + lut (2d)
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
    const center = opts.center ?? [0, 0, 0];
    this.volTex = dev.createTexture({ size: dims, dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.volTex }, data, { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] }, dims);
    this.lutTex = dev.createTexture({ size: [256, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
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
    this.shade = opts.shade ?? [0.35, 0.75, 0.35, 20];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
    this.dev = dev;
  }
  /** Replace the 256-entry rgba8 color/opacity LUT in place (no texture/bind-group churn).
   *  The bind group holds a stable view of lutTex, so the next render uses the new LUT. */
  setLUT(lut) {
    this.dev.queue.writeTexture({ texture: this.lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
  }
  /** The scalar range the LUT spans — window/level for the volume rendering. Re-packed into
   *  the material uniform on the next syncUniforms()/render, so no pipeline rebuild. */
  setClim(lo, hi) {
    this.clim = [lo, hi];
  }
  getClim() {
    return [this.clim[0], this.clim[1]];
  }
  origP2t;
  // sampling matrix + box at identity, for setWorldTransform
  origBox;
  uniformFloats() {
    return 28;
  }
  // mat4(16) + clim(4) + shade(4) + params(4)
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
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
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
      // lo, hi, _, _
      `  img${s}_shade : vec4<f32>,`,
      // ka, kd, ks, shininess
      `  img${s}_params : vec4<f32>,`
      // opacity_unit_distance, _, _, _
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
      { binding: base, resource: this.volTex.createView() },
      { binding: base + 1, resource: this.lutTex.createView() }
    ];
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
  for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) jobs.push([kk, jj, ii]);
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
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { data: out, dims: [nx, ny, nz], range: [lo, hi] };
}

// render/mrson.ts
var TYPE_TO_CLASS = {
  image: "vtkMRMLScalarVolumeNode",
  mesh: "vtkMRMLModelNode",
  segmentation: "vtkMRMLSegmentationNode",
  markup: "vtkMRMLMarkupsFiducialNode",
  transform: "vtkMRMLLinearTransformNode",
  camera: "vtkMRMLCameraNode",
  view: "vtkMRMLViewNode",
  transferFunction: "vtkMRMLVolumePropertyNode",
  scalarVolumeDisplay: "vtkMRMLScalarVolumeDisplayNode",
  volumeRenderingDisplay: "vtkMRMLGPURayCastVolumeRenderingDisplayNode",
  modelDisplay: "vtkMRMLModelDisplayNode",
  markupDisplay: "vtkMRMLMarkupsDisplayNode"
};
function isMrsonScene(raw) {
  const r = raw;
  if (!r || typeof r !== "object") return false;
  if (r.mrson !== void 0) return true;
  return !!r.nodes && Object.values(r.nodes).some((n) => typeof n?.type === "string");
}
var colorRows = (a) => Array.isArray(a) ? a.map((s) => [s.value, s.rgba[0], s.rgba[1], s.rgba[2]]) : [];
var opacityRows = (a) => Array.isArray(a) ? a.map((s) => [s.value, s.opacity]) : [];
function adaptMrsonScene(scene) {
  const nodes = scene.nodes ?? {};
  const out = {};
  for (const [id, n] of Object.entries(nodes)) {
    const cls = n.source?.mrmlClass ?? TYPE_TO_CLASS[n.type] ?? n.type;
    const refs = { ...n.refs ?? {} };
    const attrs = {};
    switch (n.type) {
      case "image":
        attrs.zarr = n.zarr;
        attrs.ijkToRAS = n.ijkToRAS;
        attrs.dims = n.dims;
        attrs.comps = n.comps;
        break;
      case "transferFunction":
        attrs.color = colorRows(n.colorStops);
        attrs.scalarOpacity = opacityRows(n.scalarOpacity);
        attrs.gradientOpacity = opacityRows(n.gradientOpacity);
        attrs.shade = n.shade;
        break;
      case "scalarVolumeDisplay":
        attrs.window = n.window;
        attrs.level = n.level;
        attrs.color = n.color;
        attrs.visibility = n.visible ? 1 : 0;
        break;
      case "volumeRenderingDisplay":
        if (n.refs?.transferFunction) refs.volumeProperty = n.refs.transferFunction;
        break;
      case "markup": {
        attrs.controlPoints = n.controlPoints;
        const dc = (n.refs?.display ?? []).map((d) => nodes[d]?.color).find(Boolean);
        if (dc) attrs.color = dc.slice(0, 3);
        break;
      }
      case "camera":
        attrs.position = n.position;
        attrs.focalPoint = n.focalPoint;
        attrs.viewUp = n.viewUp;
        attrs.viewAngle = n.viewAngle;
        attrs.parallelScale = n.parallelScale;
        break;
      default:
        break;
    }
    out[id] = { id, class: cls, name: n.name, refs, attrs, blobs: [] };
  }
  return { blobBase: scene.blobBase, nodes: out };
}

// render/scene-volume.ts
function interpTF(tf, s, comps) {
  if (!tf.length) return new Array(comps).fill(0);
  if (s <= tf[0][0]) return tf[0].slice(1, 1 + comps);
  const last = tf[tf.length - 1];
  if (s >= last[0]) return last.slice(1, 1 + comps);
  for (let i = 1; i < tf.length; i++) {
    if (s <= tf[i][0]) {
      const a = tf[i - 1], b = tf[i];
      const u = (s - a[0]) / Math.max(b[0] - a[0], 1e-9);
      return Array.from({ length: comps }, (_, c) => a[1 + c] + u * (b[1 + c] - a[1 + c]));
    }
  }
  return last.slice(1, 1 + comps);
}
function lutFromTransferFunctions(colorTF, opacityTF, clim) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const s = clim[0] + i / 255 * (clim[1] - clim[0]);
    const [r, g, b] = interpTF(colorTF, s, 3);
    const [a] = interpTF(opacityTF, s, 1);
    lut[i * 4 + 0] = Math.round(Math.max(0, Math.min(1, r)) * 255);
    lut[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    lut[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  return lut;
}
function lutFromWindowLevel() {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const g = Math.round(t * 255);
    lut[i * 4 + 0] = lut[i * 4 + 1] = lut[i * 4 + 2] = g;
    lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (t - 0.15) / 0.85)) * 200);
  }
  return lut;
}
function parseMarkups(nodes) {
  const out = [];
  for (const n of Object.values(nodes)) {
    if (!/Markups.*Node$/.test(n.class)) continue;
    const cps = n.attrs?.controlPoints ?? n.attrs?.markups;
    if (!Array.isArray(cps)) continue;
    const color = n.attrs?.color ?? [1, 0.85, 0.2];
    cps.forEach((cp, i) => {
      const c = cp;
      const p = c.position ?? cp;
      if (!Array.isArray(p) || p.length < 3) return;
      out.push({ ras: [p[0], p[1], p[2]], label: c.label ?? `${n.name ?? "F"}-${i + 1}`, color });
    });
  }
  return out;
}
async function loadSceneVolumeField(dev, sceneUrl, onBytes, opts = {}) {
  const raw = await (await fetch(sceneUrl)).json();
  const adapted = isMrsonScene(raw) ? adaptMrsonScene(raw) : raw;
  const wrapper = adapted.nodes ? adapted : { nodes: adapted };
  const nodes = wrapper.nodes;
  const pageBase = globalThis.location?.href ?? "file:///";
  const sceneAbs = new URL(sceneUrl, pageBase).href;
  const blobBase = new URL(wrapper.blobBase ?? "./blobs/", sceneAbs).href;
  const vol = Object.values(nodes).find((n) => n.class === "vtkMRMLScalarVolumeNode" && n.attrs?.zarr);
  if (!vol) throw new Error("no zarr ScalarVolumeNode in scene");
  const z = vol.attrs.zarr;
  let ijkToRAS = vol.attrs.ijkToRAS;
  if (!ijkToRAS) throw new Error("volume node has no ijkToRAS");
  if (opts.extraTranslationRAS) {
    const t = opts.extraTranslationRAS;
    ijkToRAS = ijkToRAS.slice();
    ijkToRAS[3] += t[0];
    ijkToRAS[7] += t[1];
    ijkToRAS[11] += t[2];
  }
  const zv = await fetchZarrVolume(blobBase, z, onBytes);
  let vp;
  for (const dispId of vol.refs?.display ?? []) {
    const disp = nodes[dispId];
    for (const vpId of disp?.refs?.volumeProperty ?? []) {
      if (nodes[vpId]?.class === "vtkMRMLVolumePropertyNode") vp = nodes[vpId];
    }
  }
  let lut, clim, shade;
  if (vp?.attrs?.color && vp?.attrs?.scalarOpacity) {
    const colorTF = vp.attrs.color, opacityTF = vp.attrs.scalarOpacity;
    const lo2 = colorTF[0][0], hi2 = colorTF[colorTF.length - 1][0];
    clim = [lo2, hi2];
    lut = lutFromTransferFunctions(colorTF, opacityTF, clim);
    shade = vp.attrs.shade ? [0.25, 0.75, 0.5, 24] : [1, 0, 0, 1];
  } else {
    const disp = nodes[(vol.refs?.display ?? [])[0]]?.attrs ?? {};
    const win2 = disp.window ?? zv.range[1] - zv.range[0];
    const lev2 = disp.level ?? (zv.range[0] + zv.range[1]) / 2;
    clim = [lev2 - win2 / 2, lev2 + win2 / 2];
    lut = lutFromWindowLevel();
    shade = [0.25, 0.75, 0.5, 24];
  }
  const disp0 = nodes[(vol.refs?.display ?? [])[0]]?.attrs ?? {};
  const win = disp0.window ?? zv.range[1] - zv.range[0];
  const lev = disp0.level ?? (zv.range[0] + zv.range[1]) / 2;
  const field = new ImageField(dev, zv.data, zv.dims, [1, 1, 1], lut, { clim, ijkToRAS, shade });
  const [lo, hi] = field.aabb();
  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  return { field, voxels: zv.data, dims: zv.dims, ijkToRAS, name: vol.name ?? "volume", range: zv.range, center, radius, win, lev, markups: parseMarkups(nodes) };
}

// render/reconstructor.ts
var WGSL = (
  /* wgsl */
  `
@group(0) @binding(0) var t_sample : texture_2d<f32>;
@group(0) @binding(1) var s_lin : sampler;
// size = (sampleW, sampleH, _, _); rect = (originX, originY, spanW, spanH) in DESTINATION pixels \u2014
// the region this present writes. A full frame is (0, 0, viewW, viewH); a PATCH is its dirty rect.
struct SR { size : vec4<f32>, rect : vec4<f32> };
@group(0) @binding(2) var<uniform> u_sr : SR;
@group(0) @binding(3) var<uniform> u_bg : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
// Catmull-Rom via 9 bilinear taps (Sigg/Hadwiger).
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
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p0.x,  p0.y),  0.0) * (w0.x  * w0.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p12.x, p0.y),  0.0) * (w12.x * w0.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p3.x,  p0.y),  0.0) * (w3.x  * w0.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p0.x,  p12.y), 0.0) * (w0.x  * w12.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p12.x, p12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p3.x,  p12.y), 0.0) * (w3.x  * w12.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p0.x,  p3.y),  0.0) * (w0.x  * w3.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p12.x, p3.y),  0.0) * (w12.x * w3.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p3.x,  p3.y),  0.0) * (w3.x  * w3.y);
  return r;
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs(v : RV) -> @location(0) vec4<f32> {
  let uv = (v.position.xy - u_sr.rect.xy) / u_sr.rect.zw;
  let s = cr(uv, u_sr.size.xy);
  let a = clamp(s.a, 0.0, 1.0);
  let bg = srgb2physical(u_bg.rgb);
  return vec4<f32>(mix(bg, s.rgb, a), 1.0);
}`
);
var Reconstructor = class {
  dev;
  pipeline;
  sampler;
  srBuf;
  // SR { size, rect }
  bgBuf;
  // background rgb
  tex;
  bind;
  tw = 0;
  th = 0;
  constructor(gpu, format) {
    this.dev = gpu.device;
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.srBuf = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bgBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = this.dev.createShaderModule({ code: WGSL });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.bgBuf && this.dev.queue.writeBuffer(this.bgBuf, 0, new Float32Array([0.05, 0.06, 0.09, 1]));
  }
  setBackground(r, g, b) {
    this.dev.queue.writeBuffer(this.bgBuf, 0, new Float32Array([r, g, b, 1]));
  }
  ensureTex(w, h) {
    if (this.tex && this.tw === w && this.th === h) return;
    this.tex?.destroy();
    this.tex = this.dev.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.tw = w;
    this.th = h;
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.tex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.srBuf } },
        { binding: 3, resource: { buffer: this.bgBuf } }
      ]
    });
  }
  /** Upload `samples` (sampleW×sampleH premultiplied rgba8) and reconstruct to `view` (viewW×viewH).
   *  With `rect`, this is a PATCH: only those destination pixels are written (scissor + load), so
   *  everything already in `view` survives — the transport can then re-send just a dirty region. */
  present(view, samples, sampleW, sampleH, viewW, viewH, rect) {
    this.ensureTex(sampleW, sampleH);
    this.dev.queue.writeTexture({ texture: this.tex }, samples, { bytesPerRow: sampleW * 4, rowsPerImage: sampleH }, [sampleW, sampleH]);
    const r = rect ?? { x: 0, y: 0, w: viewW, h: viewH };
    this.dev.queue.writeBuffer(this.srBuf, 0, new Float32Array([sampleW, sampleH, 0, 0, r.x, r.y, r.w, r.h]));
    const enc = this.dev.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: rect ? "load" : "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    p.setPipeline(this.pipeline);
    p.setBindGroup(0, this.bind);
    if (rect) p.setScissorRect(r.x, r.y, r.w, r.h);
    p.draw(3);
    p.end();
    this.dev.queue.submit([enc.finish()]);
  }
};

// render/budget-controller.ts
var BudgetController = class {
  budgetPx;
  targetMs;
  minPx;
  maxPx;
  constructor(opts = {}) {
    this.targetMs = opts.targetMs ?? 16;
    this.minPx = opts.minPx ?? 3e4;
    this.maxPx = opts.maxPx ?? 8e6;
    this.budgetPx = opts.startPx ?? 35e4;
  }
  /** Nudge the budget toward hitting targetMs. Multiplicative, clamped per step (0.8–1.25×) so the
   *  loop is stable, and bounded to [minPx, maxPx]. Faster-than-target grows it; slower shrinks it. */
  update(measuredMs) {
    if (!(measuredMs > 0) || !Number.isFinite(measuredMs)) return;
    const adj = Math.max(0.35, Math.min(1.2, this.targetMs / measuredMs));
    this.budgetPx = Math.max(this.minPx, Math.min(this.maxPx, this.budgetPx * adj));
  }
  /** Resolution scale for a `w×h` view: sqrt(budget / area), clamped to [0.25, 1]. 1 when the view
   *  already fits the budget (small window); a fraction for a big/retina window under load. */
  scale(w, h) {
    const area = Math.max(1, w * h);
    return Math.max(0.25, Math.min(1, Math.sqrt(this.budgetPx / area)));
  }
};

// render/demos/accum-loop.ts
function mountAdaptiveLoop(opts) {
  const target = opts.target ?? 32;
  const idleGap = opts.idleGapMs ?? 120;
  const paced = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => r())),
    new Promise((r) => setTimeout(r, 33))
  ]);
  const sync = opts.sync ?? (() => Promise.resolve());
  let running = false, stopped = false, lastKick = -1e12, wasMoving = false;
  const step = () => {
    if (performance.now() - lastKick < idleGap) {
      opts.renderMoving();
      wasMoving = true;
      return true;
    }
    if (wasMoving) {
      wasMoving = false;
      opts.renderSettled(true);
      return true;
    }
    if (opts.count() < target) {
      opts.renderSettled(false);
      return true;
    }
    return false;
  };
  const run = async () => {
    running = true;
    stopped = false;
    while (!stopped && step()) await Promise.all([sync(), paced()]);
    running = false;
  };
  return {
    kick() {
      lastKick = performance.now();
      if (!running) run();
    },
    // run() renders the 1st frame synchronously
    stop() {
      stopped = true;
    }
  };
}
function mountAdaptive3d(opts) {
  const budget = new BudgetController({ targetMs: opts.targetMs ?? 16 });
  const DBG = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
  let dbgN = 0, dbgMoving = 0, dbgSettled = 0, dbgLast = 0;
  const dbgTick = (kind, ms, s) => {
    if (!DBG) return;
    dbgN++;
    if (kind === "mov") dbgMoving += ms;
    else dbgSettled += ms;
    const now = performance.now();
    if (now - dbgLast > 500) {
      console.log(`[perf] mov=${dbgMoving.toFixed(0)}ms/${dbgN}f settled=${dbgSettled.toFixed(0)}ms lastScale=${s.toFixed(2)} last=${ms.toFixed(1)}ms`);
      dbgLast = now;
      dbgMoving = dbgSettled = dbgN = 0;
    }
  };
  const movingCap = opts.movingScaleCap ?? 1;
  const renderMoving = () => {
    const sc = opts.scene();
    if (!sc) return;
    const { w: vw, h: vh } = opts.size();
    if (!vw || !vh) return;
    const s = Math.min(movingCap, budget.scale(vw, vh)), t0 = performance.now();
    if (s > 0.98) {
      opts.setCamera(sc, vw, vh);
      sc.renderToView(opts.view(), vw, vh);
    } else {
      const rw = Math.max(16, Math.round(vw * s)), rh = Math.max(16, Math.round(vh * s));
      opts.setCamera(sc, rw, rh);
      sc.renderUpscaled(opts.view(), rw, rh, vw, vh);
    }
    opts.gpu.device.queue.onSubmittedWorkDone().then(() => {
      const ms = performance.now() - t0;
      budget.update(ms);
      dbgTick("mov", ms, s);
    });
    opts.onFrame?.();
  };
  const renderSettled = (reset) => {
    const sc = opts.scene();
    if (!sc) return;
    const { w: vw, h: vh } = opts.size();
    if (!vw || !vh) return;
    const t0 = performance.now();
    opts.setCamera(sc, vw, vh);
    sc.renderAccum(opts.view(), vw, vh, reset);
    if (DBG) opts.gpu.device.queue.onSubmittedWorkDone().then(() => dbgTick("set", performance.now() - t0, 1));
    opts.onFrame?.();
  };
  const loop = mountAdaptiveLoop({
    renderMoving,
    renderSettled,
    count: () => opts.scene()?.accumCount() ?? 1e9,
    target: opts.target ?? 24,
    idleGapMs: opts.idleGapMs,
    sync: () => opts.gpu.device.queue.onSubmittedWorkDone()
    // GPU-paced: no backlog, input preempts
  });
  let kickN = 0, kickLast = 0;
  const draw = () => {
    if (DBG) {
      kickN++;
      const now = performance.now();
      if (now - kickLast > 500) {
        console.log(`[perf] kicks=${kickN} in 500ms`);
        kickN = 0;
        kickLast = now;
      }
    }
    loop.kick();
  };
  return { draw, budget, renderSettled, renderMoving, loop };
}

// render/vtk-camera.ts
var sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
var add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
var scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
var cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
var dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var norm = (a) => Math.hypot(a[0], a[1], a[2]);
var normalize = (a) => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
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
  // degrees (vtkCamera default 30)
  parallelProjection = false;
  parallelScale = 1;
  constructor(position = [0, 0, 1], focalPoint = [0, 0, 0], viewUp = [0, 1, 0], viewAngle = 30) {
    this.position = [...position];
    this.focalPoint = [...focalPoint];
    this.viewUp = [...viewUp];
    this.viewAngle = viewAngle;
  }
  /** Slicer's default 3D camera (vtkMRMLCameraNode): (0,500,0) -> origin, +S up, 30 deg. */
  static slicerDefault() {
    return new _VtkCamera([0, 500, 0], [0, 0, 0], [0, 0, 1], 30);
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
    return { right, up, back };
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
    return { x: (ndcx * 0.5 + 0.5) * w, y: (0.5 - ndcy * 0.5) * h, depth };
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
      position: [...this.position],
      focalPoint: [...this.focalPoint],
      viewUp: [...this.viewUp],
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
  // previous position, VTK display coords
  onChange;
  constructor(camera, onChange) {
    this.camera = camera;
    this.onChange = onChange;
  }
  /** Convert browser (cssX, cssY within the view) to VTK display coords (y up). */
  static toDisplay(cssX, cssY, height) {
    return [cssX, height - cssY];
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
    this.prev = [x, y];
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
    const kv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
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
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.style.touchAction = "none";
  const docEl = (canvas.ownerDocument ?? document).documentElement;
  if (docEl) docEl.style.overscrollBehavior = "none";
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  const pointers = /* @__PURE__ */ new Map();
  let pinch = null;
  let triple = null;
  const centroid = () => {
    let mx = 0, my = 0;
    for (const p of pointers.values()) {
      mx += p.x;
      my += p.y;
    }
    const n = pointers.size || 1;
    return { mx: mx / n, my: my / n };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  const on = () => opts.enabled?.() ?? true;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    if (!on()) return;
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      interactor.start(e.button, x, y, canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
      opts.onLog?.("cameraStart", { action: interactor.action, x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
    } else if (pointers.size === 2) {
      interactor.end();
      pinch = pinchState();
    } else if (pointers.size === 3) {
      pinch = null;
      const c = centroid();
      triple = { mx: c.mx, my: c.my };
      opts.onVolumeDragStart?.();
    }
  });
  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (!on()) {
      interactor.end();
      pinch = null;
      return;
    }
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size < 3 && triple) {
      triple = null;
      opts.onVolumeDragEnd?.();
    }
    if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      interactor.start(0, p.x, p.y, canvas.clientHeight, { shift: false, ctrl: false, alt: false });
    } else if (pointers.size === 0) {
      interactor.end();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointermove", (e) => {
    if (!on()) return;
    if (!pointers.has(e.pointerId)) return;
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    if (pointers.size >= 3) {
      const c = centroid();
      if (triple) opts.onVolumeDrag?.(c.mx - triple.mx, c.my - triple.my);
      return;
    }
    if (pointers.size === 2) {
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
    if (!on()) return;
    e.preventDefault();
    interactor.wheel(e.deltaY < 0);
    opts.onLog?.("cameraWheel", { deltaY: e.deltaY, distance: camera.distance });
  }, { passive: false });
  return interactor;
}
function framedCamera(center, radius, distMul = 2.6) {
  return new VtkCamera(
    [center[0], center[1] + radius * distMul, center[2]],
    [...center],
    [0, 0, 1],
    30
  );
}

// render/demos/widget-control.ts
var sub2 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
var dot2 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function camMatrices(cam, w, h) {
  const view = lookAt(cam.position, cam.focalPoint, cam.viewUp);
  const proj = perspectiveZO(cam.viewAngle * Math.PI / 180, w / h, 1, 1e5);
  const vp = multiply(proj, view);
  return { vp, invVp: invert(vp) };
}
function worldToClip(vp, p) {
  return [
    vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12],
    vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13],
    vp[2] * p[0] + vp[6] * p[1] + vp[10] * p[2] + vp[14],
    vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]
  ];
}
function projectToCanvasCss(cam, viewW, viewH, world, rw, rh) {
  const { vp } = camMatrices(cam, viewW, viewH);
  const c = worldToClip(vp, world);
  if (c[3] <= 0) return null;
  return { x: (c[0] / c[3] * 0.5 + 0.5) * rw, y: (1 - (c[1] / c[3] * 0.5 + 0.5)) * rh };
}
function unprojectToCameraPlane(cam, viewW, viewH, cssX, cssY, rw, rh, pivot) {
  const { invVp } = camMatrices(cam, viewW, viewH);
  const ndcx = cssX / rw * 2 - 1, ndcy = 1 - cssY / rh * 2;
  const near = applyMat4(invVp, [ndcx, ndcy, 0]);
  const far = applyMat4(invVp, [ndcx, ndcy, 1]);
  const rd = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const n = [cam.position[0] - cam.focalPoint[0], cam.position[1] - cam.focalPoint[1], cam.position[2] - cam.focalPoint[2]];
  const denom = rd[0] * n[0] + rd[1] * n[1] + rd[2] * n[2];
  if (Math.abs(denom) < 1e-9) return [...pivot];
  const t = ((pivot[0] - near[0]) * n[0] + (pivot[1] - near[1]) * n[1] + (pivot[2] - near[2]) * n[2]) / denom;
  return [near[0] + rd[0] * t, near[1] + rd[1] * t, near[2] + rd[2] * t];
}
function attachWidgetControls(canvas, camera, opts) {
  const cursorCss = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, rw: r.width, rh: r.height };
  };
  const project = (vp, world, rw, rh) => {
    const c = worldToClip(vp, world);
    if (c[3] <= 0) return null;
    const ndcx = c[0] / c[3], ndcy = c[1] / c[3];
    return { x: (ndcx * 0.5 + 0.5) * rw, y: (1 - (ndcy * 0.5 + 0.5)) * rh };
  };
  const unprojectToPlane = (invVp, px, py, rw, rh, planePt) => {
    const ndcx = px / rw * 2 - 1, ndcy = 1 - py / rh * 2;
    const near = applyMat4(invVp, [ndcx, ndcy, 0]);
    const far = applyMat4(invVp, [ndcx, ndcy, 1]);
    const ro = near, rd = sub2(far, near);
    const n = sub2(camera.position, camera.focalPoint);
    const denom = dot2(rd, n);
    if (Math.abs(denom) < 1e-9) return [...planePt];
    const t = dot2(sub2(planePt, ro), n) / denom;
    return [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
  };
  const pick = (e) => {
    const { x, y, rw, rh } = cursorCss(e);
    const { w, h } = opts.getSize();
    const { vp } = camMatrices(camera, w, h);
    const touch = e.pointerType === "touch";
    let best = null, bestD = Infinity;
    for (const hnd of opts.getHandles()) {
      const s = project(vp, hnd.world, rw, rh);
      if (!s) continue;
      const r = (hnd.pickPx ?? 16) * (touch ? 2.75 : 1);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < r && d < bestD) {
        bestD = d;
        best = hnd;
      }
    }
    return best;
  };
  let grabbed = null, hovered = null, grabbedId = -1;
  const release = (pointerId) => {
    if (!grabbed) return;
    const g = grabbed;
    grabbed = null;
    grabbedId = -1;
    try {
      canvas.releasePointerCapture(pointerId);
    } catch {
    }
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    canvas.style.cursor = "";
    opts.onDragEnd?.(g);
  };
  const onDown = (e) => {
    if (e.button !== 0) return;
    if (grabbed) {
      release(e.pointerId);
      return;
    }
    if (e.isPrimary === false) return;
    const h = pick(e);
    if (!h) return;
    e.stopPropagation();
    e.preventDefault();
    grabbed = h;
    grabbedId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = h.cursor ? h.cursor : "grabbing";
    opts.onDragStart?.(h);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  };
  const onMove = (e) => {
    if (!grabbed || e.pointerId !== grabbedId) return;
    e.stopPropagation();
    const { x, y, rw, rh } = cursorCss(e);
    const { w, h } = opts.getSize();
    const { invVp } = camMatrices(camera, w, h);
    const world = unprojectToPlane(invVp, x, y, rw, rh, grabbed.world);
    opts.onDrag(grabbed, world);
    opts.onChange?.();
  };
  const onUp = (e) => {
    if (!grabbed || e.pointerId !== grabbedId) return;
    e.stopPropagation();
    release(e.pointerId);
  };
  const onCancel = (e) => {
    if (grabbed && e.pointerId === grabbedId) release(e.pointerId);
  };
  const onHoverMove = (e) => {
    if (grabbed) return;
    const h = pick(e);
    if (h !== hovered) {
      hovered = h;
      canvas.style.cursor = h ? h.cursor ?? "grab" : "";
      opts.onHover?.(h);
      opts.onChange?.();
    }
  };
  canvas.addEventListener("pointerdown", onDown, true);
  canvas.addEventListener("pointermove", onHoverMove);
  return {
    detach() {
      canvas.removeEventListener("pointerdown", onDown, true);
      canvas.removeEventListener("pointermove", onHoverMove);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    }
  };
}

// render/transform-gizmo-field.ts
var TransformGizmoField = class {
  kind = "giz";
  bindingCount = 0;
  clippable = false;
  ghost = true;
  providesSkip = true;
  pivot;
  px;
  // on-screen gizmo size, in pixels (radius of the rings ~ this)
  active = -1;
  // highlighted component (0..6) or -1
  constructor(pivot, pxSize = 60) {
    this.pivot = [...pivot];
    this.px = pxSize;
  }
  setPivot(p) {
    this.pivot = [...p];
  }
  setActive(id) {
    this.active = id ?? -1;
  }
  get pxSize() {
    return this.px;
  }
  get activeId() {
    return this.active;
  }
  uniformFloats() {
    return 8;
  }
  // pivot(4: xyz, pxSize) + params(4: active, _, _, _)
  sampleStep() {
    return 1;
  }
  aabb() {
    const m = 300;
    return [[this.pivot[0] - m, this.pivot[1] - m, this.pivot[2] - m], [this.pivot[0] + m, this.pivot[1] + m, this.pivot[2] + m]];
  }
  structMembers(s) {
    return [`  giz${s}_pivot : vec4<f32>,`, `  giz${s}_params : vec4<f32>,`].join("\n");
  }
  declareBindings() {
    return "";
  }
  bindEntries() {
    return [];
  }
  samplingWGSL(s) {
    return (
      /* wgsl */
      `
fn giz${s}_axis(i : i32) -> vec3<f32> {
  if (i == 0) { return vec3<f32>(1.0, 0.0, 0.0); }
  if (i == 1) { return vec3<f32>(0.0, 1.0, 0.0); }
  return vec3<f32>(0.0, 0.0, 1.0);
}
fn giz${s}_color(a : i32, on : bool) -> vec3<f32> {
  if (a == 0) { return select(vec3<f32>(0.85, 0.40, 0.40), vec3<f32>(0.98, 0.16, 0.16), on); }
  if (a == 1) { return select(vec3<f32>(0.40, 0.80, 0.40), vec3<f32>(0.10, 0.85, 0.10), on); }
  return select(vec3<f32>(0.45, 0.50, 0.95), vec3<f32>(0.20, 0.35, 1.00), on);
}
fn giz${s}_arrow(p : vec3<f32>, a : i32) -> f32 {
  let e = giz${s}_axis(a);
  let al = dot(p, e);
  let rad = length(p - al * e);
  let shaft = max(rad - 0.035, max(0.12 - al, al - 0.66));            // capped cylinder
  let hr = 0.11 * clamp((1.0 - al) / 0.34, 0.0, 1.0);                 // cone taper to the tip
  let head = max(rad - hr, max(0.66 - al, al - 1.0));
  return min(shaft, head);
}
fn giz${s}_ring(p : vec3<f32>, a : i32) -> f32 {
  let e = giz${s}_axis(a);
  let al = dot(p, e);
  let rad = length(p - al * e);
  return length(vec2<f32>(rad - 0.92, al)) - 0.045;                   // torus in the plane \u22A5 axis
}
fn sample_field_giz${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let pivot = u_material.giz${s}_pivot.xyz;
  let pxSize = u_material.giz${s}_pivot.w;
  let activeId = i32(u_material.giz${s}_params.x);
  // screen-constant size: world size for pxSize pixels at the pivot's depth
  let S = pxSize * length(u_cam.eye.xyz - pivot) / max(u_cam.size.z, 1.0);
  if (S <= 0.0) { return vec4<f32>(0.0); }
  let p = (wp - pivot) / S;                        // gizmo-local (unit = ring radius-ish)
  let vn = normalize(u_cam.eye.xyz - pivot);       // view vector for the degenerate-axis fade
  let stepg = max(u_material.scene.x / S, 1e-4);    // AA band, in gizmo units
  var best_op = 0.0;
  var best_col = vec3<f32>(0.0);
  // 3 translation arrows \u2014 fade as the axis points at the camera
  for (var a = 0; a < 3; a = a + 1) {
    let dp = abs(dot(vn, giz${s}_axis(a)));
    let fade = 1.0 - smoothstep(0.80, 0.97, dp);
    let on = activeId == a;
    let op = clamp(0.5 - giz${s}_arrow(p, a) / stepg, 0.0, 1.0) * select(0.5 * fade, 1.0, on);
    if (op > best_op) { best_op = op; best_col = giz${s}_color(a, on); }
  }
  // 3 rotation rings \u2014 fade as the axis approaches edge-on
  for (var a = 0; a < 3; a = a + 1) {
    let dp = abs(dot(vn, giz${s}_axis(a)));
    let fade = smoothstep(0.06, 0.22, dp);
    let on = activeId == a + 3;
    let op = clamp(0.5 - giz${s}_ring(p, a) / stepg, 0.0, 1.0) * select(0.5 * fade, 1.0, on);
    if (op > best_op) { best_op = op; best_col = giz${s}_color(a, on); }
  }
  // centre sphere \u2014 view-plane translate
  {
    let on = activeId == 6;
    let op = clamp(0.5 - (length(p) - 0.08) / stepg, 0.0, 1.0) * select(0.5, 1.0, on);
    if (op > best_op) { best_op = op; best_col = select(vec3<f32>(0.85), vec3<f32>(1.0), on); }
  }
  if (best_op <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>(srgb2physical(best_col) * best_op, best_op);
}`
    );
  }
  skipWGSL(s) {
    return (
      /* wgsl */
      `
fn skip_giz${s}(wp : vec3<f32>) -> f32 {
  let pivot = u_material.giz${s}_pivot.xyz;
  let S = u_material.giz${s}_pivot.w * length(u_cam.eye.xyz - pivot) / max(u_cam.size.z, 1.0);
  if (S <= 0.0) { return 1.0e6; }
  let p = (wp - pivot) / S;
  var d = length(p) - 0.08;
  for (var a = 0; a < 3; a = a + 1) { d = min(d, giz${s}_arrow(p, a)); d = min(d, giz${s}_ring(p, a)); }
  return max(d * S, 0.0);
}`
    );
  }
  fillUniforms(out, off) {
    out[off + 0] = this.pivot[0];
    out[off + 1] = this.pivot[1];
    out[off + 2] = this.pivot[2];
    out[off + 3] = this.px;
    out[off + 4] = this.active;
  }
};

// render/demos/xform-widget.ts
var E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
var sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
var dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var cross2 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
var scale2 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
var norm2 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
var reject = (v, axis) => sub3(v, scale2(axis, dot3(v, axis)));
function componentOf(m) {
  if (m.kind === "translate-cam") return 6;
  if (m.kind === "translate-axis") return m.axis;
  return m.axis + 3;
}
function makeXformWidget(target, _sizeMm, initial) {
  const C0 = target.worldCenter();
  const field = new TransformGizmoField(C0, 88);
  let M = initial ? initial.slice() : identity();
  let M0 = identity();
  let pivot0 = [...C0];
  const pivot = () => applyMat4(M, C0);
  if (initial) field.setPivot(pivot());
  return {
    field,
    pivotWorld: () => pivot(),
    scaleFor(eye, focalPx) {
      const p = pivot();
      return field.pxSize * Math.hypot(eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]) / Math.max(focalPx, 1);
    },
    handleList(S) {
      const p = pivot();
      const at = (off) => [p[0] + off[0] * S, p[1] + off[1] * S, p[2] + off[2] * S];
      const hs = [];
      let id = 0;
      hs.push({ id: id++, world: p, data: { kind: "translate-cam" }, cursor: "move" });
      for (let a = 0; a < 3; a++) hs.push({ id: id++, world: at(scale2(E[a], 0.5)), data: { kind: "translate-axis", axis: a }, cursor: "move" });
      const k = 0.92 / Math.SQRT2;
      for (let a = 0; a < 3; a++) {
        const p1 = E[(a + 1) % 3], p2 = E[(a + 2) % 3];
        for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const off = [(p1[0] * s1 + p2[0] * s2) * k, (p1[1] * s1 + p2[1] * s2) * k, (p1[2] * s1 + p2[2] * s2) * k];
          hs.push({ id: id++, world: at(off), data: { kind: "rotate", axis: a }, cursor: "grab" });
        }
      }
      return hs;
    },
    beginDrag() {
      M0 = M.slice();
      pivot0 = pivot();
    },
    drag(meta, P0, W) {
      if (meta.kind === "translate-cam") {
        M = multiply(translation(sub3(W, P0)), M0);
      } else if (meta.kind === "translate-axis") {
        M = multiply(translation(scale2(E[meta.axis], dot3(sub3(W, P0), E[meta.axis]))), M0);
      } else {
        const a = E[meta.axis];
        const v0 = norm2(reject(sub3(P0, pivot0), a));
        const v1 = norm2(reject(sub3(W, pivot0), a));
        const ang = Math.atan2(dot3(a, cross2(v0, v1)), dot3(v0, v1));
        const Rp = multiply(translation(pivot0), multiply(rotationAboutAxis(a, ang), translation(scale2(pivot0, -1))));
        M = multiply(Rp, M0);
      }
      target.setWorldTransform(M);
      field.setPivot(pivot());
    },
    setActive(id) {
      field.setActive(id);
    },
    matrix: () => M.slice()
  };
}

// render/demos/selftest-scenes.ts
var SCENES = {
  CTACardio: "https://pieper.github.io/live/scenes/CTACardio.json",
  Panoramix: "https://pieper.github.io/live/scenes/CTAAbdomenPanoramix.json",
  MRHead: "https://pieper.github.io/live/legacy/scenes/MRHead.json"
};
var PANO_OFFSET_R = 200;
async function buildMultiVolume(dev, onBytes) {
  const cta = await loadSceneVolumeField(dev, SCENES.CTACardio, onBytes);
  const pano = await loadSceneVolumeField(dev, SCENES.Panoramix, onBytes, {
    // the selftest's initial +200mm R translation, folded into the volume's geometry
    extraTranslationRAS: [PANO_OFFSET_R, 0, 0]
  });
  return { cta, pano, fields: [cta.field, pano.field] };
}

// render/codec.ts
var AV1_GRID = 64;

// render/av1-presenter.ts
var codedSize = (w, h) => [
  Math.ceil(w / AV1_GRID) * AV1_GRID,
  Math.ceil(h / AV1_GRID) * AV1_GRID
];
var WGSL2 = (
  /* wgsl */
  `
@group(0) @binding(0) var t : texture_external;
@group(0) @binding(1) var s : sampler;
// rect = (x,y,w,h) DEST pixels; crop = (u1,v1) source sub-rect max (top-left corner is 0,0).
struct U { rect : vec4<f32>, crop : vec4<f32> };
@group(0) @binding(2) var<uniform> u : U;
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  // a full-viewport triangle; the scissor rect limits rasterisation to the patch.
  let x = select(-1.0, 3.0, i == 1u);
  let y = select(-1.0, 3.0, i == 2u);
  return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p : vec4<f32>) -> @location(0) vec4<f32> {
  // Map THIS fragment's position within the DEST RECT (not the viewport) to the source content.
  // Using the viewport-global position instead is what enlarged and misplaced motion patches.
  let local = (p.xy - u.rect.xy) / u.rect.zw;   // 0..1 across the patch rect
  let src = local * u.crop.xy;                  // scale into the cropped source region
  return vec4<f32>(textureSampleBaseClampToEdge(t, s, src).rgb, 1.0);
}`
);
var Av1Presenter = class {
  #gpu;
  #pipeline;
  #sampler;
  #uni;
  #decoder = null;
  #cw = 0;
  #ch = 0;
  #pending = null;
  #fail = null;
  constructor(gpu, format) {
    this.#gpu = gpu;
    const mod = gpu.device.createShaderModule({ code: WGSL2 });
    this.#pipeline = gpu.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
    this.#sampler = gpu.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.#uni = gpu.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  static get supported() {
    return typeof VideoDecoder !== "undefined";
  }
  /** Real capability probe: WebCodecs present AND this exact AV1 profile is decodable (many old
   *  browsers/phones have no VideoDecoder, or no AV1). Async — call once at startup. */
  static async canDecode() {
    if (typeof VideoDecoder === "undefined") return false;
    try {
      const s = await VideoDecoder.isConfigSupported({ codec: "av01.0.04M.08", codedWidth: 1280, codedHeight: 768 });
      return !!s.supported;
    } catch {
      return false;
    }
  }
  /** Decode one AV1 intra frame (single self-contained key chunk) to a VideoFrame. Keeps a
   *  persistent decoder, reconfiguring only when the coded size changes. */
  async decode(av1, sw, sh) {
    const [cw, ch] = codedSize(sw, sh);
    if (!this.#decoder || this.#cw !== cw || this.#ch !== ch) {
      if (this.#decoder) {
        try {
          this.#decoder.close();
        } catch {
        }
      }
      this.#cw = cw;
      this.#ch = ch;
      this.#decoder = new VideoDecoder({
        output: (f) => {
          const cb = this.#pending;
          this.#pending = null;
          this.#fail = null;
          cb?.(f);
        },
        error: (e) => {
          const cb = this.#fail;
          this.#pending = null;
          this.#fail = null;
          cb?.(new Error(e.message));
        }
      });
      this.#decoder.configure({ codec: "av01.0.04M.08", codedWidth: cw, codedHeight: ch, optimizeForLatency: true });
    }
    const dec = this.#decoder;
    const frame = new Promise((res, rej) => {
      this.#pending = res;
      this.#fail = rej;
    });
    dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: av1 }));
    await dec.flush().catch(() => {
    });
    return frame;
  }
  /** Draw a decoded frame (whose real content is sw×sh in its top-left) into `dst` at the view
   *  rect (x,y,w,h). Everything already in `dst` outside the rect is preserved (scissor + load). */
  present(dst, frame, sw, sh, rect, format) {
    const [cw, ch] = codedSize(sw, sh);
    this.#gpu.device.queue.writeBuffer(this.#uni, 0, new Float32Array([
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      // dest rect (framebuffer px)
      sw / cw,
      sh / ch,
      0,
      0
      // source crop (drop the coded-size padding)
    ]));
    const ext = this.#gpu.device.importExternalTexture({ source: frame });
    const bind = this.#gpu.device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: ext },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#uni } }
      ]
    });
    const enc = this.#gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(this.#pipeline);
    pass.setScissorRect(rect.x, rect.y, rect.w, rect.h);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.#gpu.device.queue.submit([enc.finish()]);
    void format;
  }
};

// render/demos/remote-browser.ts
var SINGLE_SCENE = "https://pieper.github.io/live/scenes/CTACardio.json";
var PROTO = 4;
var status = (msg, err = false) => {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = msg;
    el.style.color = err ? "#ff6b74" : "#9fb3d0";
  }
};
async function main() {
  const canvas = document.getElementById("gpu");
  const params = new URLSearchParams(location.search);
  const serverUrl = params.has("local") ? "" : params.get("server") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
  const modeBtn = document.getElementById("mode");
  if (!navigator.gpu) {
    status("WebGPU not available \u2014 try Chrome/Edge 113+ or Safari 18+.", true);
    return;
  }
  const gpu = await initDevice();
  const ctx = canvas.getContext("webgpu");
  const preferred = navigator.gpu.getPreferredCanvasFormat();
  const srgb = preferred + "-srgb";
  ctx.configure({
    device: gpu.device,
    format: preferred,
    viewFormats: [srgb],
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
  });
  const recon = new Reconstructor(gpu, srgb);
  recon.setBackground(0.05, 0.06, 0.09);
  const av1CanDecode = await Av1Presenter.canDecode();
  const av1 = av1CanDecode ? new Av1Presenter(gpu, srgb) : null;
  let viewTex = null, viewW = 0, viewH = 0, surfaceValid = false;
  const makeViewTex = (w, h) => {
    const t = gpu.device.createTexture({
      size: [w, h],
      format: preferred,
      viewFormats: [srgb],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING
    });
    const enc = gpu.device.createCommandEncoder();
    enc.beginRenderPass({
      colorAttachments: [{
        view: t.createView({ format: srgb }),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1 }
      }]
    }).end();
    gpu.device.queue.submit([enc.finish()]);
    return t;
  };
  const ensureViewTex = () => {
    if (!viewTex || viewW !== canvas.width || viewH !== canvas.height) {
      viewTex?.destroy();
      viewW = canvas.width;
      viewH = canvas.height;
      surfaceValid = false;
      viewTex = makeViewTex(viewW, viewH);
    }
    return viewTex;
  };
  const blitToCanvas = () => {
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: viewTex }, { texture: ctx.getCurrentTexture() }, [viewW, viewH]);
    gpu.device.queue.submit([enc.finish()]);
  };
  const stretchWGSL = (
    /* wgsl */
    `
@group(0) @binding(0) var t : texture_2d<f32>;
@group(0) @binding(1) var s : sampler;
struct V { @builtin(position) p : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> V {
  let x = select(-1.0, 3.0, i == 1u); let y = select(-1.0, 3.0, i == 2u);
  var o : V; o.p = vec4<f32>(x, y, 0.0, 1.0); o.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5); return o;
}
@fragment fn fs(v : V) -> @location(0) vec4<f32> { return textureSample(t, s, v.uv); }`
  );
  const stretchMod = gpu.device.createShaderModule({ code: stretchWGSL });
  const stretchPipe = gpu.device.createRenderPipeline({
    layout: "auto",
    vertex: { module: stretchMod, entryPoint: "vs" },
    fragment: { module: stretchMod, entryPoint: "fs", targets: [{ format: srgb }] },
    primitive: { topology: "triangle-list" }
  });
  const stretchSampler = gpu.device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const stretchInto = (dst, src) => {
    const bind = gpu.device.createBindGroup({
      layout: stretchPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: src.createView() }, { binding: 1, resource: stretchSampler }]
    });
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView({ format: srgb }), loadOp: "clear", storeOp: "store", clearValue: { r: 0.05, g: 0.06, b: 0.09, a: 1 } }] });
    pass.setPipeline(stretchPipe);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    gpu.device.queue.submit([enc.finish()]);
  };
  const MAX_DIM = 3840;
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cw = Math.floor(canvas.clientWidth * dpr), ch = Math.floor(canvas.clientHeight * dpr);
    if (cw <= 0 || ch <= 0) return false;
    const k = Math.min(1, MAX_DIM / Math.max(cw, ch));
    const w = Math.max(16, Math.round(cw * k)), h = Math.max(16, Math.round(ch * k));
    if (w === canvas.width && h === canvas.height) return false;
    const old = viewTex;
    viewTex = null;
    canvas.width = w;
    canvas.height = h;
    ensureViewTex();
    if (old) {
      stretchInto(viewTex, old);
      old.destroy();
    }
    blitToCanvas();
    return true;
  };
  new ResizeObserver(() => {
    if (resize()) {
      requestResync();
      onCam();
    }
  }).observe(canvas);
  globalThis.addEventListener("resize", () => {
    if (resize()) {
      requestResync();
      onCam();
    }
  });
  resize();
  let camera = null;
  let sceneName = "scene", sceneUrl = "", demo = params.get("demo") ?? "multi";
  let mode = "remote";
  let frames = 0, bytes = 0, frameBytes = 0, lastCamSentAt = 0;
  let camDirty = true;
  let pdown = false;
  const rtt = [];
  const parts = [];
  let resyncSent = false;
  let dbgDropped = 0, dbgResyncs = 0, dbgApplied = 0;
  let lastErr = "";
  const requestResync = () => {
    dbgDropped++;
    if (resyncSent || ws?.readyState !== WebSocket.OPEN) return;
    resyncSent = true;
    dbgResyncs++;
    ws.send('{"type":"resync"}');
  };
  let lastFrame = null;
  let dbgStarts = 0, dbgDrags = 0;
  let dbgPresentMs = 0, dbgGunzipMs = 0, dbgQueued = 0;
  const concat = (bs) => {
    const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bs) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  };
  let widget = null;
  let widgetSeed = null;
  const toMat4 = (v) => {
    const a = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
    return a.length === 16 ? new Float32Array(a) : identity();
  };
  let localPano = null;
  let xformDirty = false;
  let localScene = null;
  let a3d = null;
  let loadingLocal = false;
  const ensureLocal = async () => {
    if (a3d) return true;
    if (loadingLocal) return false;
    loadingLocal = true;
    status(`loading ${sceneName} locally\u2026`);
    let mb = 0;
    const prog = (n) => {
      mb += n;
      status(`loading ${sceneName} locally\u2026 ${(mb / 1e6).toFixed(0)} MB`);
    };
    localScene = new SceneRenderer(gpu, srgb);
    if (demo === "multi") {
      const sc = await buildMultiVolume(gpu.device, prog);
      localPano = sc.pano.field;
      const c0 = sc.pano.field.worldCenter();
      if (!widget) createWidget({ center: c0, m: [...identity()] });
      localPano.setWorldTransform(widget.matrix());
      localScene.build([...sc.fields, widget.field]);
      bootstrap({
        name: `${sc.cta.name} + ${sc.pano.name}`,
        sceneUrl: "",
        center: [
          (sc.cta.center[0] + sc.pano.center[0]) / 2,
          (sc.cta.center[1] + sc.pano.center[1]) / 2,
          (sc.cta.center[2] + sc.pano.center[2]) / 2
        ],
        radius: Math.max(sc.cta.radius, sc.pano.radius) * 1.35
      });
    } else {
      const sv = await loadSceneVolumeField(gpu.device, sceneUrl || SINGLE_SCENE, prog);
      localScene.build([sv.field]);
      bootstrap({ name: sv.name, sceneUrl: sceneUrl || SINGLE_SCENE, center: sv.center, radius: sv.radius });
    }
    localScene.setBackground(0.05, 0.06, 0.09);
    a3d = mountAdaptive3d({
      scene: () => localScene,
      view: () => ctx.getCurrentTexture().createView({ format: srgb }),
      size: () => ({ w: canvas.width, h: canvas.height }),
      setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
      gpu,
      onFrame: () => statusLine("local")
    });
    loadingLocal = false;
    return true;
  };
  canvas.addEventListener("pointerdown", () => {
    pdown = true;
    camDirty = true;
    scheduleSend();
  }, true);
  globalThis.addEventListener("pointerup", () => {
    pdown = false;
    camDirty = true;
    scheduleSend();
  }, true);
  const ws = serverUrl ? new WebSocket(serverUrl) : null;
  if (ws) ws.binaryType = "arraybuffer";
  let lastSent = -1e12;
  let trailing = 0;
  const sendCam = () => {
    trailing = 0;
    if (!camera || ws?.readyState !== WebSocket.OPEN) return;
    lastSent = lastCamSentAt = performance.now();
    if (camDirty) {
      camDirty = false;
      ws.send(JSON.stringify({ type: "cam", w: canvas.width, h: canvas.height, p: [...camera.position], f: [...camera.focalPoint], u: [...camera.viewUp], a: camera.viewAngle, dn: pdown ? 1 : 0 }));
    }
    if (xformDirty && widget) {
      xformDirty = false;
      const active = widget.field.activeId;
      ws.send(JSON.stringify({ type: "xform", m: [...widget.matrix()], pivot: widget.pivotWorld(), active: active >= 0 ? active : null }));
    }
  };
  const scheduleSend = () => {
    if (!camera || ws?.readyState !== WebSocket.OPEN) return;
    const dt = performance.now() - lastSent;
    if (dt >= 15) sendCam();
    else if (!trailing) trailing = setTimeout(sendCam, 15 - dt);
  };
  const statusLine = (where, extra = "") => status(`${sceneName} \xB7 ${where.toUpperCase()} \xB7 ${canvas.width}\xD7${canvas.height} view \xB7 ${extra}${where === "remote" ? `~${[...rtt].sort((a, b) => a - b)[rtt.length >> 1] | 0} ms round-trip \xB7 ${(bytes / 1e6).toFixed(1)} MB` : "your GPU"}`);
  const requestFrame = () => {
    if (mode === "remote") scheduleSend();
    else a3d?.draw();
  };
  const onCam = () => {
    camDirty = true;
    requestFrame();
  };
  const pushXform = () => {
    if (!widget) return;
    xformDirty = true;
    localPano?.setWorldTransform(widget.matrix());
    localScene?.syncUniforms();
    if (mode === "remote") scheduleSend();
  };
  const createWidget = (seed) => {
    const target = {
      worldCenter: () => seed.center,
      setWorldTransform: () => {
      }
    };
    widget = makeXformWidget(target, 0, toMat4(seed.m));
  };
  let widgetAttached = false;
  const attachWidget = () => {
    if (!widget || !camera || widgetAttached) return;
    widgetAttached = true;
    const focalPx = () => canvas.height / 2 / Math.tan(camera.viewAngle * Math.PI / 360);
    attachWidgetControls(canvas, camera, {
      getHandles: () => widget.handleList(widget.scaleFor(camera.position, focalPx())),
      getSize: () => ({ w: canvas.width, h: canvas.height }),
      onDragStart: (h) => {
        dbgStarts++;
        widget.setActive(componentOf(h.data));
        widget.beginDrag();
        pushXform();
      },
      onDrag: (h, world) => {
        dbgDrags++;
        widget.drag(h.data, h.world, world);
        pushXform();
      },
      onDragEnd: () => {
        widget.setActive(null);
        pushXform();
      },
      onHover: (h) => {
        widget.setActive(h ? componentOf(h.data) : null);
        pushXform();
      },
      onChange: () => requestFrame()
      // NOT onCam: the camera did not move
    });
  };
  const bootstrap = (c) => {
    sceneName = c.name;
    if (c.sceneUrl) sceneUrl = c.sceneUrl;
    if (!camera) {
      camera = framedCamera(c.center, c.radius);
      attachCameraControls(canvas, camera, {
        onChange: onCam,
        // THREE-FINGER = move the picked volume (the touch-friendly alternative to grabbing a fine
        // gizmo handle). Same camera-plane translate the gizmo centre does, driven by the centroid.
        onVolumeDragStart: () => {
          if (widget) {
            widget.beginDrag();
            pushXform();
          }
        },
        onVolumeDrag: (dx, dy) => {
          if (!widget || !camera) return;
          const r = canvas.getBoundingClientRect();
          const pivot = widget.pivotWorld();
          const w0 = unprojectToCameraPlane(camera, canvas.width, canvas.height, r.width / 2, r.height / 2, r.width, r.height, pivot);
          const w1 = unprojectToCameraPlane(camera, canvas.width, canvas.height, r.width / 2 + dx, r.height / 2 + dy, r.width, r.height, pivot);
          widget.drag({ kind: "translate-cam" }, w0, w1);
          pushXform();
        },
        onVolumeDragEnd: () => {
          if (widget) pushXform();
        }
      });
    }
    attachWidget();
  };
  ws?.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "caps", av1: av1CanDecode }));
    status("connected \u2014 waiting for scene\u2026");
  });
  const fallbackLocal = async (why) => {
    if (mode === "local") return;
    status(`${why} \u2014 rendering locally instead`, true);
    if (await ensureLocal()) await setMode("local");
  };
  ws?.addEventListener("close", () => fallbackLocal("render server disconnected"));
  ws?.addEventListener("error", () => fallbackLocal("cannot reach the render server"));
  const gunzip = async (b) => new Uint8Array(await new Response(new Response(b).body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  let applyChain = Promise.resolve();
  ws?.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string" && ws.readyState === WebSocket.OPEN) ws.send('{"type":"cack"}');
    applyChain = applyChain.then(() => applyMessage(ev)).catch((err) => {
      lastErr = String(err?.message ?? err);
      status("frame decode error: " + lastErr + " \u2014 try a hard reload", true);
      requestResync();
    });
  });
  const applyMessage = async (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.type === "hello") {
        if ((m.proto ?? 0) !== PROTO) {
          status(`page/server version mismatch (page ${PROTO}, server ${m.proto}) \u2014 reloading\u2026`, true);
          ws?.close();
          if (!sessionStorage.getItem("lr_reloaded")) {
            sessionStorage.setItem("lr_reloaded", "1");
            location.reload();
          }
          return;
        }
        sessionStorage.removeItem("lr_reloaded");
        demo = m.demo ?? "single";
        widgetSeed = m.widget ?? null;
        if (widgetSeed && !widget) createWidget(widgetSeed);
        bootstrap({ name: m.name ?? "scene", sceneUrl: m.sceneUrl ?? "", center: m.center, radius: m.radius });
        sendCam();
        statusLine("remote", widget ? "drag a gizmo handle to move Panoramix \xB7 " : "drag to orbit \xB7 ");
      }
      return;
    }
    if (mode !== "remote") return;
    const buf = e.data;
    const head = new Uint16Array(buf, 0, 16);
    const sw = head[0], sh = head[1], settled = head[4], codec = head[5];
    const chunk = head[6], chunks = head[7];
    const kind = head[8], px = head[9], py = head[10], pw = head[11], ph = head[12];
    const srvSinceInput = head[13], srvRenderMs = head[14];
    frameBytes += buf.byteLength;
    let payload;
    if (chunks > 1) {
      if (chunk === 0) parts.length = 0;
      parts.push(new Uint8Array(buf, 32));
      if (chunk < chunks - 1) return;
      payload = concat(parts);
    } else {
      payload = new Uint8Array(buf, 32);
    }
    if (codec === 1) payload = await gunzip(payload);
    const vw = head[2], vh = head[3];
    if (vw !== canvas.width || vh !== canvas.height) {
      requestResync();
      return;
    }
    if (kind === 1 && (!surfaceValid || px + pw > viewW || py + ph > viewH)) {
      requestResync();
      return;
    }
    const tp = performance.now();
    const dst = ensureViewTex().createView({ format: srgb });
    const rect = kind === 1 ? { x: px, y: py, w: pw, h: ph } : { x: 0, y: 0, w: viewW, h: viewH };
    if (codec === 2 && av1) {
      let frame;
      try {
        frame = await av1.decode(payload, sw, sh);
      } catch (err) {
        lastErr = "av1 decode: " + err.message;
        requestResync();
        return;
      }
      av1.present(dst, frame, sw, sh, rect, srgb);
      frame.close();
    } else {
      recon.present(dst, payload, sw, sh, viewW, viewH, kind === 1 ? rect : void 0);
    }
    if (kind === 0) {
      surfaceValid = true;
      resyncSent = false;
    }
    blitToCanvas();
    dbgApplied++;
    dbgPresentMs += performance.now() - tp;
    ws.send('{"type":"ack"}');
    frames++;
    bytes += frameBytes;
    const kB = frameBytes / 1e3;
    frameBytes = 0;
    lastFrame = { kind, sw, sh, pw, ph, kB: Math.round(kB), settled, codec };
    const dt = performance.now() - lastCamSentAt;
    rtt.push(dt);
    if (rtt.length > 30) rtt.shift();
    statusLine("remote", `${kind === 1 ? `patch ${sw}\xD7${sh}\u2192${pw}\xD7${ph}` : settled ? "samples native" : `samples ${sw}\xD7${sh}`} \xB7 ${kB.toFixed(0)} kB ${["raw", "gz", "av1"][codec] ?? codec} \xB7 srv ${srvSinceInput}ms (render ${srvRenderMs}) \xB7 `);
  };
  const setMode = async (m) => {
    if (m === "local") {
      if (!await ensureLocal()) {
        status("cannot load local scene", true);
        return;
      }
    }
    if (m === "remote" && ws?.readyState !== WebSocket.OPEN) {
      status("no render server connected \u2014 staying local", true);
      return;
    }
    mode = m;
    if (modeBtn) {
      modeBtn.textContent = m === "remote" ? "Rendering on the REMOTE GPU \u2014 click to render locally" : "Rendering on YOUR GPU \u2014 click to render remotely";
    }
    if (m === "remote") sendCam();
    else a3d?.draw();
  };
  modeBtn?.addEventListener("click", () => setMode(mode === "remote" ? "local" : "remote"));
  if (!ws) {
    status("no render server \u2014 rendering locally");
    if (await ensureLocal()) await setMode("local");
  }
  globalThis.__remoteDbg = {
    frames: () => frames,
    connected: () => ws?.readyState === WebSocket.OPEN,
    hasCam: () => !!camera,
    mode: () => mode,
    setMode: (m) => setMode(m),
    // Gizmo handles in CSS px, so a harness can aim a synthetic pointer at one (the remote twin of
    // selftest-browser's __xformDbg).
    handles: () => {
      if (!widget || !camera) return [];
      const r = canvas.getBoundingClientRect();
      const focalPx = canvas.height / 2 / Math.tan(camera.viewAngle * Math.PI / 360);
      return widget.handleList(widget.scaleFor(camera.position, focalPx)).map((h) => {
        const m = h.data;
        const s = projectToCanvasCss(camera, canvas.width, canvas.height, h.world, r.width, r.height);
        return { id: h.id, kind: m.kind, axis: m.axis, x: s?.x ?? null, y: s?.y ?? null };
      });
    },
    matrix: () => widget ? [...widget.matrix()] : null,
    cam: () => camera ? { p: [...camera.position], f: [...camera.focalPoint], u: [...camera.viewUp], d: camera.distance } : null,
    diag: () => ({
      proto: PROTO,
      dpr: globalThis.devicePixelRatio,
      css: [canvas.clientWidth, canvas.clientHeight],
      buf: [canvas.width, canvas.height],
      tex: [viewW, viewH],
      surfaceValid,
      applied: dbgApplied,
      dropped: dbgDropped,
      resyncs: dbgResyncs,
      lastErr
    }),
    last: () => lastFrame,
    drags: () => ({ starts: dbgStarts, drags: dbgDrags }),
    timing: () => {
      const r = { frames, presentMs: Math.round(dbgPresentMs), gunzipMs: Math.round(dbgGunzipMs), queued: dbgQueued };
      dbgPresentMs = 0;
      dbgGunzipMs = 0;
      return r;
    }
  };
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
