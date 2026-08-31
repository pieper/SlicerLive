// SlicePlaneField — the "Slice Model" / Drop-Slice: shows a slice view as a textured plane at its correct
// anatomical (RAS) location in the 3D scene. It is a ray-march Field that samples the SHARED volume texture,
// but contributes only inside a thin slab of the slice plane and within the slice's rectangular extent, so a
// ray that crosses the plane picks up the resliced image (opaque). Hot-updatable: setPlane() rewrites the
// uniforms in place (Tier-A, no pipeline rebuild), so scrolling the slice moves/updates the 3D plane live.
// Grayscale via window/level (matches the slice view's W/L); the volume texture is shared with the ImageField.
import type { Field } from "./fields.ts";
import type { Mat4, Vec3 } from "./mat4.ts";

export interface SlicePlaneOpts {
  p2t: Mat4;                 // RAS -> volume texture[0,1] (the volume's patientToTexture)
  origin: Vec3;             // a point on the plane (the slice centre, RAS)
  normal: Vec3;             // unit plane normal (RAS)
  uAxis: Vec3;              // unit in-plane axis (screen right, RAS)
  vAxis: Vec3;              // unit in-plane axis (screen up, RAS)
  halfExtU: number;         // half the plane's width along uAxis (mm)
  halfExtV: number;         // half the plane's height along vAxis (mm)
  clim: [number, number];   // window/level as [lo, hi]
  halfThick?: number;       // slab half-thickness (mm); default 0.5
  normScale?: number;       // r8unorm volumes sample /255 -> clim packed /normScale (like ImageField)
}

export class SlicePlaneField implements Field {
  readonly kind = "slice";
  readonly bindingCount = 1;      // shared volume texture (3d)
  readonly clippable = false;     // a dropped slice isn't cropped by ROI clip planes
  readonly providesSkip = true;

  private volTex: GPUTexture;
  private o: SlicePlaneOpts;
  private halfThick: number;
  private normScale: number;

  constructor(volTex: GPUTexture, opts: SlicePlaneOpts) {
    this.volTex = volTex;
    this.o = opts;
    this.halfThick = opts.halfThick ?? 0.5;
    this.normScale = opts.normScale ?? 1;
  }

  /** Hot update: re-place the plane (scroll/pan/zoom) and/or re-window. Repacked on the next syncUniforms(). */
  setPlane(opts: Partial<SlicePlaneOpts>) { this.o = { ...this.o, ...opts }; if (opts.halfThick !== undefined) this.halfThick = opts.halfThick; }
  setClim(lo: number, hi: number) { this.o.clim = [lo, hi]; }

  uniformFloats() { return 36; }   // mat4(16) + origin/thick(4) + normal(4) + uAxis/extU(4) + vAxis/extV(4) + clim(4)
  sampleStep(): number { return Math.max(0.25, this.halfThick); }

  aabb(): [Vec3, Vec3] {
    // corners of the quad ± the slab thickness along the normal
    const { origin: c, uAxis: u, vAxis: v, normal: n, halfExtU: hu, halfExtV: hv } = this.o;
    const t = this.halfThick;
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const su of [-1, 1]) for (const sv of [-1, 1]) for (const sn of [-1, 1]) {
      for (let a = 0; a < 3; a++) {
        const p = c[a] + su * hu * u[a] + sv * hv * v[a] + sn * t * n[a];
        if (p < lo[a]) lo[a] = p; if (p > hi[a]) hi[a] = p;
      }
    }
    return [lo, hi];
  }

  structMembers(s: number): string {
    return [
      `  slice${s}_p2t : mat4x4<f32>,`,
      `  slice${s}_origin : vec4<f32>,`,   // ox,oy,oz, halfThick
      `  slice${s}_normal : vec4<f32>,`,   // nx,ny,nz, _
      `  slice${s}_u : vec4<f32>,`,        // ux,uy,uz, halfExtU
      `  slice${s}_v : vec4<f32>,`,        // vx,vy,vz, halfExtV
      `  slice${s}_clim : vec4<f32>,`,     // lo, hi, _, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return `@group(0) @binding(${base}) var t_vol_slice${s} : texture_3d<f32>;`;
  }

  skipWGSL(s: number): string {
    return /* wgsl */ `
fn skip_slice${s}(wp : vec3<f32>) -> f32 {
  let d = abs(dot(wp - u_material.slice${s}_origin.xyz, u_material.slice${s}_normal.xyz)) - u_material.slice${s}_origin.w;
  return max(d, 0.0);
}`;
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sample_field_slice${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let rel = wp - u_material.slice${s}_origin.xyz;
  if (abs(dot(rel, u_material.slice${s}_normal.xyz)) > u_material.slice${s}_origin.w) { return vec4<f32>(0.0); }
  let pu = dot(rel, u_material.slice${s}_u.xyz);
  let pv = dot(rel, u_material.slice${s}_v.xyz);
  if (abs(pu) > u_material.slice${s}_u.w || abs(pv) > u_material.slice${s}_v.w) { return vec4<f32>(0.0); }
  let t4 = u_material.slice${s}_p2t * vec4<f32>(wp, 1.0);
  if (any(t4.xyz < vec3<f32>(0.0)) || any(t4.xyz > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let val = textureSampleLevel(t_vol_slice${s}, s_lin, t4.xyz, 0.0).r;
  let lo = u_material.slice${s}_clim.x; let hi = u_material.slice${s}_clim.y;
  let g = clamp((val - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
  let lin = srgb2physical(vec3<f32>(g, g, g));   // opaque grayscale slice
  return vec4<f32>(lin, 1.0);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    const { p2t, origin: c, normal: n, uAxis: u, vAxis: v, halfExtU: hu, halfExtV: hv, clim } = this.o;
    out.set(p2t, off);
    out[off + 16] = c[0]; out[off + 17] = c[1]; out[off + 18] = c[2]; out[off + 19] = this.halfThick;
    out[off + 20] = n[0]; out[off + 21] = n[1]; out[off + 22] = n[2];
    out[off + 24] = u[0]; out[off + 25] = u[1]; out[off + 26] = u[2]; out[off + 27] = hu;
    out[off + 28] = v[0]; out[off + 29] = v[1]; out[off + 30] = v[2]; out[off + 31] = hv;
    out[off + 32] = clim[0] / this.normScale; out[off + 33] = clim[1] / this.normScale;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [{ binding: base, resource: this.volTex.createView() }];
  }
}
