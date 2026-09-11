// Synthetic "field compositing" scene — a port of SlicerWGPU SceneRendering's
// test_vtk_FieldCompositing, the "lava lamp": four synthetic fiber bundles (helix, U-arc, fan,
// diagonal; ~1500 streamlines) rendered as capsule tubes by FiberField, an animated RGBA volume of
// three breathing Gaussian blobs that chase an attractor fiducial, and four markup fiducials — all
// composited in ONE ray-march. Deterministic (seeded RNG, fixed physics tick) so the Deno test and
// the browser demo render the same thing.
import { RGBAVolumeField } from "../fields.ts";
import { FiberField, type RGBA, type Strand } from "../fiber-field.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import type { Vec3 } from "../mat4.ts";

/** Seeded Gaussian sampler (mulberry32 + Box-Muller). */
function gaussianRng(seed: number): (sd: number) => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (sd) => sd * Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** The four synthetic bundles of SlicerWGPU's fiber tests — same shapes and strand counts. */
export function syntheticBundles(seed = 42): Strand[] {
  const normal = gaussianRng(seed);
  const strands: Strand[] = [];
  // A per-strand offset gives variety; the per-sample jitter must stay well below the tube radius or
  // the capsule chain zigzags instead of reading as a smooth tube.
  const add = (fn: (t: number) => Vec3, bundle: number, n: number, jitter = 0.02) => {
    const off = [normal(0.8), normal(0.8), normal(0.8)];
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = fn(i / (n - 1));
      for (let a = 0; a < 3; a++) pts[i * 3 + a] = p[a] + off[a] + normal(jitter);
    }
    strands.push({ points: pts, bundle });
  };
  // 1: helix along +Z
  for (let s = 0; s < 400; s++) {
    const phase = (2 * Math.PI * s) / 400, r = 22 + ((s % 13) - 6) * 0.7;
    add((t) => {
      const z = (t - 0.5) * 110, th = (2 * Math.PI * z) / 38 + phase;
      return [r * Math.cos(th), r * Math.sin(th), z];
    }, 1, 70);
  }
  // 2: U-arc along +X
  for (let s = 0; s < 400; s++) {
    const zOff = (s - 200) * 0.30, yThick = ((s % 11) - 5) * 0.4;
    add((t) => [-55 + 110 * t, 32 * Math.sin(Math.PI * t) + yThick, zOff], 2, 70);
  }
  // 3: fan from a focal point over a forward-facing cone (a 20x20 grid of directions)
  const focal: Vec3 = [-30, -8, 0];
  for (let s = 0; s < 400; s++) {
    const azim = (2 * Math.PI * (s % 20)) / 20, elev = (0.40 * Math.PI * (Math.floor(s / 20) - 9.5)) / 10;
    const d: Vec3 = [Math.cos(elev), Math.sin(elev) * Math.cos(azim) * 0.8, Math.sin(elev) * Math.sin(azim) * 0.8];
    const l = Math.max(Math.hypot(d[0], d[1], d[2]), 1e-6);
    add((t) => [focal[0] + (80 * t * d[0]) / l, focal[1] + (80 * t * d[1]) / l, focal[2] + (80 * t * d[2]) / l], 3, 60);
  }
  // 4: diagonal bundle through the centre
  const k = 1 / Math.sqrt(3), axis: Vec3 = [k, k, k], u: Vec3 = [Math.SQRT1_2, -Math.SQRT1_2, 0];
  const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  for (let s = 0; s < 300; s++) {
    const ang = (2 * Math.PI * s) / 300, r = 9 + ((s % 7) - 3) * 0.4;
    const o = [0, 1, 2].map((a) => r * (Math.cos(ang) * u[a] + Math.sin(ang) * v[a]));
    add((t) => [(t - 0.5) * 100 * axis[0] + o[0], (t - 0.5) * 100 * axis[1] + o[1], (t - 0.5) * 100 * axis[2] + o[2]], 4, 60);
  }
  return strands;
}

/** test_vtk_FieldCompositing's palette (the blue U-arc at half opacity, so the helix shows through). */
export const BUNDLE_COLORS: Record<number, RGBA> = {
  1: [235 / 255, 70 / 255, 70 / 255, 220 / 255],
  2: [80 / 255, 190 / 255, 235 / 255, 128 / 255],
  3: [245 / 255, 200 / 255, 70 / 255, 220 / 255],
  4: [90 / 255, 220 / 255, 130 / 255, 220 / 255],
};
export const BUNDLE_NAMES: Record<number, string> = { 1: "helix", 2: "U-arc", 3: "fan", 4: "diagonal" };

const TICK = 0.05;   // physics step (s) — the Slicer test's 50 ms QTimer

// rgba16float upload. Every value written is in [0, 1], so a 12-bit table of half-float encodings is
// plenty and avoids per-voxel float→half bit twiddling.
const HALF = (() => {
  const lut = new Uint16Array(4096);
  for (let i = 1; i < 4096; i++) {
    const x = i / 4095, e = Math.floor(Math.log2(x)), m = Math.round((x / 2 ** e - 1) * 1024);
    lut[i] = m === 1024 ? (e + 16) << 10 : ((e + 15) << 10) | m;
  }
  return lut;
})();

/** Three breathing Gaussian blobs of primary colour in a 48³ rgba16float volume, rendered by the
 *  stock RGBAVolumeField and re-uploaded as they move. */
export class LavaLamp {
  static readonly DIMS: Vec3 = [48, 48, 48];
  static readonly LO: Vec3 = [-60, -45, -60];
  static readonly HI: Vec3 = [60, 45, 60];
  readonly field: RGBAVolumeField;
  readonly pos: Vec3[] = [[60, 25, 30], [30, 45, 30], [30, 15, 50]];   // a triangle around the attractor
  readonly color: Vec3[] = [[1.00, 0.18, 0.18], [0.18, 1.00, 0.30], [0.25, 0.45, 1.00]];
  private vel: Vec3[] = [[0, 10, 0], [10, 0, 10], [-10, -10, 0]];      // a slight initial swirl
  private period = [3.7, 5.3, 4.6];   // prime-ish breathing periods (s) so the blobs never sync
  private phase = [0.0, 2.1, 4.7];
  private time = 0;
  private pending = 0;
  private dev: GPUDevice;
  private tex: GPUTexture;
  private acc: Float32Array;
  private half: Uint16Array<ArrayBuffer>;

  constructor(dev: GPUDevice) {
    const [dx, dy, dz] = LavaLamp.DIMS, lo = LavaLamp.LO, hi = LavaLamp.HI;
    this.dev = dev;
    this.tex = dev.createTexture({ size: [dx, dy, dz], dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const ext: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    this.field = new RGBAVolumeField(this.tex, LavaLamp.DIMS, [ext[0] / dx, ext[1] / dy, ext[2] / dz], {
      center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
      // Density mode as in the Slicer test: one blob integrates to ~0.85 alpha across its diameter.
      opacityUnitDistance: Math.max(Math.min(...ext) / 12, 4),
    });
    this.acc = new Float32Array(dx * dy * dz * 4);
    this.half = new Uint16Array(dx * dy * dz * 4);
    this.upload();
  }

  /** Breathing phase of blob i in [0, 1]; scales both its size and how hard it pulls. */
  private pulse(i: number) { return 0.5 + 0.5 * Math.sin((2 * Math.PI * this.time) / this.period[i] + this.phase[i]); }

  /** Advance the simulation by `dt` seconds, in fixed 50 ms ticks (frame-rate independent). */
  advance(dt: number, attractor: Vec3) {
    this.pending += Math.min(Math.max(dt, 0), 0.25);
    while (this.pending >= TICK) { this.tick(attractor); this.pending -= TICK; }
  }

  // Each blob springs toward the attractor with a gain its breath modulates (0.3..1.7x) and is pushed
  // off the others (softened inverse square), lightly damped — so the three hand the spot nearest the
  // attractor back and forth without ever settling.
  private tick(fid: Vec3) {
    this.time += TICK;
    const n = this.pos.length;
    const force = this.pos.map(() => [0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const k = 1.2 * (0.3 + 1.4 * this.pulse(i));
      for (let a = 0; a < 3; a++) force[i][a] += k * (fid[a] - this.pos[i][a]);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = [0, 1, 2].map((a) => this.pos[i][a] - this.pos[j][a]);
        const s = 4500 / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + 4) ** 1.5;
        for (let a = 0; a < 3; a++) force[i][a] += s * d[a];
      }
    }
    for (let i = 0; i < n; i++) {
      const vel = this.vel[i];
      for (let a = 0; a < 3; a++) vel[a] = vel[a] * 0.985 + force[i][a] * TICK;
      const speed = Math.hypot(vel[0], vel[1], vel[2]);
      if (speed > 50) for (let a = 0; a < 3; a++) vel[a] *= 50 / speed;
      for (let a = 0; a < 3; a++) this.pos[i][a] += vel[a] * TICK;
    }
  }

  /** Re-render the blobs into the texture: separable Gaussians, then one rgba16float upload. */
  upload() {
    const [dx, dy, dz] = LavaLamp.DIMS, lo = LavaLamp.LO, hi = LavaLamp.HI;
    const acc = this.acc;
    acc.fill(0);
    const sigmaBase = 0.07 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);   // distinct droplets
    const axis = (a: number, d: number, c: number, inv: number) => {
      const out = new Float32Array(d);
      for (let i = 0; i < d; i++) {
        const x = lo[a] + ((i + 0.5) * (hi[a] - lo[a])) / d - c;
        out[i] = Math.exp(-x * x * inv);
      }
      return out;
    };
    for (let b = 0; b < this.pos.length; b++) {
      const sigma = sigmaBase * (0.6 + 0.6 * this.pulse(b));
      const inv = 1 / (2 * sigma * sigma);
      const [cx, cy, cz] = this.pos[b], [cr, cg, cb] = this.color[b];
      const ex = axis(0, dx, cx, inv), ey = axis(1, dy, cy, inv), ez = axis(2, dz, cz, inv);
      for (let z = 0; z < dz; z++) {
        for (let y = 0; y < dy; y++) {
          const eyz = ez[z] * ey[y];
          if (eyz < 1e-7) continue;
          let o = (z * dy + y) * dx * 4;
          for (let x = 0; x < dx; x++, o += 4) {
            const g = eyz * ex[x];
            acc[o] += g * cr; acc[o + 1] += g * cg; acc[o + 2] += g * cb; acc[o + 3] += g;
          }
        }
      }
    }
    // Colour = the density-weighted mean, so overlapping blobs stay pure instead of bleaching to
    // white; alpha = total density, capped at 1.
    const half = this.half;
    for (let o = 0; o < acc.length; o += 4) {
      const a = acc[o + 3], w = 1 / Math.max(a, 1e-6);
      half[o] = HALF[Math.round(Math.min(acc[o] * w, 1) * 4095)];
      half[o + 1] = HALF[Math.round(Math.min(acc[o + 1] * w, 1) * 4095)];
      half[o + 2] = HALF[Math.round(Math.min(acc[o + 2] * w, 1) * 4095)];
      half[o + 3] = HALF[Math.round(Math.min(a, 1) * 4095)];
    }
    this.dev.queue.writeTexture({ texture: this.tex }, half, { bytesPerRow: dx * 8, rowsPerImage: dy }, [dx, dy, dz]);
  }
}

/** The Slicer test's "RefPoints" markup list. The first control point is the blobs' attractor. */
export const CONTROL_POINTS: Vec3[] = [[40, 25, 30], [0, 0, 0], [0, 0, 45], [-30, 25, -30]];

export function fiducialSpheres(points: Vec3[]): Sphere[] {
  return points.map((c) => ({ center: [c[0], c[1], c[2]], radius: 3, color: [1, 1, 0.3, 1] }));
}

export interface FiberScene {
  fibers: FiberField;
  lava: LavaLamp;
  fiducials: FiducialField;
  points: Vec3[];
  center: Vec3;
  radius: number;
}

export function buildFiberScene(dev: GPUDevice, strands: Strand[] = syntheticBundles()): FiberScene {
  const fibers = new FiberField(dev, strands, { radius: 0.2, bundleColors: BUNDLE_COLORS });
  const lava = new LavaLamp(dev);
  const points = CONTROL_POINTS.map((p) => [p[0], p[1], p[2]] as Vec3);
  const fiducials = new FiducialField(fiducialSpheres(points), { shininess: 60, kSpecular: 0.5 });
  return { fibers, lava, fiducials, points, center: [0, 0, 0], radius: 80 };
}

/** SceneRenderer.build order. */
export const sceneFields = (sc: FiberScene) => [sc.lava.field, sc.fibers, sc.fiducials];
