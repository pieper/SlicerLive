// Coalescer — the client half of mrson impedance matching. A fast producer (a 60–120Hz pointer
// drag, a moving camera, an intraoperative sensor) calls update() as often as it likes for
// immediate LOCAL feedback; the Coalescer forwards to the wire at a BOUNDED rate, keeping only
// the latest value per key (latest-wins), and it always flushes a trailing value so the two
// scenes settle to the same final state. This decouples the producer's event loop from the
// transport's — the same pattern works whether the wire is a WebSocket, WebRTC, or a shared-memory
// ring (the flush callback is transport-agnostic; bulk payloads travel on their own channel and
// are referenced here only by small ops/handles).
//
// Keying: coalesce by the smallest unit that must not clobber another — e.g. "cp:<nodeId>:<index>"
// for a control point, "cam:<nodeId>" for a camera pose. Distinct keys in one interval flush
// together as a batch (one wire message), so a multi-node update is still a single round trip.

export class Coalescer<V> {
  private pending = new Map<string, V>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = -Infinity;

  /**
   * @param intervalMs minimum wall time between wire flushes (e.g. 33 = ~30Hz).
   * @param flush       called with the coalesced batch (latest value per key) to put on the wire.
   * @param now         clock (overridable for tests); defaults to performance.now.
   */
  constructor(
    private intervalMs: number,
    private flush: (batch: Map<string, V>) => void,
    private now: () => number = () => performance.now(),
  ) {}

  /** Record the latest value for `key`. Cheap — safe to call every animation frame. */
  update(key: string, value: V): void {
    this.pending.set(key, value); // latest wins
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null || this.pending.size === 0) return;
    const wait = Math.max(0, this.intervalMs - (this.now() - this.lastFlush));
    this.timer = setTimeout(() => this.doFlush(), wait);
  }

  private doFlush(): void {
    this.timer = null;
    if (this.pending.size === 0) return;
    this.lastFlush = this.now();
    const batch = this.pending;
    this.pending = new Map();
    this.flush(batch);
    this.schedule(); // anything produced during flush() rides the next interval (trailing flush)
  }

  /** Force the pending batch out now (e.g. on pointer-up: the authoritative final value must land
   *  without waiting out the interval). Resets the rate window so the next update can flush at once. */
  flushNow(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.lastFlush = -Infinity;
    this.doFlush();
  }

  /** Drop any pending values without sending (e.g. interaction cancelled). */
  clear(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
  }

  get pendingCount(): number { return this.pending.size; }
}
