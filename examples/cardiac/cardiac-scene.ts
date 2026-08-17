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
export function presetLUT(name: string): {
  lut: Uint8Array; clim: [number, number]; shade: [number, number, number, number];
} {
  const p = CARDIAC_PRESETS[name];
  const clim = presetClim(name);
  return { lut: lutFromTransferFunctions(p.color, p.scalarOpacity, clim), clim, shade: p.shade };
}

export interface LoadProgress {
  /** Bytes received so far / expected for the phase currently loading. */
  bytes: number;
  /** Cine phases uploaded so far, and in total. */
  frames: number;
  totalFrames: number;
  /** What is being fetched: the cine sequence or the (lazy) CTA. */
  what: "cine" | "cta";
}

export interface CardiacScene {
  scene: SceneRenderer;
  slice: SliceRenderer;
  /** null until ensureCta() has loaded it — the CTA is 57 MB and is not needed to start. */
  cta: ImageField | null;
  cine: CineField;
  browser: SequenceBrowser<number>;
  center: Vec3;
  radius: number;
  ctaIjkToRAS: number[];
  cineIjkToRAS: number[];
  ctaDims: Vec3;
  cineDims: Vec3;
  /** Resolves once every cine phase has been uploaded. */
  cineReady: Promise<void>;
  /** Fetch + build the static CTA on demand. Resolves immediately if already loaded. */
  ensureCta(onProgress?: (p: LoadProgress) => void): Promise<void>;
  ctaLoaded(): boolean;
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

export interface BuildOpts {
  /** Which dataset this page needs. "cine" loads only the 10 phases (~13 MB); "cta" loads only
   *  the static 512^3 volume (~57 MB). Splitting the demos in two is what lets each page fetch
   *  one dataset instead of both. */
  only?: "cine" | "cta";
}

export async function buildCardiacScene(
  gpu: Gpu,
  base: string,
  format?: GPUTextureFormat,
  onProgress?: (p: LoadProgress) => void,
  buildOpts: BuildOpts = {},
): Promise<CardiacScene> {
  const dev = gpu.device;

  // ---- 4D cine FIRST, progressively -------------------------------------------------
  // The page opens on the cine, so nothing else may block first paint. Phases are fetched
  // one at a time into a preallocated CineField; the caller can build and render as soon as
  // phase 0 lands (~1.3 MB) rather than after the whole 70 MB payload.
  const wantCine = buildOpts.only !== "cta";
  // The endo page has no cine at all: build a 1-phase placeholder so every downstream reference
  // (slice textures, bounds, the browser) stays valid without fetching 13 MB it will never show.
  const cineScene = wantCine
    ? await loadScene(base + "cine.json")
    : { nodes: {}, blobBase: base };
  const seqNode = wantCine
    ? Object.values(cineScene.nodes).find((n) => n.class === "vtkMRMLSequenceNode")!
    : null;
  const items = (seqNode?.attrs!.items ?? [{ index: "0", node: "" }]) as { index: string; node: string }[];
  const firstVol = wantCine ? cineScene.nodes[items[0].node] : null;
  const cineIjkToRAS = (firstVol?.attrs!.ijkToRAS as number[]) ?? [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const z0 = firstVol?.attrs!.zarr as ZarrDesc | undefined;
  const cineDims: Vec3 = z0 ? [z0.shape[2], z0.shape[1], z0.shape[0]] : [2, 2, 2];

  const cinePreset = presetLUT("CT-Coronary-Arteries-3");
  const cine = new CineField(dev, items.length, cineDims, cinePreset.lut, {
    clim: cinePreset.clim, ijkToRAS: cineIjkToRAS, shade: cinePreset.shade,
  });

  const report = (what: "cine" | "cta", bytes: number) =>
    onProgress?.({ bytes, frames: cine.framesLoaded, totalFrames: items.length, what });

  // phase 0 before we return, so the caller always has something to draw
  if (wantCine && z0) {
    const zv = await fetchZarrVolume(cineScene.blobBase, z0, (n) => report("cine", n));
    cine.setFrameData(0, zv.data);
    report("cine", 0);
  }
  // the rest in the background
  const cineReady = (async () => {
    if (!wantCine) return;
    for (let i = 1; i < items.length; i++) {
      const vn = cineScene.nodes[items[i].node];
      const zv = await fetchZarrVolume(cineScene.blobBase, vn.attrs!.zarr as ZarrDesc, (n) => report("cine", n));
      cine.setFrameData(i, zv.data);
      report("cine", 0);
    }
  })();

  // ---- static CTA: lazy ---------------------------------------------------------------
  let cta: ImageField | null = null;
  let ctaIjkToRAS: number[] = [];
  let ctaDims: Vec3 = [0, 0, 0];
  let ctaPending: Promise<void> | null = null;
  const ensureCta = (onP?: (p: LoadProgress) => void): Promise<void> => {
    if (cta) return Promise.resolve();
    if (ctaPending) return ctaPending;
    ctaPending = (async () => {
      const ctaScene = await loadScene(base + "cta.json");
      const ctaVol = Object.values(ctaScene.nodes).find((n) => n.class === "vtkMRMLScalarVolumeNode")!;
      ctaIjkToRAS = ctaVol.attrs!.ijkToRAS as number[];
      const zv = await fetchZarrVolume(ctaScene.blobBase, ctaVol.attrs!.zarr as ZarrDesc,
        (n) => onP?.({ bytes: n, frames: 0, totalFrames: 0, what: "cta" }));
      ctaDims = zv.dims;
      const p = presetLUT("CT-EndoVascular");
      cta = new ImageField(dev, zv.data, zv.dims, [1, 1, 1], p.lut, {
        clim: p.clim, ijkToRAS: ctaIjkToRAS, shade: p.shade,
      });
    })();
    return ctaPending;
  };

  // ---- sequence browser (mirrors vtkMRMLSequenceBrowserNode) --------------------------
  // On the endo page there is no sequence node; keep a valid 1-item browser so every
  // downstream reference stays live without special-casing the caller.
  const sa = (seqNode?.attrs ?? {}) as Record<string, unknown>;
  const sequence = new Sequence<number>({
    indexName: (sa.indexName as string) ?? "frame",
    indexUnit: (sa.indexUnit as string) ?? "",
    indexType: (sa.indexType as "numeric" | "text") ?? "numeric",
    numericIndexValueTolerance: (sa.numericIndexValueTolerance as number) ?? 0.001,
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

  // The endo page renders the CTA, so it must be loaded BEFORE the scene is built — otherwise
  // build() captures the (empty) cine placeholder field and the 3D view stays black.
  if (buildOpts.only === "cta") await ensureCta((p) => onProgress?.(p));

  // ---- renderers --------------------------------------------------------------------
  const scene = new SceneRenderer(gpu, format);
  let mode: "cta" | "cine" = buildOpts.only === "cta" ? "cta" : "cine";
  let preset = buildOpts.only === "cta" ? "CT-EndoVascular" : "CT-Coronary-Arteries-3";

  // ROI crop widget, spanning the middle of whichever volume is showing. The wireframe and
  // its handles are `clippable:false`, so the box never crops itself.
  let roi: RoiWidget = createRoiWidget(...(((mode === "cta" && cta) ? cta : cine).aabb()), { coverage: 0.3 });
  let cropOn = false, roiOn = false;
  const rebuild = () => {
    const vol = (mode === "cta" && cta) ? cta : cine;
    scene.build(roiOn ? [vol, roi.box, roi.handles] : [vol]);
    scene.setBackground(0.05, 0.06, 0.09);
    if (cropOn) scene.setClipBox(roi.lo(), roi.hi()); else scene.clearClip();
  };
  rebuild();

  const slice = new SliceRenderer(gpu, format);
  const applySliceVolume = () => {
    const f = (mode === "cta" && cta) ? cta : cine;
    const [lo, hi] = f.aabb();
    slice.setVolume(f.patientToTexture(), lo, hi);
    slice.setTextures(f.volumeTexture());
    const wl = CARDIAC_PRESETS[preset].windowLevel ?? [1400, 300];
    slice.setWindowLevel(wl[0], wl[1]);
    slice.setOverlayOpacity(0);
  };
  applySliceVolume();

  const bounds = (): { center: Vec3; radius: number } => {
    const [lo, hi] = ((mode === "cta" && cta) ? cta : cine).aabb();
    return {
      center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
      radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
    };
  };
  const b0 = bounds();

  const out: CardiacScene = {
    scene, slice, cine, browser,
    get cta() { return cta; },
    cineReady, ensureCta, ctaLoaded: () => !!cta,
    center: b0.center, radius: b0.radius,
    cineIjkToRAS,
    get ctaDims() { return ctaDims; }, cineDims,
    get ctaIjkToRAS() { return ctaIjkToRAS; },
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
      const { lut, clim, shade } = presetLUT(name);
      // setLUT rewrites the 256-entry texture in place; clim and the Phong coefficients move
      // with the preset (both uniform writes). Neither touches the pipeline.
      const f = (mode === "cta" && cta) ? cta : cine;
      f.setLUT(lut);
      (f as unknown as { clim: [number, number]; shade: [number, number, number, number] }).clim = clim;
      (f as unknown as { clim: [number, number]; shade: [number, number, number, number] }).shade = shade;
      scene.syncUniforms();
      applySliceVolume();
    },
    setMode(m: "cta" | "cine") {
      if (m === mode) return;
      mode = m;
      // The two volumes have very different extents, so re-fit the ROI to the new one.
      const [lo, hi] = ((m === "cta" && cta) ? cta : cine).aabb();
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
