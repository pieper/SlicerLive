// TransformGizmoField — a classic transform GIZMO (Blender/Unity/Maya/Slicer style) drawn
// procedurally in the ray-march: 3 RGB axis ARROWS (translate), 3 RGB RINGS (rotate), and a
// white CENTRE sphere (view-plane translate). Colours follow the universal convention (and
// Slicer's RAS): X/R=red, Y/A=green, Z/S=blue.
//
// It follows the gizmo conventions the user asked about:
//   * SCREEN-CONSTANT size — the whole gizmo scales with camera distance so it stays a fixed
//     on-screen size (always grabbable), computed in-shader from the Camera eye + focal.
//   * DEGENERATE-AXIS FADE (Slicer's vtkMRMLInteractionWidgetRepresentation::GetHandleOpacity):
//     an arrow fades as its axis points at the camera (head-on -> a dot); a ring fades as its
//     axis approaches edge-on (a line). Computed in-shader from the view vector.
//   * ACTIVE HIGHLIGHT — the hovered/dragged component (set via setActive) goes full opacity
//     and a saturated colour; everything else is 50% opaque (inactive, less distracting).
//   * GHOST x-ray (ghost=true) — the gizmo dims what's in front of it so it's never lost
//     behind the volume, the on-top/see-through behaviour every gizmo uses.
//
// Not clippable, no skip (screen-space size varies with the camera). Component ids:
// 0..2 arrows, 3..5 rings, 6 centre — matching the widget's handle→component mapping.
import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

export class TransformGizmoField implements Field {
  readonly kind = "giz";
  readonly bindingCount = 0;
  readonly clippable = false;
  readonly ghost = true;
  readonly providesSkip = true;
  private pivot: Vec3;
  private px: number;      // on-screen gizmo size, in pixels (radius of the rings ~ this)
  private active = -1;     // highlighted component (0..6) or -1

  constructor(pivot: Vec3, pxSize = 60) { this.pivot = [...pivot] as Vec3; this.px = pxSize; }

  setPivot(p: Vec3) { this.pivot = [...p] as Vec3; }
  setActive(id: number | null) { this.active = id ?? -1; }
  get pxSize(): number { return this.px; }
  get activeId(): number { return this.active; }

  uniformFloats() { return 8; }   // pivot(4: xyz, pxSize) + params(4: active, _, _, _)
  sampleStep(): number { return 1.0; }
  aabb(): [Vec3, Vec3] {
    const m = 300;   // generous; the ray-entry union is dominated by the volume anyway
    return [[this.pivot[0] - m, this.pivot[1] - m, this.pivot[2] - m], [this.pivot[0] + m, this.pivot[1] + m, this.pivot[2] + m]];
  }

  structMembers(s: number): string {
    return [`  giz${s}_pivot : vec4<f32>,`, `  giz${s}_params : vec4<f32>,`].join("\n");
  }
  declareBindings(): string { return ""; }
  bindEntries(): GPUBindGroupEntry[] { return []; }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
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
  return length(vec2<f32>(rad - 0.92, al)) - 0.045;                   // torus in the plane ⊥ axis
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
  // 3 translation arrows — fade as the axis points at the camera
  for (var a = 0; a < 3; a = a + 1) {
    let dp = abs(dot(vn, giz${s}_axis(a)));
    let fade = 1.0 - smoothstep(0.80, 0.97, dp);
    let on = activeId == a;
    let op = clamp(0.5 - giz${s}_arrow(p, a) / stepg, 0.0, 1.0) * select(0.5 * fade, 1.0, on);
    if (op > best_op) { best_op = op; best_col = giz${s}_color(a, on); }
  }
  // 3 rotation rings — fade as the axis approaches edge-on
  for (var a = 0; a < 3; a = a + 1) {
    let dp = abs(dot(vn, giz${s}_axis(a)));
    let fade = smoothstep(0.06, 0.22, dp);
    let on = activeId == a + 3;
    let op = clamp(0.5 - giz${s}_ring(p, a) / stepg, 0.0, 1.0) * select(0.5 * fade, 1.0, on);
    if (op > best_op) { best_op = op; best_col = giz${s}_color(a, on); }
  }
  // centre sphere — view-plane translate
  {
    let on = activeId == 6;
    let op = clamp(0.5 - (length(p) - 0.08) / stepg, 0.0, 1.0) * select(0.5, 1.0, on);
    if (op > best_op) { best_op = op; best_col = select(vec3<f32>(0.85), vec3<f32>(1.0), on); }
  }
  if (best_op <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>(srgb2physical(best_col) * best_op, best_op);
}`;
  }

  skipWGSL(s: number): string {
    // Conservative distance to the nearest glyph, so a ray leaps between handles once the
    // volume is done. The per-glyph SDFs are lower bounds (arrow = max-of-halfspaces), so
    // scaling the local min by S never over-estimates the world distance.
    return /* wgsl */ `
fn skip_giz${s}(wp : vec3<f32>) -> f32 {
  let pivot = u_material.giz${s}_pivot.xyz;
  let S = u_material.giz${s}_pivot.w * length(u_cam.eye.xyz - pivot) / max(u_cam.size.z, 1.0);
  if (S <= 0.0) { return 1.0e6; }
  let p = (wp - pivot) / S;
  var d = length(p) - 0.08;
  for (var a = 0; a < 3; a = a + 1) { d = min(d, giz${s}_arrow(p, a)); d = min(d, giz${s}_ring(p, a)); }
  return max(d * S, 0.0);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.pivot[0]; out[off + 1] = this.pivot[1]; out[off + 2] = this.pivot[2]; out[off + 3] = this.px;
    out[off + 4] = this.active;
  }
}
