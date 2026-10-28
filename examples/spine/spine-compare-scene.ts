// SlicerLive spine-compare scene: one case from the spine-review bucket — the CT
// (zarr, low→med) with TWO vertebra labelmaps on the same med grid: SPINEPS and
// the IDC reference (expert for spine-mets, nnU-Net for myeloma).
//
// Two method ROWS, CompareVolumes-style: per-method MPR overlays (crisp NEAREST
// colorize, shared level palette so the same-named bone matches colours across
// rows — a level mismatch reads as a colour mismatch) + a per-method 3D SDF
// shell in level colours over a faint CT VR. ONE SliceRenderer is shared by
// both rows (the overlay texture is swapped per draw), so pan/zoom/scroll state
// is identical across rows by construction. The level buttons drive an EXTENT:
// a clip box around the selected vertebra (±N or full spine) applied to both 3D
// scenes, plus a focus bbox the browser uses to frame cameras and zoom slices.
//
// PROGRESSIVE LOAD: the object store throttles GETs (~0.5 MB/s), so the ~35 MB
// ct_med would mean a minute of black screen. Phase A fetches ct_low (~1 MB) +
// both masks and shows the full scene in seconds (masks client-resampled onto
// the low grid for the 2D overlays; the 3D SDF shells are med-native either
// way). ct_med streams in the background and swaps in when it lands
// (`upgraded` resolves — redraw then).
import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { SliceRenderer } from "../../render/slice-renderer.ts";
import { ImageField } from "../../render/fields.ts";
import { bakeColorizeRGBA } from "../../render/bake.ts";
import { fetchZarrVolume, type ZarrDesc, type ZarrVolume } from "../../render/zarr.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { resampleIsotropic } from "../../algorithms/geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { formatBytes, gpuBudget, sdfVoxelCap } from "../../render/gpu-budget.ts";
import { JfaSdfBaker } from "../../render/sdf-bake.ts";
import type { Vec3 } from "../../render/mat4.ts";

export const BUCKET = "https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/";

export const LEVEL_NAME: Record<number, string> = {
  1: "C1", 2: "C2", 3: "C3", 4: "C4", 5: "C5", 6: "C6", 7: "C7",
  8: "T1", 9: "T2", 10: "T3", 11: "T4", 12: "T5", 13: "T6", 14: "T7", 15: "T8",
  16: "T9", 17: "T10", 18: "T11", 19: "T12", 20: "L1", 21: "L2", 22: "L3",
  23: "L4", 24: "L5", 25: "L6", 26: "S1", 27: "Cocc", 28: "T13", 29: "S2", 30: "S3",
};

// Slicer-label-like level palette: distinct hues cycling so ADJACENT vertebrae never share a colour.
const LEVEL_COLORS: [number, number, number][] = [
  [0.85, 0.42, 0.42], [0.42, 0.75, 0.42], [0.42, 0.55, 0.90], [0.90, 0.78, 0.35],
  [0.72, 0.45, 0.85], [0.35, 0.80, 0.80], [0.90, 0.55, 0.25], [0.55, 0.72, 0.30],
  [0.85, 0.45, 0.70], [0.40, 0.65, 0.60], [0.65, 0.55, 0.90], [0.80, 0.68, 0.50],
];
export const levelColor = (label: number): [number, number, number] => LEVEL_COLORS[label % LEVEL_COLORS.length];

export const METHOD_COLORS: Record<"spineps" | "ref", [number, number, number]> = {
  spineps: [0.95, 0.60, 0.20],   // warm orange
  ref: [0.30, 0.65, 0.95],       // cool blue
};

export interface CaseMeta {
  pid: string;
  collection: string;
  med_mm: number;
  low_mm: number;
  ijkToRAS_med: number[][] | number[];
  ijkToRAS_low: number[][] | number[];
  ct_range: [number, number];
  spineps_labels: number[];
  ref_labels: number[];
  volumes: Record<"ct_med" | "ct_low" | "spineps_med" | "ref_med", ZarrDesc>;
}

const flat = (m: number[][] | number[]): number[] =>
  Array.isArray(m[0]) ? (m as number[][]).flat() : (m as number[]);

/** Invert an affine 4x4 (row-major, last row 0001). */
function invertAffine(m: number[]): number[] {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  const i = [
    (r[4] * r[8] - r[5] * r[7]) / det, (r[2] * r[7] - r[1] * r[8]) / det, (r[1] * r[5] - r[2] * r[4]) / det,
    (r[5] * r[6] - r[3] * r[8]) / det, (r[0] * r[8] - r[2] * r[6]) / det, (r[2] * r[3] - r[0] * r[5]) / det,
    (r[3] * r[7] - r[4] * r[6]) / det, (r[1] * r[6] - r[0] * r[7]) / det, (r[0] * r[4] - r[1] * r[3]) / det,
  ];
  const t = [m[3], m[7], m[11]];
  return [
    i[0], i[1], i[2], -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2]),
    i[3], i[4], i[5], -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2]),
    i[6], i[7], i[8], -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2]),
    0, 0, 0, 1,
  ];
}

/** NEAREST-resample a labelmap from one grid onto another (both row-major ijkToRAS). */
function resampleLabels(
  lab: Uint8Array, dims: [number, number, number], ijkToRAS: number[],
  outDims: [number, number, number], outIjkToRAS: number[],
): Uint8Array {
  const [nx, ny, nz] = dims, [ox, oy, oz] = outDims;
  const m = invertAffine(ijkToRAS);   // RAS -> source ijk
  const g = outIjkToRAS;
  const out = new Uint8Array(ox * oy * oz);
  for (let k = 0; k < oz; k++) {
    for (let j = 0; j < oy; j++) {
      for (let i = 0; i < ox; i++) {
        const rx = g[0] * i + g[1] * j + g[2] * k + g[3];
        const ry = g[4] * i + g[5] * j + g[6] * k + g[7];
        const rz = g[8] * i + g[9] * j + g[10] * k + g[11];
        const si = Math.round(m[0] * rx + m[1] * ry + m[2] * rz + m[3]);
        const sj = Math.round(m[4] * rx + m[5] * ry + m[6] * rz + m[7]);
        const sk = Math.round(m[8] * rx + m[9] * ry + m[10] * rz + m[11]);
        if (si >= 0 && si < nx && sj >= 0 && sj < ny && sk >= 0 && sk < nz) {
          out[(k * oy + j) * ox + i] = lab[(sk * ny + sj) * nx + si];
        }
      }
    }
  }
  return out;
}

/** Per-level info computed from a labelmap in one pass (centroid + bbox, RAS). */
export interface LevelGeom {
  label: number;
  name: string;
  voxels: number;
  centroid: Vec3;      // RAS
  lo: Vec3;            // RAS bbox (envelope of transformed ijk bbox corners)
  hi: Vec3;
}

function levelGeometry(lab: Uint8Array, dims: [number, number, number], ijkToRAS: number[]): Map<number, LevelGeom> {
  const [nx, ny, nz] = dims;
  const acc = new Map<number, { n: number; s: [number, number, number]; lo: [number, number, number]; hi: [number, number, number] }>();
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const base = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const v = lab[base + i];
        if (!v) continue;
        let a = acc.get(v);
        if (!a) { a = { n: 0, s: [0, 0, 0], lo: [i, j, k], hi: [i, j, k] }; acc.set(v, a); }
        a.n++; a.s[0] += i; a.s[1] += j; a.s[2] += k;
        if (i < a.lo[0]) a.lo[0] = i; if (j < a.lo[1]) a.lo[1] = j; if (k < a.lo[2]) a.lo[2] = k;
        if (i > a.hi[0]) a.hi[0] = i; if (j > a.hi[1]) a.hi[1] = j; if (k > a.hi[2]) a.hi[2] = k;
      }
    }
  }
  const m = ijkToRAS;
  const xf = (p: [number, number, number]): Vec3 => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
  const out = new Map<number, LevelGeom>();
  for (const [label, a] of acc) {
    const c = xf([a.s[0] / a.n, a.s[1] / a.n, a.s[2] / a.n]);
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const ci of [a.lo[0], a.hi[0]]) for (const cj of [a.lo[1], a.hi[1]]) for (const ck of [a.lo[2], a.hi[2]]) {
      const r = xf([ci, cj, ck]);
      for (let d = 0; d < 3; d++) { if (r[d] < lo[d]) lo[d] = r[d]; if (r[d] > hi[d]) hi[d] = r[d]; }
    }
    out.set(label, { label, name: LEVEL_NAME[label] ?? String(label), voxels: a.n, centroid: c, lo, hi });
  }
  return out;
}

// SPINEPS vert_msk labels: n = vertebra (bone), 100+n = the INTERVERTEBRAL DISC below
// vertebra n (semantic class 100 — verified against spine_msk). Discs render as their own
// muted layer, never merged into the bone.
// NEAR-WHITE, not a muted tone close to the level colours. The vertebra palette is saturated, and a
// disc sits between two of those bodies with no gap, so a beige disc read as a smear ACROSS the two
// levels rather than as a structure of its own — the thing the disc layer exists to show. White is
// outside the level palette entirely, so the boundary between bone and disc is unambiguous.
export const DISC_COLOR: [number, number, number] = [0.96, 0.96, 0.94];
export const isDisc = (label: number) => label > 100;

export interface MethodRow {
  key: "spineps" | "ref";
  overlayTex: GPUTexture;               // this method's crisp colorized labelmap (current ct grid)
  scene: SceneRenderer;                 // this method's SDF shell (level colours) + faint CT VR
  logic: SegmentationLogic;
  levels: Map<number, LevelGeom>;
  destroy(): void;
}

export interface SpineCompareScene {
  meta: CaseMeta;
  dims: [number, number, number];       // CURRENT ct grid (low until upgraded)
  ijkToRAS: number[];
  rasLo: Vec3;
  rasHi: Vec3;
  center: Vec3;
  radius: number;
  win: number;
  lev: number;
  /** ONE slice renderer shared by both rows — swap `row.overlayTex` in before each draw.
   *  Shared state = pan/zoom/scroll linked across rows by construction. */
  slice: SliceRenderer;
  rows: MethodRow[];
  /** Point the shared slice renderer at this row's overlay (call before drawing a row's cells). */
  bindRowSlice(key: "spineps" | "ref"): void;
  /** Resolves when ct_med has streamed in and every view swapped to it — redraw then. */
  upgraded: Promise<void>;
  /** Per-method 3D shell opacity (tri-state UI) — applies to that row's scene. */
  setMethodOpacity(key: "spineps" | "ref", o: number): void;
  methodOpacity(key: "spineps" | "ref"): number;
  /** CT VR opacity inside the row 3D cells (LUT-scaled; 0 removes the field). */
  setVolumeOpacity(o: number): void;
  volumeOpacity(): number;
  /** Extent: clip BOTH row 3D scenes to ±count levels around `label`, hide every OTHER
   *  vertebra in the 3D shells (per-label opacity 0 — details of the selected level are
   *  unobstructed), and return the focus bbox (union of both methods, 12mm padded) for
   *  camera framing + slice zoom. Slice overlays keep all labels (2D doesn't occlude and
   *  the neighbour colours carry the shift signature). count>=99 or label null restores
   *  everything and returns null (= frame the whole case). */
  setExtent(label: number | null, count: number): { lo: Vec3; hi: Vec3 } | null;
  /** VERTEBRA labels currently visible in a row's 3D shell (all levels when unscoped). */
  visibleLevels(key: "spineps" | "ref"): number[];
  /** The muted intervertebral-disc layer (SPINEPS's 100+n labels): 0 hides, 1 full muted colour. */
  setDiscOpacity(o: number): void;
  discOpacity(): number;
  /** What this view is holding on the GPU, and the budget it sized itself to. Worth surfacing: when
   *  the grid is coarsened to fit, the surfaces a reviewer is comparing are lower-resolution than
   *  the data, and that has to be visible rather than silent. */
  memory(): { budgetBytes: number; why: string; rows: string[]; coarsened: boolean };
  /** 3D shell smoothing, σ in voxels of the SDF grid. 0 = the labelmap as segmented (every voxel
   *  face visible, which is what a review of the algorithm's actual output needs); higher = a
   *  modelled surface. Applies to both method rows. */
  setSegSmoothing(sigmaVoxels: number): void;
  segSmoothing(): number;
  destroy(): void;
}

const CT_WIN = 1400, CT_LEV = 400;   // bone-ish default for vertebra comparison

function ctLUT(maxAlpha = 0.32): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = Math.max(0, (t - 0.42) / 0.58); a *= a;
    lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = Math.round(t * 255);
    lut[i * 4 + 3] = Math.round(Math.min(maxAlpha, a) * 255);
  }
  return lut;
}

/** Phase A: ct_low + masks → full scene in seconds. Phase B (background): ct_med
 *  streams in and swaps under every view; `upgraded` resolves. */
export interface SpineShellOpts {
  shell?: "outer" | "all";   // SDF boundary mode (default "outer" — segroulette's crisp surface-model look)
  bandVox?: number;          // shell half-thickness override, in (isotropic SDF) voxels
}

export async function buildSpineCompareScene(
  gpu: Gpu,
  format: GPUTextureFormat,
  meta: CaseMeta,
  base: string,                        // e.g. BUCKET + "mets/10458/zarr/"
  onProgress?: (msg: string, bytes: number) => void,
  shellOpts?: SpineShellOpts,
): Promise<SpineCompareScene> {
  const dev = gpu.device;
  const vol = meta.volumes;
  const track = (msg: string) => (n: number) => onProgress?.(msg, n);
  const [ctLow, sp, ref] = await Promise.all([
    fetchZarrVolume(base, { ...vol.ct_low, dataset: "." }, track("CT preview")),
    fetchZarrVolume(base, { ...vol.spineps_med, dataset: "." }, track("SPINEPS labels")),
    fetchZarrVolume(base, { ...vol.ref_med, dataset: "." }, track("reference labels")),
  ]);
  const medDims = sp.dims;
  const medRAS = flat(meta.ijkToRAS_med);
  const lowRAS = flat(meta.ijkToRAS_low);
  const spMed = Uint8Array.from(sp.data);   // raw labels: vertebrae + 100+n discs
  const refMed = Uint8Array.from(ref.data);

  let discOp = 0;   // the muted disc layer's opacity (SPINEPS only) — OFF by default; the tri-state control brings it back
  const levelPalette = new Float32Array(256 * 4);
  for (let l = 1; l < 256; l++) {
    const [r, g, b] = isDisc(l) ? DISC_COLOR : levelColor(l);
    levelPalette[l * 4] = r; levelPalette[l * 4 + 1] = g; levelPalette[l * 4 + 2] = b; levelPalette[l * 4 + 3] = isDisc(l) ? discOp : 1;
  }

  let volOpacity = 0;   // CT VR layer in the row 3D cells — OFF by default so the shells read clean; tri-state control brings it back
  const scaledLut = (o: number): Uint8Array => {
    const l = ctLUT().slice();
    for (let i = 0; i < 256; i++) l[i * 4 + 3] = Math.round(l[i * 4 + 3] * o);
    return l;
  };
  const mkCtField = (v: ZarrVolume, ijk: number[]) =>
    new ImageField(dev, v.data, v.dims, [1, 1, 1], scaledLut(volOpacity), {
      clim: [CT_LEV - CT_WIN / 2, CT_LEV + CT_WIN / 2], ijkToRAS: ijk, shade: [0.25, 0.7, 0.45, 20],
    });

  // CURRENT ct state (low now, med after upgrade)
  let ctField = mkCtField(ctLow, lowRAS);
  let ctDims = ctLow.dims, ctRAS = lowRAS;
  const [rasLo0, rasHi0] = ctField.aabb();

  // 2D overlays for the CURRENT ct grid (σ=0 crisp; overlay and CT share the one
  // SliceRenderer's patientToTexture, so phase A resamples masks onto the low grid).
  const bakeOverlay = (lab: Uint8Array) => {
    const l = ctDims === medDims ? lab : resampleLabels(lab, medDims, medRAS, ctDims, ctRAS);
    return bakeColorizeRGBA(dev, l, ctDims, levelPalette, 0);
  };

  // The ONE shared slice renderer (rows swap their overlay in before drawing).
  const slice = new SliceRenderer(gpu, format);
  slice.setVolume(ctField.patientToTexture(), rasLo0, rasHi0);
  slice.setWindowLevel(CT_WIN, CT_LEV);
  slice.setOverlayOpacity(0.5);

  const methodOp: Record<"spineps" | "ref", number> = { spineps: 1, ref: 1 };
  let clip: { lo: Vec3; hi: Vec3 } | null = null;
  let extentState: { label: number | null; count: number } = { label: null, count: 99 };

  /** applyShellVisibility: after per-label opacity updates, re-derive the outer-mode SDF if the
   *  visible-label SET changed (region-limited when a bbox is given). Returns true when it rebaked
   *  (attr included) — the caller then skips the attr-only refreshOpacity. */
  // Shell smoothing (σ, SDF-grid voxels), shared by both method rows so they stay comparable —
  // the whole point of the view is that the two surfaces are rendered identically.
  let segSigma = 1.0;
  type RowState = MethodRow & {
    lab: Uint8Array; shown: Map<number, number>; rebuild(): void;
    applyShellVisibility(regionRAS: { lo: Vec3; hi: Vec3 } | null): boolean;
  };
  // MEMORY BUDGET. Two segmentations side by side, each with a JFA-SDF pipeline, is the heaviest
  // thing this page does: 68 B per padded voxel (render/gpu-budget.ts). At the old flat 256-per-axis
  // cap that is ~1 GB EACH on a chest CT, which a laptop's integrated GPU does not have — the device
  // is lost, every canvas goes white, and nothing in the console says why. Size the grid to the
  // device instead, and say so when that costs resolution.
  const budget = gpuBudget(gpu.adapter);
  const voxelCap = sdfVoxelCap(budget.bytes, 2);
  const memNote: string[] = [];
  let coarsenedAny = false;
  const makeRow = (key: "spineps" | "ref", lab: Uint8Array): RowState => {
    const overlayTex = bakeOverlay(lab);
    // 3D: this method's SDF shell in level colours, clippable so the extent control
    // crops it (with the CT VR) to the selected levels. The SDF grid is capped at 256
    // per axis (segroulette's standard): bakes AND per-level visibility rebakes scale
    // with this volume, and the full-res med grid still feeds the 2D overlays.
    const cap = resampleIsotropic(lab, medDims, medRAS, 256, voxelCap);
    const capBytes = JfaSdfBaker.estimateBytes(cap.dims);
    memNote.push(`${key}: ${cap.dims.join("×")} @ ${cap.vox.toFixed(2)}mm = ${formatBytes(capBytes)}${cap.coarsened ? " (coarsened to fit)" : ""}`);
    if (cap.coarsened) coarsenedAny = true;
    const editable = new EditableSegmentation(dev, cap.dims, { ijkToRAS: cap.ijkToRAS });
    // boundaryMode: "outer" (default) is segroulette's crisp surface-model look — SIGNED
    // distance, tight 0.65-voxel shell band. "all" (multi-material interface field) reads
    // noticeably softer (unsigned blurred distance, wider 1.5-voxel band); ?shell=all to compare.
    const outerShell = (shellOpts?.shell ?? "outer") === "outer";
    const logic = new SegmentationLogic(dev, editable, {
      renderMode: "sdf", boundaryMode: outerShell ? "outer" : "all", opacity: 1, clippable: true,
      sigmaVoxels: segSigma,
      bandMm: shellOpts?.bandVox !== undefined ? shellOpts.bandVox * cap.vox : undefined,
    });
    const levels = levelGeometry(lab, medDims, medRAS);   // centroids/bboxes stay med-exact
    for (const [l] of levels) logic.setLabelColor(l, isDisc(l) ? DISC_COLOR : levelColor(l));
    const shown = new Map<number, number>();
    for (const [l] of levels) shown.set(l, isDisc(l) ? discOp : 1);
    for (const [l, o] of shown) logic.setLabelOpacity(l, o);
    // "outer" has no shell at a label↔label contact, so a hidden neighbour would leave an
    // OPEN HOLE at the endplate. Fix: hidden labels become BACKGROUND in the SDF labelmap —
    // the contact face is then a genuine outer boundary and gets the same crisp capped shell
    // as everywhere else (Slicer's per-segment closed-surface semantics). Small flips (a level
    // step) rewrite ONLY the changed labels' bbox and re-flood that region (refineRegion), so
    // stepping through the spine with the arrows renders essentially instantly; large flips
    // (full-spine restore, disc toggle) take the one-shot full bake.
    const visOf = () => {
      const v = new Uint8Array(256).fill(1);
      for (const [l, o] of shown) v[l] = o > 0.001 ? 1 : 0;
      return v;
    };
    let visKey = "";
    // Was the labelmap the last shell bake saw EMPTY? A region re-flood patches the previous flood's
    // seed texture — and if that texture has no seeds in it at all, there is nothing for the box's
    // taps to build on outside the box, and the patch comes back as a scatter of speckles instead of
    // a vertebra. It happens exactly once per row, on the step where a method's labels first come
    // into range: SPINEPS labels 12 of the reference's 24 levels, so arrowing down from the cervical
    // spine crosses that edge, and the first SPINEPS vertebra rendered at 511 px against 5500 for the
    // same level reached any other way. A full bake there costs ~390 ms, once.
    const rebakeShellFull = () => {
      const vis = visOf();
      visKey = vis.join("");
      const f = new Uint32Array(cap.lab.length);
      for (let i = 0; i < f.length; i++) { const l = cap.lab[i]; if (vis[l]) f[i] = l; }
      editable.loadLabelmap(f);
      logic.refineNow();
    };
    // (The region-limited variant of this — rewrite only the changed labels' box and re-flood it —
    // lived here and is gone. It was wrong three separate ways, two of them about which voxels it
    // touched rather than how it flooded them, and the full rebake costs ~16 ms at the device-sized
    // grid. SegmentationLogic.regionReflood still exists for live editing, where the next stroke
    // corrects an approximation anyway.)
    if (outerShell) rebakeShellFull();   // initial bake already excludes the hidden discs
    else { editable.loadLabelmap(cap.lab); logic.refineNow(); }
    const scene = new SceneRenderer(gpu, format);
    const row = {
      key, overlayTex, scene, logic, levels, lab, shown,
      rebuild() {
        const f = [];
        if (volOpacity > 0.001) f.push(ctField);
        if (methodOp[key] > 0.001) f.push(logic.field());
        scene.build(f);
        scene.setBackground(0.05, 0.06, 0.09);
        if (clip) scene.setClipBox(clip.lo, clip.hi); else scene.clearClip();
      },
      applyShellVisibility(regionRAS: { lo: Vec3; hi: Vec3 } | null) {
        if (!outerShell) return false;                 // "all" caps interfaces in the field itself
        if (visOf().join("") === visKey) return false; // pure opacity tweak — attr fast path suffices
        // ALWAYS the full rebake. The region path rewrote only the changed labels' box in the
        // labelmap, which assumes that box (from the MED-grid level geometry, +2 voxels) covers
        // every voxel of those labels on the CAP grid. It does not once the cap grid is coarse —
        // and it is now sized to the device, so it varies per machine. The symptom is a level step
        // rendering ~4% different from the same level reached any other way, with the leftover
        // voxels of the label you just hid still in the map. Of the three ways this fast path has
        // been wrong, two were about which voxels it touched rather than how it flooded them, so
        // the honest move is to stop guessing at the extent. A full rebake is ~70-150 ms depending
        // on the grid; it is the correctness floor for a view whose whole job is "do these two
        // segmentations differ".
        rebakeShellFull();
        return true;
      },
      destroy() { logic.destroy(); editable.destroy(); this.overlayTex.destroy(); },
    } as RowState;
    row.rebuild();
    return row;
  };
  onProgress?.("baking SPINEPS shell", 0);
  const rowSp = makeRow("spineps", spMed);
  onProgress?.("baking reference shell", 0);
  const rowRef = makeRow("ref", refMed);
  const rowOf = (key: "spineps" | "ref") => key === "spineps" ? rowSp : rowRef;

  const scObj: SpineCompareScene = {
    meta, dims: ctDims, ijkToRAS: ctRAS, rasLo: rasLo0, rasHi: rasHi0,
    center: [(rasLo0[0] + rasHi0[0]) / 2, (rasLo0[1] + rasHi0[1]) / 2, (rasLo0[2] + rasHi0[2]) / 2],
    radius: Math.hypot(rasHi0[0] - rasLo0[0], rasHi0[1] - rasLo0[1], rasHi0[2] - rasLo0[2]) / 2,
    win: CT_WIN, lev: CT_LEV,
    slice,
    rows: [rowSp, rowRef],
    // The 2D overlay follows the SAME per-method control as the 3D surface: "hide SPINEPS" that
    // leaves SPINEPS labels painted over the CT is not hiding SPINEPS. 0.5 is the overlay's normal
    // strength over the CT; the control scales it, so the tri-state reads the same in both places.
    bindRowSlice(key) {
      slice.setTextures(ctField.volumeTexture(), rowOf(key).overlayTex);
      slice.setOverlayOpacity(0.5 * methodOp[key]);
    },
    upgraded: Promise.resolve(),   // replaced below
    setMethodOpacity(key, o) {
      const was = methodOp[key] > 0.001;
      methodOp[key] = Math.max(0, Math.min(1, o));
      rowOf(key).logic.setGlobalOpacity(methodOp[key]);
      if (was !== (methodOp[key] > 0.001)) rowOf(key).rebuild();
      else rowOf(key).scene.syncUniforms();
    },
    methodOpacity: (key) => methodOp[key],
    setVolumeOpacity(o) {
      const was = volOpacity > 0.001;
      volOpacity = Math.max(0, Math.min(1, o));
      ctField.setLUT(scaledLut(volOpacity));
      if (was !== (volOpacity > 0.001)) { rowSp.rebuild(); rowRef.rebuild(); }
    },
    volumeOpacity: () => volOpacity,
    setExtent(label, count) {
      extentState = { label, count };
      // per-label 3D visibility via the ATTR-ONLY rebake (no JFA re-sweep) and clip via
      // uniform updates (no scene rebuild) — a level switch is a few cheap GPU passes,
      // so stepping down the spine level-by-level stays real-time.
      const applyVisibility = (inRange: (l: number) => boolean) => {
        for (const row of [rowSp, rowRef]) {
          const changed: number[] = [];
          for (const [l] of row.levels) {
            // a disc (100+m) borders vertebrae m and m+1 — visible when either is in range
            const vis = isDisc(l) ? (inRange(l - 100) || inRange(l - 100 + 1)) : inRange(l);
            const o = vis ? (isDisc(l) ? discOp : 1) : 0;
            if (row.shown.get(l) !== o) { row.logic.setLabelOpacity(l, o); row.shown.set(l, o); changed.push(l); }
          }
          if (!changed.length) continue;
          // CHANGED labels' bbox: a level step touches a couple of vertebrae, a few % of the
          // volume — everything downstream (labelmap rewrite, JFA re-flood, attr rebake) runs
          // region-limited over it so stepping stays real-time. Large flips go full-volume.
          // The region shortcut is only safe for a SMALL change — a level step. Sized to the
          // region, the JFA's step schedule cannot reach seeds that lie outside it, so a voxel
          // inside the region whose nearest surface is outside ends up with no seed at all: its
          // distance reads "nothing here for a metre", the ray skip leaps past the surface, and
          // the shell is CUT along the region's edge. That is why the two rows clipped
          // differently at ±3 — identical clip box, but the reference row (14 levels, no discs)
          // fell under the old "less than half the labels changed" rule and took the region
          // path, while SPINEPS (40 labels with discs) did not and rebaked in full.
          //
          // VERIFIED SCOPE. The fast path is used only where it has been checked against a full
          // rebake at every level of the spine, in both rows: "1 vert" and "±1" (see
          // examples/spine/test/level-step-equivalence.ts and the sweep it was derived from — 22
          // level steps × 2 rows × 2 modes, max deviation 0.6%). At ±3 a walk down the spine still
          // reaches one state where the patched bake renders ~5% less than a full one, reproducibly
          // but only via that walk; the cause is not pinned down, so ±3 takes the full bake until it
          // is. Wider extents are also where the fast path is worth least: the box spans the whole
          // visible stack.
          let bbox: { lo: Vec3; hi: Vec3 } | null = null;
          if (changed.length <= 6 && extentState.count <= 1) {
            const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
            for (const l of changed) {
              const g = row.levels.get(l)!;
              for (let d = 0; d < 3; d++) { if (g.lo[d] < lo[d]) lo[d] = g.lo[d]; if (g.hi[d] > hi[d]) hi[d] = g.hi[d]; }
            }
            bbox = { lo: [lo[0], lo[1], lo[2]], hi: [hi[0], hi[1], hi[2]] };
          }
          // outer mode + membership change: the shell rebake (region or full) re-derives attr
          // too. Otherwise (pure opacity tweak, or ?shell=all) the attr-only fast path settles it.
          if (row.applyShellVisibility(bbox)) continue;
          if (bbox) row.logic.refreshOpacity(bbox); else row.logic.refreshOpacity();
        }
      };
      const applyClip = () => {
        for (const row of [rowSp, rowRef]) {
          if (clip) row.scene.setClipBox(clip.lo, clip.hi); else row.scene.clearClip();
          row.scene.syncUniforms();
        }
      };
      if (label == null || count >= 99) {
        applyVisibility(() => true);
        clip = null; applyClip();
        return null;
      }
      const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      let any = false;
      for (const levels of [rowSp.levels, rowRef.levels]) {
        for (const [l, g] of levels) {
          if (isDisc(l) || Math.abs(l - label) > count) continue;
          any = true;
          for (let d = 0; d < 3; d++) { if (g.lo[d] < lo[d]) lo[d] = g.lo[d]; if (g.hi[d] > hi[d]) hi[d] = g.hi[d]; }
        }
      }
      if (!any) { applyVisibility(() => true); clip = null; applyClip(); return null; }
      applyVisibility((l) => Math.abs(l - label) <= count);
      for (let d = 0; d < 3; d++) { lo[d] -= 12; hi[d] += 12; }
      clip = { lo, hi };
      applyClip();
      return { lo, hi };
    },
    visibleLevels: (key) => [...rowOf(key).levels.keys()].filter((l) => !isDisc(l) && (rowOf(key).shown.get(l) ?? 1) > 0),
    setDiscOpacity(o) {
      discOp = Math.max(0, Math.min(1, o));
      for (let l = 101; l < 256; l++) levelPalette[l * 4 + 3] = discOp;   // 2D overlay alpha
      for (const row of [rowSp, rowRef]) {
        const nt = bakeOverlay(row.lab);
        row.overlayTex.destroy();
        row.overlayTex = nt;
      }
      this.setExtent(extentState.label, extentState.count);   // re-applies 3D label opacities
    },
    discOpacity: () => discOp,
    memory: () => ({ budgetBytes: budget.bytes, why: budget.why, rows: [...memNote], coarsened: coarsenedAny }),
    setSegSmoothing(sigmaVoxels) {
      segSigma = Math.max(0, sigmaVoxels);
      rowSp.logic.setSmoothing(segSigma);
      rowRef.logic.setSmoothing(segSigma);
      // σ=0 flips the field to cube rendering, which rides in a UNIFORM — and uniforms only
      // reach the GPU on syncUniforms(). Without this the re-bake lands but the switch doesn't.
      rowSp.scene.syncUniforms();
      rowRef.scene.syncUniforms();
    },
    segSmoothing: () => segSigma,
    destroy() { rowSp.destroy(); rowRef.destroy(); },
  };

  // Phase B: stream ct_med in the background and swap it under every view.
  scObj.upgraded = (async () => {
    const ctMed = await fetchZarrVolume(base, { ...vol.ct_med, dataset: "." }, track("full-res CT"));
    ctField = mkCtField(ctMed, medRAS);
    ctDims = ctMed.dims; ctRAS = medRAS;
    const [lo, hi] = ctField.aabb();
    scObj.dims = ctDims; scObj.ijkToRAS = ctRAS; scObj.rasLo = lo; scObj.rasHi = hi;
    slice.setVolume(ctField.patientToTexture(), lo, hi);
    for (const row of [rowSp, rowRef]) {
      const nt = bakeOverlay(row.lab);            // med-native overlay now
      row.overlayTex.destroy();
      row.overlayTex = nt;
      row.rebuild();
    }
    onProgress?.("full-res CT in", 0);
  })();

  return scObj;
}

/** Load a case's zarr meta.json. */
export async function loadCaseMeta(coll: string, pid: string): Promise<{ meta: CaseMeta; base: string }> {
  const base = `${BUCKET}${coll}/${pid}/zarr/`;
  const r = await fetch(base + "meta.json");
  if (!r.ok) throw new Error(`no zarr bundle yet for ${coll}/${pid} (HTTP ${r.status}) — the worker may not have reached this case`);
  return { meta: await r.json() as CaseMeta, base };
}
