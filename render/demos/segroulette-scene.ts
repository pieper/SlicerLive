// SlicerLive SEGRoulette scene: build from a random IDC series (CT/MR/PET source +
// DICOM SEG) loaded client-side by idc_tools. The source volume renders as a subtle
// grayscale VR for context; the segmentation renders with the SegmentField `iso`
// band-shell (the step-derived isosurface of a Gaussian-smoothed presence field) —
// the WebGPU-native replacement for the vtk.js surface models. The MPR planes show
// windowed grayscale + a colored segmentation overlay.
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { ImageField, RGBAVolumeField, SegmentField, type Field } from "../fields.ts";
import { bakeColorizeRGBA, bakeSegmentPresence } from "../bake.ts";

// WebGPU guarantees only 16 sampled textures per shader stage, and each SegmentField binds one 3D
// texture. Past this many segments we can't give each its own iso field, so the 3D view switches to
// a SINGLE colorized RGBAVolumeField (the same texture the MPR overlay already uses) — one binding,
// scales to any number of segments. (Leaves headroom under 16.)
const MAX_ISO_SEGMENTS = 12;
import type { Vec3 } from "../mat4.ts";
import type { CTVolume, SegLabelmap } from "../vendor/idc_tools/types.js";

/** Modality-appropriate volume-render transfer function: grayscale with a bone-weighted opacity
 *  ramp for CT/MR, hot-metal (black→red→orange→yellow→white) for PET. Kept translucent so it reads
 *  as anatomical CONTEXT behind the colored segmentation — it's an independent, toggleable layer. */
function modalityLUT(modality: string | undefined, maxAlpha = 0.42): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  const m = (modality ?? "CT").toUpperCase();
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number, a: number;
    if (m === "PET" || m === "PT") {
      r = Math.min(1, t * 3);
      g = Math.min(1, Math.max(0, t * 3 - 1));
      b = Math.min(1, Math.max(0, t * 3 - 2));
      a = Math.max(0, (t - 0.25) / 0.75) * 0.9;            // hot uptake reads opaque
    } else {
      r = g = b = t;                                        // grayscale
      let aa = Math.max(0, (t - 0.42) / 0.58); aa *= aa;    // emphasize the high (bone) end
      a = Math.min(maxAlpha, aa);
    }
    lut[i * 4] = Math.round(r * 255); lut[i * 4 + 1] = Math.round(g * 255); lut[i * 4 + 2] = Math.round(b * 255); lut[i * 4 + 3] = Math.round(a * 255);
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
  segments: { num: number; name: string; color: [number, number, number]; voxels: number }[];
  mode: "iso" | "colorized" | "volume";   // how the 3D view renders the segmentation
  hasSeg: boolean;                         // whether there's a segmentation layer to toggle
  /** Toggle the two independent 3D layers (background modality VR + segmentation). Rebuilds the
   *  scene with the visible subset; caller re-renders. Never leaves the 3D view empty. */
  setLayers(showVolume: boolean, showSeg: boolean): void;
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

  // The source volume: modality-appropriate VR (also the raw scalar the MPR window/levels).
  const volumeField = new ImageField(dev, data, dims, [1, 1, 1], modalityLUT(ct.modality), {
    clim, ijkToRAS: ct.ijkToRAS, shade: [0.25, 0.7, 0.45, 20],
  });

  // Pass 1: enumerate renderable segments (skip background/black/whole-grid labels) + build the
  // 256-entry colour palette. No GPU baking yet — we decide iso vs colorized from the count first.
  const segments: { num: number; name: string; color: [number, number, number]; voxels: number }[] = [];
  const palette = new Float32Array(256 * 4);
  if (seg) {
    const total = dims[0] * dims[1] * dims[2];
    for (const [num, r, g, b] of seg.colors) {
      if (num === 0 || (r === 0 && g === 0 && b === 0)) continue;   // background / unlabeled
      let n = 0;
      for (let i = 0; i < seg.lab.length; i++) if (seg.lab[i] === num) n++;
      if (!n || n > total * 0.6) continue;                          // empty, or covers most of the grid
      if (num < 256) { palette[num * 4] = r; palette[num * 4 + 1] = g; palette[num * 4 + 2] = b; palette[num * 4 + 3] = 1; }
      segments.push({ num, name: seg.names[num] ?? `Segment ${num}`, color: [r, g, b], voxels: n });
    }
  }

  // The colorized volume (one texture) drives BOTH the MPR overlay and the many-segment 3D fallback.
  const colorizeTex = seg ? bakeColorizeRGBA(dev, seg.lab, dims, palette, 1.5) : undefined;

  // The SEGMENTATION layer, independent of the background volume: per-segment iso shells when few
  // (crisp, the demo's identity), else ONE colorized RGBAVolumeField (all segments, one binding) so
  // we never blow the 16-texture limit.
  const useIso = segments.length > 0 && segments.length <= MAX_ISO_SEGMENTS;
  let mode: "iso" | "colorized" | "volume" = "volume";
  let segLayer: Field[] = [];
  if (useIso) {
    segLayer = segments.map((s) => {
      const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
      for (let i = 0; i < seg!.lab.length; i++) if (seg!.lab[i] === s.num) mask[i] = 1;
      const tex = bakeSegmentPresence(dev, mask, dims, 1.5);
      return new SegmentField(tex, dims, [1, 1, 1], { color: s.color, opacity: 1, ijkToRAS: ct.ijkToRAS });
    });
    mode = "iso";
  } else if (colorizeTex) {
    segLayer = [new RGBAVolumeField(colorizeTex, dims, [1, 1, 1], { ijkToRAS: ct.ijkToRAS, shade: [0.3, 0.78, 0.5, 28] })];
    mode = "colorized";
  }

  const scene = new SceneRenderer(gpu, format);
  // Two independent layers: background modality VR + segmentation. Rebuild picks the visible subset.
  // (build() creates the uniform buffer, so setBackground must follow it — and re-apply per rebuild.)
  const setLayers = (showVolume: boolean, showSeg: boolean) => {
    const f: Field[] = [];
    if (showVolume) f.push(volumeField);
    if (showSeg) f.push(...segLayer);
    scene.build(f);   // may be empty → blank 3D (both layers off is a valid state)
    scene.setBackground(0.05, 0.06, 0.09);
  };
  setLayers(true, segLayer.length > 0);          // default: VR context + segmentation both on

  const slice = new SliceRenderer(gpu, format);
  const [rasLo, rasHi] = volumeField.aabb();
  slice.setVolume(volumeField.patientToTexture(), rasLo, rasHi);
  slice.setTextures(volumeField.volumeTexture(), colorizeTex);
  slice.setWindowLevel(ct.win, ct.lev);
  slice.setOverlayOpacity(seg ? 0.5 : 0);

  const center: Vec3 = [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2];
  const radius = Math.hypot(rasHi[0] - rasLo[0], rasHi[1] - rasLo[1], rasHi[2] - rasLo[2]) / 2;
  return { scene, slice, center, radius, rasLo, rasHi, ijkToRAS: ct.ijkToRAS, dims, win: ct.win, lev: ct.lev, segments, mode, hasSeg: segLayer.length > 0, setLayers };
}
