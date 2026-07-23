// TransformField — a 3D displacement field that warps ANY other field's sampling
// position during the ray march. A TS/WebGPU port of slicer_wgpu's TransformField
// (fields/transform.py), giving SlicerLive nonlinear (grid / thin-plate-spline)
// transform support.
//
// Unlike ImageField / RGBAVolumeField / FiducialField this is a MODIFIER, not a
// compositor: it contributes no colour or opacity. Instead a receiver field holds a
// reference to it and the SceneRenderer inlines
//
//     transform_point_<kind><slot>(wp) = wp + displacement_grid<M>(wp)
//
// which the receiver calls at the top of its sampling path (including its gradient
// taps). So the warp deforms the apparent shape of a volume, the position of
// fiducials, etc., without the receiver knowing anything about grid slots. This
// mirrors STEP's transformPoint pattern that slicer_wgpu followed.
//
// The displacement texture holds world (RAS) mm displacements; outside the [0,1]^3
// box the warp returns the zero vector, so only the region the grid covers deforms.

import type { Field } from "./fields.ts";
import { type Mat4, patientToTexture, type Vec3, volumeAABB } from "./mat4.ts";

export interface TransformFieldOpts {
  /** Scales the displacement; 0 = identity, 1 = as authored. */
  gain?: number;
  /** World centre of the grid box (default origin). */
  center?: Vec3;
}

export class TransformField implements Field {
  readonly kind = "grid";
  readonly modifier = true;          // never composited into the ray-march sum
  readonly bindingCount = 1;         // displacement texture (sampler shared)
  private tex: GPUTexture;
  private p2t: Mat4;
  private box: [Vec3, Vec3];
  private gainValue: number;
  private stepMm: number;

  /** `displacement` is (dx,dy,dz,_) per voxel in RAS mm, C-order (z,y,x), dims=[X,Y,Z]. */
  constructor(dev: GPUDevice, displacement: Float32Array, dims: Vec3, spacing: Vec3, opts: TransformFieldOpts = {}) {
    const center = opts.center ?? [0, 0, 0];
    this.gainValue = opts.gain ?? 1;
    this.tex = dev.createTexture({
      size: dims as [number, number, number],
      dimension: "3d",
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture({ texture: this.tex }, displacement, { bytesPerRow: dims[0] * 16, rowsPerImage: dims[1] }, dims as [number, number, number]);
    this.p2t = patientToTexture(dims, spacing, center);
    this.box = volumeAABB(dims, spacing, center);
    this.stepMm = Math.min(...spacing);
  }

  get gain(): number { return this.gainValue; }
  setGain(g: number) { this.gainValue = g; }

  uniformFloats() { return 20; }     // mat4(16) + params(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }

  structMembers(s: number): string {
    return [
      `  grid${s}_p2t : mat4x4<f32>,`,
      `  grid${s}_params : vec4<f32>,`,   // gain, _, _, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return `@group(0) @binding(${base}) var t_grid${s} : texture_3d<f32>;`;
  }

  /** Modifier fields emit the displacement lookup, not a sample_field_* function. */
  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn displacement_grid${s}(wp : vec3<f32>) -> vec3<f32> {
  let t4 = u_material.grid${s}_p2t * vec4<f32>(wp, 1.0);
  let tex = t4.xyz;
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec3<f32>(0.0); }
  let d = textureSampleLevel(t_grid${s}, s_lin, tex, 0.0).xyz;
  return u_material.grid${s}_params.x * d;
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.gainValue;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [{ binding: base, resource: this.tex.createView() }];
  }
}

// ---------------------------------------------------------------------------
// Thin-plate spline (3D) — builds a displacement grid from landmark pairs, which
// is how Slicer's "Landmark Deform" selftest authors a nonlinear transform.
//
// 3D TPS uses the kernel U(r) = r. For each output component we solve
//     [ K  P ] [w]   [v]
//     [ P' 0 ] [a] = [0]
// with K_ij = U(|p_i - p_j|) and P_i = [1, x, y, z].
// ---------------------------------------------------------------------------

/** Solve A x = b in place (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = Math.abs(A[r][r]) < 1e-12 ? 0 : s / A[r][r];
  }
  return x;
}

/** Returns f(p) -> displacement, mapping each source landmark onto its target. */
export function tps3d(source: Vec3[], target: Vec3[]): (p: Vec3) => Vec3 {
  const n = source.length;
  const U = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const build = () => {
    const M: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row = new Array(n + 4).fill(0);
      for (let j = 0; j < n; j++) row[j] = U(source[i], source[j]);
      row[n] = 1; row[n + 1] = source[i][0]; row[n + 2] = source[i][1]; row[n + 3] = source[i][2];
      M.push(row);
    }
    for (let c = 0; c < 4; c++) {
      const row = new Array(n + 4).fill(0);
      for (let j = 0; j < n; j++) row[j] = c === 0 ? 1 : source[j][c - 1];
      M.push(row);
    }
    return M;
  };
  // one solve per component, on the displacement (target - source)
  const coeffs: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const b = new Array(n + 4).fill(0);
    for (let i = 0; i < n; i++) b[i] = target[i][c] - source[i][c];
    coeffs.push(solve(build(), b));
  }
  return (p: Vec3): Vec3 => {
    const out: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const w = coeffs[c];
      let v = w[n] + w[n + 1] * p[0] + w[n + 2] * p[1] + w[n + 3] * p[2];
      for (let i = 0; i < n; i++) v += w[i] * U(p, source[i]);
      out[c] = v;
    }
    return out;
  };
}

/** Sample a displacement function onto an rgba32float grid ready for TransformField. */
export function sampleDisplacementGrid(
  dims: Vec3,
  spacing: Vec3,
  center: Vec3,
  f: (p: Vec3) => Vec3,
): Float32Array {
  const [X, Y, Z] = dims;
  const out = new Float32Array(X * Y * Z * 4);
  const ext: Vec3 = [X * spacing[0], Y * spacing[1], Z * spacing[2]];
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        // voxel centre in world coords for the same box volumeAABB/patientToTexture describe
        const p: Vec3 = [
          center[0] - ext[0] / 2 + (x + 0.5) * spacing[0],
          center[1] - ext[1] / 2 + (y + 0.5) * spacing[1],
          center[2] - ext[2] / 2 + (z + 0.5) * spacing[2],
        ];
        const d = f(p);
        const o = ((z * Y + y) * X + x) * 4;
        out[o] = d[0]; out[o + 1] = d[1]; out[o + 2] = d[2]; out[o + 3] = 0;
      }
    }
  }
  return out;
}
