// Cardiac example — scene construction (no DOM, so it builds headless under Deno too).
//
// Reproduces the rendering options of two CHOP/SlicerHeart papers on public sample data:
//
//   Cianciulli et al., JACC Case Reports 2025 (doi:10.1016/j.jaccas.2024.102827)
//     Volume rendering of CTA with a transfer function that shows MYOCARDIUM rather than
//     the contrast-filled blood pool, so the camera can sit inside a chamber and look at
//     the endocardial surface. That is SlicerHeart's CT-EndoVascular preset.
//
//   Iacovella et al., Radiology: Cardiothoracic Imaging 2026 (doi:10.1148/ryct.250129)
//     The same idea plus time: 4D cine playback of the volume-rendered heart.
//
// Data (both public, direct download, no registration) is prepared by prep.ts:
//   CTA-cardio.nrrd     512x512x321 adult cardiac CTA
//   CT-cardio.seq.nrrd  10 cardiac phases x 128x104x72
//
// See docs/CARDIAC-RENDERING-PLAN.md and docs/SEQUENCES-CINE.md.

import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { SliceRenderer } from "../../render/slice-renderer.ts";
import { ImageField } from "../../render/fields.ts";
import { CineField } from "../../render/cine-field.ts";
import { Sequence, SequenceBrowser } from "../../render/sequence.ts";
import { fetchZarrVolume, type ZarrDesc } from "../../render/zarr.ts";
import { createRoiWidget, type RoiWidget } from "../../render/demos/roi-widget.ts";
import { lutFromTransferFunctions } from "../../render/scene-volume.ts";
import type { Vec3 } from "../../render/mat4.ts";
import { CARDIAC_PRESETS } from "./presets.ts";

interface SceneNode {
  class: string;
  name?: string;
  attrs?: Record<string, unknown>;
  refs?: Record<string, string[]>;
}
interface SceneFile {
  blobBase?: string;
  nodes: Record<string, SceneNode>;
}

async function loadScene(url: string): Promise<{ nodes: Record<string, SceneNode>; blobBase: string }> {
  const raw = await (await fetch(url)).json() as SceneFile;
  const pageBase = (globalThis as { location?: { href?: string } }).location?.href ?? "file:///";
  const sceneAbs = new URL(url, pageBase).href;
  return { nodes: raw.nodes, blobBase: new URL(raw.blobBase ?? "./blobs/", sceneAbs).href };
}

/** clim for a preset = the span of its colour transfer function, as Slicer does it. */
function presetClim(name: string): [number, number] {
  const p = CARDIAC_PRESETS[name];
  return [p.color[0][0], p.color[p.color.length - 1][0]];
}
export function presetLUT(name: string): { lut: Uint8Array; clim: [number, number] } {
  const p = CARDIAC_PRESETS[name];
  const clim = presetClim(name);
  return { lut: lutFromTransferFunctions(p.color, p.scalarOpacity, clim), clim };
}

export interface CardiacScene {
  scene: SceneRenderer;
  slice: SliceRenderer;
  cta: ImageField;
  cine: CineField;
  browser: SequenceBrowser<number>;
  center: Vec3;
  radius: number;
  ctaIjkToRAS: number[];
  cineIjkToRAS: number[];
  ctaDims: Vec3;
  cineDims: Vec3;
  roi: RoiWidget;
  /** Slicer's Volume Rendering module has exactly these two switches. */
  cropEnabled(): boolean;
  roiVisible(): boolean;
  setCropEnabled(on: boolean): void;
  setRoiVisible(on: boolean): void;
  /** Swap the 3D transfer function preset (LUT rewritten in place — no pipeline rebuild). */
  setPreset(name: string): void;
  /** Show the static CTA or the 4D cine in the 3D view. Rebuilds the scene's field list. */
  setMode(mode: "cta" | "cine"): void;
  mode(): "cta" | "cine";
  presetName(): string;
}

export async function buildCardiacScene(
  gpu: Gpu,
  base: string,
  format?: GPUTextureFormat,
  onBytes?: (n: number) => void,
): Promise<CardiacScene> {
  const dev = gpu.device;

  // ---- static CTA ------------------------------------------------------------------
  const ctaScene = await loadScene(base + "cta.json");
  const ctaVol = Object.values(ctaScene.nodes).find((n) => n.class === "vtkMRMLScalarVolumeNode")!;
  const ctaIjkToRAS = ctaVol.attrs!.ijkToRAS as number[];
  const ctaZ = await fetchZarrVolume(ctaScene.blobBase, ctaVol.attrs!.zarr as ZarrDesc, onBytes);
  const p0 = "CT-EndoVascular";
  const { lut, clim } = presetLUT(p0);
  const cta = new ImageField(dev, ctaZ.data, ctaZ.dims, [1, 1, 1], lut, {
    clim, ijkToRAS: ctaIjkToRAS, shade: [0.25, 0.75, 0.5, 24],
  });

  // ---- 4D cine ---------------------------------------------------------------------
  const cineScene = await loadScene(base + "cine.json");
  const seqNode = Object.values(cineScene.nodes).find((n) => n.class === "vtkMRMLSequenceNode")!;
  const items = seqNode.attrs!.items as { index: string; node: string }[];
  const frames: Float32Array[] = [];
  let cineDims: Vec3 = [0, 0, 0];
  let cineIjkToRAS: number[] = [];
  for (const it of items) {
    const vn = cineScene.nodes[it.node];
    const zv = await fetchZarrVolume(cineScene.blobBase, vn.attrs!.zarr as ZarrDesc, onBytes);
    frames.push(zv.data);
    cineDims = zv.dims;
    cineIjkToRAS = vn.attrs!.ijkToRAS as number[];
  }
  // Cardiac CT over a beating heart: CT-Cardiac3 (blood pool opaque) reads better in motion
  // than the endovascular inversion, which is meant for a camera inside the chamber.
  const cinePreset = presetLUT("CT-Cardiac3");
  const cine = new CineField(dev, frames, cineDims, cinePreset.lut, {
    clim: cinePreset.clim, ijkToRAS: cineIjkToRAS, shade: [0.25, 0.75, 0.5, 24],
  });

  // ---- sequence browser (mirrors vtkMRMLSequenceBrowserNode) --------------------------
  const sa = seqNode.attrs!;
  const sequence = new Sequence<number>({
    indexName: sa.indexName as string,
    indexUnit: sa.indexUnit as string,
    indexType: sa.indexType as "numeric" | "text",
    numericIndexValueTolerance: sa.numericIndexValueTolerance as number,
  });
  items.forEach((it, i) => sequence.setDataNodeAtValue(i, it.index));
  const browser = new SequenceBrowser<number>();
  const brAttrs = Object.values(cineScene.nodes).find((n) => n.class === "vtkMRMLSequenceBrowserNode")?.attrs ?? {};
  browser.playbackRateFps = (brAttrs.playbackRateFps as number) ?? 10;
  browser.playbackLooped = (brAttrs.playbackLooped as boolean) ?? true;
  // The proxy update: point the CineField at the current frame. Continuous position drives
  // inter-frame interpolation so playback is smooth rather than stepped.
  browser.addSynchronizedSequence(sequence, () => {
    cine.setFrame(browser.continuousItem, browser.playbackLooped);
  });

  // ---- renderers --------------------------------------------------------------------
  const scene = new SceneRenderer(gpu, format);
  let mode: "cta" | "cine" = "cta";
  let preset = p0;

  // ROI crop widget, spanning the middle of whichever volume is showing. The wireframe and
  // its handles are `clippable:false`, so the box never crops itself.
  let roi: RoiWidget = createRoiWidget(...cta.aabb(), { coverage: 0.3 });
  let cropOn = false, roiOn = false;
  const rebuild = () => {
    const vol = mode === "cta" ? cta : cine;
    scene.build(roiOn ? [vol, roi.box, roi.handles] : [vol]);
    scene.setBackground(0.05, 0.06, 0.09);
    if (cropOn) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip();
  };
  rebuild();

  const slice = new SliceRenderer(gpu, format);
  const applySliceVolume = () => {
    const f = mode === "cta" ? cta : cine;
    const [lo, hi] = f.aabb();
    slice.setVolume(f.patientToTexture(), lo, hi);
    slice.setTextures(f.volumeTexture());
    const wl = CARDIAC_PRESETS[preset].windowLevel ?? [1400, 300];
    slice.setWindowLevel(wl[0], wl[1]);
    slice.setOverlayOpacity(0);
  };
  applySliceVolume();

  const bounds = (): { center: Vec3; radius: number } => {
    const [lo, hi] = (mode === "cta" ? cta : cine).aabb();
    return {
      center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
      radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
    };
  };
  const b0 = bounds();

  const out: CardiacScene = {
    scene, slice, cta, cine, browser,
    center: b0.center, radius: b0.radius,
    ctaIjkToRAS, cineIjkToRAS,
    ctaDims: ctaZ.dims, cineDims,
    mode: () => mode,
    presetName: () => preset,
    roi,
    cropEnabled: () => cropOn,
    roiVisible: () => roiOn,
    setCropEnabled(on: boolean) { cropOn = on; if (on) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip(); },
    setRoiVisible(on: boolean) { roiOn = on; rebuild(); },
    setPreset(name: string) {
      if (!CARDIAC_PRESETS[name]) return;
      preset = name;
      const { lut, clim } = presetLUT(name);
      // setLUT rewrites the 256-entry texture in place; clim moves with the preset, which
      // is a uniform write. Neither touches the pipeline.
      if (mode === "cta") { cta.setLUT(lut); (cta as unknown as { clim: [number, number] }).clim = clim; }
      else { cine.setLUT(lut); (cine as unknown as { clim: [number, number] }).clim = clim; }
      scene.syncUniforms();
      applySliceVolume();
    },
    setMode(m: "cta" | "cine") {
      if (m === mode) return;
      mode = m;
      // The two volumes have very different extents, so re-fit the ROI to the new one.
      const [lo, hi] = (m === "cta" ? cta : cine).aabb();
      roi = createRoiWidget(lo, hi, { coverage: 0.3 });
      out.roi = roi;
      rebuild();
      const b = bounds();
      out.center = b.center; out.radius = b.radius;
      applySliceVolume();
    },
  };
  return out;
}
