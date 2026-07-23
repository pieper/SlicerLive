// Scene builders for the SlicerWGPU selftest ports — on the SAME DATA the selftests load.
//
// Datasets (published to the slicerlive JS2 bucket by tools/publish_volume.py):
//   CTACardio            -> Single Volume, Volume + Fiducials, Multi-Volume
//   CTAAbdomenPanoramix  -> Multi-Volume (second volume)
//   MRHead               -> Landmark Deform (deform-scene.ts), Segmentation
//
// Each builder mirrors the corresponding test in SlicerWGPU/SceneRendering/SceneRendering.py.

import { ImageField, RGBAVolumeField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { bakeColorizeRGBA } from "../bake.ts";
import { loadSceneVolumeField, type SceneVolume } from "../scene-volume.ts";
import type { Vec3 } from "../mat4.ts";

export const SCENES = {
  CTACardio: "https://pieper.github.io/live/scenes/CTACardio.json",
  Panoramix: "https://pieper.github.io/live/scenes/CTAAbdomenPanoramix.json",
  MRHead: "https://pieper.github.io/live/legacy/scenes/MRHead.json",
};

// --------------------------------------------------------------------------
// Volume + Fiducials  (test_vtk_VolumeAndFiducials / _build_markup_nodes)
//
// The selftest builds FOUR markup lists of 25 control points each (100 total),
// scattered uniformly inside the volume's bounds, with these colours and glyph sizes.
// We keep one FiducialField per markup list, which is both faithful (a list is a node)
// and keeps each field inside its 64-sphere uniform capacity.
//
// NOTE: the selftest scatters with numpy default_rng(seed=20260415). We cannot reproduce
// NumPy's PCG64 stream in TS, so we use our own seeded PRNG: the same *construction*
// (uniform in bounds, 25 per list, fixed seed => deterministic) but not the same points.
// --------------------------------------------------------------------------
export const MARKUP_LISTS: { name: string; color: [number, number, number]; radius: number }[] = [
  { name: "MarkupsRed", color: [0.95, 0.20, 0.20], radius: 5.0 },
  { name: "MarkupsGreen", color: [0.20, 0.85, 0.30], radius: 3.5 },
  { name: "MarkupsBlue", color: [0.20, 0.45, 0.95], radius: 7.0 },
  { name: "MarkupsYellow", color: [0.95, 0.85, 0.10], radius: 2.5 },
];
export const POINTS_PER_LIST = 25;

/** Small deterministic PRNG (mulberry32) so the scatter is reproducible across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FiducialsScene { sv: SceneVolume; image: ImageField; lists: FiducialField[] }

export async function buildVolumeAndFiducials(dev: GPUDevice, onBytes?: (n: number) => void): Promise<FiducialsScene> {
  const sv = await loadSceneVolumeField(dev, SCENES.CTACardio, onBytes);
  const [lo, hi] = sv.field.aabb();
  const r = rng(20260415);                       // same seed value the selftest uses
  const lists = MARKUP_LISTS.map(({ color, radius }) => {
    const pins: Sphere[] = [];
    for (let i = 0; i < POINTS_PER_LIST; i++) {
      pins.push({
        center: [
          lo[0] + r() * (hi[0] - lo[0]),
          lo[1] + r() * (hi[1] - lo[1]),
          lo[2] + r() * (hi[2] - lo[2]),
        ] as Vec3,
        radius,
        color: [color[0], color[1], color[2], 1],
      });
    }
    return new FiducialField(pins, { shininess: 90, kSpecular: 0.6 });
  });
  return { sv, image: sv.field, lists };
}

// --------------------------------------------------------------------------
// Multi-Volume  (test_vtk_MultiVolume)
//
// CTACardio + CTAAbdomenPanoramix, each with its own transfer function, with Panoramix
// translated +200 mm along R so the two sit side by side (the selftest puts that offset
// on an interactive linear transform node).
// --------------------------------------------------------------------------
export const PANO_OFFSET_R = 200.0;

export interface MultiVolumeScene { cta: SceneVolume; pano: SceneVolume; fields: [ImageField, ImageField] }

export async function buildMultiVolume(dev: GPUDevice, onBytes?: (n: number) => void): Promise<MultiVolumeScene> {
  const cta = await loadSceneVolumeField(dev, SCENES.CTACardio, onBytes);
  const pano = await loadSceneVolumeField(dev, SCENES.Panoramix, onBytes, {
    // the selftest's initial +200mm R translation, folded into the volume's geometry
    extraTranslationRAS: [PANO_OFFSET_R, 0, 0],
  });
  return { cta, pano, fields: [cta.field, pano.field] };
}

// --------------------------------------------------------------------------
// Segmentation  (test_vtk_Segmentation)
//
// Two segments thresholded straight out of MRHead's intensities, exactly as the
// selftest builds them, then baked through ColorizeVolume for the 3D view.
// --------------------------------------------------------------------------
export const SEGMENTS: { name: string; color: [number, number, number]; test: (v: number) => boolean }[] = [
  { name: "Brain", color: [0.90, 0.20, 0.20], test: (v) => v > 40 && v < 120 },
  { name: "High", color: [0.20, 0.80, 0.50], test: (v) => v > 120 },
];

export interface SegmentationScene {
  sv: SceneVolume;
  labelmap: Uint8Array;
  colorizeTex: GPUTexture;
  field3d: RGBAVolumeField;
  counts: number[];
}

export async function buildSegmentation(dev: GPUDevice, onBytes?: (n: number) => void): Promise<SegmentationScene> {
  const sv = await loadSceneVolumeField(dev, SCENES.MRHead, onBytes);
  const v = sv.voxels;
  const labelmap = new Uint8Array(v.length);
  const counts = [0, 0];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (SEGMENTS[0].test(x)) { labelmap[i] = 1; counts[0]++; }
    else if (SEGMENTS[1].test(x)) { labelmap[i] = 2; counts[1]++; }
  }
  const palette = new Float32Array(256 * 4);
  SEGMENTS.forEach((s, i) => palette.set([s.color[0], s.color[1], s.color[2], 1.0], (i + 1) * 4));
  const colorizeTex = bakeColorizeRGBA(dev, labelmap, sv.dims, palette, 1.2);
  const field3d = new RGBAVolumeField(colorizeTex, sv.dims, [1, 1, 1], {
    ijkToRAS: sv.ijkToRAS, shade: [0.28, 0.8, 0.5, 28],
  });
  return { sv, labelmap, colorizeTex, field3d, counts };
}
