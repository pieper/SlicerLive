// Recording — loads a FINALIZED on-disk mrson recording (written by the Slicer-side
// LiveStoryLib/mrson_recorder.py) and compiles it into the same Frame tape the live SceneRecorder
// uses, so SlicerLive can scrub/replay a past session. A recording is served by the mrson server at
//   <base> = http://host:2131/mrson/rec/<name>/
// as recording.json (manifest: keyframes[], events[], thumbs[], marks[]) + key*.mrson.json + blobs/
// + thumbs/*.png. The manifest is a keyframe+delta stream; here we reduce it to key/up/rm/reset
// frames (via a pure event reducer, the dual of LiveScene.receiveEvent's model mutation) so
// seekFrames() reconstructs any timepoint exactly. Replay drives the view with
// LiveScene.applySnapshot(seek(t)) — identical to live scrub.

import { nearestThumbOf, seekFrames, type Frame, type Mark, type Session, type Thumb } from "./recorder.ts";
import { branchPointAtTime, type BranchPoint, type Commit, type ContentHash, sealStream, verifyChain, type VerifyResult } from "./commits.ts";
import type { MrsonNode } from "./mrson.ts";

interface RecEvent { t: number; event: string; sourceId?: string; node?: MrsonNode; display?: Record<string, unknown>; [k: string]: unknown }
interface Manifest {
  id: string; startedAt: number; endedAt: number; blobBase: string;
  keyframes: { t: number; scene: string }[];
  events: RecEvent[];
  thumbs: { t: number; file: string }[];
  marks: Mark[];
  commits?: Commit[]; head?: ContentHash; root?: ContentHash;   // git-style history (sealed on disk, or computed on load)
}

/** Apply one recorded mrson event to a node map, returning the resulting frame delta. This is the pure
 *  dual of LiveScene.receiveEvent's MODEL mutation (no managers, no feed): NodeAdded → upsert, NodeRemoved
 *  → remove, CameraModified / SegmentationDisplayModified → merge fields into the node, SceneClosed →
 *  reset. Anything else (bare "Modified", etc.) is a no-op. */
function reduceEvent(nodes: Map<string, MrsonNode>, ev: RecEvent): Frame | null {
  const t = ev.t;
  switch (ev.event) {
    case "NodeAdded": {
      if (!ev.node) return null;
      const node = structuredClone(ev.node);
      nodes.set(node.id, node);
      return { t, k: "up", id: node.id, node };
    }
    case "NodeRemoved": {
      const id = ev.sourceId!;
      nodes.delete(id);
      return { t, k: "rm", id };
    }
    case "CameraModified": {
      const id = ev.sourceId!;
      const node = nodes.get(id);
      if (!node) return null;
      for (const k of ["position", "focalPoint", "viewUp", "viewAngle", "parallelScale"]) {
        if (k in ev) (node as unknown as Record<string, unknown>)[k] = ev[k];
      }
      return { t, k: "up", id, node: structuredClone(node) };
    }
    case "SegmentationDisplayModified": {
      const id = ev.sourceId!;
      const node = nodes.get(id);
      if (!node || !ev.display) return null;
      for (const k of ["visible", "opacity", "fill2D", "outline2D", "segments"]) {
        if (k in ev.display) (node as unknown as Record<string, unknown>)[k] = ev.display[k];
      }
      return { t, k: "up", id, node: structuredClone(node) };
    }
    case "SceneClosed":
      nodes.clear();
      return { t, k: "reset" };
    default:
      return null;   // bare "Modified" and friends carry no reconstructable state
  }
}

export class Recording {
  // git-style history over the event stream (see commits.ts). Present when the recording was sealed on
  // disk (render/tools/seal-recording.ts); otherwise computed deterministically on load, so every
  // recording "has" a verifiable commit chain and a stable head hash.
  commits: Commit[] = [];
  headCommit?: ContentHash;   // NB: distinct from head() (the timeline's max frame time)
  rootCommit?: ContentHash;

  constructor(public base: string, public session: Session) {}

  /** Fetch + compile a finalized recording at `base` (…/mrson/rec/<name>/). */
  static async load(base: string): Promise<Recording> {
    if (!base.endsWith("/")) base += "/";
    const man = await (await fetch(base + "recording.json")).json() as Manifest;
    const keyDocs = await Promise.all(
      man.keyframes.map((k) => fetch(base + k.scene).then((r) => r.json() as Promise<{ nodes: Record<string, MrsonNode> }>)),
    );

    // Merge keyframes + events into one time-ordered stream, then reduce to a Frame tape. Keyframes
    // sort before same-t events so a boundary keyframe wins.
    type Item = { t: number; key?: Record<string, MrsonNode>; ev?: RecEvent };
    const items: Item[] = [];
    man.keyframes.forEach((k, i) => items.push({ t: k.t, key: keyDocs[i].nodes }));
    for (const e of man.events) items.push({ t: e.t, ev: e });
    items.sort((a, b) => (a.t - b.t) || ((a.key ? 0 : 1) - (b.key ? 0 : 1)));

    const frames: Frame[] = [];
    const cur = new Map<string, MrsonNode>();
    for (const it of items) {
      if (it.key) {
        frames.push({ t: it.t, k: "key", nodes: structuredClone(it.key) });
        cur.clear();
        for (const [id, n] of Object.entries(it.key)) cur.set(id, structuredClone(n));
      } else if (it.ev) {
        const fr = reduceEvent(cur, it.ev);
        if (fr) frames.push(fr);
      }
    }

    const thumbs: Thumb[] = man.thumbs.map((th) => ({ t: th.t, url: base + th.file }));
    const session: Session = { id: man.id, startedAt: man.startedAt, frames, thumbs, marks: man.marks ?? [] };
    const rec = new Recording(base, session);
    // git-style history: use the on-disk chain if the recording was sealed, else compute it deterministically.
    rec.commits = (man.commits && man.commits.length) ? man.commits : await sealStream(man.events ?? [], { intervalMs: 1000, role: "module" });
    rec.rootCommit = man.root ?? rec.commits[0]?.hash;
    rec.headCommit = man.head ?? rec.commits[rec.commits.length - 1]?.hash;
    return rec;
  }

  // Same query surface as SceneRecorder, so the timeline UI drives either interchangeably.
  seek(t: number): Map<string, MrsonNode> { return seekFrames(this.session.frames, t); }
  nearestThumb(t: number): Thumb | undefined { return nearestThumbOf(this.session.thumbs, t); }
  head(): number { const f = this.session.frames; return f.length ? f[f.length - 1].t : this.session.startedAt; }
  span(): [number, number] { return [this.session.startedAt, this.head()]; }
  /** Times of every recorded frame (keyframe/delta), ascending — used to skip idle gaps in playback. */
  frameTimes(): number[] { return this.session.frames.map((f) => f.t); }
  /** blobBase for a LiveScene replaying this recording (so ImageField/zarr fetch the recording's blobs). */
  blobBase(): string { return this.base; }

  // ── git-style history ────────────────────────────────────────────────────
  /** The `(commit, offset)` branch point at a timeline position — the address to fork from here. */
  branchPointAt(tMs: number): BranchPoint { return branchPointAtTime(this.commits, tMs); }
  /** Re-hash the commit chain: detects any altered delta (integrity). */
  verify(): Promise<VerifyResult> { return verifyChain(this.commits); }
}
