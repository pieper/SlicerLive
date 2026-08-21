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
import { ImageField, type Field } from "../fields.ts";
import { bakeColorizeRGBA } from "../bake.ts";
import { createRoiWidget, type RoiWidget } from "./roi-widget.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { labelmapHasInternalBoundary, resampleIsotropic } from "../../algorithms/geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";

// The 3D segmentation is ONE unified colorized signed-distance-field surface (algorithms/ + logic/):
// every segment in a single labelmap → JFA-SDF → one SegmentField (crisp surface-model look, per-
// segment colour + opacity, colour seams pre-blended). Replaces the old hack (per-segment iso fields
// ≤12 segments, else an ugly colorized RGBA volume): one binding, any number of segments, one field
// to ray-march. The JFA bake is capped to SDF_MAX_DIM per axis (the labelmap is downsampled for the
// 3D SDF only; the 2D slice overlay stays full-res) so large IDC volumes don't blow GPU memory.
const SDF_MAX_DIM = 256;
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
  mode: "sdf" | "volume";                  // 3D seg render: unified colorized-SDF surface (or none)
  hasSeg: boolean;                         // whether there's a segmentation layer to toggle
  /** Toggle the two independent 3D layers (background modality VR + segmentation). */
  setLayers(showVolume: boolean, showSeg: boolean): void;
  /** Continuous 3D-LAYER opacity (0..1): the background VR (scales its transfer-function alpha) and the
   *  whole segmentation (field-level multiplier over per-segment opacity). 0 removes the layer from the
   *  build; >0 composites it. Lets a semi-transparent VR sit behind the segmentation. */
  setVolumeOpacity(o: number): void;
  volumeOpacity(): number;
  /** Swap the 3D VR transfer function to a baked CT preset (LUT + clim + lighting), or null to
   *  restore the grayscale modality VR. Opacity + shift stay applied on top. */
  setVolumePreset(bake: { lut: Uint8Array; clim: [number, number]; shade: [number, number, number, number] } | null): void;
  /** Slicer's VR "Shift": offset the whole VR transfer function along the scalar axis by `hu`
   *  (affects only the 3D volume rendering, not the 2D slice window/level). */
  setVolumeShift(hu: number): void;
  volumeShift(): number;
  setSegOpacity(o: number): void;
  segOpacity(): number;
  /** Per-segment opacity (0 = hidden, 0.5 = translucent, 1 = opaque) — 3D SDF shell + slice overlay.
   *  Rebakes the colorized overlay and the SDF attr in place. Caller redraws slices afterwards. */
  setSegmentOpacity(num: number, opacity: number): void;
  segmentOpacity(num: number): number;
  /** Binary visibility convenience (opacity 0/1) — kept for tests + callers that only toggle. */
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
  /** Free the 3D segmentation GPU resources (call before dropping a scene on Spin). */
  destroy(): void;
}

/** Build the renderable scene (3D VR + segmentation iso + MPR) from an idc_tools load. */
export function buildSegrouletteScene(
  gpu: Gpu,
  format: GPUTextureFormat,
  ct: CTVolume,
  seg?: SegLabelmap,
  opts: { sdfMaxDim?: number; sdfMaxVoxels?: number; refineDelayMs?: number } = {},
): SegrouletteScene {
  const dev = gpu.device;
  const dims = ct.dims;
  const data = ct.vol instanceof Float32Array ? ct.vol : Float32Array.from(ct.vol);
  const clim: [number, number] = [ct.lev - ct.win / 2, ct.lev + ct.win / 2];

  // The source volume: modality-appropriate VR (also the raw scalar the MPR window/levels). This is
  // the ONLY clippable field — the ROI crop spares the segmentation (seg fields are clippable:false).
  // VR transfer function: the grayscale modality LUT is the default; a CT preset can swap in a
  // colored LUT + its own clim + lighting. `base*` hold the ACTIVE VR TF (grayscale or preset);
  // the originals restore it. `volShift` offsets the whole TF along the scalar axis (Slicer's VR
  // "Shift"). scaledVolLut scales the active LUT's alpha for the live opacity control.
  const grayLut = modalityLUT(ct.modality);
  const grayClim: [number, number] = [clim[0], clim[1]];
  const grayShade: [number, number, number, number] = [0.25, 0.7, 0.45, 20];
  let baseVolLut = grayLut;
  let baseClim: [number, number] = [clim[0], clim[1]];
  let baseShade: [number, number, number, number] = [grayShade[0], grayShade[1], grayShade[2], grayShade[3]];
  let volShift = 0;
  const scaledVolLut = (o: number): Uint8Array => {
    const l = baseVolLut.slice();
    for (let i = 0; i < 256; i++) l[i * 4 + 3] = Math.round(l[i * 4 + 3] * o);
    return l;
  };
  const volumeField = new ImageField(dev, data, dims, [1, 1, 1], baseVolLut, {
    clim, ijkToRAS: ct.ijkToRAS, shade: baseShade,
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

  // Per-segment opacity (tri-state in the UI: 1 → 0.5 → 0 → 1). Default 1 (opaque); 0 = hidden, 0.5 =
  // translucent surface. Baking uses a palette whose alpha is the per-segment opacity (the colorized
  // overlay dims with it; the SDF attr renders the shell at that opacity).
  const segOpacity = new Map<number, number>();
  const opacityOf = (num: number) => segOpacity.get(num) ?? 1;
  const visPalette = (): Float32Array => {
    const p = palette.slice();
    for (const s of segments) if (s.num < 256) p[s.num * 4 + 3] = opacityOf(s.num);
    return p;
  };

  // 2D slice overlay: full-res colorized labelmap (crisp per-voxel fill; visPalette() alpha 0 hides).
  let colorTex = seg ? bakeColorizeRGBA(dev, seg.lab, dims, visPalette(), 1.5) : undefined;

  // 3D segmentation = ONE unified colorized signed-distance-field surface (algorithms/ + logic/): the
  // whole labelmap (downsampled to the SDF cap) → JFA-SDF → a single SegmentField. Per-segment colour
  // + opacity via the palette; visibility = opacity 0. Refined once (static scene). clippable:false so
  // the ROI crops only the background VR, not the segmentation.
  let mode: "sdf" | "volume" = "volume";
  let segLogic: SegmentationLogic | undefined;
  let editable: EditableSegmentation | undefined;
  if (seg && segments.length > 0) {
    // ISOTROPIC resample (capacity-gated): thick-slice CTs must upsample the slice axis toward
    // isotropic or a near-slice-parallel surface falls between slices and the SDF shell misses it →
    // holes (user report: lung/liver tops vanish when rotated). sdfMaxVoxels caps memory so a weaker
    // device coarsens instead of OOMing; `coarsened` → we surfaced fewer voxels than ideal.
    const cap = resampleIsotropic(seg.lab, dims, ct.ijkToRAS, opts.sdfMaxDim ?? SDF_MAX_DIM, opts.sdfMaxVoxels);
    if (cap.coarsened) console.warn(`SEGRoulette: SDF grid coarsened to fit the device memory budget (${cap.dims.join("×")}, ${cap.vox.toFixed(2)}mm) — a remote render server would allow full resolution.`);
    editable = new EditableSegmentation(dev, cap.dims, { ijkToRAS: cap.ijkToRAS });
    // Real data often has EMBEDDED/adjacent labels (tumor in liver, cyst clusters): auto-pick the
    // multi-material interface field ("all") so internal label↔label boundaries surface too, else the
    // crisp outer shell for segments separated by background (ribs/vertebrae render identically).
    const boundaryMode = labelmapHasInternalBoundary(cap.lab, cap.dims) ? "all" : "outer";
    segLogic = new SegmentationLogic(dev, editable, { renderMode: "sdf", opacity: 1.0, boundaryMode, refineDelayMs: opts.refineDelayMs });
    for (const s of segments) { segLogic.setLabelColor(s.num, s.color); segLogic.setLabelOpacity(s.num, opacityOf(s.num)); }
    editable.loadLabelmap(cap.lab);   // fast bake
    segLogic.refineNow();             // static scene → high-quality bake now
    mode = "sdf";
  }
  const hasSeg = !!segLogic;

  const scene = new SceneRenderer(gpu, format);
  const [rasLo, rasHi] = volumeField.aabb();
  const roi = createRoiWidget(rasLo, rasHi, { coverage: 0.35 });

  // Central state + rebuild. build() creates the uniform buffer (so setBackground/clip must FOLLOW
  // it) and re-packs the shader, so every visibility/crop change funnels through here.
  let volumeOpacity = 1, segLayerOpacity = 1;   // 3D layer opacities (segLayerOpacity = global seg multiplier; distinct from the per-segment `segOpacity` map)
  let showVolume = true, showSeg = hasSeg;   // derived: opacity > 0 (field present in the scene build)
  let roiEnabled = false, roiVisible = false;
  const currentSegFields = (): Field[] => segLogic ? [segLogic.field()] : [];
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

  // Re-bake the 2D slice-overlay colorized texture from the current per-segment palette (alpha =
  // opacity). The 3D seg is the SDF field (updated separately via setLabelOpacity); this feeds only
  // the MPR overlay. Cheap enough for an occasional toggle.
  const rebakeColorized = () => {
    if (!seg) return;
    const nt = bakeColorizeRGBA(dev, seg.lab, dims, visPalette(), 1.5);
    const old = colorTex;
    colorTex = nt;
    slice.setTextures(volumeField.volumeTexture(), colorTex);
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
    setLayers(sv, ss) { this.setVolumeOpacity(sv ? 1 : 0); this.setSegOpacity(ss ? 1 : 0); },
    setVolumeOpacity(o) {
      volumeOpacity = Math.max(0, Math.min(1, o));
      const was = showVolume; showVolume = volumeOpacity > 0.001;
      volumeField.setLUT(scaledVolLut(volumeOpacity));         // scale the VR transfer-function alpha
      if (was !== showVolume) rebuild();                        // add/remove the VR field only when crossing 0
    },
    volumeOpacity: () => volumeOpacity,
    setVolumePreset(bake) {
      if (bake) { baseVolLut = bake.lut; baseClim = [bake.clim[0], bake.clim[1]]; baseShade = bake.shade; }
      else { baseVolLut = grayLut; baseClim = [grayClim[0], grayClim[1]]; baseShade = grayShade; }
      volumeField.setLUT(scaledVolLut(volumeOpacity));
      volumeField.setClim(baseClim[0] + volShift, baseClim[1] + volShift);
      volumeField.setShade(baseShade);
      scene.syncUniforms();
    },
    setVolumeShift(hu) {
      volShift = hu;
      volumeField.setClim(baseClim[0] + volShift, baseClim[1] + volShift);
      scene.syncUniforms();
    },
    volumeShift: () => volShift,
    setSegOpacity(o) {
      segLayerOpacity = Math.max(0, Math.min(1, o));
      const was = showSeg; showSeg = hasSeg && segLayerOpacity > 0.001;
      segLogic?.setGlobalOpacity(segLayerOpacity);
      if (was !== showSeg) rebuild(); else scene.syncUniforms();   // op0 is a uniform → re-pack in place
    },
    segOpacity: () => segLayerOpacity,
    setSegmentOpacity(num, opacity) {
      const o = Math.max(0, Math.min(1, opacity));
      if (o >= 1) segOpacity.delete(num); else segOpacity.set(num, o);   // 1 is the default
      rebakeColorized();                                   // 2D slice overlay (palette alpha = opacity)
      segLogic?.setLabelOpacity(num, o);                   // 3D: per-segment shell opacity
      segLogic?.refineNow();                               // rebake attr + sdf in place (same field/texture)
    },
    segmentOpacity: (num) => opacityOf(num),
    setSegmentVisible(num, visible) { this.setSegmentOpacity(num, visible ? 1 : 0); },
    isSegmentVisible: (num) => opacityOf(num) > 0,
    setRoiEnabled(on) { roiEnabled = on; rebuild(); },
    setRoiVisible(on) { roiVisible = on; rebuild(); },
    roiEnabled: () => roiEnabled,
    roiVisible: () => roiVisible,
    reclip() { if (roiEnabled) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip(); scene.syncUniforms(); },
    destroy() { segLogic?.destroy(); editable?.destroy(); },
  };
}
