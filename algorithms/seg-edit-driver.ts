// SegEditDriver (A-1b) — consumes the mrson SegEdit stream and drives editing effects. This is how
// SlicerLive edits: NO tool-palette UI (docs/ALGORITHMS.md) — effects are driven by the SegEdit ops
// coming from Slicer (live over the WS, or replayed from a recording), which doubles as the test
// harness (feed ops, not human events). Lives in `algorithms/`; no render/ dependency.
//
// The SegEdit contract (mrson/structure/segedit.struct.json; emitted by LiveStoryLib/mrson_recorder):
//   edit = { kind:"stroke", segmentId, effect, points:[[R,A,S]...],
//            brush:{shape:"sphere"|"disk", diameterMm}, mode:"add"|"remove", closed?, view }
// It rides either as a recorder event {event:"SegEdit", sourceId, edit} or an mrson cmd
// {op:"cmd", id:<segNodeId>, cmd:"segEdit", args:<edit>}; unwrap() accepts all three shapes.
//
// Kinds handled: `stroke` → PaintEffect (A-1), `scissors` → ScissorsEffect (A-3), `seeds` →
// GrowCutEffect (A-5). All three are the SAME mrson SegEdit contract, differing only by `kind` — so
// one driver turns a Slicer edit stream (paint / scissors / grow-from-seeds) into the matching
// WebGPU-native effect. Kinds still unimplemented (click, draw, threshold) are logged via onUnhandled.
import type { Vec3 } from "./geom.ts";
import type { EditableSegmentation } from "./editable-segmentation.ts";
import { PaintEffect, type PaintMode, type StrokeOpts } from "./effects/paint.ts";
import { ScissorsEffect, type ScissorsOp } from "./effects/scissors.ts";
import { GrowCutEffect } from "./effects/growcut.ts";

export interface Brush { shape?: "sphere" | "disk"; diameterMm?: number }
export interface StrokeEdit {
  kind: "stroke";
  segmentId?: string;
  effect?: string;
  points: Vec3[];
  brush?: Brush;
  mode?: "add" | "remove" | "smudge";
  closed?: boolean;
  view?: unknown;
}
/** A closed contour drawn on a slice view, extruded through the volume (A-3). `u`,`v` are the
 *  in-plane view axes the contour lives in (e.g. axial → u=R, v=A); the extrusion is along u×v. */
export interface ScissorsEdit {
  kind: "scissors";
  segmentId?: string;
  effect?: string;
  contour: Vec3[];                 // closed RAS polygon (the drawn outline)
  u: Vec3;
  v: Vec3;
  operation?: ScissorsOp;          // default eraseInside (Slicer's default)
  view?: unknown;
}
/** One seed scribble for grow-from-seeds: a spherical-brush polyline tagged with the label it plants.
 *  `label` is the numeric master label (foreground=1, background/other=2…); `segmentId` maps via the
 *  same labelFor() as strokes when the label isn't given explicitly. */
export interface SeedScribble { label?: number; segmentId?: string; points: Vec3[]; brush?: Brush }
/** Grow-from-seeds (A-5): plant sparse multi-label scribbles, then flood the volume by intensity
 *  similarity (needs the source image — see SegEditDriverOpts.imageTex). */
export interface SeedsEdit {
  kind: "seeds";
  segmentId?: string;
  effect?: string;                 // "GrowFromSeeds"
  scribbles: SeedScribble[];
  edgeLo?: number;                 // growcut similarity thresholds (fractions of intensity range)
  edgeHi?: number;
  intensityRange?: number;
  iterations?: number;
}
export type SegEdit = StrokeEdit | ScissorsEdit | SeedsEdit | { kind: string; [k: string]: unknown };

export interface SegEditDriverOpts {
  defaultDiameterMm?: number;                       // brush size when the op omits one (default 6 mm)
  labelForSegment?: (segmentId: string) => number;  // map a Slicer segment id → numeric master label
  onUnhandled?: (kind: string) => void;             // notified for kinds A-1 doesn't implement yet
  /** Source intensity volume (r32float, aligned to the seg grid) — REQUIRED for `seeds`/grow-from-seeds,
   *  which is intensity-guided. A function so the driver can pick up a volume swapped in later. */
  imageTex?: GPUTexture | (() => GPUTexture | undefined);
}

export class SegEditDriver {
  private paint: PaintEffect;
  private scissors?: ScissorsEffect;
  private growcut?: GrowCutEffect;
  private growcutImg?: GPUTexture;                   // the image the current growcut was built for
  private labels = new Map<string, number>();       // Slicer segment id → r32uint master label
  private nextLabel = 1;
  private active?: { opts: StrokeOpts; last?: Vec3 };

  constructor(private seg: EditableSegmentation, private opts: SegEditDriverOpts = {}) {
    this.paint = new PaintEffect(seg);
  }

  /** Normalize any of the three carriers → the bare SegEdit payload (or null). */
  static unwrap(op: unknown): SegEdit | null {
    const o = op as Record<string, unknown>;
    if (o && typeof o === "object") {
      if (o.edit && typeof o.edit === "object") return o.edit as SegEdit;                 // recorder event
      if (o.cmd === "segEdit" && o.args && typeof o.args === "object") return o.args as SegEdit; // mrson cmd
      if (typeof o.kind === "string") return o as SegEdit;                                 // bare edit
    }
    return null;
  }

  private image(): GPUTexture | undefined {
    const t = this.opts.imageTex;
    return typeof t === "function" ? t() : t;
  }

  private labelFor(segmentId?: string): number {
    if (!segmentId) return 1;
    if (this.opts.labelForSegment) return this.opts.labelForSegment(segmentId);
    let id = this.labels.get(segmentId);
    if (id === undefined) { id = this.nextLabel++; this.labels.set(segmentId, id); }
    return id;
  }
  private radiusFor(e: StrokeEdit): number { return (e.brush?.diameterMm ?? this.opts.defaultDiameterMm ?? 6) / 2; }
  private modeFor(e: StrokeEdit): PaintMode {
    if (e.mode === "remove" || (e.effect ?? "").toLowerCase().startsWith("erase")) return "remove";
    return "add";
  }
  private strokeOpts(e: StrokeEdit): StrokeOpts {
    return { radiusMm: this.radiusFor(e), id: this.labelFor(e.segmentId), mode: this.modeFor(e) };
  }

  /** Apply one COMMITTED edit (all its points at once) — the replay/live path. `stroke`/`scissors`
   *  submit synchronously; `seeds` (grow-from-seeds) awaits the CA to converge, so this is async. */
  async applyEdit(op: unknown): Promise<void> {
    const e = SegEditDriver.unwrap(op);
    if (!e) return;
    switch (e.kind) {
      case "stroke": {
        const s = e as StrokeEdit;
        if (s.points?.length) this.paint.stampStroke(s.points, this.strokeOpts(s));
        return;
      }
      case "scissors": return this.applyScissors(e as ScissorsEdit);
      case "seeds":    return this.applySeeds(e as SeedsEdit);
      default: this.opts.onUnhandled?.(e.kind); return;
    }
  }

  private applyScissors(e: ScissorsEdit): void {
    if (!e.contour?.length || !e.u || !e.v) return;
    this.scissors ??= new ScissorsEffect(this.seg);
    this.scissors.apply(e.contour, {
      u: e.u, v: e.v,
      operation: e.operation ?? "eraseInside",
      id: this.labelFor(e.segmentId),
    });
  }

  /** Grow-from-seeds: stamp the sparse scribbles into the master (as seeds, one label each), then run
   *  the intensity-guided CA to flood the volume. Needs the source image (opts.imageTex). */
  private async applySeeds(e: SeedsEdit): Promise<void> {
    if (!e.scribbles?.length) return;
    const img = this.image();
    if (!img) { this.opts.onUnhandled?.("seeds(no image)"); return; }
    // Plant every scribble at its label (a spherical dab/capsule), like painting seed scribbles.
    for (const sc of e.scribbles) {
      if (!sc.points?.length) continue;
      const label = sc.label ?? this.labelFor(sc.segmentId ?? e.segmentId);
      const radiusMm = (sc.brush?.diameterMm ?? this.opts.defaultDiameterMm ?? 6) / 2;
      this.paint.stampStroke(sc.points, { radiusMm, id: label, mode: "add" });
    }
    // (Re)build the growcut when the image changes (a different volume swapped in).
    if (!this.growcut || this.growcutImg !== img) {
      this.growcut?.destroy();
      this.growcut = new GrowCutEffect(this.seg, img);
      this.growcutImg = img;
    }
    await this.growcut.grow({
      edgeLo: e.edgeLo, edgeHi: e.edgeHi, intensityRange: e.intensityRange, iterations: e.iterations,
    });
  }

  // ── Incremental live path: begin / addPoint / end, as pointer samples arrive (real-time apply,
  //    no wait for mouse-up). A stroke is a pointer-drag stream, exactly like a camera drag. ──
  /** Start an incremental stroke; `meta` carries the same fields a full edit would (minus points). */
  beginStroke(meta: Omit<StrokeEdit, "kind" | "points"> = {}): void {
    this.active = { opts: this.strokeOpts({ kind: "stroke", points: [], ...meta }), last: undefined };
  }
  /** Add one sampled point — welds a capsule from the previous sample (first point = a dab). */
  addPoint(p: Vec3): void {
    if (!this.active) return;
    this.paint.stampStroke(this.active.last ? [this.active.last, p] : [p], this.active.opts);
    this.active.last = p;
  }
  endStroke(): void { this.active = undefined; }

  destroy() { this.paint.destroy(); this.scissors?.destroy(); this.growcut?.destroy(); }
}
