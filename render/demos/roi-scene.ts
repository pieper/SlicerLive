// ROI-crop scene: a volume + an axis-aligned RoiBoxField wireframe + draggable handles.
// The box drives SceneRenderer.setClipBox, so the wireframe and the crop are one node's
// state updated together (ARCHITECTURE-2026-07-24 §6.4). Handle-drag math (face = 1 axis,
// corner = 3, centre = translate) mirrors the vtk.js ROIDM (viewer/slicerlive.js), now on
// the WebGPU field renderer with widget-control doing the picking.
import { ImageField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { RoiBoxField } from "../roi-box-field.ts";
import { loadSceneVolumeField, type SceneVolume } from "../scene-volume.ts";
import type { Vec3 } from "../mat4.ts";

export type HandleMeta =
  | { kind: "center" }
  | { kind: "face"; axis: 0 | 1 | 2; sign: -1 | 1 }
  | { kind: "corner"; s: [number, number, number] };

export interface RoiHandle { id: number; world: Vec3; data: HandleMeta; cursor: string }
export interface Box { center: Vec3; half: Vec3 }

const MIN_HALF = 5;   // mm — never let a side collapse

export interface RoiScene {
  sv: SceneVolume;
  image: ImageField;
  box: RoiBoxField;
  handles: FiducialField;
  center: Vec3;
  half: Vec3;
  lo(): Vec3;
  hi(): Vec3;
  handleList(): RoiHandle[];
  /** Apply a drag of `meta` from the box snapshot `box0` by camera-plane `delta` (RAS mm).
   *  Mutates center/half and refreshes the box + handle fields. */
  applyDrag(meta: HandleMeta, box0: Box, delta: Vec3): void;
  setHover(i: number | null): void;
  snapshot(): Box;
}

export async function buildRoiScene(
  dev: GPUDevice,
  sceneUrl = "https://pieper.github.io/live/scenes/CTACardio.json",
  onBytes?: (n: number) => void,
): Promise<RoiScene> {
  const sv = await loadSceneVolumeField(dev, sceneUrl, onBytes);
  const image = sv.field;
  const [lo, hi] = image.aabb();
  // start at a box covering the middle ~70% so there's obvious room to grow and shrink
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const half: Vec3 = [(hi[0] - lo[0]) * 0.35, (hi[1] - lo[1]) * 0.35, (hi[2] - lo[2]) * 0.35];
  const hR = Math.max(3, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.012);
  const bar = Math.max(1.2, hR * 0.35);

  const box = new RoiBoxField(center, half, { color: [1, 0.85, 0.25], barHalfMm: bar });
  const handles = new FiducialField([], { shininess: 60, kSpecular: 0.4, clippable: false });
  let hover: number | null = null;

  // Handle layout: 6 face centres + 8 corners + 1 centre = 15, in a fixed order so `id`
  // maps stably to a descriptor.
  const metas: HandleMeta[] = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1] as const) metas.push({ kind: "face", axis: axis as 0 | 1 | 2, sign });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) metas.push({ kind: "corner", s: [sx, sy, sz] });
  metas.push({ kind: "center" });

  const worldOf = (m: HandleMeta): Vec3 => {
    if (m.kind === "center") return [...center] as Vec3;
    if (m.kind === "face") { const w = [...center] as Vec3; w[m.axis] += m.sign * half[m.axis]; return w; }
    return [center[0] + m.s[0] * half[0], center[1] + m.s[1] * half[1], center[2] + m.s[2] * half[2]];
  };

  const refreshHandles = () => {
    const pins: Sphere[] = metas.map((m, i): Sphere => {
      const on = i === hover;
      const base: [number, number, number] = m.kind === "center" ? [0.4, 1, 0.5] : [0.35, 0.8, 1];
      return { center: worldOf(m), radius: on ? hR * 1.6 : hR, color: on ? [1, 0.9, 0.3, 1] : [...base, 1] };
    });
    handles.setSpheres(pins);
  };
  refreshHandles();

  // Move one face along its RAS axis, keeping the opposite face fixed; returns [newCenterA, newHalfA].
  const moveFace = (axis: number, sign: number, box0: Box, deltaAxis: number): [number, number] => {
    const opp = box0.center[axis] - sign * box0.half[axis];
    let face = box0.center[axis] + sign * box0.half[axis] + deltaAxis;
    // keep the face on its own side of the opposite face (no flip / collapse)
    face = sign > 0 ? Math.max(face, opp + 2 * MIN_HALF) : Math.min(face, opp - 2 * MIN_HALF);
    return [(face + opp) / 2, Math.abs(face - opp) / 2];
  };

  const scene: RoiScene = {
    sv, image, box, handles, center, half,
    lo: () => [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    hi: () => [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
    handleList: () => metas.map((m, i) => ({
      id: i, world: worldOf(m), data: m,
      cursor: m.kind === "center" ? "move" : "grab",
    })),
    applyDrag(meta, box0, delta) {
      if (meta.kind === "center") {
        for (let a = 0; a < 3; a++) center[a] = box0.center[a] + delta[a];
      } else if (meta.kind === "face") {
        const [c, h] = moveFace(meta.axis, meta.sign, box0, delta[meta.axis]);
        center[meta.axis] = c; half[meta.axis] = h;
      } else {
        for (let a = 0; a < 3; a++) { const [c, h] = moveFace(a, meta.s[a], box0, delta[a]); center[a] = c; half[a] = h; }
      }
      box.setBox(center, half);
      refreshHandles();
    },
    setHover(i) { hover = i; refreshHandles(); },
    snapshot: () => ({ center: [...center] as Vec3, half: [...half] as Vec3 }),
  };
  return scene;
}
