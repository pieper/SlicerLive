// CapsuleField — a fixed-capacity array of round-capped line segments (capsules) rendered
// procedurally in the ray-march, the sibling of FiducialField for markup GEOMETRY: the
// connectors of line/angle markups, the interpolated polyline of a curve/closed curve, and
// the border of a plane. Same Field contract (each sample returns a PREMULTIPLIED vec4),
// same screen-space + ghost options so lines stay a constant pixel thickness and shine
// through the volume like Slicer's markup display.

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

const MAX = 256; // segments per field (uniform array size, fixed at WGSL-generation time)

export interface Segment { a: Vec3; b: Vec3; radius: number; color: [number, number, number, number] }

export interface CapsuleOpts {
  shininess?: number;
  kAmbient?: number;
  kDiffuse?: number;
  kSpecular?: number;
  lightColor?: Vec3;
  clippable?: boolean;
  /** radius is a PIXEL half-thickness, sized per-frame from the camera (constant on screen). */
  screenSpace?: boolean;
  /** GHOST compositing: the segment dims what's in front so it shines through the volume. */
  ghost?: boolean;
}

export class CapsuleField implements Field {
  readonly kind = "cap";
  readonly bindingCount = 0;
  private segA = new Float32Array(MAX * 4);  // (ax,ay,az,radius)
  private segB = new Float32Array(MAX * 4);  // (bx,by,bz,_)
  private colors = new Float32Array(MAX * 4);
  private n = 0;
  private maxR = 0;
  readonly clippable: boolean;
  readonly ghost: boolean;
  readonly providesSkip = true;
  private screen: boolean;
  private sh: number;
  private ka: number;
  private kd: number;
  private ks: number;
  private light: Vec3;

  constructor(segments: Segment[] = [], opts: CapsuleOpts = {}) {
    this.setSegments(segments);
    this.sh = opts.shininess ?? 40;
    this.ka = opts.kAmbient ?? 0.35;
    this.kd = opts.kDiffuse ?? 0.8;
    this.ks = opts.kSpecular ?? 0.35;
    this.light = opts.lightColor ?? [1, 1, 1];
    this.clippable = opts.clippable ?? true;
    this.ghost = opts.ghost ?? false;
    this.screen = opts.screenSpace ?? false;
  }

  setSegments(list: Segment[]) {
    this.n = Math.min(list.length, MAX);
    this.segA.fill(0);
    this.segB.fill(0);
    this.colors.fill(0);
    this.maxR = 0;
    for (let i = 0; i < this.n; i++) {
      const s = list[i];
      this.segA.set([s.a[0], s.a[1], s.a[2], s.radius], i * 4);
      this.segB.set([s.b[0], s.b[1], s.b[2], 0], i * 4);
      this.colors.set(s.color, i * 4);
      this.maxR = Math.max(this.maxR, s.radius);
    }
  }
  get count(): number { return this.n; }

  uniformFloats(): number { return 12 + MAX * 4 * 3; } // params + params2 + light + segA + segB + colors
  sampleStep(): number { return 1.0; }

  aabb(): [Vec3, Vec3] {
    if (this.n === 0) return [[-1, -1, -1], [1, 1, 1]];
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.n; i++) {
      const r = this.screen ? 0 : this.segA[i * 4 + 3];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], this.segA[i * 4 + a] - r, this.segB[i * 4 + a] - r);
        hi[a] = Math.max(hi[a], this.segA[i * 4 + a] + r, this.segB[i * 4 + a] + r);
      }
    }
    if (this.screen) {
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const m = Math.max(40, diag * 0.15);
      for (let a = 0; a < 3; a++) { lo[a] -= m; hi[a] += m; }
    }
    return [lo, hi];
  }

  structMembers(s: number): string {
    return [
      `  cap${s}_params : vec4<f32>,`,    // n_segments, visible, shininess, k_ambient
      `  cap${s}_params2 : vec4<f32>,`,   // k_diffuse, k_specular, max_radius, _
      `  cap${s}_light : vec4<f32>,`,     // light_color.rgb, _
      `  cap${s}_segA : array<vec4<f32>, ${MAX}>,`,
      `  cap${s}_segB : array<vec4<f32>, ${MAX}>,`,
      `  cap${s}_colors : array<vec4<f32>, ${MAX}>,`,
    ].join("\n");
  }
  declareBindings(_s: number, _base: number): string { return ""; }
  bindEntries(_s: number, _base: number): GPUBindGroupEntry[] { return []; }

  skipWGSL(s: number): string {
    // exact nearest-surface distance over all segments (works for screen + world radius).
    return /* wgsl */ `
fn cap_closest${s}(p : vec3<f32>, a : vec3<f32>, b : vec3<f32>) -> vec3<f32> {
  let ba = b - a;
  let h = clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return a + ba * h;
}
fn skip_cap${s}(wp : vec3<f32>) -> f32 {
  let n = i32(u_material.cap${s}_params.x);
  if (n <= 0) { return 1.0e6; }
  var best = 1.0e12;
  for (var k = 0; k < n; k = k + 1) {
    let A = u_material.cap${s}_segA[k];
    if (A.w <= 0.0) { continue; }
    let c = cap_closest${s}(wp, A.xyz, u_material.cap${s}_segB[k].xyz);
    ${this.screen ? `let r = A.w * length(u_cam.eye.xyz - c) / max(u_cam.size.z, 1.0);` : `let r = A.w;`}
    best = min(best, length(wp - c) - r);
  }
  return max(best, 0.0);
}`;
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sample_field_cap${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let wp_r = transform_point_cap${s}(wp);
  let n = i32(u_material.cap${s}_params.x);
  var best_depth = -1.0;
  var best_c = vec3<f32>(0.0);
  var best_color = vec4<f32>(0.0);
  var found = false;
  for (var k = 0; k < n; k = k + 1) {
    let A = u_material.cap${s}_segA[k];
    if (A.w <= 0.0) { continue; }
    let c = cap_closest${s}(wp_r, A.xyz, u_material.cap${s}_segB[k].xyz);
    ${this.screen ? `let r = A.w * length(u_cam.eye.xyz - c) / max(u_cam.size.z, 1.0);` : `let r = A.w;`}
    let depth = r - length(wp_r - c);
    if (depth > best_depth) { best_depth = depth; best_c = c; best_color = u_material.cap${s}_colors[k]; found = true; }
  }
  if (!found || best_depth <= 0.0) { return vec4<f32>(0.0); }

  let to_wp = wp_r - best_c;
  var n_hat = to_wp / max(length(to_wp), 1e-6);
  if (dot(n_hat, -rd) < 0.0) { n_hat = -n_hat; }
  let view_dir = normalize(-rd);
  let ldotn = max(dot(view_dir, n_hat), 0.0);
  let refl = normalize(2.0 * ldotn * n_hat - view_dir);
  let rdotv = max(dot(refl, view_dir), 0.0);
  let sh = u_material.cap${s}_params.z;
  let ka = u_material.cap${s}_params.w; let kd = u_material.cap${s}_params2.x; let ks = u_material.cap${s}_params2.y;
  let base = best_color.rgb;
  let highlight = mix(base, u_material.cap${s}_light.rgb, 0.85);
  let lit = base * ka + base * (kd * ldotn) + highlight * (ks * pow(rdotv, sh));
  let col = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  ${this.ghost ? `let ghostScale = 0.5;` : `let ghostScale = 1.0;`}
  let opacity = clamp(best_color.a, 0.0, 1.0) * ghostScale;
  return vec4<f32>(col * opacity, opacity);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.n; out[off + 1] = 1.0; out[off + 2] = this.sh; out[off + 3] = this.ka;
    out[off + 4] = this.kd; out[off + 5] = this.ks; out[off + 6] = this.maxR; out[off + 7] = -1;
    out[off + 8] = this.light[0]; out[off + 9] = this.light[1]; out[off + 10] = this.light[2];
    out.set(this.segA, off + 12);
    out.set(this.segB, off + 12 + MAX * 4);
    out.set(this.colors, off + 12 + MAX * 8);
  }
}
