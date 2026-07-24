// RoiBoxField — an axis-aligned ROI box drawn as a wireframe FRAME, ray-marched in the
// same pass as the volume so the box occludes and is occluded correctly (no separate
// widget pass). It pairs with SceneRenderer.setClipBox: the box shows WHERE the volume is
// cropped, and one syncUniforms updates both the wireframe and the clip planes together —
// the event→state→render tight loop of ARCHITECTURE-2026-07-24 §6.4.
//
// Not clippable (clippable=false): the frame lies on the clip planes, so it must not be
// cropped by them. Provides a skip: the box-frame SDF is extremely sparse, so a ray leaps
// between edges (the case empty-space skipping was built for), making the widget near-free.
//
// The bars are drawn flat/unlit (the Slicer widget look) as a crisp opaque frame via the
// exact box-frame signed distance (Inigo Quilez's sdBoxFrame).

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

export interface RoiBoxOpts {
  color?: [number, number, number];
  opacity?: number;
  barHalfMm?: number;    // half-thickness of the wireframe bars (mm); default 1.5
}

export class RoiBoxField implements Field {
  readonly kind = "roi";
  readonly bindingCount = 0;         // procedural — all state in the uniform block
  readonly clippable = false;        // the frame sits on the clip planes; never clip it
  readonly providesSkip = true;      // sparse SDF -> cheap via empty-space skipping
  private center: Vec3;
  private half: Vec3;
  private color: [number, number, number];
  private opacity: number;
  private bar: number;

  constructor(center: Vec3, half: Vec3, opts: RoiBoxOpts = {}) {
    this.center = [...center] as Vec3;
    this.half = [...half] as Vec3;
    this.color = opts.color ?? [1, 0.85, 0.25];
    this.opacity = opts.opacity ?? 1;
    this.bar = opts.barHalfMm ?? 1.5;
  }

  /** Update the box (a drag) — caller does scene.syncUniforms() + redraw. */
  setBox(center: Vec3, half: Vec3) { this.center = [...center] as Vec3; this.half = [...half] as Vec3; }
  get boxCenter(): Vec3 { return [...this.center] as Vec3; }
  get boxHalf(): Vec3 { return [...this.half] as Vec3; }

  uniformFloats() { return 16; }     // center(4) + half(4) + color(4) + params(4)
  sampleStep(): number { return Math.max(0.5 * this.bar, 0.25); }
  aabb(): [Vec3, Vec3] {
    const m = this.bar + 0.5;
    return [
      [this.center[0] - this.half[0] - m, this.center[1] - this.half[1] - m, this.center[2] - this.half[2] - m],
      [this.center[0] + this.half[0] + m, this.center[1] + this.half[1] + m, this.center[2] + this.half[2] + m],
    ];
  }

  structMembers(s: number): string {
    return [
      `  roi${s}_center : vec4<f32>,`,   // cx,cy,cz,_
      `  roi${s}_half : vec4<f32>,`,     // hx,hy,hz,_
      `  roi${s}_color : vec4<f32>,`,    // rgb, opacity
      `  roi${s}_params : vec4<f32>,`,   // bar_half, _, _, _
    ].join("\n");
  }

  declareBindings(): string { return ""; }
  bindEntries(): GPUBindGroupEntry[] { return []; }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sd_box_frame${s}(p0 : vec3<f32>, b : vec3<f32>, e : f32) -> f32 {
  let p = abs(p0) - b;
  let q = abs(p + vec3<f32>(e)) - vec3<f32>(e);
  return min(min(
    length(max(vec3<f32>(p.x, q.y, q.z), vec3<f32>(0.0))) + min(max(p.x, max(q.y, q.z)), 0.0),
    length(max(vec3<f32>(q.x, p.y, q.z), vec3<f32>(0.0))) + min(max(q.x, max(p.y, q.z)), 0.0)),
    length(max(vec3<f32>(q.x, q.y, p.z), vec3<f32>(0.0))) + min(max(q.x, max(q.y, p.z)), 0.0));
}
fn sd_roi${s}(wp : vec3<f32>) -> f32 {
  return sd_box_frame${s}(wp - u_material.roi${s}_center.xyz, u_material.roi${s}_half.xyz, u_material.roi${s}_params.x);
}
fn skip_roi${s}(wp : vec3<f32>) -> f32 {
  // exact exterior distance to the bars, minus a bar-width margin (stays conservative)
  return max(sd_roi${s}(wp) - u_material.roi${s}_params.x, 0.0);
}
fn sample_field_roi${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let op0 = u_material.roi${s}_color.a;
  if (op0 <= 0.0) { return vec4<f32>(0.0); }
  let sd = sd_roi${s}(wp);
  // crisp opaque bar: ~1 inside, AA-ramp to 0 across ~half a sample step at the surface
  let op = clamp(0.5 - sd / max(u_material.scene.x, 1e-3), 0.0, 1.0) * op0;
  if (op <= 0.0) { return vec4<f32>(0.0); }
  let col = srgb2physical(u_material.roi${s}_color.rgb);   // flat/unlit, the Slicer widget look
  return vec4<f32>(col * op, op);
}`;
  }

  skipWGSL(s: number): string { return ""; }   // skip_roi<s> is emitted by samplingWGSL above

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.center[0]; out[off + 1] = this.center[1]; out[off + 2] = this.center[2];
    out[off + 4] = this.half[0]; out[off + 5] = this.half[1]; out[off + 6] = this.half[2];
    out[off + 8] = this.color[0]; out[off + 9] = this.color[1]; out[off + 10] = this.color[2]; out[off + 11] = this.opacity;
    out[off + 12] = this.bar;
  }
}
