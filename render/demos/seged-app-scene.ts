// seged app scene — the standalone, AGENT-EDITABLE segmentation scene. Loads an IDC case (CT + DICOM
// SEG) via idc_tools, puts EVERYTHING on ONE capped working grid (CT grayscale/VR + labelmap + editable
// + 2D overlay all share the grid, so they align and stay memory-safe), and drives:
//   • 3D  : SegmentationLogic (colorized JFA-SDF surface) — re-bakes on every edit
//   • 2D  : a crisp (σ=0) ColorizeBaker overlay from the SAME EditableSegmentation master
//   • edit: SegEditDriver (paint / erase / scissors / seeds) — the agent's hands
// This is the segroulette render path + the seged-manager editable pattern, merged and exposed for a
// cooperative AI agent (applyOp / readLabelmap / setLabelmap / dice / segment stats).
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { ImageField, type Field } from "../fields.ts";
import { ColorizeBaker } from "../bake.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { SegEditDriver } from "../../algorithms/seg-edit-driver.ts";
import { uploadImage } from "../../algorithms/effects/growcut.ts";
import { labelmapHasInternalBoundary, resampleIsotropic, type Vec3 } from "../../algorithms/geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { dice as diceLabel } from "../../algorithms/eval/degrade.ts";
import { modalityLUT } from "./seged-lut.ts";
import type { CTVolume, SegLabelmap } from "../vendor/idc_tools/types.js";

const SDF_MAX_DIM = 256;

export interface SegInfo { num: number; name: string; color: [number, number, number]; voxels: number }

export interface SegedScene {
  scene: SceneRenderer;
  slice: SliceRenderer;
  editable: EditableSegmentation;
  driver: SegEditDriver;
  /** The CT scalar volume (HU) on the working grid — the native array to reason over directly. */
  ct: Float32Array;
  dims: Vec3;
  ijkToRAS: number[];
  rasLo: Vec3; rasHi: Vec3; center: Vec3; radius: number;
  win: number; lev: number;
  segments: SegInfo[];
  /** Apply one SegEdit op (stroke/scissors/seeds) or a segment display patch, then re-render. */
  applyOp(op: unknown): Promise<void>;
  /** Current labelmap (working grid) — for scoring / diffing. */
  readLabelmap(): Promise<Uint8Array>;
  /** Replace the whole labelmap (used to install a degraded map, or reset). */
  setLabelmap(lab: Uint8Array): void;
  /** Live voxel count per segment number (labelmap readback). */
  voxelCounts(): Promise<Record<number, number>>;
  /** Dice of the current labelmap vs a reference, for a label. */
  diceVs(ref: ArrayLike<number>, label: number): Promise<number>;
  /** Inspect a segment's CURRENT geometry + intensity (for diagnosis — NOT ground truth): voxel count,
   *  IJK bbox, centroid (voxel + RAS), and HU stats of its voxels (min/median/max + fraction below 0 HU
   *  = fat/air, a tell for a leak out of soft tissue). */
  labelStats(label: number): Promise<{ label: number; voxels: number; bboxVox: [Vec3, Vec3]; centroidVox: Vec3; centroidRAS: Vec3; hu: { min: number; median: number; max: number; fracBelow0: number } }>;
  /** Intensity-guided cleanup: within `label`, REMOVE voxels whose CT HU is outside [min,max] (set to 0).
   *  The tool to trim a boundary leak that bled into a different-intensity tissue. Returns removed count. */
  thresholdTrim(label: number, min: number, max: number): Promise<number>;
  /** HU histogram of a segment's voxels — the distribution shape (bimodal = necrotic tumor / cyst vs
   *  enhancing parenchyma, etc.), for building intensity intuition across cases. */
  segHistogram(label: number, lo?: number, hi?: number, bins?: number): Promise<{ label: number; count: number; lo: number; hi: number; binWidth: number; counts: number[]; mean: number; p10: number; p50: number; p90: number }>;
  /** Register a redraw hook the app calls after any edit (draw slices + 3D). */
  onRedraw(cb: () => void): void;
  setVolumeOpacity(o: number): void;
  /** BLIND CANDIDATE mode: the editable started EMPTY and the ground truth is held private. Score my
   *  current segmentation per class vs the hidden GT. */
  blind: boolean;
  scoreCandidate(): Promise<{ label: number; name: string; dice: number; mineVox: number; gtVox: number }[]>;
  /** After scoring: swap the view to the hidden GT (for the human to compare), and back to mine. */
  showGroundTruth(): void;
  showMine(): void;
  /** Set every voxel of `label` to 0 (e.g. drop a scratch "background" label after growcut). */
  clearLabel(label: number): Promise<number>;
  /** Map a fraction (0..1) within an MPR view (at out-of-plane fraction `off`) to a RAS point — so the
   *  agent can place a seed where it SEES a structure. Flip flags match the radiological display. */
  viewSeedRAS(orient: "axial" | "coronal" | "sagittal", uFrac: number, vFrac: number, off: number, flipU?: boolean, flipV?: boolean): Vec3;
  destroy(): void;
}

/** Nearest-resample any scalar array onto a target grid using the SAME index mapping resampleIsotropic
 *  uses for the labelmap, so CT + labelmap land on an identical grid. */
function resampleScalarNearest(src: ArrayLike<number>, srcDims: Vec3, dstDims: Vec3): Float32Array {
  const [nx, ny, nz] = srcDims, [cx, cy, cz] = dstDims;
  const out = new Float32Array(cx * cy * cz);
  if (cx === nx && cy === ny && cz === nz) { for (let i = 0; i < out.length; i++) out[i] = src[i]; return out; }
  for (let z = 0; z < cz; z++) { const sz = Math.min(nz - 1, Math.floor((z + 0.5) * nz / cz));
    for (let y = 0; y < cy; y++) { const sy = Math.min(ny - 1, Math.floor((y + 0.5) * ny / cy));
      for (let x = 0; x < cx; x++) { const sx = Math.min(nx - 1, Math.floor((x + 0.5) * nx / cx));
        out[(z * cy + y) * cx + x] = src[(sz * ny + sy) * nx + sx]; } } }
  return out;
}

export function buildSegedScene(gpu: Gpu, format: GPUTextureFormat, ct: CTVolume, seg: SegLabelmap, opts: { sdfMaxDim?: number; blind?: boolean } = {}): SegedScene {
  const dev = gpu.device;
  // ONE capped grid for everything (from the labelmap's physical extent).
  const cap = resampleIsotropic(seg.lab, ct.dims, ct.ijkToRAS, opts.sdfMaxDim ?? SDF_MAX_DIM);
  const dims = cap.dims, ijkToRAS = cap.ijkToRAS;
  const lab0 = Uint8Array.from(cap.lab);                                   // capped labelmap (u8)
  const ctSrc = ct.vol instanceof Float32Array ? ct.vol : Float32Array.from(ct.vol);
  const ctCap = resampleScalarNearest(ctSrc, ct.dims, dims);              // CT on the SAME grid

  // segments + palette (skip background / grid-covering labels)
  const segments: SegInfo[] = [];
  const total = dims[0] * dims[1] * dims[2];
  const overlayPalette = new Float32Array(256 * 4);
  for (const [num, r, g, b] of seg.colors) {
    if (num === 0 || (r === 0 && g === 0 && b === 0)) continue;
    let n = 0; for (let i = 0; i < lab0.length; i++) if (lab0[i] === num) n++;
    if (!n || n > total * 0.6) continue;
    if (num < 256) { const o = num * 4; overlayPalette[o] = r; overlayPalette[o + 1] = g; overlayPalette[o + 2] = b; overlayPalette[o + 3] = 1; }
    segments.push({ num, name: seg.names[num] ?? `Segment ${num}`, color: [r, g, b], voxels: n });
  }

  // CT grayscale/VR field (context) on the capped grid.
  const clim: [number, number] = [ct.lev - ct.win / 2, ct.lev + ct.win / 2];
  const baseVolLut = modalityLUT(ct.modality);
  const scaledVolLut = (o: number) => { const l = baseVolLut.slice(); for (let i = 0; i < 256; i++) l[i * 4 + 3] = Math.round(l[i * 4 + 3] * o); return l; };
  const volumeField = new ImageField(dev, ctCap, dims, [1, 1, 1], baseVolLut, { clim, ijkToRAS, shade: [0.25, 0.7, 0.45, 20] });

  // Editable segmentation (the agent's target) → 3D SDF + growcut image.
  const editable = new EditableSegmentation(dev, dims, { ijkToRAS });
  const imageTex = uploadImage(dev, ctCap, dims);                          // CT intensity for grow-from-seeds
  const labelForNum = new Map<string, number>();
  for (const s of segments) labelForNum.set(String(s.num), s.num);
  const driver = new SegEditDriver(editable, {
    labelForSegment: (id) => labelForNum.get(id) ?? (Number(id) || 1),
    imageTex,
  });
  const boundaryMode = labelmapHasInternalBoundary(lab0, dims) ? "all" : "outer";
  const segLogic = new SegmentationLogic(dev, editable, { renderMode: "sdf", opacity: 1.0, boundaryMode });
  for (const s of segments) { segLogic.setLabelColor(s.num, s.color); segLogic.setLabelOpacity(s.num, 1); }

  // 2D crisp overlay from the SAME master.
  const overlayBaker = new ColorizeBaker(dev, editable.masterTexture(), dims);
  const overlayTex = overlayBaker.output();
  const bakeOverlay = () => overlayBaker.bakeInto(overlayTex, overlayPalette, 0);

  // BLIND CANDIDATE mode: hold the GT private, start the editable EMPTY (I build from CT reasoning).
  const groundTruth = lab0;
  let mine: Uint8Array | null = null;
  const startLab = opts.blind ? new Uint8Array(lab0.length) : lab0;
  editable.loadLabelmap(startLab);
  segLogic.refineNow();
  bakeOverlay();

  const scene = new SceneRenderer(gpu, format);
  const [rasLo, rasHi] = volumeField.aabb();
  let volumeOpacity = 0.35, showVolume = true;
  const rebuild = () => {
    const f: Field[] = [];
    if (showVolume) f.push(volumeField);
    f.push(segLogic.field());
    scene.build(f);
    scene.setBackground(0.05, 0.06, 0.09);
  };
  rebuild();

  const slice = new SliceRenderer(gpu, format);
  slice.setVolume(volumeField.patientToTexture(), rasLo, rasHi);
  slice.setTextures(volumeField.volumeTexture(), overlayTex);
  slice.setWindowLevel(ct.win, ct.lev);
  slice.setOverlayOpacity(0.5);

  let redrawCb: () => void = () => {};
  // Every edit: SegmentationLogic re-bakes the 3D field → onRedraw → re-bake the 2D overlay + app redraw.
  segLogic.onRedraw(() => { bakeOverlay(); slice.setTextures(volumeField.volumeTexture(), overlayTex); redrawCb(); });

  const center: Vec3 = [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2];
  const radius = Math.hypot(rasHi[0] - rasLo[0], rasHi[1] - rasLo[1], rasHi[2] - rasLo[2]) / 2;

  return {
    scene, slice, editable, driver, ct: ctCap, dims, ijkToRAS, rasLo, rasHi, center, radius, win: ct.win, lev: ct.lev, segments,
    async applyOp(op) { await this.driver.applyEdit(op); segLogic.refineNow(); },
    readLabelmap: async () => { const u = await editable.readLabelmap(); return Uint8Array.from(u); },
    setLabelmap(lab) { editable.loadLabelmap(lab); segLogic.refineNow(); },
    async voxelCounts() { const lab = await editable.readLabelmap(); const c: Record<number, number> = {}; for (const s of segments) c[s.num] = 0; for (let i = 0; i < lab.length; i++) { const v = lab[i]; if (v in c) c[v]++; } return c; },
    async diceVs(ref, label) { const lab = await editable.readLabelmap(); return diceLabel(lab, ref, label); },
    async labelStats(label) {
      const lab = await editable.readLabelmap();
      const [nx, ny, nz] = dims;
      let n = 0, sx = 0, sy = 0, sz = 0; const lo: Vec3 = [nx, ny, nz], hi: Vec3 = [-1, -1, -1]; const hus: number[] = [];
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const i = (z * ny + y) * nx + x; if (lab[i] !== label) continue;
        n++; sx += x; sy += y; sz += z;
        if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
        if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
        hus.push(ctCap[i]);
      }
      hus.sort((a, b) => a - b);
      const cv: Vec3 = n ? [sx / n, sy / n, sz / n] : [0, 0, 0];
      const m = ijkToRAS;
      const cr: Vec3 = [m[0] * cv[0] + m[1] * cv[1] + m[2] * cv[2] + m[3], m[4] * cv[0] + m[5] * cv[1] + m[6] * cv[2] + m[7], m[8] * cv[0] + m[9] * cv[1] + m[10] * cv[2] + m[11]];
      const below0 = hus.filter((h) => h < 0).length;
      return { label, voxels: n, bboxVox: [lo, hi], centroidVox: cv, centroidRAS: cr,
        hu: { min: hus[0] ?? 0, median: hus[Math.floor(hus.length / 2)] ?? 0, max: hus[hus.length - 1] ?? 0, fracBelow0: n ? below0 / n : 0 } };
    },
    async segHistogram(label, lo = -200, hi = 400, bins = 24) {
      const u = await editable.readLabelmap();
      const w = (hi - lo) / bins; const counts = new Array(bins).fill(0); let n = 0, sum = 0; const vals: number[] = [];
      for (let i = 0; i < u.length; i++) { if (u[i] !== label) continue; n++; const h = ctCap[i]; sum += h; vals.push(h); let b = Math.floor((h - lo) / w); b = Math.max(0, Math.min(bins - 1, b)); counts[b]++; }
      vals.sort((a, b) => a - b);
      const pct = (p: number) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
      return { label, count: n, lo, hi, binWidth: w, counts, mean: n ? sum / n : 0, p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) };
    },
    async thresholdTrim(label, min, max) {
      const u = await editable.readLabelmap();
      const lab = Uint8Array.from(u);
      let removed = 0;
      for (let i = 0; i < lab.length; i++) { if (lab[i] === label && (ctCap[i] < min || ctCap[i] > max)) { lab[i] = 0; removed++; } }
      editable.loadLabelmap(lab); segLogic.refineNow();
      return removed;
    },
    onRedraw(cb) { redrawCb = cb; },
    setVolumeOpacity(o) { volumeOpacity = Math.max(0, Math.min(1, o)); const was = showVolume; showVolume = volumeOpacity > 0.001; volumeField.setLUT(scaledVolLut(volumeOpacity)); if (was !== showVolume) rebuild(); else scene.syncUniforms(); redrawCb(); },
    setLabelOpacity(label: number, o: number) { segLogic.setLabelOpacity(label, Math.max(0, Math.min(1, o))); segLogic.refineNow(); redrawCb(); },
    blind: !!opts.blind,
    async scoreCandidate() {
      const cur = await editable.readLabelmap();
      const gtCount: Record<number, number> = {}, mineCount: Record<number, number> = {}, inter: Record<number, number> = {};
      for (const s of segments) { gtCount[s.num] = 0; mineCount[s.num] = 0; inter[s.num] = 0; }
      for (let i = 0; i < cur.length; i++) {
        const g = groundTruth[i], m = cur[i];
        if (g in gtCount) gtCount[g]++;
        if (m in mineCount) mineCount[m]++;
        if (g === m && g in inter) inter[g]++;
      }
      return segments.map((s) => ({ label: s.num, name: s.name, dice: (mineCount[s.num] + gtCount[s.num]) ? (2 * inter[s.num]) / (mineCount[s.num] + gtCount[s.num]) : 1, mineVox: mineCount[s.num], gtVox: gtCount[s.num] }));
    },
    async showGroundTruth() { mine = await this.readLabelmap(); editable.loadLabelmap(groundTruth); segLogic.refineNow(); },
    showMine() { if (mine) { editable.loadLabelmap(mine); segLogic.refineNow(); } },
    async clearLabel(label) { const u = await editable.readLabelmap(); const lab = Uint8Array.from(u); let n = 0; for (let i = 0; i < lab.length; i++) if (lab[i] === label) { lab[i] = 0; n++; } editable.loadLabelmap(lab); segLogic.refineNow(); return n; },
    viewSeedRAS(orient, uFrac, vFrac, off, flipU = false, flipV = false) {
      const u = flipU ? 1 - uFrac : uFrac, v = flipV ? 1 - vFrac : vFrac;
      const at = (a: number, f: number) => rasLo[a] + f * (rasHi[a] - rasLo[a]);
      // in-plane axes per orientation (u horizontal, v vertical) + fixed out-of-plane axis = off
      if (orient === "axial") return [at(0, u), at(1, v), at(2, off)];       // R,A fixed S
      if (orient === "coronal") return [at(0, u), at(1, off), at(2, v)];     // R,S fixed A
      return [at(0, off), at(1, u), at(2, v)];                                // sagittal: A,S fixed R
    },
    destroy() { segLogic.destroy(); editable.destroy(); imageTex.destroy(); overlayTex.destroy(); },
  };
}
