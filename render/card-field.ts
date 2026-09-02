// CardField — a text/glass "label card" as a first-class ray-march Field (not a screen overlay). The
// card is a camera-facing GLASS SLAB with real thickness: the compositor marches it together with the
// anatomy, so overlapping/intersecting cards resolve by depth for free, and the frosted look falls out
// of the march (a translucent slab dims/tints whatever is behind it). Text/swatch/buttons are baked into
// a small RGBA texture (alpha = "ink") and read in the sample function on the FRONT face: a ray that hits
// a glyph returns opaque ink, a ray that misses passes through the glass and shows the background.
//
// Tier 1 (this file): rounded slab + embedded ink + Beer–Lambert frosted glass. Tier 2 (later): refract
// the ray at the interface (per-channel IOR for prismatic glints) + a roughness cone for true blur —
// that needs the compositor to bend/scatter the ray, so it is a renderer feature, not a field tweak.
//
// Billboarding: the slab's centre + (u,v,n) frame + half-extents are pushed every frame via setBillboard
// (Tier-A syncUniforms, no rebuild). aabb() is a large STATIC box (the skip leaps the empty space, so a
// generous box costs nothing) because the compositor bakes aabb at build() time.

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

export interface CardFieldOpts {
  aabb: [Vec3, Vec3];                 // large static world box covering all billboard positions
  glassOpacity?: number;              // total frosted opacity through the slab (default 0.8)
  glassRGB?: [number, number, number];// frosted tint (default near-white)
  cornerMm?: number;                  // rounded-corner radius (world mm at the card's scale)
  inkFrontMm?: number;                // ink lives within this depth of the front face (default ~1 step)
}

export class CardField implements Field {
  readonly kind = "card";
  readonly bindingCount = 1;          // baked RGBA content texture (2d), shares the linear sampler
  readonly clippable = false;         // cards are not ROI-cropped
  readonly providesSkip = true;       // SDF slab → sphere-trace to it, leap empty space

  private tex: GPUTexture;
  private box: [Vec3, Vec3];
  private c: Vec3 = [0, 0, 0];
  private u: Vec3 = [1, 0, 0]; private hu = 10;
  private v: Vec3 = [0, 1, 0]; private hv = 10;
  private n: Vec3 = [0, 0, 1]; private ht = 5;
  private glassOpacity: number;
  private glassRGB: [number, number, number];
  private cornerMm: number;
  private inkFrontMm: number;

  constructor(tex: GPUTexture, opts: CardFieldOpts) {
    this.tex = tex;
    this.box = opts.aabb;
    this.glassOpacity = opts.glassOpacity ?? 0.8;
    this.glassRGB = opts.glassRGB ?? [0.97, 0.97, 0.98];
    this.cornerMm = opts.cornerMm ?? 0;
    this.inkFrontMm = opts.inkFrontMm ?? 0;
  }

  /** Place/orient the slab this frame. center world (RAS); u,v unit in-plane axes; n unit toward camera;
   *  hu,hv in-plane half-extents (mm); halfThick slab half-thickness (mm). */
  setBillboard(center: Vec3, u: Vec3, v: Vec3, n: Vec3, hu: number, hv: number, halfThick: number, cornerMm?: number) {
    this.c = center; this.u = u; this.v = v; this.n = n; this.hu = hu; this.hv = hv; this.ht = halfThick;
    if (cornerMm !== undefined) this.cornerMm = cornerMm;
    if (this.inkFrontMm === 0) this.inkFrontMm = Math.max(0.5, halfThick);   // default: ink across the front half
  }
  setTexture(tex: GPUTexture, destroyPrev = true) { if (destroyPrev && this.tex !== tex) this.tex.destroy(); this.tex = tex; }
  get texture(): GPUTexture { return this.tex; }

  uniformFloats() { return 24; }       // center(4) u(4) v(4) n(4) params(4) tint(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return Math.max(0.4, this.ht * 0.5); }   // a few samples through the slab

  structMembers(s: number): string {
    return [
      `  card${s}_center : vec4<f32>,`,
      `  card${s}_u : vec4<f32>,`,      // xyz axis, w = half-extent u
      `  card${s}_v : vec4<f32>,`,      // xyz axis, w = half-extent v
      `  card${s}_n : vec4<f32>,`,      // xyz axis (toward camera), w = half-thickness
      `  card${s}_params : vec4<f32>,`, // glassDensity(1/mm), inkFrontMm, cornerMm, _
      `  card${s}_tint : vec4<f32>,`,   // frosted rgb, _
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return `@group(0) @binding(${base}) var t_card${s} : texture_2d<f32>;`;
  }

  skipWGSL(s: number): string {
    return /* wgsl */ `
fn skip_card${s}(wp : vec3<f32>) -> f32 {
  let d = wp - u_material.card${s}_center.xyz;
  let pu = dot(d, u_material.card${s}_u.xyz);
  let pv = dot(d, u_material.card${s}_v.xyz);
  let pn = dot(d, u_material.card${s}_n.xyz);
  let q = vec3<f32>(abs(pu) - u_material.card${s}_u.w, abs(pv) - u_material.card${s}_v.w, abs(pn) - u_material.card${s}_n.w);
  let sd = length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);   // sdBox (neg inside)
  return max(0.0, sd);
}`;
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sample_field_card${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let d = wp - u_material.card${s}_center.xyz;
  let pu = dot(d, u_material.card${s}_u.xyz);
  let pv = dot(d, u_material.card${s}_v.xyz);
  let pn = dot(d, u_material.card${s}_n.xyz);
  let hu = u_material.card${s}_u.w; let hv = u_material.card${s}_v.w; let ht = u_material.card${s}_n.w;
  if (abs(pn) > ht) { return vec4<f32>(0.0); }
  // rounded-rect mask in the plane (mm): outside → no card here
  let r = u_material.card${s}_params.z;
  let qp = vec2<f32>(abs(pu) - (hu - r), abs(pv) - (hv - r));
  let rd2 = min(max(qp.x, qp.y), 0.0) + length(max(qp, vec2<f32>(0.0))) - r;
  if (rd2 > 0.0) { return vec4<f32>(0.0); }
  let uv = vec2<f32>(pu / hu * 0.5 + 0.5, 0.5 - pv / hv * 0.5);
  let baked = textureSampleLevel(t_card${s}, s_lin, uv, 0.0);   // (rgb, a); a>0.5 = ink (text/swatch/buttons/border)
  let atFront = pn > (ht - u_material.card${s}_params.y);
  if (atFront && baked.a > 0.5) {                              // opaque ink on the front face
    return vec4<f32>(srgb2physical(baked.rgb), 1.0);
  }
  // frosted glass body: Beer–Lambert white per step, background shows through the residual alpha
  let step = u_material.scene.x;
  let a = 1.0 - exp(-u_material.card${s}_params.x * step);
  if (a <= 0.0001) { return vec4<f32>(0.0); }
  return vec4<f32>(srgb2physical(u_material.card${s}_tint.xyz) * a, a);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.c[0]; out[off + 1] = this.c[1]; out[off + 2] = this.c[2];
    out[off + 4] = this.u[0]; out[off + 5] = this.u[1]; out[off + 6] = this.u[2]; out[off + 7] = this.hu;
    out[off + 8] = this.v[0]; out[off + 9] = this.v[1]; out[off + 10] = this.v[2]; out[off + 11] = this.hv;
    out[off + 12] = this.n[0]; out[off + 13] = this.n[1]; out[off + 14] = this.n[2]; out[off + 15] = this.ht;
    // total opacity O through thickness 2·ht ⇒ density = -ln(1-O) / (2·ht)
    const dens = -Math.log(Math.max(1e-3, 1 - this.glassOpacity)) / Math.max(1e-3, 2 * this.ht);
    out[off + 16] = dens; out[off + 17] = Math.max(this.inkFrontMm, this.ht * 0.5); out[off + 18] = this.cornerMm; out[off + 19] = 0;
    out[off + 20] = this.glassRGB[0]; out[off + 21] = this.glassRGB[1]; out[off + 22] = this.glassRGB[2]; out[off + 23] = 0;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [{ binding: base, resource: this.tex.createView() }];
  }
}
