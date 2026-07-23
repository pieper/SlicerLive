// FiducialField — a fixed-capacity array of solid spheres (markup control points)
// rendered procedurally in the ray-march: no geometry buffer, no texture. A TS/WebGPU
// port of slicer_wgpu's FiducialField, adapted to SlicerLive's Field contract (each
// sample returns a PREMULTIPLIED vec4). Plastic-Phong headlight shading reads like a
// pushpin head against the volume. This is also the field nnLive click-points will use.

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

const MAX = 64; // spheres per field; fixed at WGSL-generation time (uniform array size)

export interface Sphere { center: Vec3; radius: number; color: [number, number, number, number] }

export interface FiducialOpts {
  shininess?: number;
  kAmbient?: number;
  kDiffuse?: number;
  kSpecular?: number;
  lightColor?: Vec3;
}

export class FiducialField implements Field {
  readonly kind = "fid";
  readonly bindingCount = 0;            // procedural — all state lives in the uniform block
  private spheres = new Float32Array(MAX * 4); // (cx,cy,cz,radius)
  private colors = new Float32Array(MAX * 4);  // (r,g,b,a)
  private n = 0;
  private sh: number;
  private ka: number;
  private kd: number;
  private ks: number;
  private light: Vec3;

  constructor(spheres: Sphere[] = [], opts: FiducialOpts = {}) {
    this.setSpheres(spheres);
    this.sh = opts.shininess ?? 80;
    this.ka = opts.kAmbient ?? 0.2;
    this.kd = opts.kDiffuse ?? 0.85;
    this.ks = opts.kSpecular ?? 0.5;
    this.light = opts.lightColor ?? [1, 1, 1];
  }

  setSpheres(list: Sphere[]) {
    this.n = Math.min(list.length, MAX);
    this.spheres.fill(0);
    this.colors.fill(0);
    for (let i = 0; i < this.n; i++) {
      const s = list[i];
      this.spheres.set([s.center[0], s.center[1], s.center[2], s.radius], i * 4);
      this.colors.set(s.color, i * 4);
    }
  }

  get count(): number { return this.n; }

  uniformFloats(): number { return 12 + MAX * 4 * 2; } // params(4)+params2(4)+light(4) + spheres + colors
  sampleStep(): number { return 1.0; }

  aabb(): [Vec3, Vec3] {
    if (this.n === 0) return [[-1, -1, -1], [1, 1, 1]];
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.n; i++) {
      const r = this.spheres[i * 4 + 3];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], this.spheres[i * 4 + a] - r);
        hi[a] = Math.max(hi[a], this.spheres[i * 4 + a] + r);
      }
    }
    return [lo, hi];
  }

  structMembers(s: number): string {
    return [
      `  fid${s}_params : vec4<f32>,`,   // n_spheres, visible, shininess, k_ambient
      `  fid${s}_params2 : vec4<f32>,`,  // k_diffuse, k_specular, _, _
      `  fid${s}_light : vec4<f32>,`,    // light_color.rgb, _
      `  fid${s}_spheres : array<vec4<f32>, ${MAX}>,`,
      `  fid${s}_colors : array<vec4<f32>, ${MAX}>,`,
    ].join("\n");
  }

  declareBindings(_s: number, _base: number): string { return ""; }
  bindEntries(_s: number, _base: number): GPUBindGroupEntry[] { return []; }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sample_field_fid${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  // an attached TransformField warps where the spheres appear (slicer_wgpu parity)
  let wp_r = transform_point_fid${s}(wp);
  let n = i32(u_material.fid${s}_params.x);
  var best_depth = -1.0;
  var best_center = vec3<f32>(0.0);
  var best_color = vec4<f32>(0.0);
  var found = false;
  for (var k = 0; k < n; k = k + 1) {
    let sp = u_material.fid${s}_spheres[k];
    let r = sp.w;
    if (r <= 0.0) { continue; }
    let depth = r - length(wp_r - sp.xyz);   // > 0 -> inside this sphere
    if (depth > best_depth) { best_depth = depth; best_center = sp.xyz; best_color = u_material.fid${s}_colors[k]; found = true; }
  }
  if (!found || best_depth <= 0.0) { return vec4<f32>(0.0); }

  let to_wp = wp_r - best_center;
  var n_hat = to_wp / max(length(to_wp), 1e-6);
  if (dot(n_hat, -rd) < 0.0) { n_hat = -n_hat; }
  let view_dir = normalize(-rd);            // headlight (== normalize(ray_origin - wp) for t>0)
  let ldotn = max(dot(view_dir, n_hat), 0.0);
  let refl = normalize(2.0 * ldotn * n_hat - view_dir);
  let rdotv = max(dot(refl, view_dir), 0.0);

  let sh = u_material.fid${s}_params.z;
  let ka = u_material.fid${s}_params.w; let kd = u_material.fid${s}_params2.x; let ks = u_material.fid${s}_params2.y;
  let base = best_color.rgb;
  let highlight = mix(base, u_material.fid${s}_light.rgb, 0.85);
  let lit = base * ka + base * (kd * ldotn) + highlight * (ks * pow(rdotv, sh));
  let col = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  let opacity = clamp(best_color.a, 0.0, 1.0);
  return vec4<f32>(col * opacity, opacity);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.n; out[off + 1] = 1.0; out[off + 2] = this.sh; out[off + 3] = this.ka;
    out[off + 4] = this.kd; out[off + 5] = this.ks;
    out[off + 8] = this.light[0]; out[off + 9] = this.light[1]; out[off + 10] = this.light[2];
    out.set(this.spheres, off + 12);
    out.set(this.colors, off + 12 + MAX * 4);
  }
}
