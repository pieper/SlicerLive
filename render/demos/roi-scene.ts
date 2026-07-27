// ROI-crop scene: a volume + an axis-aligned RoiBoxField wireframe + draggable handles.
// The box drives SceneRenderer.setClipBox, so the wireframe and the crop are one node's
// state updated together (ARCHITECTURE-2026-07-24 §6.4). The box + handle math lives in the
// shared roi-widget.ts (also used by the SEGRoulette 3D crop); this module just pairs it with
// a streamed scene volume.
import { ImageField } from "../fields.ts";
import { FiducialField } from "../fiducial-field.ts";
import { RoiBoxField } from "../roi-box-field.ts";
import { loadSceneVolumeField, type SceneVolume } from "../scene-volume.ts";
import { createRoiWidget, type Box, type HandleMeta, type RoiHandle } from "./roi-widget.ts";
import type { Vec3 } from "../mat4.ts";

export type { Box, HandleMeta, RoiHandle } from "./roi-widget.ts";

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
  const w = createRoiWidget(lo, hi, { coverage: 0.35 });
  return { sv, image, ...w };
}
