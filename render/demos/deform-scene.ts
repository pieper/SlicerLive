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
// control point. Until markup picking lands (next milestone) this demo ships a preset
// target offset plus a gain slider, so gain 0 is exactly the selftest's initial state
// and gain 1 shows a full deformation. `setTarget()` is wired for the picking work.
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
  /** Rebuild the TPS + displacement grid from the current targets (as the selftest does). */
  rebuild(dev: GPUDevice): void;
  setTarget(i: number, p: Vec3, dev: GPUDevice): void;
}

/** Default demo deformation: pull two opposite corners, leaving the rest fixed. */
function defaultTargets(sources: Vec3[]): Vec3[] {
  const t = sources.map((c) => [...c] as Vec3);
  t[7] = [t[7][0] + 55, t[7][1] + 25, t[7][2] + 20];   // +R+A+S corner pulled out
  t[0] = [t[0][0] - 30, t[0][1] - 10, t[0][2] - 15];   // -R-A-S corner pulled out
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

  let warp!: TransformField;
  const fiducials = new FiducialField([]);
  const pinR = Math.max(4, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.012);

  const scene: DeformScene = {
    sv, image, warp: undefined as unknown as TransformField, fiducials, sources, targets,
    rebuild(d: GPUDevice) {
      const f = tps3d(sources, targets);                       // basis R, as SetBasisToR()
      const disp = sampleDisplacementGrid(GRID_DIMS, spacing, center, f);
      warp = new TransformField(d, disp, GRID_DIMS, spacing, { gain: 1, center });
      image.transform = warp;
      scene.warp = warp;
      const pins: Sphere[] = [
        ...sources.map((c): Sphere => ({ center: c, radius: pinR, color: [0.25, 0.85, 1, 1] })),
        ...targets.map((c, i): Sphere => ({
          center: c, radius: pinR,
          // only show a magenta target pin where it actually differs from its source
          color: Math.hypot(c[0] - sources[i][0], c[1] - sources[i][1], c[2] - sources[i][2]) > 1e-6
            ? [1, 0.35, 0.85, 1] : [0, 0, 0, 0],
        })),
      ];
      fiducials.setSpheres(pins);
    },
    setTarget(i: number, p: Vec3, d: GPUDevice) { targets[i] = [...p] as Vec3; scene.rebuild(d); },
  };
  scene.rebuild(dev);
  return scene;
}
