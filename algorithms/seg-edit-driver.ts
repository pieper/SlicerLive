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
// A-1 handles the `stroke` kind → PaintEffect (sphere brush, add/remove). Other kinds (click,
// scissors, seeds, draw, threshold) are A-2..A-5 and are ignored (logged) for now.
import type { Vec3 } from "./geom.ts";
import type { EditableSegmentation } from "./editable-segmentation.ts";
import { PaintEffect, type PaintMode, type StrokeOpts } from "./effects/paint.ts";

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
export type SegEdit = StrokeEdit | { kind: string; [k: string]: unknown };

export interface SegEditDriverOpts {
  defaultDiameterMm?: number;                       // brush size when the op omits one (default 6 mm)
  labelForSegment?: (segmentId: string) => number;  // map a Slicer segment id → numeric master label
  onUnhandled?: (kind: string) => void;             // notified for kinds A-1 doesn't implement yet
}

export class SegEditDriver {
  private paint: PaintEffect;
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

  /** Apply one COMMITTED edit (all its points at once) — the replay path. */
  applyEdit(op: unknown): void {
    const e = SegEditDriver.unwrap(op);
    if (!e) return;
    if (e.kind !== "stroke") { this.opts.onUnhandled?.(e.kind); return; }
    const s = e as StrokeEdit;
    if (!s.points?.length) return;
    this.paint.stampStroke(s.points, this.strokeOpts(s));
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

  destroy() { this.paint.destroy(); }
}
