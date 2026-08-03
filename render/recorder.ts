// SceneRecorder — records a whole SlicerLive session as a timeseries of mrson scene transitions, so
// any past timepoint can be reconstructed (scrubbable replay) and the session can be narrated,
// shared, or analyzed. The video-compression analog: periodic KEYFRAMES (full node-map snapshots) +
// DELTAS (per-node upsert/remove) between them, so a seek replays only from the nearest keyframe.
//
// A "session" is the span between mrmlScene.Clear() invocations — it arrives on the LiveScene
// `_changes` feed as a `reset` change (Slicer's EndCloseEvent). The recorder segments on `reset`.
//
// Bulk data is NOT stored in the log: images/labelmaps reference content-addressed zarr by hash, so a
// node is small JSON. A CT loaded once is one set of hashed chunks referenced from every keyframe; a
// segmentation edited many times contributes many small node revisions (all pointing at hashed
// blobs). Losslessness is the default; cull() trades exactness for storage (see below).
//
// The recorder is a pure consumer of the `_changes` feed + the model's current node map, so it runs
// identically in Deno and the browser and is unit-testable headless. Thumbnails + marks (the
// LiveStory narrative layer) are optional side-channels keyed by time.

import type { Change, LiveScene } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";

/** A screen capture for the scrub timeline — a data URL (small JPEG) at a wall-clock time. */
export interface Thumb { t: number; url: string }

/** A narrative/semantic marker — the LiveStory atom and the unit a macro-extractor reasons over
 *  ("placed annulus point", "approved resection plan"). `nodes`/`camera` can pin a useful viewpoint. */
export interface Mark { t: number; label: string; note?: string; role?: string }

/** One entry on the session tape. `key` = full snapshot (replay restart point); `up`/`rm` = deltas;
 *  `reset` = a session boundary (mrmlScene.Clear) that empties the model. */
export type Frame =
  | { t: number; k: "key"; nodes: Record<string, MrsonNode> }
  | { t: number; k: "up"; id: string; node: MrsonNode }
  | { t: number; k: "rm"; id: string }
  | { t: number; k: "reset" };

export interface Session {
  id: string;
  startedAt: number;
  frames: Frame[];    // time-ordered (non-decreasing t)
  thumbs: Thumb[];
  marks: Mark[];
}

export interface RecorderOpts {
  now?: () => number;        // injectable clock (tests); defaults to Date.now
  keyEveryN?: number;        // force a keyframe after this many deltas (default 200)
  keyEveryMs?: number;       // ...or this long since the last keyframe (default 15000)
}

const clone = <T>(v: T): T => structuredClone(v);

export class SceneRecorder {
  session: Session;
  private now: () => number;
  private keyEveryN: number;
  private keyEveryMs: number;
  private deltas = 0;          // deltas since the last keyframe
  private lastKeyT = -Infinity;
  private unsub?: () => void;

  constructor(private scene: LiveScene, opts: RecorderOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.keyEveryN = opts.keyEveryN ?? 200;
    this.keyEveryMs = opts.keyEveryMs ?? 15000;
    this.session = this.newSession();
  }

  private newSession(): Session {
    const t = this.now();
    return { id: "s" + t, startedAt: t, frames: [], thumbs: [], marks: [] };
  }

  /** Begin recording: seed a keyframe from the current model, then subscribe to the `_changes` feed. */
  start(): void {
    if (this.unsub) return;
    this.keyframe();
    this.unsub = this.scene.subscribe((c) => this.onChange(c));
  }
  stop(): void { this.unsub?.(); this.unsub = undefined; }

  private snapshotNodes(): Record<string, MrsonNode> {
    const o: Record<string, MrsonNode> = {};
    for (const [id, n] of this.scene.nodes) o[id] = clone(n);
    return o;
  }

  /** Force a full-snapshot keyframe now (also called automatically per keyEveryN/keyEveryMs). */
  keyframe(): void {
    const t = this.now();
    this.session.frames.push({ t, k: "key", nodes: this.snapshotNodes() });
    this.lastKeyT = t;
    this.deltas = 0;
  }

  private onChange(c: Change): void {
    const t = this.now();
    if (c.kind === "reset") {
      this.session.frames.push({ t, k: "reset" });
      this.lastKeyT = -Infinity;   // next delta forces a keyframe (fresh session state)
      this.deltas = this.keyEveryN;
      return;
    }
    if (c.kind === "remove") {
      this.session.frames.push({ t, k: "rm", id: c.id });
      this.afterDelta(t);
      return;
    }
    // upsert: snapshot the node's CURRENT state from the authoritative model (the Change may carry the
    // full node, but reading the model is uniform for local + remote origins).
    const node = this.scene.nodes.get(c.id);
    if (!node) return;
    this.session.frames.push({ t, k: "up", id: c.id, node: clone(node) });
    this.afterDelta(t);
  }

  private afterDelta(t: number): void {
    if (++this.deltas >= this.keyEveryN || t - this.lastKeyT >= this.keyEveryMs) this.keyframe();
  }

  // ── query + reconstruction ──────────────────────────────────────────────────

  /** Wall-clock time of the most recent frame (the DVR head). */
  head(): number {
    const f = this.session.frames;
    return f.length ? f[f.length - 1].t : this.session.startedAt;
  }
  /** [startedAt, head] — the scrub range. */
  span(): [number, number] { return [this.session.startedAt, this.head()]; }

  /** Reconstruct the full node map as of time `t`: restore the nearest keyframe/reset at or before t,
   *  then apply every delta up to t in order. O(frames) with a keyframe cap on the replay length. */
  seek(t: number): Map<string, MrsonNode> {
    const f = this.session.frames;
    let base = -1;
    for (let i = 0; i < f.length; i++) {
      if (f[i].t > t) break;
      if (f[i].k === "key" || f[i].k === "reset") base = i;
    }
    const nodes = new Map<string, MrsonNode>();
    let start = 0;
    if (base >= 0) {
      const b = f[base];
      if (b.k === "key") for (const [id, n] of Object.entries(b.nodes)) nodes.set(id, clone(n));
      start = base + 1;
    }
    for (let i = start; i < f.length; i++) {
      const e = f[i];
      if (e.t > t) break;
      if (e.k === "up") nodes.set(e.id, clone(e.node));
      else if (e.k === "rm") nodes.delete(e.id);
      else if (e.k === "reset") nodes.clear();
      else if (e.k === "key") { nodes.clear(); for (const [id, n] of Object.entries(e.nodes)) nodes.set(id, clone(n)); }
    }
    return nodes;
  }

  // ── narrative + thumbnails (LiveStory side-channels) ─────────────────────────

  mark(label: string, note?: string, role?: string): Mark {
    const m: Mark = { t: this.now(), label, note, role };
    this.session.marks.push(m);
    return m;
  }
  addThumb(url: string, t = this.now()): void {
    this.session.thumbs.push({ t, url });
  }
  /** The thumbnail nearest `t` (for instant scrub feedback before the exact state is reconstructed). */
  nearestThumb(t: number): Thumb | undefined {
    let best: Thumb | undefined, bestD = Infinity;
    for (const th of this.session.thumbs) {
      const d = Math.abs(th.t - t);
      if (d < bestD) { bestD = d; best = th; }
    }
    return best;
  }

  // ── bulk-data references + culling ───────────────────────────────────────────

  /** Every content-addressed blob (zarr) hash referenced by any retained frame — the manifest a
   *  portable/lossless bundle must carry, and the retain-set a blob-store GC keeps. Collected by a
   *  generic deep scan for a `zarr` descriptor's chunk paths/hashes. */
  blobRefs(): Set<string> {
    const refs = new Set<string>();
    const scanZarr = (z: unknown) => {
      JSON.stringify(z, (_k, v) => {
        if (typeof v === "string" && /[0-9a-f]{8,}/i.test(v)) refs.add(v);
        return v;
      });
    };
    const scanNode = (n: MrsonNode) => { if (n && (n as { zarr?: unknown }).zarr) scanZarr((n as { zarr?: unknown }).zarr); };
    for (const fr of this.session.frames) {
      if (fr.k === "key") for (const n of Object.values(fr.nodes)) scanNode(n);
      else if (fr.k === "up") scanNode(fr.node);
    }
    return refs;
  }

  /** LOSSY compaction: thin the delta stream so each node keeps at most one revision per `minGapMs`
   *  (keyframes and resets are always kept, so every keyframe time still reconstructs exactly). This
   *  is the "cull the intermediate data" option — e.g. drop the hundreds of in-progress revisions of a
   *  segmentation being painted, keeping periodic checkpoints. Returns how many frames were dropped. */
  cull(minGapMs: number): number {
    const kept: Frame[] = [];
    const lastKept = new Map<string, number>();   // id -> t of its last kept delta (since last keyframe)
    let dropped = 0;
    for (const fr of this.session.frames) {
      if (fr.k === "key" || fr.k === "reset") { lastKept.clear(); kept.push(fr); continue; }
      const prev = lastKept.get(fr.id);
      if (prev !== undefined && fr.t - prev < minGapMs) { dropped++; continue; }
      lastKept.set(fr.id, fr.t);
      kept.push(fr);
    }
    this.session.frames = kept;
    return dropped;
  }

  // ── persistence ─────────────────────────────────────────────────────────────

  toJSON(): Session { return this.session; }
  static fromJSON(s: Session): Session { return s; }
}
