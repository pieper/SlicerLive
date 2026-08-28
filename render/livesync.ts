// LiveSync — the active data-transport layer: replicates one local LiveScene to one peer over one
// Transport (ARCHITECTURE-2026-08-02 §2). It is the ONLY component that knows the wire. LiveScene is
// the pure data model; LiveSync moves changes between two models.
//
//   outbound: subscribe the LiveScene _changes feed -> local-origin ops -> coalesce latest-wins per
//             key (Tier B, drop-to-latest) -> transport.send
//   inbound:  transport messages -> LiveScene.receiveEvent (Slicer's event-shaped changes) in order
//   lifecycle: connect + event-driven exponential-backoff reconnect (laptop-sleep resilient) +
//             re-subscribe on (re)connect so the peer re-sends state
//   echo suppression: only local-origin ops go out; a remote change carries no op on the feed
//
// Reconnect/status machinery moved here from LiveScene (which is now transport-agnostic). Per-key
// stream-vs-update-on-complete policy and seq/checkpoint resume are the next refinements (§2).

import type { Change, LiveScene } from "./livescene.ts";
import type { Op } from "./liveops.ts";
import type { Transport } from "./transport.ts";
import { Coalescer } from "./rate-limiter.ts";

/** Connection state for a UI feedback line. `waiting` carries the backoff countdown target. */
export type LiveStatus =
  | { state: "connecting"; attempt: number }
  | { state: "connected" }
  | { state: "waiting"; attempt: number; nextRetryAt: number };

/** Coalescing key: the smallest unit that must not clobber another (a control point, a camera pose,
 *  one property). Bursts on the same key collapse to the latest; distinct keys flush together. */
function opKey(op: Op): string {
  if (op.op === "cmd") return `${op.id}:${op.cmd}:${op.args?.index ?? ""}`;
  if (op.op === "patch") return `${op.id}:${op.path}`;
  return `${op.id}:${op.op}`;
}

export interface LiveSyncOpts {
  intervalMs?: number;   // outbound coalesce interval (default 33 = ~30Hz)
  now?: () => number;    // clock (tests)
  /** This peer's id (default "remote"). With several LiveSyncs on one LiveScene the scene is the HUB:
   *  a change that arrived from peer A is forwarded to every other peer as a put/del (never back to A). */
  peerId?: string;
  /** Node types this peer should receive at all (default: everything the scene subscribes to). */
  relayTypes?: string[];
  /** Hub relay (default OFF): forward changes that came from OTHER peers to this one. A single-peer
   *  LiveSync must never send anything that did not originate locally (echo suppression). */
  relay?: boolean;
}

export class LiveSync {
  onStatus?: (s: LiveStatus) => void;

  private out: Coalescer<Op>;
  private tag = 0;
  /** Sent batches not yet acknowledged by the peer (tag -> ops). Re-sent after a reconnect so a burst
   *  that raced the drop is not lost; cleared by OpAck. */
  pending = new Map<number, Op[]>();
  /** Highest peer seq seen (a checkpoint for resumable reconnects). */
  lastSeq = 0;
  private everConnected = false;
  private unsub?: () => void;
  private inq: Promise<void> = Promise.resolve();   // serialize inbound handling in arrival order

  // event-driven reconnect (no heartbeat)
  private backoff = { base: 1000, factor: 2, max: 30000 };
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private wantClose = false;
  private firstOpen?: () => void;
  private now: () => number;

  peerId: string;
  private relayTypes?: Set<string>;
  private relay: boolean;
  private relayed = new Map<string, string>();   // node id -> last content relayed to this peer
  private relayedDel = new Set<string>();
  private relayCount = 0;
  constructor(public scene: LiveScene, public transport: Transport, opts: LiveSyncOpts = {}) {
    this.peerId = opts.peerId ?? "remote";
    this.relay = !!opts.relay;
    this.relayTypes = opts.relayTypes ? new Set(opts.relayTypes) : undefined;
    this.now = opts.now ?? (() => Date.now());
    this.out = new Coalescer<Op>(
      opts.intervalMs ?? 33,
      (batch) => { const ops = [...batch.values()]; const tag = ++this.tag; this.pending.set(tag, ops); this.transport.send({ op: "applyOps", ops, tag }); },
      opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now())),
    );
    transport.onMessage = (m) => this.onMessage(m);
    transport.onOpen = () => this.onOpen();
    transport.onClose = () => this.onClose();
  }

  private emit(s: LiveStatus): void { try { this.onStatus?.(s); } catch { /* UI must never break sync */ } }

  /** Connect and keep connected. Resolves on the FIRST open; later drops auto-reconnect. No reject —
   *  a down peer just keeps retrying (progress via onStatus). */
  connect(): Promise<void> {
    this.wantClose = false;
    return new Promise((resolve) => { this.firstOpen = resolve; this.transport.connect(); });
  }

  private onOpen(): void {
    this.attempt = 0;
    const reconnect = this.everConnected;
    this.everConnected = true;
    // localBulk: types this scene reproduces locally → peer skips re-streaming their bulk updates.
    this.transport.send({ op: "subscribe", types: this.scene.subscribedTypes(), localBulk: this.scene.localBulk(), lastSeq: this.lastSeq });   // peer re-sends state
    this.unsub?.();
    this.unsub = this.scene.subscribe((c) => this.onLocalChange(c));                  // start replicating out
    // LiveScene is the authority: capture OUR state now (before the peer's re-snapshot upserts the local
    // model with its possibly stale values) and push it back once SnapshotComplete lands; the peer's echo
    // then converges the local model onto the same values.
    if (reconnect) { this.reconcileAfter = true; this.reconcileSnapshot = JSON.parse(JSON.stringify(Object.fromEntries(this.scene.nodes))); }
    this.emit({ state: "connected" });
    this.firstOpen?.(); this.firstOpen = undefined;
  }
  private reconcileAfter = false;
  private reconcileSnapshot: Record<string, unknown> = {};
  /** After a reconnect the peer (a restarted app, or one that diverged while we were away) re-snapshots;
   *  authority inversion means OUR node map wins: send it as a reconcile, then re-send unacked batches. */
  private reconcile(): void {
    this.reconcileAfter = false;
    this.transport.send({ op: "reconcile", nodes: this.reconcileSnapshot });
    this.reconcileSnapshot = {};
    for (const [tag, ops] of this.pending) this.transport.send({ op: "applyOps", ops, tag });
  }

  private onLocalChange(c: Change): void {
    if (c.origin === this.peerId) return;                                   // echo suppression: never back to its source
    if (this.relayTypes && c.type && !this.relayTypes.has(c.type)) return;
    if (c.op && c.origin === this.scene.origin) { this.out.update(opKey(c.op), c.op); return; }   // local write
    // HUB RELAY (opt-in): a change from another peer (no op on the feed) is forwarded as a whole-node put / del.
    // LOOP BREAKER: the receiving peer echoes what it applied, the hub would relay that echo back to the
    // origin's other peers, and so on forever. Relay a node only when its CONTENT differs from what this peer
    // last received from us — an echo of our own relay is identical and stops here.
    if (!this.relay || c.origin === this.scene.origin) return;
    if (c.kind === "upsert" && c.node) {
      const body = JSON.stringify(c.node);
      if (this.relayed.get(c.id) === body) return;
      this.relayed.set(c.id, body);
      if (++this.relayCount > 5000) { console.warn("LiveSync: relay cap reached — possible loop; relay disabled for", this.peerId); this.relay = false; return; }
      this.out.update(`${c.id}:put`, { op: "put", id: c.id, node: c.node, origin: c.origin, role: "module" } as Op);
    } else if (c.kind === "remove") {
      if (!this.relayed.has(c.id) && this.relayedDel.has(c.id)) return;
      this.relayed.delete(c.id); this.relayedDel.add(c.id);
      this.out.update(`${c.id}:del`, { op: "del", id: c.id, origin: c.origin } as Op);
    }
  }

  private onMessage(m: unknown): void {
    const msg = m as { event?: string; seq?: number; tag?: number; created?: Record<string, string> };
    if (!msg || typeof msg !== "object" || !("event" in msg)) return;
    if (typeof msg.seq === "number" && msg.seq > this.lastSeq) this.lastSeq = msg.seq;
    if (msg.event === "OpAck") {
      if (typeof msg.tag === "number") this.pending.delete(msg.tag);
      if (msg.created) for (const [clientId, realId] of Object.entries(msg.created)) this.scene.aliasNode(clientId, realId);
      return;
    }
    if (msg.event === "Reconciled") return;
    if (this.relay && msg.event === "NodeAdded" && (msg as { node?: { id?: string } }).node?.id) { const n = (msg as { node: { id: string } }).node; this.relayed.set(n.id, JSON.stringify(n)); }   // what this peer holds now
    this.inq = this.inq.then(() => this.scene.receiveEvent(msg as Record<string, unknown>, this.peerId));
    if (msg.event === "SnapshotComplete" && this.reconcileAfter) this.inq = this.inq.then(() => this.reconcile());
  }

  private onClose(): void {
    this.unsub?.(); this.unsub = undefined;
    if (!this.wantClose) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.wantClose || this.retryTimer !== undefined) return;
    const delay = Math.min(this.backoff.max, this.backoff.base * this.backoff.factor ** this.attempt);
    this.attempt++;
    this.emit({ state: "waiting", attempt: this.attempt, nextRetryAt: this.now() + delay });
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.emit({ state: "connecting", attempt: this.attempt }); this.transport.connect(); }, delay);
  }

  /** Force an immediate reconnect (the "Try now" button); does not reset the backoff schedule. */
  reconnectNow(): void {
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.emit({ state: "connecting", attempt: this.attempt });
    this.transport.connect();
  }

  /** Direct outbound (e.g. a pointer drag that owns its own optimistic local update): coalesced onto
   *  the wire exactly like a feed-driven write. Ops are stamped local-origin if unset. */
  sendOps(ops: Op[]): void {
    for (const o of ops) {
      const op = o.origin ? o : ({ ...o, origin: this.scene.origin } as Op);
      this.out.update(opKey(op), op);
    }
  }

  /** Flush pending outbound now (e.g. on pointer-up — the authoritative final value must not wait). */
  flush(): void { this.out.flushNow(); }

  close(): void {
    this.wantClose = true;
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.unsub?.(); this.unsub = undefined;
    this.out.clear();
    this.transport.close();
  }
}
