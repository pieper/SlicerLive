// SessionStore — the durable home of a LiveScene: a Session directory (SlicerLiveSessions/<id>/) with a
// checkpoint, an append-only op log, bookmarks, an undo/redo stack, and a content-addressed blob cache.
//
//   <id>/session.json        name, created, schema, head (log sequence), checkpoint time
//   <id>/scene.mrson.json    latest checkpoint of the node map (the current state)
//   <id>/log/NNNN.ops.jsonl  append-only: {seq, t, kind: up|rm|reset, id?, node?, op?, origin, role}
//   <id>/bookmarks.json      [{name, t, seq}]
//   <id>/blobs/<hash>        content-addressed bulk (zarr chunks, mesh blobs) — also the fetch cache
//
// Autosave = write-behind append of every `_changes` entry (coalesced per 500 ms); a checkpoint every
// keyEveryN deltas / keyEveryMs. Reopen = checkpoint + replay of the log tail. Undo/redo = inverse ops
// written through LiveScene.write (so a connected app follows). "Save" = export the reachable active set.
import type { Change, LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import type { Op } from "../liveops.ts";
import type { SessionFS } from "./session-fs.ts";

export interface SessionMeta { id: string; name: string; created: number; schema: number; head: number; checkpointT: number; checkpointSeq: number }
export interface LogEntry { seq: number; t: number; kind: "up" | "rm" | "reset"; id?: string; node?: MrsonNode; op?: Op; origin: string; role?: string }
export interface Bookmark { name: string; t: number; seq: number }
export interface UndoEntry { seq: number; id: string; before: MrsonNode | null; after: MrsonNode | null; label: string; path?: string }

const getByPointer = (node: MrsonNode | null, path: string): unknown => {
  if (!node) return undefined;
  let cur: unknown = node;
  for (const k of path.replace(/^#/, "").split("/").filter(Boolean)) { if (cur == null || typeof cur !== "object") return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export interface SessionStoreOpts { now?: () => number; keyEveryN?: number; keyEveryMs?: number; flushMs?: number; name?: string }

export class SessionStore {
  meta!: SessionMeta;
  private pending: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private deltasSinceKey = 0;
  private unsub?: () => void;
  private shadow = new Map<string, MrsonNode>();      // last known node state per id (for undo "before")
  undo: UndoEntry[] = [];
  redo: UndoEntry[] = [];
  private applyingHistory = false;
  private now: () => number;
  private keyEveryN: number; private keyEveryMs: number; private flushMs: number;
  private scene?: LiveScene;

  constructor(public fs: SessionFS, private opts: SessionStoreOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.keyEveryN = opts.keyEveryN ?? 200; this.keyEveryMs = opts.keyEveryMs ?? 15000; this.flushMs = opts.flushMs ?? 500;
  }

  /** Open (or create) the session in `fs`. Returns the checkpoint node map + log tail replayed, or an empty map. */
  async open(): Promise<Map<string, MrsonNode>> {
    const metaText = await this.fs.readText("session.json");
    if (metaText) this.meta = JSON.parse(metaText);
    else {
      const t = this.now();
      this.meta = { id: "s" + t, name: this.opts.name ?? new Date(t).toISOString(), created: t, schema: 1, head: 0, checkpointT: 0, checkpointSeq: 0 };
      await this.fs.writeText("session.json", JSON.stringify(this.meta));
    }
    const nodes = new Map<string, MrsonNode>();
    const cp = await this.fs.readText("scene.mrson.json");
    if (cp) for (const [id, n] of Object.entries((JSON.parse(cp) as { nodes: Record<string, MrsonNode> }).nodes ?? {})) nodes.set(id, n);
    for (const e of await this.readLog(this.meta.checkpointSeq)) {
      if (e.kind === "reset") nodes.clear();
      else if (e.kind === "rm" && e.id) nodes.delete(e.id);
      else if (e.kind === "up" && e.node) nodes.set(e.node.id, e.node);
      if (e.seq > this.meta.head) this.meta.head = e.seq;
    }
    for (const [id, n] of nodes) this.shadow.set(id, clone(n));
    return nodes;
  }

  /** Every log entry with seq > afterSeq, in order (segments are numbered; entries carry seq). */
  async readLog(afterSeq = 0): Promise<LogEntry[]> {
    const names = (await this.fs.list("log")).filter((n) => n.endsWith(".ops.jsonl")).sort();
    const out: LogEntry[] = [];
    for (const n of names) {
      const text = await this.fs.readText("log/" + n);
      if (!text) continue;
      for (const line of text.split("\n")) { if (!line.trim()) continue; const e = JSON.parse(line) as LogEntry; if (e.seq > afterSeq) out.push(e); }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** Start logging a LiveScene. Seeds a checkpoint if the store is new and the scene already has nodes. */
  async attach(scene: LiveScene): Promise<void> {
    this.scene = scene;
    if (this.shadow.size === 0) for (const [id, n] of scene.nodes) this.shadow.set(id, clone(n));
    this.unsub?.();
    this.unsub = scene.subscribe((c) => this.onChange(c));
    if (!(await this.fs.exists("scene.mrson.json"))) await this.checkpoint();   // a new store starts from the scene as it is
  }
  detach(): void { this.unsub?.(); this.unsub = undefined; }

  private onChange(c: Change): void {
    const t = this.now();
    const seq = ++this.meta.head;
    let entry: LogEntry;
    if (c.kind === "reset") { entry = { seq, t, kind: "reset", origin: c.origin }; this.shadow.clear(); }
    else if (c.kind === "remove") {
      entry = { seq, t, kind: "rm", id: c.id, origin: c.origin, role: (c.op as { role?: string } | undefined)?.role };
      if (!this.applyingHistory && c.origin === "local") this.pushUndo({ seq, id: c.id, before: this.shadow.get(c.id) ?? null, after: null, label: "delete " + c.id });
      this.shadow.delete(c.id);
    } else {
      const node = this.scene?.nodes.get(c.id) ?? c.node;
      if (!node) return;
      entry = { seq, t, kind: "up", id: c.id, node: clone(node), op: c.op, origin: c.origin, role: (c.op as { role?: string } | undefined)?.role };
      if (!this.applyingHistory && c.origin === "local" && c.op) {
        const before = this.shadow.get(c.id) ?? null;
        this.pushUndo({ seq, id: c.id, before: before ? clone(before) : null, after: clone(node), label: (c.op.op === "patch" ? (c.op as { path?: string }).path : c.op.op) ?? "edit", path: c.op.op === "patch" ? (c.op as { path?: string }).path : undefined });
      }
      this.shadow.set(c.id, clone(node));
    }
    this.pending.push(entry);
    if (++this.deltasSinceKey >= this.keyEveryN || t - this.meta.checkpointT >= this.keyEveryMs) void this.checkpoint();
    if (this.flushTimer === undefined) this.flushTimer = setTimeout(() => void this.flush(), this.flushMs);
  }

  private pushUndo(e: UndoEntry): void {
    // coalesce a drag: same node + same label within 300 ms extends the previous entry's "after"
    const last = this.undo[this.undo.length - 1];
    if (last && last.id === e.id && last.label === e.label && e.seq - last.seq < 50 && this.now() - (last as { at?: number }).at! < 300) { last.after = e.after; last.seq = e.seq; (last as { at?: number }).at = this.now(); }
    else { (e as { at?: number }).at = this.now(); this.undo.push(e); if (this.undo.length > 500) this.undo.shift(); }
    this.redo = [];
  }

  /** Write pending log entries (append-only, current segment). */
  async flush(): Promise<void> {
    this.flushTimer = undefined;
    if (!this.pending.length) return;
    const batch = this.pending; this.pending = [];
    const segment = String(Math.floor(batch[0].seq / 1000)).padStart(4, "0");
    await this.fs.appendText(`log/${segment}.ops.jsonl`, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await this.fs.writeText("session.json", JSON.stringify(this.meta));
  }

  /** Write the current node map as the checkpoint (the current state). */
  async checkpoint(): Promise<void> {
    if (!this.scene) return;
    const nodes: Record<string, MrsonNode> = {};
    for (const [id, n] of this.scene.nodes) nodes[id] = n;
    this.meta.checkpointT = this.now(); this.meta.checkpointSeq = this.meta.head; this.deltasSinceKey = 0;
    await this.fs.writeText("scene.mrson.json", JSON.stringify({ mrson: 0, blobBase: "blobs/", nodes }));
    await this.fs.writeText("session.json", JSON.stringify(this.meta));
  }

  // ── undo / redo (inverse ops through the normal write path: a connected app follows) ──
  private applyState(id: string, node: MrsonNode | null, path?: string): void {
    if (!this.scene) return;
    this.applyingHistory = true;
    try {
      const value = path ? getByPointer(node, path) : undefined;
      if (path && node && value !== undefined) this.scene.write({ op: "patch", id, path, value: clone(value) });   // single-property edit: restore that property
      else if (node) this.scene.write({ op: "put", id, node: clone(node) });                                       // whole-node restore (create / structural change)
      else this.scene.write({ op: "del", id });
    } finally { this.applyingHistory = false; }
  }
  canUndo(): boolean { return this.undo.length > 0; }
  canRedo(): boolean { return this.redo.length > 0; }
  undoLast(): UndoEntry | undefined { const e = this.undo.pop(); if (!e) return; this.applyState(e.id, e.before, e.path); this.redo.push(e); return e; }
  redoLast(): UndoEntry | undefined { const e = this.redo.pop(); if (!e) return; this.applyState(e.id, e.after, e.path); this.undo.push(e); return e; }

  // ── bookmarks + branching ──
  async bookmarks(): Promise<Bookmark[]> { const t = await this.fs.readText("bookmarks.json"); return t ? JSON.parse(t) : []; }
  async bookmark(name: string): Promise<Bookmark> {
    const list = await this.bookmarks(); const b = { name, t: this.now(), seq: this.meta.head }; list.push(b);
    await this.fs.writeText("bookmarks.json", JSON.stringify(list)); return b;
  }
  /** The node map as of log seq `seq` (checkpoint-independent: replays from the first checkpoint ≤ seq or the log start). */
  async stateAt(seq: number): Promise<Map<string, MrsonNode>> {
    const nodes = new Map<string, MrsonNode>();
    const cp = await this.fs.readText("scene.mrson.json");
    const cpSeq = this.meta.checkpointSeq;
    if (cp && cpSeq <= seq) for (const [id, n] of Object.entries((JSON.parse(cp) as { nodes: Record<string, MrsonNode> }).nodes ?? {})) nodes.set(id, n);
    for (const e of await this.readLog(cp && cpSeq <= seq ? cpSeq : 0)) {
      if (e.seq > seq) break;
      if (e.kind === "reset") nodes.clear(); else if (e.kind === "rm" && e.id) nodes.delete(e.id); else if (e.kind === "up" && e.node) nodes.set(e.node.id, e.node);
    }
    return nodes;
  }
  /** Branch: a new session directory seeded from the state at `seq` (default: now). Blobs are shared by hash. */
  async branch(target: SessionFS, name: string, seq = this.meta.head): Promise<SessionMeta> {
    const nodes = Object.fromEntries(await this.stateAt(seq));
    const t = this.now();
    const meta: SessionMeta = { id: "s" + t, name, created: t, schema: 1, head: 0, checkpointT: t, checkpointSeq: 0 };
    await target.writeText("session.json", JSON.stringify({ ...meta, branchOf: { session: this.meta.id, seq } }));
    await target.writeText("scene.mrson.json", JSON.stringify({ mrson: 0, blobBase: "blobs/", nodes }));
    for (const h of blobRefs(Object.values(nodes))) { const b = await this.fs.readBytes("blobs/" + h); if (b) await target.writeBytes("blobs/" + h, b); }
    return meta;
  }

  // ── blob cache ──
  async cacheBlob(hash: string, bytes: Uint8Array): Promise<void> { if (!(await this.fs.exists("blobs/" + hash))) await this.fs.writeBytes("blobs/" + hash, bytes); }
  cachedBlob(hash: string): Promise<Uint8Array | null> { return this.fs.readBytes("blobs/" + hash); }

  /** "Save": export the current active set (nodes + exactly the blobs they reference) into `target`. */
  async exportActiveSet(target: SessionFS, fetchBlob: (hash: string) => Promise<Uint8Array | null>): Promise<{ nodes: number; blobs: number; missing: string[] }> {
    if (!this.scene) throw new Error("no scene attached");
    const nodes: Record<string, MrsonNode> = {};
    for (const [id, n] of this.scene.nodes) nodes[id] = n;
    await target.writeText("scene.mrson.json", JSON.stringify({ mrson: 0, blobBase: "blobs/", nodes }));
    const missing: string[] = []; let count = 0;
    for (const h of blobRefs(Object.values(nodes))) {
      const b = (await this.cachedBlob(h)) ?? (await fetchBlob(h));
      if (b) { await target.writeBytes("blobs/" + h, b); count++; } else missing.push(h);
    }
    return { nodes: Object.keys(nodes).length, blobs: count, missing };
  }
}

/** Every content-addressed blob hash a set of nodes references (zarr chunks, mesh points/triangles). */
export function blobRefs(nodes: MrsonNode[]): Set<string> {
  const refs = new Set<string>();
  for (const n of nodes) {
    const z = (n as { zarr?: { chunkHashes?: Record<string, string> } }).zarr;
    if (z?.chunkHashes) for (const h of Object.values(z.chunkHashes)) refs.add(h);
    for (const k of ["points", "triangles"]) { const v = (n as Record<string, unknown>)[k]; if (typeof v === "string" && v.startsWith("sha256-")) refs.add(v); }
  }
  return refs;
}
