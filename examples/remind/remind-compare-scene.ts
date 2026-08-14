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
import { SliceRenderer, type Orientation } from "../../render/slice-renderer.ts";
import { ImageField } from "../../render/fields.ts";
import { bakeColorizeRGBA } from "../../render/bake.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { resampleIsotropic } from "../../algorithms/geom.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
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

/** A greyscale VR ramp: opacity climbs quadratically above the window's midpoint, so a
 *  post-contrast MR shows the head surface and an ultrasound block shows its bright
 *  interfaces without either drowning in noise. */
function rampLUT(maxAlpha: number): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = Math.max(0, (t - 0.45) / 0.55);
    a *= a;
    lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = Math.round(t * 255);
    lut[i * 4 + 3] = Math.round(Math.min(maxAlpha, a) * 255);
  }
  return lut;
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

  private buildRow(row: Row, vol: LoadedVolume) {
    const dev = this.gpu.device;
    const field = new ImageField(dev, vol.vol, vol.dims, [1, 1, 1], rampLUT(this.volOpacity), {
      clim: [vol.lev - vol.win / 2, vol.lev + vol.win / 2],
      ijkToRAS: vol.ijkToRAS,
      shade: [0.3, 0.7, 0.4, 20],
    });
    const [lo, hi] = field.aabb();
    const slice = new SliceRenderer(this.gpu, this.format);
    slice.setVolume(field.patientToTexture(), lo, hi);
    slice.setTextures(field.volumeTexture());
    slice.setWindowLevel(vol.win, vol.lev);
    slice.setOverlayOpacity(this.overlayOp);
    slice.setOutlineOpacity(1);
    const scene = new SceneRenderer(this.gpu, this.format);
    row.vol = vol; row.field = field; row.slice = slice; row.scene = scene;
    row.rasLo = lo; row.rasHi = hi;
    row.center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    row.radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    row.segs = [];
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

  setVolumeOpacity(o: number) {
    const was = this.volOpacity > 0.001;
    this.volOpacity = Math.max(0, Math.min(1, o));
    const lut = rampLUT(this.volOpacity);
    for (const r of this.readyRows()) {
      r.field!.setLUT(lut);
      if (was !== (this.volOpacity > 0.001)) this.rebuildScene(r);
    }
  }
  volumeOpacity() { return this.volOpacity; }

  setOverlayOpacity(o: number) {
    this.overlayOp = Math.max(0, Math.min(1, o));
    for (const r of this.readyRows()) r.slice!.setOverlayOpacity(this.overlayOp);
  }
  overlayOpacity() { return this.overlayOp; }

  /** 3D shell opacity across every row that has segmentations. */
  setShellOpacity(o: number) {
    for (const r of this.readyRows()) r.logic?.setGlobalOpacity(Math.max(0, Math.min(1, o)));
  }

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
