// Linear transform widget (rotation + translation) for a volume — the port of the vtk.js
// TransformWidgetDM (viewer/slicerlive.js), extended from translate-only to translate+rotate,
// on the WebGPU field renderer. It edits a rigid worldFromLocal matrix on a target ImageField
// via setWorldTransform; each drag is Tier-A (syncUniforms, no rebuild). Handles are rendered
// as a FiducialField in the same ray-march; picking/drag is the shared grab-or-bubble
// widget-control. Registration-style: nudge/spin one volume relative to another.
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import type { ImageField } from "../fields.ts";
import { applyMat4, identity, type Mat4, type Vec3, multiply, rotationAboutAxis, translation } from "../mat4.ts";

export type XMeta =
  | { kind: "translate-cam" }                 // free translate in the camera plane (centre)
  | { kind: "translate-axis"; axis: 0 | 1 | 2 } // translate along one RAS axis
  | { kind: "rotate"; axis: 0 | 1 | 2 };        // rotate about one RAS axis, about the volume centre

export interface XHandle { id: number; world: Vec3; data: XMeta; cursor: string }

const E: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const AXCOL: [number, number, number][] = [[1, 0.35, 0.35], [0.4, 0.95, 0.45], [0.5, 0.6, 1]]; // R/A/S
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const reject = (v: Vec3, axis: Vec3): Vec3 => sub(v, scale(axis, dot(v, axis)));   // component ⊥ axis

export interface XformWidget {
  handles: FiducialField;
  handleList(): XHandle[];
  beginDrag(): void;
  drag(meta: XMeta, startWorld: Vec3, world: Vec3): void;
  setHover(i: number | null): void;
  matrix(): Mat4;
}

export function makeXformWidget(target: ImageField, sizeMm: number): XformWidget {
  const C0 = target.worldCenter();
  const hR = Math.max(3, sizeMm * 0.02);
  const Lt = sizeMm * 0.5;    // translate handles along each axis
  const Lr = sizeMm * 0.72;   // rotate handles further out, on a ring
  let M: Mat4 = identity();
  let M0: Mat4 = identity();
  let pivot0: Vec3 = [...C0] as Vec3;
  let hover: number | null = null;

  const metas: XMeta[] = [
    { kind: "translate-cam" },
    { kind: "translate-axis", axis: 0 }, { kind: "translate-axis", axis: 1 }, { kind: "translate-axis", axis: 2 },
    { kind: "rotate", axis: 0 }, { kind: "rotate", axis: 1 }, { kind: "rotate", axis: 2 },
  ];

  const pivot = (): Vec3 => applyMat4(M, C0);
  const worldOf = (m: XMeta): Vec3 => {
    const p = pivot();
    if (m.kind === "translate-cam") return p;
    if (m.kind === "translate-axis") return [p[0] + Lt * E[m.axis][0], p[1] + Lt * E[m.axis][1], p[2] + Lt * E[m.axis][2]];
    const e = E[(m.axis + 1) % 3];                         // rotate handle sits on a perpendicular
    return [p[0] + Lr * e[0], p[1] + Lr * e[1], p[2] + Lr * e[2]];
  };
  const colorOf = (m: XMeta, on: boolean): [number, number, number, number] => {
    if (on) return [1, 0.9, 0.3, 1];
    if (m.kind === "translate-cam") return [0.9, 0.9, 0.9, 1];
    const c = AXCOL[m.axis];
    return m.kind === "rotate" ? [c[0], c[1], c[2], 1] : [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, 1];
  };

  const handles = new FiducialField([], { shininess: 60, kSpecular: 0.4, screenSpace: true, ghost: true });
  const refresh = () => handles.setSpheres(metas.map((m, i): Sphere => {
    const on = i === hover;
    const c = colorOf(m, on);
    return { center: worldOf(m), radius: on ? 13 : 8, color: [c[0], c[1], c[2], on ? 1 : 0.5] };
  }));
  refresh();

  return {
    handles,
    handleList: () => metas.map((m, i) => ({ id: i, world: worldOf(m), data: m, cursor: m.kind === "rotate" ? "grab" : "move" })),
    beginDrag() { M0 = M.slice() as Mat4; pivot0 = pivot(); },
    drag(meta, P0, W) {
      if (meta.kind === "translate-cam") {
        M = multiply(translation(sub(W, P0)), M0);
      } else if (meta.kind === "translate-axis") {
        const d = dot(sub(W, P0), E[meta.axis]);
        M = multiply(translation(scale(E[meta.axis], d)), M0);
      } else {
        const a = E[meta.axis];
        const v0 = norm(reject(sub(P0, pivot0), a));
        const v1 = norm(reject(sub(W, pivot0), a));
        const ang = Math.atan2(dot(a, cross(v0, v1)), dot(v0, v1));
        const Rp = multiply(translation(pivot0), multiply(rotationAboutAxis(a, ang), translation(scale(pivot0, -1))));
        M = multiply(Rp, M0);
      }
      target.setWorldTransform(M);
      refresh();
    },
    setHover(i) { hover = i; refresh(); },
    matrix: () => M.slice() as Mat4,
  };
}
