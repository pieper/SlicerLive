// SlicerLive SEGRoulette scene: build from a random IDC series (CT/MR/PET source +
// DICOM SEG) loaded client-side by idc_tools. The source volume renders as a subtle
// grayscale VR for context; the segmentation renders with the SegmentField `iso`
// band-shell (the step-derived isosurface of a Gaussian-smoothed presence field) —
// the WebGPU-native replacement for the vtk.js surface models. The MPR planes show
// windowed grayscale + a colored segmentation overlay.
//
// Three independent, toggleable things share one rebuild(): the background modality VR,
// the segmentation (with per-segment visibility), and a volume-only ROI crop box that
// crops the VR but NOT the segmentation (the seg fields are marked clippable:false).
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { ImageField, RGBAVolumeField, SegmentField, type Field } from "../fields.ts";
import { bakeColorizeRGBA, bakeSegmentPresence } from "../bake.ts";
import { createRoiWidget, type RoiWidget } from "./roi-widget.ts";

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
  /** Toggle the two independent 3D layers (background modality VR + segmentation). */
  setLayers(showVolume: boolean, showSeg: boolean): void;
  /** Per-segment visibility (3D + slice overlay). Rebakes the colorized overlay/field and, in iso
   *  mode, rebuilds the scene with the visible subset. Caller redraws slices afterwards. */
  setSegmentVisible(num: number, visible: boolean): void;
  isSegmentVisible(num: number): boolean;
  // Volume-only ROI crop (Slicer's independent enable + visibility). The box crops the VR but NOT
  // the segmentation. `roi` is the draggable widget; enable applies the clip, visible shows the box.
  roi: RoiWidget;
  setRoiEnabled(on: boolean): void;
  setRoiVisible(on: boolean): void;
  roiEnabled(): boolean;
  roiVisible(): boolean;
  /** Re-apply the clip planes from the current box (after a handle drag) without a rebuild. */
  reclip(): void;
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

  // The source volume: modality-appropriate VR (also the raw scalar the MPR window/levels). This is
  // the ONLY clippable field — the ROI crop spares the segmentation (seg fields are clippable:false).
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

  // Per-segment visibility: nums in `hidden` render nowhere. Baking uses a palette whose hidden
  // entries have alpha 0 (drops them from the colorized overlay + 3D field); iso mode also filters
  // the SegmentField subset at rebuild.
  const hidden = new Set<number>();
  const visPalette = (): Float32Array => {
    const p = palette.slice();
    for (const n of hidden) if (n < 256) p[n * 4 + 3] = 0;
    return p;
  };

  // The colorized volume (one texture) drives BOTH the MPR overlay and the many-segment 3D fallback.
  let colorTex = seg ? bakeColorizeRGBA(dev, seg.lab, dims, visPalette(), 1.5) : undefined;

  // The SEGMENTATION layer, independent of the background volume: per-segment iso shells when few
  // (crisp, the demo's identity), else ONE colorized RGBAVolumeField (all segments, one binding) so
  // we never blow the 16-texture limit. Seg fields are clippable:false so the ROI crops only the VR.
  const useIso = segments.length > 0 && segments.length <= MAX_ISO_SEGMENTS;
  let mode: "iso" | "colorized" | "volume" = "volume";
  const isoByNum = new Map<number, SegmentField>();
  let colorizedField: RGBAVolumeField | undefined;
  if (useIso) {
    for (const s of segments) {
      const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
      for (let i = 0; i < seg!.lab.length; i++) if (seg!.lab[i] === s.num) mask[i] = 1;
      const tex = bakeSegmentPresence(dev, mask, dims, 1.5);
      isoByNum.set(s.num, new SegmentField(tex, dims, [1, 1, 1], { color: s.color, opacity: 1, ijkToRAS: ct.ijkToRAS, clippable: false }));
    }
    mode = "iso";
  } else if (colorTex) {
    colorizedField = new RGBAVolumeField(colorTex, dims, [1, 1, 1], { ijkToRAS: ct.ijkToRAS, shade: [0.3, 0.78, 0.5, 28], clippable: false });
    mode = "colorized";
  }
  const hasSeg = isoByNum.size > 0 || !!colorizedField;

  const scene = new SceneRenderer(gpu, format);
  const [rasLo, rasHi] = volumeField.aabb();
  const roi = createRoiWidget(rasLo, rasHi, { coverage: 0.35 });

  // Central state + rebuild. build() creates the uniform buffer (so setBackground/clip must FOLLOW
  // it) and re-packs the shader, so every visibility/crop change funnels through here.
  let showVolume = true, showSeg = hasSeg;
  let roiEnabled = false, roiVisible = false;
  const currentSegFields = (): Field[] => {
    if (mode === "iso") return segments.filter((s) => !hidden.has(s.num)).map((s) => isoByNum.get(s.num)!);
    return colorizedField ? [colorizedField] : [];
  };
  const rebuild = () => {
    const f: Field[] = [];
    if (showVolume) f.push(volumeField);
    if (showSeg) f.push(...currentSegFields());
    if (roiVisible) { f.push(roi.box, roi.handles); }
    scene.build(f);                                    // may be empty → blank 3D (a valid state)
    scene.setBackground(0.05, 0.06, 0.09);
    if (roiEnabled) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip();
  };
  rebuild();

  // Re-bake the colorized texture from the visible-segment palette; feeds the slice overlay and,
  // in colorized mode, the 3D field. Cheap enough for an occasional toggle.
  const rebakeColorized = () => {
    if (!seg) return;
    const nt = bakeColorizeRGBA(dev, seg.lab, dims, visPalette(), 1.5);
    const old = colorTex;
    colorTex = nt;
    slice.setTextures(volumeField.volumeTexture(), colorTex);
    colorizedField?.setTexture(colorTex, false);   // swap in place; rebuild() refreshes the bind group
    old?.destroy();                                 // one owner destroys the retired texture
  };

  const slice = new SliceRenderer(gpu, format);
  slice.setVolume(volumeField.patientToTexture(), rasLo, rasHi);
  slice.setTextures(volumeField.volumeTexture(), colorTex);
  slice.setWindowLevel(ct.win, ct.lev);
  slice.setOverlayOpacity(seg ? 0.5 : 0);

  const center: Vec3 = [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2];
  const radius = Math.hypot(rasHi[0] - rasLo[0], rasHi[1] - rasLo[1], rasHi[2] - rasLo[2]) / 2;
  return {
    scene, slice, center, radius, rasLo, rasHi, ijkToRAS: ct.ijkToRAS, dims, win: ct.win, lev: ct.lev,
    segments, mode, hasSeg, roi,
    setLayers(sv, ss) { showVolume = sv; showSeg = ss; rebuild(); },
    setSegmentVisible(num, visible) {
      if (visible) hidden.delete(num); else hidden.add(num);
      rebakeColorized();     // slices + colorized 3D field reflect the change
      rebuild();             // refresh the 3D bind group (iso subset / swapped colorized texture)
    },
    isSegmentVisible: (num) => !hidden.has(num),
    setRoiEnabled(on) { roiEnabled = on; rebuild(); },
    setRoiVisible(on) { roiVisible = on; rebuild(); },
    roiEnabled: () => roiEnabled,
    roiVisible: () => roiVisible,
    reclip() { if (roiEnabled) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip(); scene.syncUniforms(); },
  };
}
