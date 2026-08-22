// ReMINDer compare scene: one ROW per acquisition in a ReMIND case, ordered along the
// surgical timeline (pre-op MRI → iUS pre-dura → iUS post-dura → iUS pre-iMRI → intra-op MRI).
//
// The difference from spine-compare, and the whole design point: those two rows shared ONE
// volume, so they could share one SliceRenderer and a normalized 0..1 slice offset. Here every
// row is a DIFFERENT acquisition on a different grid — a 1 mm axial MR of the whole head next
// to a 0.125 mm oblique ultrasound block of the resection cavity. So each row owns its
// ImageField + SliceRenderer + SceneRenderer, and the linking happens where it is actually
// meaningful: in PATIENT SPACE. The viewer holds one RAS focus point and one RAS field of
// view, and each row converts them through its own geometry (setPlane for the scrub position,
// setMirrorFrame for the in-plane frame). Rows therefore stay anatomically registered even
// though no two of them share a voxel grid — which is exactly what makes the intra-operative
// shift visible when you scroll.
//
// Rows are built lazily: a case is 200–780 MB in IDC, so nothing loads until a row is
// switched on, and switching one off frees its GPU objects.
import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import { type Orientation, type PlaneBasis, SliceRenderer } from "../../render/slice-renderer.ts";
import { ImageField } from "../../render/fields.ts";
import { bakeColorizeRGBA } from "../../render/bake.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { resampleIsotropic } from "../../algorithms/geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import { lutFromTransferFunctions, type TF } from "../../render/scene-volume.ts";
import type { Vec3 } from "../../render/mat4.ts";
import {
  loadSeg, loadVolume, type CaseEntry, type LoadedVolume, type SeriesEntry,
  structureColor, TIMEPOINTS,
} from "./remind-data.ts";

/** SDF grid cap for the 3D segment shells. Lower than spine-compare's 256 on purpose:
 *  a ReMIND case can have five rows resident at once, each with its own image texture. */
const SEG_MAX_DIM = 192;

export interface RowSeg {
  structure: string;
  label: number;                       // merged-labelmap value for this structure
  color: [number, number, number];
  voxels: number;
  centroid: Vec3 | null;               // RAS, for "jump to the tumour"
}

export type RowState = "idle" | "loading" | "ready" | "error";

export interface Row {
  key: string;                         // series uuid — stable id for URL state and tests
  entry: SeriesEntry;
  state: RowState;
  error?: string;
  progress: { msg: string; frac: number };
  // populated once ready
  vol?: LoadedVolume;
  field?: ImageField;
  slice?: SliceRenderer;
  scene?: SceneRenderer;
  logic?: SegmentationLogic;
  segs: RowSeg[];
  rasLo?: Vec3;
  rasHi?: Vec3;
  center?: Vec3;
  radius?: number;
  /** This row's own volume-rendering transfer function + display window. */
  tf?: RowTF;
  win?: number;
  lev?: number;
  /** Cached intensity histogram over [lev±win/2] — built once, for the TF editor. */
  hist?: Float32Array;
}

export interface RemindSceneOpts {
  maxDim?: number;
  maxVoxels?: number;
  /** VR opacity for the 3D column (0 = segment shells only). */
  volumeOpacity?: number;
  /** 2D overlay fill opacity for segmentations. */
  overlayOpacity?: number;
  onRowChange?: (row: Row) => void;    // state/progress ticks — the browser repaints from this
  onRedraw?: () => void;               // a row's shell finished refining
}

// ── transfer functions ───────────────────────────────────────────────────────
// Per ROW, not global: ReMIND rows are raw MR scanner units next to 8-bit ultrasound, so a
// single shared transfer function is meaningless. Each row keeps its own opacity curve
// (control points in normalised 0..1 across that row's window) and a colour ramp, and the
// 256-entry LUT is rebuilt with the repo's own lutFromTransferFunctions and written in
// place — no pipeline rebuild, so dragging a control point is interactive.

/** Colour ramps, as control points in normalised intensity. */
export const RAMPS: Record<string, [number, number, number, number][]> = {
  grey: [[0, 0, 0, 0], [1, 1, 1, 1]],
  // ultrasound is conventionally read on a warm/sepia ramp — and it separates a US row from
  // an MR row at a glance when both are on screen
  amber: [[0, 0.03, 0.01, 0], [0.45, 0.55, 0.33, 0.12], [1, 1, 0.93, 0.78]],
  hot: [[0, 0, 0, 0], [0.35, 0.62, 0.06, 0.02], [0.7, 0.96, 0.62, 0.05], [1, 1, 1, 0.86]],
  cool: [[0, 0.02, 0.02, 0.08], [0.5, 0.16, 0.45, 0.72], [1, 0.85, 0.96, 1]],
};
// Each ultrasound renders in ITS OWN timepoint's colour — the same hue the dashboard's
// timeline bars and coverage grid use for that stage. So a pre-dura block and a pre-iMRI
// block are told apart by hue in the volume rendering exactly as they are on the dashboard,
// and the two pages read as one encoding rather than two. Built from the same TIMEPOINTS
// values the dashboard declares, so they cannot drift apart.
const rampFromColor = (c: [number, number, number]): [number, number, number, number][] => [
  [0, c[0] * 0.06, c[1] * 0.06, c[2] * 0.06],
  [0.45, c[0] * 0.72, c[1] * 0.72, c[2] * 0.72],
  [1, c[0] + (1 - c[0]) * 0.5, c[1] + (1 - c[1]) * 0.5, c[2] + (1 - c[2]) * 0.5],
];
for (const [key, tp] of Object.entries(TIMEPOINTS)) RAMPS[tp.short] = rampFromColor(tp.color);

export const RAMP_NAMES = Object.keys(RAMPS);

/** The ramp a freshly loaded series gets: ultrasound in its stage colour, MR in grey —
 *  grey is what anatomy is read on, and the MR is the reference the US is compared against. */
export const defaultRamp = (e: SeriesEntry) => e.m === "US" ? TIMEPOINTS[e.tp].short : "grey";

/** The default opacity curve — the quadratic foot the demo shipped with, as control points:
 *  transparent to the window midpoint, then climbing, so a post-contrast MR shows the head
 *  surface and an ultrasound block shows its bright interfaces without drowning in noise. */
export const DEFAULT_TF_POINTS: [number, number][] =
  [[0, 0], [0.45, 0], [0.6, 0.07], [0.75, 0.3], [0.9, 0.66], [1, 1]];

export interface RowTF {
  ramp: string;
  /** [t, alpha] control points, t and alpha both 0..1; alpha is scaled by the global VR opacity. */
  points: [number, number][];
}

// ── reslicing in a volume's own frame ────────────────────────────────────────
// Brain shift is largely gravity-driven: the brain sags once the dura is open. An
// intra-operative ultrasound is acquired with the probe on the exposed cortex, so its
// acquisition axes are tied to the surgical approach rather than to the scanner — which
// means one of its native planes tends to contain the up/down direction, and the sag reads
// directly in it. The anatomical axial/sagittal/coronal planes cut that obliquely and smear
// it. So the viewer can reslice EVERY row along the axes of one chosen volume.
//
// The normal comes from the volume; the in-plane orientation does not. Using the volume's own
// row/column directions would happily display a reformat upside-down or mirrored. Instead:
// screen-up is whatever in-plane direction is closest to SUPERIOR, and screen-right is then
// fixed to the radiological sense (patient left on the right). Where the plane contains the
// S axis — the gravity case above — up on screen really is up in the patient.
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A display-correct basis for a plane with the given RAS normal. */
export function basisFromNormal(nIn: Vec3): PlaneBasis {
  const n = norm(nIn);
  // screen-up = the in-plane direction nearest SUPERIOR; if the plane is (near) axial, S has
  // no in-plane component, so fall back to ANTERIOR, which is how an axial view is read.
  let up: Vec3 = [0, 0, 1];
  if (Math.abs(dot3(up, n)) > 0.98) up = [0, 1, 0];
  const vRaw: Vec3 = [
    up[0] - n[0] * dot3(up, n), up[1] - n[1] * dot3(up, n), up[2] - n[2] * dot3(up, n),
  ];
  const v = norm(vRaw);
  let u = norm(cross3(v, n));
  let nn = n;
  // radiological sense: patient LEFT on the right of screen. Flipping u alone would mirror
  // the image, so flip u AND the normal — a 180 deg turn about the up vector, which keeps
  // handedness and keeps up pointing up.
  if (dot3(u, [-1, 0, 0]) < 0) { u = [-u[0], -u[1], -u[2]]; nn = [-n[0], -n[1], -n[2]]; }
  return { uDir: u, vDir: v, nDir: nn };
}

/** The three planes of a volume's own grid: normals along its k, j and i axes. */
export function nativeBases(ijkToRAS: number[]): Record<Orientation, PlaneBasis> {
  const col = (c: number): Vec3 => [ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]];
  return {
    axial: basisFromNormal(col(2)),     // through the acquisition stack — the stored image plane
    coronal: basisFromNormal(col(1)),
    sagittal: basisFromNormal(col(0)),
  };
}

/** How far a basis is from the nearest anatomical plane, in degrees — for honest labelling. */
export function obliquityDeg(b: PlaneBasis): number {
  const best = Math.max(Math.abs(b.nDir[0]), Math.abs(b.nDir[1]), Math.abs(b.nDir[2]));
  return Math.acos(Math.min(1, best)) * 180 / Math.PI;
}

export class RemindScene {
  readonly rows: Row[] = [];
  private gpu: Gpu;
  private format: GPUTextureFormat;
  private opts: RemindSceneOpts;
  private volOpacity: number;
  private overlayOp: number;
  private palette = new Float32Array(256 * 4);
  private overlayTex = new Map<string, GPUTexture>();
  private segsOn = false;   // segmentations start hidden — they sit on top of the anatomy being compared
  private shellOp = 1;

  constructor(gpu: Gpu, format: GPUTextureFormat, readonly kase: CaseEntry, opts: RemindSceneOpts = {}) {
    this.gpu = gpu;
    this.format = format;
    this.opts = opts;
    this.volOpacity = opts.volumeOpacity ?? 0.35;
    this.overlayOp = opts.overlayOpacity ?? 0.45;
    for (const e of kase.series) {
      this.rows.push({ key: e.u, entry: e, state: "idle", progress: { msg: "", frac: 0 }, segs: [] });
    }
    this.rows.sort((a, b) =>
      (TIMEPOINTS[a.entry.tp].rank - TIMEPOINTS[b.entry.tp].rank) || (a.entry.sn - b.entry.sn));
  }

  row(key: string): Row | undefined {
    return this.rows.find((r) => r.key === key);
  }

  readyRows(): Row[] {
    return this.rows.filter((r) => r.state === "ready");
  }

  /** RAS bounding box over every loaded row — the extent the viewer frames on. */
  bounds(): { lo: Vec3; hi: Vec3; center: Vec3; radius: number } | null {
    const ready = this.readyRows();
    if (!ready.length) return null;
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const r of ready) {
      for (let d = 0; d < 3; d++) {
        if (r.rasLo![d] < lo[d]) lo[d] = r.rasLo![d];
        if (r.rasHi![d] > hi[d]) hi[d] = r.rasHi![d];
      }
    }
    const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    return { lo, hi, center, radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
  }

  /** Load a row (image + all of its SEGs) and build its GPU objects. Idempotent. */
  async ensureRow(key: string): Promise<Row> {
    const row = this.row(key);
    if (!row) throw new Error("no such row " + key);
    if (row.state === "ready" || row.state === "loading") return row;
    row.state = "loading";
    row.error = undefined;
    const tick = (msg: string, frac: number) => {
      row.progress = { msg, frac };
      this.opts.onRowChange?.(row);
    };
    tick("queued…", 0);
    try {
      const vol = await loadVolume(row.entry, {
        maxDim: this.opts.maxDim, maxVoxels: this.opts.maxVoxels, onProgress: tick,
      });
      this.buildRow(row, vol);
      // SEGs land after the image so the row is interactive while they rasterise.
      for (let i = 0; i < row.entry.segs.length; i++) {
        const g = row.entry.segs[i];
        tick(`${g.s} SEG…`, 0.9);
        const lm = await loadSeg(g, { dims: vol.dims, ijkToRAS: vol.ijkToRAS }, { onProgress: tick });
        this.addSeg(row, g.s, lm.lab, i + 1);
      }
      if (row.entry.segs.length) this.finishSegs(row);
      row.state = "ready";
      tick("ready", 1);
    } catch (e) {
      row.state = "error";
      row.error = (e as Error)?.message ?? String(e);
      this.opts.onRowChange?.(row);
    }
    return row;
  }

  /** Drop a row's GPU objects (toggling it off) — a five-row case is a lot of resident volume. */
  releaseRow(key: string) {
    const row = this.row(key);
    if (!row || row.state !== "ready") return;
    this.overlayTex.get(key)?.destroy();
    this.overlayTex.delete(key);
    row.logic?.destroy();
    (row as { editable?: EditableSegmentation }).editable?.destroy?.();
    row.field = undefined; row.slice = undefined; row.scene = undefined; row.logic = undefined;
    row.vol = undefined; row.segs = [];
    row.state = "idle";
    row.progress = { msg: "", frac: 0 };
    this.opts.onRowChange?.(row);
  }

  /** Build this row's 256-entry LUT from its own TF, scaled by the global VR opacity. */
  private lutFor(row: Row): Uint8Array {
    const tf = row.tf!;
    const lo = row.lev! - row.win! / 2, hi = row.lev! + row.win! / 2;
    const s = (t: number) => lo + t * (hi - lo);
    const color: TF = (RAMPS[tf.ramp] ?? RAMPS.grey).map(([t, r, g, b]) => [s(t), r, g, b]);
    const opacity: TF = tf.points.map(([t, a]) => [s(t), a * this.volOpacity]);
    return lutFromTransferFunctions(color, opacity, [lo, hi]);
  }

  /** Replace a row's transfer function (ramp and/or control points) and repaint its LUT. */
  setRowTF(key: string, patch: Partial<RowTF>) {
    const row = this.row(key);
    if (!row || row.state !== "ready") return;
    row.tf = { ...row.tf!, ...patch };
    row.field!.setLUT(this.lutFor(row));
    row.scene!.syncUniforms();
  }

  /** Display window for a row — drives the MPR *and* the range the VR's LUT spans. */
  setRowWindowLevel(key: string, win: number, lev: number) {
    const row = this.row(key);
    if (!row || row.state !== "ready") return;
    row.win = Math.max(1e-6, win);
    row.lev = lev;
    row.slice!.setWindowLevel(row.win, row.lev);
    row.field!.setClim(row.lev - row.win / 2, row.lev + row.win / 2);
    row.field!.setLUT(this.lutFor(row));
    row.scene!.syncUniforms();
  }

  /** Intensity histogram (128 bins over the row's current window), log-compressed for display. */
  histogram(key: string, bins = 128): Float32Array | undefined {
    const row = this.row(key);
    if (!row || row.state !== "ready") return undefined;
    if (row.hist && row.hist.length === bins) return row.hist;
    const v = row.vol!.vol;
    const lo = row.lev! - row.win! / 2, hi = row.lev! + row.win! / 2;
    const h = new Float32Array(bins);
    const sc = bins / Math.max(1e-9, hi - lo);
    const stride = Math.max(1, Math.floor(v.length / 400000));
    for (let i = 0; i < v.length; i += stride) {
      const b = Math.floor((v[i] - lo) * sc);
      if (b >= 0 && b < bins) h[b]++;
    }
    let max = 0;
    for (let i = 0; i < bins; i++) { h[i] = Math.log1p(h[i]); if (h[i] > max) max = h[i]; }
    if (max > 0) for (let i = 0; i < bins; i++) h[i] /= max;
    row.hist = h;
    return h;
  }

  private buildRow(row: Row, vol: LoadedVolume) {
    const dev = this.gpu.device;
    row.win = vol.win;
    row.lev = vol.lev;
    // ultrasound gets the warm ramp by default — it reads the way sonographers expect, and
    // it tells a US row apart from an MR row at a glance in the 3D column
    row.tf = { ramp: defaultRamp(row.entry), points: [...DEFAULT_TF_POINTS] };
    row.vol = vol;
    const field = new ImageField(dev, vol.vol, vol.dims, [1, 1, 1], this.lutFor(row), {
      clim: [vol.lev - vol.win / 2, vol.lev + vol.win / 2],
      ijkToRAS: vol.ijkToRAS,
      shade: [0.3, 0.7, 0.4, 20],
    });
    const [lo, hi] = field.aabb();
    const slice = new SliceRenderer(this.gpu, this.format);
    slice.setVolume(field.patientToTexture(), lo, hi);
    slice.setTextures(field.volumeTexture());
    slice.setWindowLevel(vol.win, vol.lev);
    slice.setOverlayOpacity(this.segsOn ? this.overlayOp : 0);
    slice.setOutlineOpacity(this.segsOn ? 1 : 0);
    const scene = new SceneRenderer(this.gpu, this.format);
    row.vol = vol; row.field = field; row.slice = slice; row.scene = scene;
    row.rasLo = lo; row.rasHi = hi;
    row.center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    row.radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    row.segs = [];
    this.applyBasis(row);          // a row loaded while a native frame is active adopts it
    this.rebuildScene(row);
  }

  /** Merge one SEG's binary mask into the row's labelmap under a per-structure label. */
  private mergedLab = new Map<string, Uint8Array>();
  private addSeg(row: Row, structure: string, lab: Uint8Array, label: number) {
    const dims = row.vol!.dims;
    let merged = this.mergedLab.get(row.key);
    if (!merged) { merged = new Uint8Array(dims[0] * dims[1] * dims[2]); this.mergedLab.set(row.key, merged); }
    const m = row.vol!.ijkToRAS;
    let n = 0;
    const sum: Vec3 = [0, 0, 0];
    for (let k = 0, i = 0; k < dims[2]; k++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let x = 0; x < dims[0]; x++, i++) {
          if (!lab[i]) continue;
          merged[i] = label;              // later structures win an overlap; tumour is loaded first
          n++; sum[0] += x; sum[1] += j; sum[2] += k;
        }
      }
    }
    const centroid: Vec3 | null = n
      ? [
        m[0] * (sum[0] / n) + m[1] * (sum[1] / n) + m[2] * (sum[2] / n) + m[3],
        m[4] * (sum[0] / n) + m[5] * (sum[1] / n) + m[6] * (sum[2] / n) + m[7],
        m[8] * (sum[0] / n) + m[9] * (sum[1] / n) + m[10] * (sum[2] / n) + m[11],
      ]
      : null;
    row.segs.push({ structure, label, color: structureColor(structure), voxels: n, centroid });
  }

  /** After every SEG of a row has landed: bake the 2D overlay and the 3D shell once. */
  private finishSegs(row: Row) {
    const dev = this.gpu.device;
    const merged = this.mergedLab.get(row.key);
    if (!merged || !row.segs.length) return;
    for (const s of row.segs) {
      const c = s.color;
      this.palette[s.label * 4] = c[0];
      this.palette[s.label * 4 + 1] = c[1];
      this.palette[s.label * 4 + 2] = c[2];
      this.palette[s.label * 4 + 3] = 1;
    }
    // σ=0: crisp labels in the 2D overlay (a smoothed labelmap under a linear sampler is
    // what produced the segroulette slice artifact) — the 3D shell does its own smoothing.
    const tex = bakeColorizeRGBA(dev, merged, row.vol!.dims, this.palette, 0);
    this.overlayTex.get(row.key)?.destroy();
    this.overlayTex.set(row.key, tex);
    row.slice!.setTextures(row.field!.volumeTexture(), tex);

    const cap = resampleIsotropic(merged, row.vol!.dims, row.vol!.ijkToRAS, SEG_MAX_DIM);
    const editable = new EditableSegmentation(dev, cap.dims, { ijkToRAS: cap.ijkToRAS });
    editable.loadLabelmap(cap.lab);
    const logic = new SegmentationLogic(dev, editable, {
      renderMode: "sdf", boundaryMode: "outer", opacity: 1, clippable: true,
    });
    for (const s of row.segs) logic.setLabelColor(s.label, s.color);
    logic.setGlobalOpacity(this.segsOn ? this.shellOp : 0);
    logic.onRedraw(() => this.opts.onRedraw?.());
    logic.refineNow();
    row.logic = logic;
    (row as { editable?: EditableSegmentation }).editable = editable;
    this.mergedLab.delete(row.key);      // the GPU copies are authoritative from here
    this.rebuildScene(row);
  }

  private rebuildScene(row: Row) {
    if (!row.scene) return;
    const fields = [];
    if (this.volOpacity > 0.001 && row.field) fields.push(row.field);
    if (row.logic) fields.push(row.logic.field());
    row.scene.build(fields);
    row.scene.setBackground(0.03, 0.04, 0.07);
  }

  // ── linked patient-space navigation ────────────────────────────────────────
  /** Where a RAS focus point falls in this row's own bbox, as the 0..1 scrub offset. */
  offset01(row: Row, orient: Orientation, focus: Vec3): number {
    const a = orient === "axial" ? 2 : orient === "coronal" ? 1 : 0;
    const lo = row.rasLo![a], hi = row.rasHi![a];
    return hi === lo ? 0.5 : Math.max(0, Math.min(1, (focus[a] - lo) / (hi - lo)));
  }

  /** Point every loaded row's in-plane view at the same patient-space frame. */
  applyFrame(orient: Orientation, centerRAS: Vec3, fovMm: number) {
    for (const r of this.readyRows()) r.slice!.setMirrorFrame(orient, centerRAS, fovMm, fovMm);
  }

  private frameBases: Record<Orientation, PlaneBasis> | null = null;
  private frameKey: string | null = null;
  /** Reslice EVERY row along the axes of one volume (null = anatomical patient planes).
   *  The same RAS basis goes to every row, so the rows stay registered with each other. */
  setFrameVolume(key: string | null) {
    this.frameKey = key;
    const src = key ? this.row(key) : undefined;
    this.frameBases = src?.state === "ready" ? nativeBases(src.vol!.ijkToRAS) : null;
    for (const r of this.readyRows()) this.applyBasis(r);
  }
  frameVolume() { return this.frameKey; }
  frameBasis(o: Orientation): PlaneBasis | null { return this.frameBases?.[o] ?? null; }
  private applyBasis(r: Row) {
    for (const o of ["axial", "coronal", "sagittal"] as Orientation[]) {
      r.slice!.setBasis(o, this.frameBases?.[o] ?? null);
    }
  }

  setVolumeOpacity(o: number) {
    const was = this.volOpacity > 0.001;
    this.volOpacity = Math.max(0, Math.min(1, o));
    for (const r of this.readyRows()) {
      r.field!.setLUT(this.lutFor(r));            // per row: each keeps its own TF shape
      if (was !== (this.volOpacity > 0.001)) this.rebuildScene(r);
    }
  }
  volumeOpacity() { return this.volOpacity; }

  setOverlayOpacity(o: number) {
    this.overlayOp = Math.max(0, Math.min(1, o));
    if (!this.segsOn) return;
    for (const r of this.readyRows()) r.slice!.setOverlayOpacity(this.overlayOp);
  }
  overlayOpacity() { return this.overlayOp; }

  /** 3D shell opacity across every row that has segmentations. */
  setShellOpacity(o: number) {
    this.shellOp = Math.max(0, Math.min(1, o));
    if (!this.segsOn) return;
    for (const r of this.readyRows()) { r.logic?.setGlobalOpacity(this.shellOp); r.scene?.syncUniforms(); }
  }

  /** One switch for ALL segmentation display — 2D fill, 2D outline and the 3D shells.
   *  Segmentations are drawn over the anatomy being compared, so there has to be a way to
   *  get them out of the way without hunting through three separate opacity controls. */
  setSegVisible(on: boolean) {
    this.segsOn = on;
    for (const r of this.readyRows()) {
      r.slice!.setOverlayOpacity(on ? this.overlayOp : 0);
      r.slice!.setOutlineOpacity(on ? 1 : 0);
      r.logic?.setGlobalOpacity(on ? this.shellOp : 0);
      // the 2D path re-writes its uniform on every draw, but the 3D shell's opacity lives in
      // the scene's material uniform — without this sync the slices hide the segmentation and
      // the 3D view goes on showing it
      r.scene?.syncUniforms();
    }
  }
  segVisible() { return this.segsOn; }

  /** Structures present anywhere in this case's loaded rows, with total voxel counts. */
  structures(): { structure: string; color: [number, number, number]; rows: number }[] {
    const m = new Map<string, { structure: string; color: [number, number, number]; rows: number }>();
    for (const r of this.readyRows()) {
      for (const s of r.segs) {
        const e = m.get(s.structure) ?? { structure: s.structure, color: s.color, rows: 0 };
        e.rows++;
        m.set(s.structure, e);
      }
    }
    return [...m.values()];
  }

  destroy() {
    for (const r of this.rows) this.releaseRow(r.key);
  }
}
