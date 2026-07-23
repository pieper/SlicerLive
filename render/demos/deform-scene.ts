// "Landmark Deform (TPS)" selftest port: a nonlinear thin-plate-spline transform,
// authored from landmark pairs, warping a volume during the ray march.
//
// The TransformField is a MODIFIER — it contributes no colour. The ImageField holds a
// reference to it, so the renderer inlines transform_point_img0() into the image's
// sampling path and the volume's apparent shape deforms. Fiducials mark the landmarks:
// cyan = source, magenta = target, so you can see what the warp was asked to do.
import { ImageField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { TransformField, sampleDisplacementGrid, tps3d } from "../transform-field.ts";
import { N, SPACING, buildLUT, syntheticVolume } from "./sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";

export const GRID_DIMS: Vec3 = [32, 32, 32];               // displacement grid resolution
export const WORLD = N * SPACING[0];                        // volume box edge (mm)
export const GRID_SPACING: Vec3 = [WORLD / GRID_DIMS[0], WORLD / GRID_DIMS[1], WORLD / GRID_DIMS[2]];

/** Landmark pairs: each source point is pulled to its target. */
export function landmarks(): { source: Vec3[]; target: Vec3[] } {
  const R = 52;
  const source: Vec3[] = [
    [R, 0, 0], [-R, 0, 0], [0, R, 0], [0, -R, 0], [0, 0, R], [0, 0, -R],
  ];
  // pull +X out and squash +Z down: a clearly non-rigid, non-uniform deformation
  const target: Vec3[] = [
    [R + 34, 0, 12], [-R, 0, 0], [0, R + 10, 0], [0, -R, 0], [0, 0, R - 26], [0, 0, -R],
  ];
  return { source, target };
}

export interface DeformScene { image: ImageField; warp: TransformField; fiducials: FiducialField }

export function buildDeformScene(dev: GPUDevice, gain = 1.0): DeformScene {
  const { source, target } = landmarks();
  const f = tps3d(source, target);
  const disp = sampleDisplacementGrid(GRID_DIMS, GRID_SPACING, [0, 0, 0], f);
  const warp = new TransformField(dev, disp, GRID_DIMS, GRID_SPACING, { gain });

  const image = new ImageField(dev, syntheticVolume(), [N, N, N], SPACING, buildLUT(), {
    clim: [0, 255], shade: [0.35, 0.75, 0.35, 24],
  });
  image.transform = warp;                       // <- the whole point: attach the warp

  const pins: Sphere[] = [
    ...source.map((c): Sphere => ({ center: c, radius: 4, color: [0.25, 0.85, 1, 1] })),   // cyan = source
    ...target.map((c): Sphere => ({ center: c, radius: 4, color: [1, 0.35, 0.85, 1] })),   // magenta = target
  ];
  const fiducials = new FiducialField(pins, { shininess: 90, kSpecular: 0.6 });

  return { image, warp, fiducials };
}
