// "Landmark Deform (TPS)" selftest port — on the REAL data the selftest uses.
//
// Faithful to SceneRendering.py test_vtk_LandmarkDeform:
//   * volume      : MRHead (streamed from the JS2 bucket), MR-Default VR transfer function
//   * landmarks   : 8 sources at the volume's BOUNDING-BOX CORNERS
//   * grid        : 24 x 24 x 24, padded 40 mm beyond the bounds on every side
//   * spline      : thin-plate spline with SetBasisToR() -> kernel U(r) = r
//   * interaction : moving a landmark defines its target; the TPS is rebuilt and baked
//                   to a displacement grid, which warps the volume live
//
// The selftest starts at identity (targets == sources) and deforms as the user drags a
// control point. This demo ships a dramatic default deformation (so the card thumbnail
// reads instantly) plus a gain slider, and the magenta target pins are DRAGGABLE:
// setTarget() re-solves the TPS and re-uploads the displacement texture in place (Tier-A,
// no pipeline rebuild — see ARCHITECTURE-2026-07-24 §6.1), driven by widget-control.ts.
import { ImageField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { TransformField, sampleDisplacementGrid, tps3d } from "../transform-field.ts";
import { loadSceneVolumeField, type SceneVolume } from "../scene-volume.ts";
import type { Vec3 } from "../mat4.ts";

export const GRID_DIMS: Vec3 = [24, 24, 24];   // selftest: grid_dims = (24, 24, 24)
export const PAD_MM = 40.0;                    // selftest: pad_mm = 40.0

/** The 8 bounding-box corners, in the selftest's order. */
export function boundsCorners(lo: Vec3, hi: Vec3): Vec3[] {
  return [
    [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]],
    [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]],
    [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]],
  ];
}

export interface DeformScene {
  sv: SceneVolume;
  image: ImageField;
  warp: TransformField;
  fiducials: FiducialField;
  sources: Vec3[];
  targets: Vec3[];
  /** Move landmark i's TARGET to p and re-solve the TPS IN PLACE (re-uploads the same
   *  displacement texture + refreshes the pin uniforms — no new fields, no pipeline
   *  rebuild). Caller does scene.syncUniforms() + redraw. This is the Tier-A interactive
   *  landmark drag (ARCHITECTURE-2026-07-24 §6.1). */
  setTarget(i: number, p: Vec3, dev: GPUDevice): void;
  /** Highlight a target pin (hover feedback) without touching the warp — just recolours
   *  the pin uniforms. Pass null to clear. Caller does scene.syncUniforms() + redraw. */
  highlightTarget(i: number | null): void;
}

/** Default demo deformation: a deliberately DRAMATIC stretch, so the card thumbnail
 *  reads instantly as "nonlinear transform" rather than a subtle nudge.
 *
 *  Corner order from boundsCorners(): 0-3 are the S=lo face, 4-7 the S=hi face; odd
 *  indices are R=hi. So we lift the whole top face far superior, push the bottom face
 *  inferior, and squeeze both R faces inward — an elongated, narrowed head. Because a
 *  TPS with only corner landmarks is smooth and global, the corners have to move a LOT
 *  before the interior visibly deforms. */
function defaultTargets(sources: Vec3[]): Vec3[] {
  const t = sources.map((c) => [...c] as Vec3);
  //  A target is FORWARD: where you want the material at that source corner to move TO.
  //  The renderer samples at wp + d(wp), so buildDeformScene solves the INVERSE spline
  //  (tps3d(targets, sources)) — you author targets intuitively and the volume follows the
  //  pull. To make the head TALLER, move the top face UP and the bottom face DOWN; to make
  //  it NARROWER, move both R faces toward the centre.
  const STRETCH_S = 62;    // elongate along S (tuned so the deformed head still frames)
  const SQUEEZE_R = 30;    // narrow across R
  for (let i = 0; i < 8; i++) {
    const top = i >= 4;                 // S = hi face
    const rHi = (i & 1) === 1;          // R = hi corner
    t[i][2] += top ? STRETCH_S : -STRETCH_S * 0.45;
    t[i][0] += rHi ? -SQUEEZE_R : SQUEEZE_R;
  }
  return t;
}

export async function buildDeformScene(
  dev: GPUDevice,
  sceneUrl = "https://pieper.github.io/live/legacy/scenes/MRHead.json",
  onBytes?: (n: number) => void,
): Promise<DeformScene> {
  const sv = await loadSceneVolumeField(dev, sceneUrl, onBytes);
  const image = sv.field;                         // MRHead + its MR-Default transfer function
  const [lo, hi] = image.aabb();

  const sources = boundsCorners(lo, hi);
  const targets = defaultTargets(sources);

  // grid box: bounds padded by PAD_MM on every side (selftest grid_origin/grid_extent)
  const gLo: Vec3 = [lo[0] - PAD_MM, lo[1] - PAD_MM, lo[2] - PAD_MM];
  const gHi: Vec3 = [hi[0] + PAD_MM, hi[1] + PAD_MM, hi[2] + PAD_MM];
  const center: Vec3 = [(gLo[0] + gHi[0]) / 2, (gLo[1] + gHi[1]) / 2, (gLo[2] + gHi[2]) / 2];
  const spacing: Vec3 = [
    (gHi[0] - gLo[0]) / GRID_DIMS[0],
    (gHi[1] - gLo[1]) / GRID_DIMS[1],
    (gHi[2] - gLo[2]) / GRID_DIMS[2],
  ];

  const fiducials = new FiducialField([]);
  const pinR = Math.max(4, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.012);
  let hover: number | null = null;

  // Pins: 8 cyan sources (reference) + 8 magenta targets (the draggable handles). The
  // hovered target brightens + grows so the grabbable handle reads clearly.
  const buildPins = () => {
    const pins: Sphere[] = sources.map((c): Sphere => ({ center: c, radius: pinR, color: [0.25, 0.85, 1, 1] }));
    for (let i = 0; i < targets.length; i++) {
      const on = i === hover;
      pins.push({
        center: targets[i], radius: on ? pinR * 1.5 : pinR,
        color: on ? [1, 0.75, 0.35, 1] : [1, 0.35, 0.85, 1],
      });
    }
    fiducials.setSpheres(pins);
  };

  // One-time build of the persistent warp field; setTarget updates it in place thereafter.
  // Solve the INVERSE spline (centres at the targets, values source-target) so the volume
  // follows the pull: the renderer samples at wp + d(wp), and d(target_i) = source_i - target_i
  // makes the output at a dragged pin fetch the input from the original corner. Building it
  // the other way (tps3d(sources, targets)) moves the volume OPPOSITE the drag.
  const solveDisp = () => sampleDisplacementGrid(GRID_DIMS, spacing, center, tps3d(targets, sources));
  const warp = new TransformField(dev, solveDisp(), GRID_DIMS, spacing, { gain: 1, center });
  image.transform = warp;
  buildPins();

  const scene: DeformScene = {
    sv, image, warp, fiducials, sources, targets,
    setTarget(i: number, p: Vec3, d: GPUDevice) {
      targets[i] = [...p] as Vec3;
      warp.updateDisplacement(d, solveDisp());   // in-place texture re-upload, no new field
      buildPins();
    },
    highlightTarget(i: number | null) { hover = i; buildPins(); },
  };
  return scene;
}
