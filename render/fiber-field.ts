// FiberField — tractography streamlines (e.g. SlicerDMRI fiber bundles) rendered as chains of
// CAPSULES — one round-capped cylinder per polyline segment, i.e. piecewise-linear tubes — inside
// the ray-march, so the tubes composite depth-correctly with volumes, segments and markups in the
// same pass. The SlicerLive counterpart of SlicerWGPU's FiberStrandField
// (SceneRenderingLib/wgpu_vtk_inject.py add_fiber_strands).
//
// SlicerWGPU rasterizes each strand piece and appends (depth, rgba) into a per-pixel A-buffer (K=64)
// that its ray-march interleaves. That costs K fragments of memory PER PIXEL, plus a raster pass that
// every SceneRenderer target (low-res moving trace, jittered accumulation, 1x1 pick, remote
// traceSamples tiles) would have to repeat. Here the geometry lives on the GPU in a uniform grid
// (two storage buffers) instead, so memory scales with the fibers rather than the viewport and every
// render path gets fibers for free.
//
// THIN SURFACES vs A POINT SAMPLE. A 0.2 mm tube is far thinner than the ray-march step, so a point
// sample would step straight over it. The field uses INTERVAL sampling (Field.intervalSampling): each
// call reports the tube-surface crossings on the ray interval (wp - seg*rd, wp] since its previous
// sample, by exact ray-capsule intersection against the segments binned in the grid cells that
// interval passes through. Consecutive intervals partition the ray, so each tube is counted once
// whatever the step or jitter — the step only sets how finely tube crossings interleave with the
// volume samples around them.
//
// JOINTS. Adjacent capsules of a strand overlap at their shared end sphere, so a ray there crosses two
// capsule surfaces — a bead on every joint of a translucent bundle. A crossing is kept only if it is
// on the surface of the strand's capsule UNION: not strictly inside the previous or next capsule, and
// a hit on a segment's END cap is left to the next segment's START cap. (SlicerWGPU solves the same
// problem with strict t-ownership of its Bezier pieces.)

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

const PAL = 256;              // palette entries at the head of the float buffer, indexed by bundle id
const MAX_HITS = 4;           // crossings composited per interval (nearest kept)
const MAX_CELLS = 16;         // grid cells walked per interval (an interval spans <= LOOKBACK steps)
const LOOKBACK = 2.5;         // max interval, in ray steps — see skipWGSL for why this is enough
const MAX_GRID_CELLS = 1 << 23;

export type RGBA = [number, number, number, number];

/** One streamline: flat xyz triples (RAS mm) and a bundle id in [1, 255] selecting its palette colour.
 *  `flow` opts this streamline into the schematic direction band (see setMotion) and requires the
 *  points to already run upstream→downstream; streamlines without a defensible anatomical direction
 *  leave it unset and are never animated. */
export interface Strand { points: ArrayLike<number>; bundle?: number; flow?: boolean }

export interface FiberFieldOpts {
  /** Tube radius (mm). Default 0.2, as SlicerWGPU's add_fiber_strands. */
  radius?: number;
  /** Per-bundle sRGB colour + opacity in [0,1], keyed by bundle id (1..255). */
  bundleColors?: Record<number, RGBA>;
  /** Phong [ka, kd, ks, shininess]; default SlicerWGPU's strand shading 0.20/0.65/0.20/96. */
  shade?: [number, number, number, number];
  /** Grid cell edge (mm). Default: the longest extent / 96, and at least 4 tube radii. */
  cellMm?: number;
  /** OBJECT-SPACE ambient occlusion strength, 0 = off (default). Dense tracts read as a flat coloured
   *  mass under a headlight alone; occlusion is what separates bundles and gives depth. This samples
   *  the capsule grid's own per-cell counts as a line-density field (Kanzler et al. 2019; Groß &
   *  Gumhold 2021; Kraaijeveld et al., who cone-trace capsules for white-matter tractography), so it
   *  needs no depth or normal buffer and cannot miss an occluder that is off-screen or behind the
   *  first depth layer — the failure mode that makes screen-space AO unusable on sub-pixel tubes. */
  aoStrength?: number;
  /** Radius of influence (mm) for that occlusion — the scale at which bundles separate (default 3). */
  aoRadiusMm?: number;
  /** Cell-count-to-opacity scale for the density field (default 0.08, i.e. ~12 capsules in a cell
   *  reads as fully occluding). */
  aoDensityScale?: number;
  /** Sample pattern, baked into the WGSL: directions over the hemisphere x steps along each. */
  aoDirections?: number;
  aoSteps?: number;
  /** Band wavelength (mm) for the schematic flow animation — default 30, about three bands on a
   *  100 mm tract, and coarse enough that the pattern cannot alias into travelling backwards. */
  motionWavelengthMm?: number;
  /** Band speed (mm/s); default 35, so a band passes a point at ~1.2 Hz. */
  motionSpeedMmPerS?: number;
  /** DEPTH-DEPENDENT HALOS (Everts et al., IEEE Vis 2009 — the strongest illustrative result for
   *  dense line data). 0 = off. A ray that misses a tube but passes within `haloWidthMm` of it emits
   *  black at that tube's depth, so front-to-back compositing lets the halo occlude what lies behind
   *  it while leaving the tube itself untouched. Tight bundles then fuse into readable surfaces and
   *  unrelated strands separate out. The paper's own limitation — needing per-segment sorting to
   *  combine with transparency — does not apply here, because the march already visits hits in depth
   *  order. */
  haloStrength?: number;
  /** Halo band width beyond the tube radius (mm); default 0.5, about three tube radii. */
  haloWidthMm?: number;
  clippable?: boolean;
}

/** Exact chessboard (L∞) distance, in cells, from every cell to the nearest occupied one (capped at
 *  255): the classic two-pass chamfer, which is exact for unit 26-neighbour weights. */
function chessboardDistance(counts: Uint32Array, nx: number, ny: number, nz: number): Uint8Array {
  const d = new Uint8Array(counts.length);
  for (let c = 0; c < d.length; c++) d[c] = counts[c] ? 0 : 255;
  for (const dir of [1, -1]) {
    for (let zi = 0; zi < nz; zi++) {
      const z = dir > 0 ? zi : nz - 1 - zi;
      for (let yi = 0; yi < ny; yi++) {
        const y = dir > 0 ? yi : ny - 1 - yi;
        for (let xi = 0; xi < nx; xi++) {
          const x = dir > 0 ? xi : nx - 1 - xi;
          const c = x + nx * (y + ny * z);
          let v = d[c];
          if (v === 0) continue;
          // The 13 neighbours this raster order has already visited (mirrored on the backward pass).
          for (let dz = -1; dz <= 0; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dz === 0 && (dy > 0 || (dy === 0 && dx >= 0))) continue;
                const X = x + dir * dx, Y = y + dir * dy, Z = z + dir * dz;
                if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
                const w = d[X + nx * (Y + ny * Z)] + 1;
                if (w < v) v = w;
              }
            }
          }
          d[c] = v;
        }
      }
    }
  }
  return d;
}

export class FiberField implements Field {
  readonly kind = "fib";
  readonly bindingCount = 2;           // segment/palette floats + grid u32s (storage buffers)
  readonly usesSampler = false;
  readonly intervalSampling = true;
  readonly providesSkip = true;
  readonly clippable: boolean;
  readonly segmentCount: number;
  readonly strandCount: number;
  readonly indexCount: number;
  readonly gridDims: Vec3;
  readonly cellMm: number;
  private dev: GPUDevice;
  private fBuf: GPUBuffer;             // [palette rgba x256][segment A (xyz, flags), B (xyz, bundle)]...
  private uBuf: GPUBuffer;             // [cell (offset, count | chessboard<<24)]...[segment indices]
  private palette = new Float32Array(PAL * 4);
  private lo: Vec3;
  private hi: Vec3;
  private radius: number;
  private shade: [number, number, number, number];
  private opacity = 1;
  private aoStrength: number;
  private aoRadiusMm: number;
  private aoDensityScale: number;
  private readonly aoDirs: number;
  private readonly aoSteps: number;
  private motionAmp = 0;          // 0 = no band at all (the default, and what every other demo gets)
  private motionWavelength: number;
  private motionSpeed: number;
  private motionTime = 0;
  private haloStrength: number;
  private haloWidth: number;

  constructor(dev: GPUDevice, strands: Strand[], opts: FiberFieldOpts = {}) {
    this.dev = dev;
    this.radius = opts.radius ?? 0.2;
    this.shade = opts.shade ?? [0.20, 0.65, 0.20, 96];
    this.aoStrength = Math.max(0, opts.aoStrength ?? 0);
    this.aoRadiusMm = opts.aoRadiusMm ?? 3;
    this.aoDensityScale = opts.aoDensityScale ?? 0.08;
    this.aoDirs = Math.max(1, Math.round(opts.aoDirections ?? 5));
    this.aoSteps = Math.max(1, Math.round(opts.aoSteps ?? 3));
    this.motionWavelength = opts.motionWavelengthMm ?? 30;
    this.motionSpeed = opts.motionSpeedMmPerS ?? 35;
    this.haloStrength = Math.max(0, opts.haloStrength ?? 0);
    this.haloWidth = opts.haloWidthMm ?? 0.5;
    this.clippable = opts.clippable ?? true;
    for (const [id, c] of Object.entries(opts.bundleColors ?? {})) {
      const i = Number(id);
      if (i >= 1 && i < PAL) this.palette.set(c, i * 4);
    }

    // 1) Capsules: one per non-degenerate polyline edge, stored strand-contiguously so a segment's
    //    neighbours are its array neighbours (flags: bit0 = has previous, bit1 = has next).
    let maxSeg = 0;
    for (const s of strands) maxSeg += Math.max(0, Math.floor(s.points.length / 3) - 1);
    const seg = new Float32Array(maxSeg * 8);   // (ax, ay, az, flags, bx, by, bz, bundle)
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    const grow = (x: number, y: number, z: number) => {
      if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
      if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
    };
    let n = 0, used = 0, strandIndex = 0;
    for (const s of strands) {
      const P = s.points, m = Math.floor(P.length / 3);
      strandIndex++;
      if (m < 2) continue;
      const bundle = Math.min(PAL - 1, Math.max(1, Math.round(s.bundle ?? 1)));
      const first = n;
      // Per-streamline PHASE, baked into the stored arclength. Without it every streamline's band
      // would march in lockstep and common fate — the strongest grouping cue there is — would fuse
      // the bundle into one pulsing sheet instead of many independent filaments.
      const animate = s.flow === true;
      let h = Math.imul(strandIndex ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
      h ^= h >>> 13;
      const phase = animate ? (h / 4294967296) * 997 : 0;   // mm, effectively uniform for any band length
      let arc = 0;
      let ax = P[0], ay = P[1], az = P[2];
      for (let i = 1; i < m; i++) {
        const bx = P[i * 3], by = P[i * 3 + 1], bz = P[i * 3 + 2];
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        if (len < 1e-6) continue;   // repeated point
        const o = n * 8;
        seg[o] = ax; seg[o + 1] = ay; seg[o + 2] = az;
        // B.w carries the arclength at A (plus this streamline's phase), or -1 for "never animate".
        seg[o + 4] = bx; seg[o + 5] = by; seg[o + 6] = bz; seg[o + 7] = animate ? arc + phase : -1;
        grow(ax, ay, az); grow(bx, by, bz);
        ax = bx; ay = by; az = bz; arc += len; n++;
      }
      // A.w packs the bundle id with the neighbour flags, freeing B.w for arclength.
      for (let j = first; j < n; j++) seg[j * 8 + 3] = bundle * 4 + ((j > first ? 1 : 0) | (j < n - 1 ? 2 : 0));
      if (n > first) used++;
    }
    if (n === 0) { lo.splice(0, 3, -1, -1, -1); hi.splice(0, 3, 1, 1, 1); }
    this.segmentCount = n;
    this.strandCount = used;

    // 2) Uniform grid over the capsules' bounds.
    const r = this.radius;
    const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 2 * r;
    let cell = opts.cellMm ?? Math.max(ext / 96, 4 * r);
    let margin = 0, glo: Vec3 = [0, 0, 0], dims: Vec3 = [1, 1, 1];
    for (;;) {
      margin = r + 0.01 * cell;
      glo = [lo[0] - margin, lo[1] - margin, lo[2] - margin];
      dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] + margin - glo[a]) / cell))) as Vec3;
      if (dims[0] * dims[1] * dims[2] <= MAX_GRID_CELLS) break;
      cell *= 1.25;
    }
    const [nx, ny, nz] = dims, ncell = nx * ny * nz;
    this.cellMm = cell;
    this.gridDims = dims;
    this.lo = glo;
    this.hi = [glo[0] + nx * cell, glo[1] + ny * cell, glo[2] + nz * cell];

    // Bin each capsule into the cells it can touch: those in its AABB whose centre is within
    // (radius + half a cell diagonal) of the segment. Conservative, and far tighter than the AABB
    // for diagonal segments. The shader relies on a crossing's cell always listing its capsule.
    const reach2 = (margin + cell * Math.sqrt(3) / 2) ** 2;
    const cl = (v: number, hiI: number) => Math.min(hiI, Math.max(0, v));
    const visit = (i: number, fn: (c: number) => void) => {
      const o = i * 8;
      const ax = seg[o], ay = seg[o + 1], az = seg[o + 2], dx = seg[o + 4] - ax, dy = seg[o + 5] - ay, dz = seg[o + 6] - az;
      const dd = dx * dx + dy * dy + dz * dz;
      const x0 = cl(Math.floor((Math.min(ax, ax + dx) - margin - glo[0]) / cell), nx - 1), x1 = cl(Math.floor((Math.max(ax, ax + dx) + margin - glo[0]) / cell), nx - 1);
      const y0 = cl(Math.floor((Math.min(ay, ay + dy) - margin - glo[1]) / cell), ny - 1), y1 = cl(Math.floor((Math.max(ay, ay + dy) + margin - glo[1]) / cell), ny - 1);
      const z0 = cl(Math.floor((Math.min(az, az + dz) - margin - glo[2]) / cell), nz - 1), z1 = cl(Math.floor((Math.max(az, az + dz) + margin - glo[2]) / cell), nz - 1);
      for (let z = z0; z <= z1; z++) {
        const cz = glo[2] + (z + 0.5) * cell - az;
        for (let y = y0; y <= y1; y++) {
          const cy = glo[1] + (y + 0.5) * cell - ay;
          for (let x = x0; x <= x1; x++) {
            const cx = glo[0] + (x + 0.5) * cell - ax;
            const h = Math.min(1, Math.max(0, (cx * dx + cy * dy + cz * dz) / dd));
            const ex = cx - dx * h, ey = cy - dy * h, ez = cz - dz * h;
            if (ex * ex + ey * ey + ez * ez <= reach2) fn(x + nx * (y + ny * z));
          }
        }
      }
    };
    const counts = new Uint32Array(ncell);
    for (let i = 0; i < n; i++) visit(i, (c) => { counts[c]++; });
    let nidx = 0;
    for (let c = 0; c < ncell; c++) nidx += counts[c];
    this.indexCount = nidx;
    const u = new Uint32Array(2 * ncell + Math.max(1, nidx));
    let at = 2 * ncell;
    for (let c = 0; c < ncell; c++) { u[2 * c] = at; at += counts[c]; }
    const fill = new Uint32Array(ncell);
    for (let i = 0; i < n; i++) visit(i, (c) => { u[u[2 * c] + fill[c]++] = i; });
    // Header: count in the low 24 bits, chessboard distance to the nearest occupied cell in the top 8
    // (the empty-space skip bound).
    const cheb = chessboardDistance(counts, nx, ny, nz);
    for (let c = 0; c < ncell; c++) {
      if (counts[c] >= 1 << 24) throw new Error(`FiberField: ${counts[c]} capsules in one grid cell — pass a smaller cellMm`);
      u[2 * c + 1] = counts[c] | (cheb[c] << 24);
    }

    const f = new Float32Array((PAL + 2 * n) * 4);
    f.set(this.palette, 0);
    f.set(seg.subarray(0, n * 8), PAL * 4);
    this.fBuf = dev.createBuffer({ size: f.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.fBuf, 0, f);
    this.uBuf = dev.createBuffer({ size: u.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.uBuf, 0, u);
  }

  /** Recolour one bundle live (a palette write — no rebuild, no bind-group churn). */
  setBundleColor(id: number, rgba: RGBA) {
    if (id < 1 || id >= PAL) return;
    this.palette.set(rgba, id * 4);
    this.dev.queue.writeBuffer(this.fBuf, id * 16, this.palette.subarray(id * 4, id * 4 + 4));
  }
  bundleColor(id: number): RGBA { return Array.from(this.palette.subarray(id * 4, id * 4 + 4)) as RGBA; }
  /** Field-level opacity multiplier; caller does scene.syncUniforms(). */
  setOpacity(o: number) { this.opacity = Math.max(0, Math.min(1, o)); }
  /** Live AO tuning (strength/radius/density are uniform-resident — no rebuild). The sample PATTERN
   *  is baked into the shader, so changing directions/steps needs a new field. */
  setAO(strength: number, radiusMm?: number, densityScale?: number) {
    this.aoStrength = Math.max(0, strength);
    if (radiusMm !== undefined) this.aoRadiusMm = radiusMm;
    if (densityScale !== undefined) this.aoDensityScale = densityScale;
  }
  /** SCHEMATIC flow band along streamlines built with `flow: true`. `amplitude` is a peak brightening
   *  (0 = off; ~0.12 reads as motion without competing with the shading that conveys 3D form), and
   *  `timeS` advances it — hold it fixed for a static directional cue that survives a screenshot.
   *  Brightness only: modulating opacity would read as travelling changes in fibre density, which is
   *  a false data impression. */
  setMotion(amplitude: number, timeS: number) {
    this.motionAmp = Math.max(0, amplitude);
    this.motionTime = timeS;
  }
  /** Depth-dependent halo strength/width, live (uniform-resident — no rebuild). */
  setHalo(strength: number, widthMm?: number) {
    this.haloStrength = Math.max(0, Math.min(1, strength));
    if (widthMm !== undefined) this.haloWidth = widthMm;
  }
  get halo(): { strength: number; widthMm: number } { return { strength: this.haloStrength, widthMm: this.haloWidth }; }
  get ao(): { strength: number; radiusMm: number; densityScale: number; dirs: number; steps: number } {
    return { strength: this.aoStrength, radiusMm: this.aoRadiusMm, densityScale: this.aoDensityScale, dirs: this.aoDirs, steps: this.aoSteps };
  }
  destroy() { this.fBuf.destroy(); this.uBuf.destroy(); }

  uniformFloats() { return 28; }        // lo + dims + hi + shade + params + motion + halo, 4 each
  aabb(): [Vec3, Vec3] { return [this.lo, this.hi]; }
  /** Tubes need no fine step (crossings are found per interval), so this only caps how coarse the
   *  march may get before intervals walk many cells. */
  sampleStep(): number { return this.cellMm; }

  structMembers(s: number): string {
    return [
      `  fib${s}_lo : vec4<f32>,`,       // grid origin xyz, cell mm
      `  fib${s}_dims : vec4<f32>,`,     // nx, ny, nz, _
      `  fib${s}_hi : vec4<f32>,`,       // grid max xyz, tube radius
      `  fib${s}_shade : vec4<f32>,`,    // ka, kd, ks, shininess
      `  fib${s}_params : vec4<f32>,`,   // opacity, ao strength, ao radius mm, ao density scale
      `  fib${s}_motion : vec4<f32>,`,   // band amplitude, wavelength mm, speed mm/s, time s
      `  fib${s}_halo : vec4<f32>,`,     // halo strength, halo width mm, _, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return [
      `@group(0) @binding(${base}) var<storage, read> fib${s}_f : array<vec4<f32>>;`,
      `@group(0) @binding(${base + 1}) var<storage, read> fib${s}_u : array<u32>;`,
    ].join("\n");
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [
      { binding: base, resource: { buffer: this.fBuf } },
      { binding: base + 1, resource: { buffer: this.uBuf } },
    ];
  }

  skipWGSL(s: number): string {
    // Distance to the nearest occupied cell: outside the grid, the box distance; inside, the empty
    // chessboard cube around wp's cell ((k-1) cells plus wp's margin to its own cell faces).
    //
    // Minus the LOOKBACK: an interval field is skipped at a check point, and the NEXT sample reports
    // only the last LOOKBACK steps behind it. Shrinking the bound by that look-back guarantees
    // nothing lies within LOOKBACK of a skipped check point, so the stretch before the next sample's
    // interval is provably empty. (Worked through: the unreported region after a skip is < 2 steps;
    // an unshrunk bound would let a crossing just behind a check point recede forever unreported.)
    return /* wgsl */ `
fn skip_fib${s}(wp : vec3<f32>) -> f32 {
  let lo = u_material.fib${s}_lo.xyz; let cell = u_material.fib${s}_lo.w;
  let hi = u_material.fib${s}_hi.xyz;
  let dims = vec3<i32>(u_material.fib${s}_dims.xyz);
  let o = max(lo - wp, wp - hi);
  var d = length(max(o, vec3<f32>(0.0)));
  if (d <= 0.0) {
    let g = (wp - lo) / cell;
    let ci = clamp(vec3<i32>(floor(g)), vec3<i32>(0), dims - vec3<i32>(1));
    let k = f32(fib${s}_u[2u * u32(ci.x + dims.x * (ci.y + dims.y * ci.z)) + 1u] >> 24u);
    if (k < 1.0) { return 0.0; }
    let f = clamp(g - vec3<f32>(ci), vec3<f32>(0.0), vec3<f32>(1.0));
    let edge = min(min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)), min(f.z, 1.0 - f.z));
    d = (k - 1.0 + edge) * cell;
  }
  return max(d - ${LOOKBACK.toFixed(1)} * max(u_material.scene.x, 1e-3), 0.0);
}`;
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
// Entry distance of the ray (ro, unit rd) into the capsule [pa, pb] of radius r (Quilez), or -1 on a
// miss or when ro already lies inside (the entry was behind ro).
fn fib_cap${s}(ro : vec3<f32>, rd : vec3<f32>, pa : vec3<f32>, pb : vec3<f32>, r : f32) -> f32 {
  let ba = pb - pa; let oa = ro - pa;
  let baba = dot(ba, ba); let bard = dot(ba, rd); let baoa = dot(ba, oa);
  let a = baba - bard * bard;
  var cap = pa;
  if (a > 1e-7 * baba) {
    let b = baba * dot(rd, oa) - baoa * bard;
    let c = baba * dot(oa, oa) - baoa * baoa - r * r * baba;
    let h = b * b - a * c;
    if (h < 0.0) { return -1.0; }            // misses the infinite cylinder, so the capsule too
    let t = (-b - sqrt(h)) / a;
    let y = baoa + t * bard;
    if (y > 0.0 && y < baba) { return t; }  // the cylindrical body
    cap = select(pb, pa, y <= 0.0);
  } else {
    cap = select(pb, pa, bard > 0.0);        // ray parallel to the axis: the near end cap
  }
  let oc = ro - cap;
  let b2 = dot(rd, oc);
  let h2 = b2 * b2 - (dot(oc, oc) - r * r);
  if (h2 < 0.0) { return -1.0; }
  return -b2 - sqrt(h2);
}
fn fib_dseg${s}(p : vec3<f32>, a : vec3<f32>, b : vec3<f32>) -> f32 {
  let ba = b - a;
  return length(p - a - ba * clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0));
}
// Closest approach between the ray and a segment: returns (distance, ray distance at that point).
// This is what the halo band needs — the radial distance where the ray passes NEAREST the tube. (An
// intersection against an inflated radius cannot answer it: its entry point always sits exactly on
// the inflated surface, so every halo measured the same distance and cancelled itself out.)
fn fib_rayseg${s}(ro : vec3<f32>, rd : vec3<f32>, a : vec3<f32>, b : vec3<f32>) -> vec2<f32> {
  let ba = b - a;
  let w0 = ro - a;
  let bb = dot(rd, ba);
  let cc = dot(ba, ba);
  let dd = dot(rd, w0);
  let ee = dot(ba, w0);
  let u = clamp((ee - bb * dd) / max(cc - bb * bb, 1e-8), 0.0, 1.0);
  let p = a + ba * u;
  let t = max(dot(p - ro, rd), 0.0);
  return vec2<f32>(length(ro + rd * t - p), t);
}
// Line density at p, straight from the grid's per-cell capsule count — the occupancy structure the
// march already needs. No depth buffer, no normals, and occluders off-screen or behind the nearest
// surface count exactly the same as visible ones.
fn fib_density${s}(p : vec3<f32>) -> f32 {
  let lo = u_material.fib${s}_lo.xyz; let cell = u_material.fib${s}_lo.w;
  let dims = vec3<i32>(u_material.fib${s}_dims.xyz);
  let g = vec3<i32>(floor((p - lo) / cell));
  if (any(g < vec3<i32>(0)) || any(g >= dims)) { return 0.0; }
  let cnt = fib${s}_u[2u * u32(g.x + dims.x * (g.y + dims.y * g.z)) + 1u] & 0xFFFFFFu;
  return clamp(f32(cnt) * u_material.fib${s}_params.w, 0.0, 1.0);
}
// Hemisphere occlusion about the surface normal, with a quadratic falloff so near occluders dominate
// (LineAO's weighting) and a floor so nothing goes fully black — dark holes read as missing data.
fn fib_ao${s}(q : vec3<f32>, n : vec3<f32>, r : f32) -> f32 {
  let strength = u_material.fib${s}_params.y;
  if (strength <= 0.0) { return 1.0; }
  let R = max(u_material.fib${s}_params.z, 1e-3);
  let up = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.z) > 0.9);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  let base = q + n * (3.0 * r);      // bias off the tube's own surface
  var occ = 0.0;
  var wsum = 0.0;
  for (var d = 0; d < ${this.aoDirs}; d = d + 1) {
    var dir = n;
    if (d > 0) {
      let a = 6.2831853 * f32(d - 1) / f32(${Math.max(1, this.aoDirs - 1)});
      dir = normalize(n * 0.57 + (t * cos(a) + b * sin(a)) * 0.82);
    }
    for (var k = 1; k <= ${this.aoSteps}; k = k + 1) {
      let dist = R * f32(k) / f32(${this.aoSteps});
      let w = 1.0 / (1.0 + 4.0 * (dist / R) * (dist / R));
      occ += w * fib_density${s}(base + dir * dist);
      wsum += w;
    }
  }
  return clamp(1.0 - strength * (occ / max(wsum, 1e-6)), 0.12, 1.0);
}
fn sample_field_fib${s}(wp_world : vec3<f32>, rd : vec3<f32>, seg : f32) -> vec4<f32> {
  let wp = transform_point_fib${s}(wp_world);
  let lo = u_material.fib${s}_lo.xyz; let cell = u_material.fib${s}_lo.w;
  let hi = u_material.fib${s}_hi.xyz; let r = u_material.fib${s}_hi.w;
  let dims = vec3<i32>(u_material.fib${s}_dims.xyz);
  let len = min(seg, ${LOOKBACK.toFixed(1)} * max(u_material.scene.x, 1e-3));
  if (!(len > 0.0)) { return vec4<f32>(0.0); }
  // The interval runs from q0 (t = 0, excluded) to wp (t = len, included), clipped to the grid.
  let q0 = wp - rd * len;
  let axis_ok = abs(rd) > vec3<f32>(1e-8);
  let inv = select(vec3<f32>(1e30), vec3<f32>(1.0) / rd, axis_ok);
  let ta = (lo - q0) * inv; let tb = (hi - q0) * inv;
  let t0 = max(max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z)), 0.0);
  let t1 = min(min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z)), len);
  if (t1 <= t0) { return vec4<f32>(0.0); }
  // 3D-DDA through the cells the interval crosses (Amanatides-Woo). A crossing counts only in the
  // cell whose stretch (tc, te] of the interval contains it, so a capsule listed in several of the
  // walked cells is still counted once.
  let tn = t0 + min(1e-3 * cell, 0.5 * (t1 - t0));
  var ci = clamp(vec3<i32>(floor((q0 + rd * tn - lo) / cell)), vec3<i32>(0), dims - vec3<i32>(1));
  let pos = rd > vec3<f32>(0.0);
  let stp = select(vec3<i32>(-1), vec3<i32>(1), pos);
  let tdelta = abs(inv) * cell;
  let face = lo + (vec3<f32>(ci) + select(vec3<f32>(0.0), vec3<f32>(1.0), pos)) * cell;
  var tmax = select(vec3<f32>(1e30), (face - q0) * inv, axis_ok);
  let ka = u_material.fib${s}_shade.x; let kd = u_material.fib${s}_shade.y;
  let ks = u_material.fib${s}_shade.z; let sh = u_material.fib${s}_shade.w;
  let fop = u_material.fib${s}_params.x;
  var ht : array<f32, ${MAX_HITS}>;
  var hc : array<vec4<f32>, ${MAX_HITS}>;
  var nh = 0;
  var tc = t0;
  for (var it = 0; it < ${MAX_CELLS}; it = it + 1) {
    let tx = min(min(tmax.x, tmax.y), tmax.z);
    let te = min(tx, t1);
    let cidx = u32(ci.x + dims.x * (ci.y + dims.y * ci.z));
    let off = fib${s}_u[2u * cidx];
    let cnt = fib${s}_u[2u * cidx + 1u] & 0xFFFFFFu;
    for (var k = 0u; k < cnt; k = k + 1u) {
      let si = fib${s}_u[off + k];
      let A = fib${s}_f[${PAL}u + 2u * si];
      let B = fib${s}_f[${PAL + 1}u + 2u * si];
      let th = fib_cap${s}(q0, rd, A.xyz, B.xyz, r);
      if (th <= tc || th > te) {
        // The ray missed this tube here. If halos are on, check whether it passed close enough to sit
        // in the tube's halo band, measured at the ray's CLOSEST APPROACH to the segment.
        let hs = u_material.fib${s}_halo.x;
        if (hs <= 0.0) { continue; }
        let hw = max(u_material.fib${s}_halo.y, 1e-4);
        let ca = fib_rayseg${s}(q0, rd, A.xyz, B.xyz);   // (radial distance, ray distance)
        if (ca.x <= r || ca.x >= r + hw) { continue; }
        if (ca.y <= tc || ca.y > te) { continue; }
        let ramp = clamp(1.0 - (ca.x - r) / hw, 0.0, 1.0);   // darkest hugging the tube
        let ha = clamp(hs * ramp * ramp, 0.0, 1.0);
        if (ha <= 0.004) { continue; }
        if (nh == ${MAX_HITS} && ca.y >= ht[${MAX_HITS - 1}]) { continue; }
        // Black, premultiplied, at the tube's own depth: front-to-back compositing then occludes
        // whatever lies behind it, which is what separates bundles — and leaves nearer tubes alone.
        var j = min(nh, ${MAX_HITS - 1});
        loop {
          if (j == 0 || ht[j - 1] <= ca.y) { break; }
          ht[j] = ht[j - 1]; hc[j] = hc[j - 1]; j = j - 1;
        }
        ht[j] = ca.y; hc[j] = vec4<f32>(0.0, 0.0, 0.0, ha);
        nh = min(nh + 1, ${MAX_HITS});
        continue;
      }
      if (nh == ${MAX_HITS} && th >= ht[${MAX_HITS - 1}]) { continue; }
      let q = q0 + rd * th;
      let ba = B.xyz - A.xyz;
      let y = dot(q - A.xyz, ba) / dot(ba, ba);
      // Keep only crossings on the strand's capsule-UNION surface (see the header).
      let packed = u32(A.w + 0.5);
      let flags = packed & 3u;
      if ((flags & 2u) != 0u) {
        if (y >= 1.0) { continue; }
        if (fib_dseg${s}(q, B.xyz, fib${s}_f[${PAL + 1}u + 2u * (si + 1u)].xyz) < r * 0.9999) { continue; }
      }
      if ((flags & 1u) != 0u && fib_dseg${s}(q, fib${s}_f[${PAL}u + 2u * (si - 1u)].xyz, A.xyz) < r * 0.9999) { continue; }
      let pal = fib${s}_f[packed >> 2u];
      let op = clamp(pal.a * fop, 0.0, 1.0);
      if (op <= 0.0) { continue; }
      // Headlight Phong on the analytic tube normal.
      let nrm = normalize(q - (A.xyz + ba * clamp(y, 0.0, 1.0)));
      let ldn = max(dot(nrm, -rd), 0.0);
      let refl = normalize(2.0 * ldn * nrm + rd);
      let rdv = max(dot(refl, -rd), 0.0);
      let ao = fib_ao${s}(q, nrm, r);
      // SCHEMATIC flow band: a comet-shaped brightening travelling along the tube's own arclength,
      // only on streamlines whose tract has a real anatomical direction (B.w >= 0). Asymmetric, so a
      // still frame still reads directionally. Faded out where the tube is thinner than a pixel — a
      // moving band on sub-pixel geometry scintillates.
      var band = 0.0;
      let amp = u_material.fib${s}_motion.x;
      if (amp > 0.0 && B.w >= 0.0) {
        let lam = max(u_material.fib${s}_motion.y, 1e-3);
        let sAt = B.w + dot(q - A.xyz, ba / max(length(ba), 1e-6));
        let u = fract((sAt - u_material.fib${s}_motion.z * u_material.fib${s}_motion.w) / lam);
        let comet = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.06, 0.30, u));
        // Soften — do not erase — where the tube is thin on screen. These tubes are SUB-PIXEL at
        // whole-brain framing (0.175 mm at ~570 mm is ~0.8 px wide), so the usual "fade out below a
        // pixel" guard would switch the band off exactly where the demo lives. Fading to a floor
        // instead keeps it visible, and the rolling accumulation absorbs the residual scintillation.
        let widthPx = 2.0 * r * u_cam.size.z / max(length(u_cam.eye.xyz - q), 1e-3);
        band = comet * amp * mix(0.4, 1.0, smoothstep(0.3, 1.2, widthPx));
      }
      let lit = pal.rgb * ((ka + kd * ldn) * ao + band) + vec3<f32>(ks * pow(rdv, sh));
      let col = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
      var j = min(nh, ${MAX_HITS - 1});       // insertion, nearest first (the farthest drops off)
      loop {
        if (j == 0 || ht[j - 1] <= th) { break; }
        ht[j] = ht[j - 1]; hc[j] = hc[j - 1]; j = j - 1;
      }
      ht[j] = th; hc[j] = vec4<f32>(col * op, op);
      nh = min(nh + 1, ${MAX_HITS});
    }
    if (tx >= t1) { break; }
    tc = tx;
    if (tmax.x <= tmax.y && tmax.x <= tmax.z) { ci.x = ci.x + stp.x; tmax.x = tmax.x + tdelta.x; }
    else if (tmax.y <= tmax.z) { ci.y = ci.y + stp.y; tmax.y = tmax.y + tdelta.y; }
    else { ci.z = ci.z + stp.z; tmax.z = tmax.z + tdelta.z; }
    if (any(ci < vec3<i32>(0)) || any(ci >= dims)) { break; }
  }
  var acc = vec4<f32>(0.0);
  for (var j = 0; j < nh; j = j + 1) { acc = acc + (1.0 - acc.a) * hc[j]; }
  return acc;
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.lo[0]; out[off + 1] = this.lo[1]; out[off + 2] = this.lo[2]; out[off + 3] = this.cellMm;
    out[off + 4] = this.gridDims[0]; out[off + 5] = this.gridDims[1]; out[off + 6] = this.gridDims[2];
    out[off + 8] = this.hi[0]; out[off + 9] = this.hi[1]; out[off + 10] = this.hi[2]; out[off + 11] = this.radius;
    out[off + 12] = this.shade[0]; out[off + 13] = this.shade[1]; out[off + 14] = this.shade[2]; out[off + 15] = this.shade[3];
    out[off + 16] = this.opacity;
    out[off + 17] = this.aoStrength;
    out[off + 18] = this.aoRadiusMm;
    out[off + 19] = this.aoDensityScale;
    out[off + 20] = this.motionAmp;
    out[off + 21] = this.motionWavelength;
    out[off + 22] = this.motionSpeed;
    out[off + 23] = this.motionTime;
    out[off + 24] = this.haloStrength;
    out[off + 25] = this.haloWidth;
  }
}
