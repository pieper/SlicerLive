// SlicerLive SEGRoulette scene: build from a random IDC series (CT/MR/PET source +
// DICOM SEG) loaded client-side by idc_tools. The source volume renders as a subtle
// grayscale VR for context; the segmentation renders with the SegmentField `iso`
// band-shell (the step-derived isosurface of a Gaussian-smoothed presence field) —
// the WebGPU-native replacement for the vtk.js surface models. The MPR planes show
// windowed grayscale + a colored segmentation overlay.
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { ImageField, SegmentField, type Field } from "../fields.ts";
import { bakeColorizeRGBA, bakeSegmentPresence } from "../bake.ts";
import type { Vec3 } from "../mat4.ts";
import type { CTVolume, SegLabelmap } from "../vendor/idc_tools/types.js";

/** Grayscale ramp with a soft opacity foot — a plain window/level VR for an arbitrary
 *  source volume. Kept translucent so the colored segmentation shells read on top. */
function grayLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const g = Math.round(t * 255);
    lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = g;
    lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (t - 0.35) / 0.65)) * 130); // soft, faint foot
  }
  return lut;
}

export interface SegrouletteScene {
  scene: SceneRenderer;
  slice: SliceRenderer;
  center: Vec3;
  radius: number;
  rasLo: Vec3;
  rasHi: Vec3;
  ijkToRAS: number[];
  dims: [number, number, number];
  win: number;
  lev: number;
  segments: { name: string; color: [number, number, number]; voxels: number }[];
}

/** Build the renderable scene (3D VR + segmentation iso + MPR) from an idc_tools load. */
export function buildSegrouletteScene(
  gpu: Gpu,
  format: GPUTextureFormat,
  ct: CTVolume,
  seg?: SegLabelmap,
): SegrouletteScene {
  const dev = gpu.device;
  const dims = ct.dims;
  const data = ct.vol instanceof Float32Array ? ct.vol : Float32Array.from(ct.vol);
  const clim: [number, number] = [ct.lev - ct.win / 2, ct.lev + ct.win / 2];

  const ctField = new ImageField(dev, data, dims, [1, 1, 1], grayLUT(), {
    clim, ijkToRAS: ct.ijkToRAS, shade: [0.25, 0.7, 0.45, 20],
  });

  // One SegmentField per DICOM segment number: a mask -> Gaussian presence (sigma 1.5
  // voxels) -> iso band-shell. Also accumulate a 256-entry palette for the MPR overlay.
  const segFields: Field[] = [];
  const segments: { name: string; color: [number, number, number]; voxels: number }[] = [];
  const palette = new Float32Array(256 * 4);
  if (seg) {
    const total = dims[0] * dims[1] * dims[2];
    for (const [num, r, g, b] of seg.colors) {
      // Skip background: DICOM segment 0, an all-black colour, or a label that covers most of
      // the grid — rendering that as an iso shell would just wrap the whole volume in a blob.
      if (num === 0 || (r === 0 && g === 0 && b === 0)) continue;
      const mask = new Uint8Array(total);
      let n = 0;
      for (let i = 0; i < seg.lab.length; i++) if (seg.lab[i] === num) { mask[i] = 1; n++; }
      if (!n || n > total * 0.6) continue;
      const tex = bakeSegmentPresence(dev, mask, dims, 1.5);
      segFields.push(new SegmentField(tex, dims, [1, 1, 1], { color: [r, g, b], opacity: 1, ijkToRAS: ct.ijkToRAS }));
      if (num < 256) { palette[num * 4] = r; palette[num * 4 + 1] = g; palette[num * 4 + 2] = b; palette[num * 4 + 3] = 1; }
      segments.push({ name: seg.names[num] ?? `Segment ${num}`, color: [r, g, b], voxels: n });
    }
  }

  // The 3D view showcases the segmentation iso shells. When there are segments, render ONLY
  // those (an opaque grayscale VR of the whole body would just bury them); fall back to the
  // source VR for segment-less cases so the view isn't empty.
  const scene = new SceneRenderer(gpu, format);
  scene.build(segFields.length ? segFields : [ctField]);
  scene.setBackground(0.05, 0.06, 0.09);

  const slice = new SliceRenderer(gpu, format);
  const [rasLo, rasHi] = ctField.aabb();
  slice.setVolume(ctField.patientToTexture(), rasLo, rasHi);
  const overlay = seg ? bakeColorizeRGBA(dev, seg.lab, dims, palette, 1.5) : undefined;
  slice.setTextures(ctField.volumeTexture(), overlay);
  slice.setWindowLevel(ct.win, ct.lev);
  slice.setOverlayOpacity(seg ? 0.5 : 0);

  const center: Vec3 = [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2];
  const radius = Math.hypot(rasHi[0] - rasLo[0], rasHi[1] - rasLo[1], rasHi[2] - rasLo[2]) / 2;
  return { scene, slice, center, radius, rasLo, rasHi, ijkToRAS: ct.ijkToRAS, dims, win: ct.win, lev: ct.lev, segments };
}
