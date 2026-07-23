// Shared setup for the real-scene demo: load a live SlicerLive scene volume
// (zarr from the JS2 bucket) into an ImageField (3D VR) and wire a SliceRenderer
// (MPR) to the SAME scalar texture. Used by both the browser entry and headless tests.
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { loadSceneVolumeField, type SceneVolume } from "../scene-volume.ts";

export interface AnatAxis { axis: 0 | 1 | 2; label: "AXIAL" | "CORONAL" | "SAGITTAL"; cls: "red" | "green" | "yellow" }

/** Classify each IJK axis by the RAS direction of its slice-plane normal (ijkToRAS column). */
export function anatomicalAxes(ijkToRAS: number[]): AnatAxis[] {
  const col = (a: number): [number, number, number] => [ijkToRAS[a], ijkToRAS[4 + a], ijkToRAS[8 + a]];
  const map: Record<number, AnatAxis> = {
    0: { axis: 0, label: "SAGITTAL", cls: "yellow" },
    1: { axis: 0, label: "CORONAL", cls: "green" },
    2: { axis: 0, label: "AXIAL", cls: "red" },
  };
  return ([0, 1, 2] as const).map((a) => {
    const c = col(a);
    const dom = [Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2])].reduce((bi, v, i, arr) => v > arr[bi] ? i : bi, 0);
    return { ...map[dom], axis: a };
  });
}

export interface RealScene {
  sv: SceneVolume;
  scene: SceneRenderer;
  slice: SliceRenderer;
  axes: AnatAxis[];   // one per IJK axis, anatomically classified
}

export async function buildRealScene(
  gpu: Gpu,
  sceneUrl: string,
  format?: GPUTextureFormat,
  onBytes?: (n: number) => void,
): Promise<RealScene> {
  const sv = await loadSceneVolumeField(gpu.device, sceneUrl, onBytes);
  const scene = new SceneRenderer(gpu, format);
  scene.build([sv.field]);
  scene.setBackground(0.05, 0.06, 0.09);

  const slice = new SliceRenderer(gpu, format);
  const [rasLo, rasHi] = sv.field.aabb();
  slice.setVolume(sv.field.patientToTexture(), rasLo, rasHi);   // reslice in RAS (honors ijkToRAS)
  slice.setTextures(sv.field.volumeTexture());                  // grayscale only (no segmentation overlay)
  slice.setWindowLevel(sv.win, sv.lev);
  slice.setOverlayOpacity(0);

  return { sv, scene, slice, axes: anatomicalAxes(sv.ijkToRAS) };
}
