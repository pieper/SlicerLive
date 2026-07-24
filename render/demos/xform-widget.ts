// Linear transform GIZMO widget (rotation + translation) for a volume — a classic
// transform gizmo (RGB axis arrows + RGB rotation rings + centre) drawn by
// TransformGizmoField, driven by the shared grab-or-bubble widget-control. It edits a rigid
// worldFromLocal matrix on a target ImageField via setWorldTransform; each drag is Tier-A
// (syncUniforms, no rebuild). Registration-style: nudge/spin one volume relative to another.
//
// The gizmo is screen-constant size and its picking must match, so handleList(scale) places
// the invisible pick points at the same world scale the shader draws the glyphs.
import type { ImageField } from "../fields.ts";
import { TransformGizmoField } from "../transform-gizmo-field.ts";
import { applyMat4, identity, type Mat4, type Vec3, multiply, rotationAboutAxis, translation } from "../mat4.ts";

export type XMeta =
  | { kind: "translate-cam" }                   // centre: free translate in the camera plane
  | { kind: "translate-axis"; axis: 0 | 1 | 2 } // arrow: translate along one RAS axis
  | { kind: "rotate"; axis: 0 | 1 | 2 };        // ring: rotate about one RAS axis, about the centre

export interface XHandle { id: number; world: Vec3; data: XMeta; cursor: string }

const E: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const reject = (v: Vec3, axis: Vec3): Vec3 => sub(v, scale(axis, dot(v, axis)));

/** Gizmo component id (0..2 arrows, 3..5 rings, 6 centre) that a handle highlights. */
export function componentOf(m: XMeta): number {
  if (m.kind === "translate-cam") return 6;
  if (m.kind === "translate-axis") return m.axis;
  return m.axis + 3;
}

export interface XformWidget {
  field: TransformGizmoField;
  pivotWorld(): Vec3;
  /** World units per gizmo-unit for the current camera, so pick points match the drawn size. */
  scaleFor(eye: Vec3, focalPx: number): number;
  handleList(worldScale: number): XHandle[];
  beginDrag(): void;
  drag(meta: XMeta, startWorld: Vec3, world: Vec3): void;
  setActive(id: number | null): void;
  matrix(): Mat4;
}

export function makeXformWidget(target: ImageField, _sizeMm: number): XformWidget {
  const C0 = target.worldCenter();
  const field = new TransformGizmoField(C0, 58);   // 58 px on-screen radius
  let M: Mat4 = identity();
  let M0: Mat4 = identity();
  let pivot0: Vec3 = [...C0] as Vec3;

  const pivot = (): Vec3 => applyMat4(M, C0);

  return {
    field,
    pivotWorld: () => pivot(),
    scaleFor(eye, focalPx) { const p = pivot(); return field.pxSize * Math.hypot(eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]) / Math.max(focalPx, 1); },
    handleList(S) {
      const p = pivot();
      const at = (off: Vec3): Vec3 => [p[0] + off[0] * S, p[1] + off[1] * S, p[2] + off[2] * S];
      const hs: XHandle[] = [];
      let id = 0;
      hs.push({ id: id++, world: p, data: { kind: "translate-cam" }, cursor: "move" });        // centre
      for (let a = 0; a < 3; a++) hs.push({ id: id++, world: at(scale(E[a], 0.5)), data: { kind: "translate-axis", axis: a as 0 | 1 | 2 }, cursor: "move" });   // arrows
      // Ring pick points sit on each ring's DIAGONALS (45° between its two perpendicular
      // axes). Axis-aligned points would be AMBIGUOUS — two rings share each axis direction
      // (the X and Y rings both pass through ±Z), so a pick there could grab the wrong ring
      // and dragging it along its own axis does nothing. Diagonals are unique per ring.
      const k = 0.92 / Math.SQRT2;
      for (let a = 0; a < 3; a++) {
        const p1 = E[(a + 1) % 3], p2 = E[(a + 2) % 3];
        for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const off: Vec3 = [(p1[0] * s1 + p2[0] * s2) * k, (p1[1] * s1 + p2[1] * s2) * k, (p1[2] * s1 + p2[2] * s2) * k];
          hs.push({ id: id++, world: at(off), data: { kind: "rotate", axis: a as 0 | 1 | 2 }, cursor: "grab" });
        }
      }
      return hs;
    },
    beginDrag() { M0 = M.slice() as Mat4; pivot0 = pivot(); },
    drag(meta, P0, W) {
      if (meta.kind === "translate-cam") {
        M = multiply(translation(sub(W, P0)), M0);
      } else if (meta.kind === "translate-axis") {
        M = multiply(translation(scale(E[meta.axis], dot(sub(W, P0), E[meta.axis]))), M0);
      } else {
        const a = E[meta.axis];
        const v0 = norm(reject(sub(P0, pivot0), a));
        const v1 = norm(reject(sub(W, pivot0), a));
        const ang = Math.atan2(dot(a, cross(v0, v1)), dot(v0, v1));
        const Rp = multiply(translation(pivot0), multiply(rotationAboutAxis(a, ang), translation(scale(pivot0, -1))));
        M = multiply(Rp, M0);
      }
      target.setWorldTransform(M);
      field.setPivot(pivot());
    },
    setActive(id) { field.setActive(id); },
    matrix: () => M.slice() as Mat4,
  };
}
