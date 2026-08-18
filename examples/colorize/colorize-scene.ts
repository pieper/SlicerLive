// Scene for the colorize-volume demo: one NLST CT plus its TotalSegmentator label volume,
// rendered as a single ColorizeField (RGBA composed per sample in the shader, so segment
// opacities stay live) with an ROI crop widget and a SliceRenderer for the 2D views.

import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { SliceRenderer } from "../../render/slice-renderer.ts";
import { ColorizeField } from "../../render/colorize-field.ts";
import { fetchZarrVolume, type ZarrDesc } from "../../render/zarr.ts";
import { createRoiWidget, type RoiWidget } from "../../render/demos/roi-widget.ts";
import { lutFromTransferFunctions } from "../../render/scene-volume.ts";
import type { Vec3 } from "../../render/mat4.ts";
import { CT_PRESETS } from "./ct-presets.ts";

export interface SegmentInfo { num: number; name: string; color: [number, number, number] }
export interface GroupInfo { name: string; segments: number[] }
export interface Manifest {
  source: Record<string, string>;
  ijkToRAS: number[];
  clim: [number, number];
  ct: ZarrDesc;
  labels: ZarrDesc;
  segments: { num: number; name: string; color: number[] }[];
  groups: GroupInfo[];
}
/** `bytes` is CUMULATIVE for the named stream, against `total`. fetchZarrVolume's own callback
 *  reports a per-chunk DELTA, so the running sum is kept here — one place, rather than in every
 *  consumer that wants a percentage. */
export interface LoadProgress { bytes: number; total: number; what: "ct" | "labels"; done?: boolean }

export interface ColorizeScene {
  scene: SceneRenderer;
  slice: SliceRenderer;
  field: ColorizeField;
  manifest: Manifest;
  segments: SegmentInfo[];
  groups: GroupInfo[];
  center: Vec3;
  radius: number;
  dims: Vec3;
  roi: RoiWidget;
  presetName(): string;
  setPreset(name: string): void;
  /** Opacity for a whole group (0..1) — what the popup sliders drive. */
  groupOpacity(group: string): number;
  setGroupOpacity(group: string, o: number): void;
  /** Resolves when the CT has landed and the view has switched from flat surfaces to full
   *  colorize rendering. The labels render immediately; this is the rest. */
  ctReady: Promise<void>;
  ctLoaded(): boolean;
  /** Opacity of the unlabelled body rendered by the CT transfer function. */
  contextOpacity(): number;
  setContextOpacity(o: number): void;
  /** Segment number at a voxel (0 outside / unlabelled). The label array is kept CPU-side so
   *  a pick can name the structure without a GPU readback. */
  labelValue(i: number, j: number, k: number): number;
  cropEnabled(): boolean;
  roiVisible(): boolean;
  setCropEnabled(on: boolean): void;
  setRoiVisible(on: boolean): void;
}

// Starting opacity per group. Everything at 1.0 is the honest default but a poor first view:
// the rib cage and lungs are outermost and fully opaque, so they hide every organ behind them
// and the demo opens on a wall of ribs. Fading the enclosing structures puts the organs on
// screen immediately; the sliders then take you either way.
export const GROUP_DEFAULT_OPACITY: Record<string, number> = {
  Organs: 0.9, Heart: 0.9, Vessels: 0.9, Intestines: 0.55, Vertebrae: 0.8,
  Lungs: 0.05, Ribs: 0.55, "Other bone": 0.5, Muscle: 0.05,
};

// A slider value is opacity per CENTIMETRE of tissue, not per voxel. With the unit distance at
// the voxel size (0.57 mm) a ray crossing 15 cm of lung takes ~265 samples, so even a slider at
// 0.02 accumulates to fully opaque and the whole top of the range does nothing visible. At 10 mm
// the number means roughly what someone dragging the slider expects it to.
const OPACITY_UNIT_MM = 10;

export function presetLUT(name: string) {
  const p = CT_PRESETS[name] ?? CT_PRESETS["CT-Soft-Tissue"];
  // The presets span the full CT range; clamp the LUT domain to what this scan actually holds
  // so all 256 entries land on real values instead of being spent on empty tails.
  const clim: [number, number] = [-1000, 1600];
  return { lut: lutFromTransferFunctions(p.color, p.opacity, clim), clim, preset: p };
}

export async function buildColorizeScene(
  gpu: Gpu,
  base: string,
  format?: GPUTextureFormat,
  onProgress?: (p: LoadProgress) => void,
): Promise<ColorizeScene> {
  const manifest = await (await fetch(base + "colorize.json")).json() as Manifest;
  const blobBase = base + "blobs/";

  // LABELS FIRST. They are ~0.6 MB against the CT's ~61 MB, so the segmentation can be on
  // screen as flat coloured surfaces about a second in, while the CT streams behind it.
  const ctTotal = manifest.ct.bytes ?? 0, labTotal = manifest.labels.bytes ?? 0;
  let labGot = 0;
  const labZ = await fetchZarrVolume(blobBase, manifest.labels, (n) => {
    labGot += n;
    onProgress?.({ bytes: labGot, total: labTotal, what: "labels" });
  });
  onProgress?.({ bytes: Math.max(labGot, labTotal), total: labTotal, what: "labels", done: true });

  const [nz, ny, nx] = manifest.ct.shape;
  const dims: Vec3 = [nx, ny, nz];
  let preset = "CT-Soft-Tissue";
  const { lut, clim, preset: p0 } = presetLUT(preset);

  const field = new ColorizeField(
    gpu.device, null, labZ.data, dims, lut,
    // Until the CT lands: no context (there are no scalars yet) and no brightness modulation,
    // which renders the labels as flat coloured surfaces. Both are turned up in ctReady below.
    //
    // The unlabelled body then settles at a LOW opacity. Several CT presets (CT-Soft-Tissue above
    // all) are fully opaque from -160 HU up, so at contextOpacity 1 the skin becomes a solid shell
    // that hides every coloured organ behind it — the demo looks broken.
    {
      clim, ijkToRAS: manifest.ijkToRAS, shade: p0.shade, contextOpacity: 0, ctModulation: 0,
      opacityUnitDistance: OPACITY_UNIT_MM,
    },
  );

  const segments: SegmentInfo[] = manifest.segments.map((s) => ({
    num: s.num, name: s.name, color: [s.color[0] / 255, s.color[1] / 255, s.color[2] / 255],
  }));
  for (const s of segments) field.setSegmentColor(s.num, s.color);

  let onCtArrived: (() => void) | null = null;
  const ctReady = new Promise<void>((res) => { onCtArrived = res; });
  // Deliberately NOT awaited: the caller gets a usable scene now and the CT fills in.
  let ctGot = 0;
  const ctFetch = fetchZarrVolume(blobBase, manifest.ct, (n) => {
    ctGot += n;
    onProgress?.({ bytes: ctGot, total: ctTotal, what: "ct" });
  })
    .then((ctZ) => {
      field.setCT(ctZ.data);
      field.setCtModulation(0.55);
      field.setContextOpacity(0.12);
      onProgress?.({ bytes: Math.max(ctGot, ctTotal), total: ctTotal, what: "ct", done: true });
      onCtArrived?.();
    });
  void ctFetch;

  const scene = new SceneRenderer(gpu, format);
  const [lo, hi] = field.aabb();
  let roi: RoiWidget = createRoiWidget(lo, hi, { coverage: 0.45 });
  let cropOn = false, roiOn = false;
  const rebuild = () => {
    scene.build(roiOn ? [field, roi.box, roi.handles] : [field]);
    scene.setBackground(0.05, 0.06, 0.09);
    if (cropOn) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip();
  };
  rebuild();

  const slice = new SliceRenderer(gpu, format);
  const applySlice = () => {
    slice.setVolume(field.patientToTexture(), lo, hi);
    slice.setTextures(field.volumeTexture());
    // Segmentation over the CT in the slice views, coloured from the SAME palette as the 3D
    // view — so a group slider fades the organ in all four panes at once.
    slice.setLabelOverlay(field.labelTexture(), field.paletteTexture());
    const wl = (CT_PRESETS[preset] ?? CT_PRESETS["CT-Soft-Tissue"]).windowLevel;
    slice.setWindowLevel(wl[0], wl[1]);
    slice.setOverlayOpacity(0.45);
  };

  // group -> segment numbers actually present, and the current opacity per group
  const groups = manifest.groups.filter((g) => g.segments.length);
  const gop = new Map<string, number>(
    groups.map((g) => [g.name, GROUP_DEFAULT_OPACITY[g.name] ?? 1]),
  );
  for (const g of groups) {
    const o = gop.get(g.name)!;
    for (const n of g.segments) field.setSegmentOpacity(n, o);
  }
  field.flushPalette();

  const labData = labZ.data;   // Float32Array of label numbers (see fetchZarrVolume)
  const out: ColorizeScene = {
    scene, slice, field, manifest, segments, groups,
    dims,
    labelValue(i, j, k) {
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
      return labData[(k * ny + j) * nx + i];
    },
    center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
    roi,
    presetName: () => preset,
    setPreset(name: string) {
      if (!CT_PRESETS[name]) return;
      preset = name;
      const r = presetLUT(name);
      field.setCtLUT(r.lut);
      field.setClim(r.clim[0], r.clim[1]);
      field.setShade(r.preset.shade);
      scene.syncUniforms();
      applySlice();
    },
    groupOpacity: (g) => gop.get(g) ?? 1,
    setGroupOpacity(g, o) {
      const grp = groups.find((x) => x.name === g);
      if (!grp) return;
      gop.set(g, o);
      for (const n of grp.segments) field.setSegmentOpacity(n, o);
      field.flushPalette();          // one 1 KB texture write, cheap per slider tick
    },
    ctReady, ctLoaded: () => field.ctLoaded,
    contextOpacity: () => field.getContextOpacity(),
    setContextOpacity(o) { field.setContextOpacity(o); scene.syncUniforms(); },
    cropEnabled: () => cropOn,
    roiVisible: () => roiOn,
    setCropEnabled(on) { cropOn = on; if (on) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip(); },
    setRoiVisible(on) { roiOn = on; rebuild(); },
  };
  applySlice();
  return out;
}
