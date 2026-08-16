// Sequence + SequenceBrowser — a faithful TS mirror of Slicer's vtkMRMLSequenceNode and
// vtkMRMLSequenceBrowserNode. Design notes and source references: docs/SEQUENCES-CINE.md.
//
// The parts that matter and are easy to get wrong:
//   - Index values are STRINGS even for a numeric index; comparison goes through parseFloat
//     plus a tolerance. Numeric indices stay sorted; text indices keep insertion order.
//   - getItemNumberFromIndexValue(v, exact=false) returns the item JUST BEFORE v, which is
//     what makes "seek to the nearest earlier frame" work.
//   - selectedItemNumber is an integer ORDINAL, not an index value.
//   - Playback advances on WALL CLOCK with frame dropping — floor(elapsed*fps + 0.5) — not
//     by counting rendered frames. Slicer polls this at 50 Hz; we call it from rAF.
//
// Deliberate divergence: Slicer's `saveChanges` defaults false, which selects the *deep
// copy* path (deepCopy = !saveChanges) and makes the default the slow one. There is no
// reason to inherit that polarity, so here proxying is always by reference and write-back
// is an explicit opt-in.

export type IndexType = "numeric" | "text";

export interface SequenceItem<T> {
  index: string;
  data: T;
}

export class Sequence<T> {
  indexName: string;
  indexUnit: string;
  indexType: IndexType;
  numericIndexValueTolerance: number;
  private items: SequenceItem<T>[] = [];

  constructor(opts: {
    indexName?: string;
    indexUnit?: string;
    indexType?: IndexType;
    numericIndexValueTolerance?: number;
  } = {}) {
    this.indexName = opts.indexName ?? "time";
    this.indexUnit = opts.indexUnit ?? "s";
    this.indexType = opts.indexType ?? "numeric";
    this.numericIndexValueTolerance = opts.numericIndexValueTolerance ?? 0.001;
  }

  get numberOfDataNodes(): number { return this.items.length; }
  getNthIndexValue(i: number): string | undefined { return this.items[i]?.index; }
  getNthDataNode(i: number): T | undefined { return this.items[i]?.data; }
  allItems(): readonly SequenceItem<T>[] { return this.items; }

  /** Numeric indices insert in sorted position; text indices append (insertion order). */
  private insertPosition(index: string): number {
    if (this.indexType !== "numeric") return this.items.length;
    const v = parseFloat(index);
    let i = 0;
    while (i < this.items.length && parseFloat(this.items[i].index) < v) i++;
    return i;
  }

  setDataNodeAtValue(data: T, index: string): void {
    const at = this.getItemNumberFromIndexValue(index, true);
    if (at >= 0) { this.items[at].data = data; return; }
    this.items.splice(this.insertPosition(index), 0, { index, data });
  }

  getDataNodeAtValue(index: string, exactMatchRequired = true): T | undefined {
    const i = this.getItemNumberFromIndexValue(index, exactMatchRequired);
    return i < 0 ? undefined : this.items[i].data;
  }

  /** -1 if not found. Non-exact numeric lookup returns the item just BEFORE the value
   *  (clamped to the ends), matching vtkMRMLSequenceNode::GetItemNumberFromIndexValue. */
  getItemNumberFromIndexValue(index: string, exactMatchRequired = true): number {
    if (this.indexType !== "numeric") {
      const i = this.items.findIndex((it) => it.index === index);
      return i;
    }
    const v = parseFloat(index);
    const tol = this.numericIndexValueTolerance;
    for (let i = 0; i < this.items.length; i++) {
      if (Math.abs(parseFloat(this.items[i].index) - v) <= tol) return i;
    }
    if (exactMatchRequired) return -1;
    if (!this.items.length) return -1;
    if (v <= parseFloat(this.items[0].index)) return 0;
    if (v >= parseFloat(this.items[this.items.length - 1].index)) return this.items.length - 1;
    let best = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (parseFloat(this.items[i].index) <= v) best = i; else break;
    }
    return best;
  }
}

export type MissingItemMode =
  | "createFromPrevious" | "createFromDefault" | "setToDefault" | "ignore" | "displayHidden";

export interface SynchronizedSequence<T> {
  sequence: Sequence<T>;
  playback: boolean;
  missingItemMode: MissingItemMode;
  /** Called with the item for the current index — the "proxy update". */
  apply(data: T | undefined, itemNumber: number): void;
}

/** Mirrors vtkMRMLSequenceBrowserNode. sequences[0] is the master (Slicer stores this as
 *  SynchronizationPostfixes[0]; there is no structural master/slave distinction). */
export class SequenceBrowser<T> {
  sequences: SynchronizedSequence<T>[] = [];
  selectedItemNumber = -1;
  playbackActive = false;
  playbackRateFps = 10;
  playbackLooped = true;
  playbackItemSkippingEnabled = true;
  /** Continuous position, so fractional values can drive inter-frame interpolation. */
  continuousItem = 0;
  private lastTimeSec: number | null = null;

  get master(): Sequence<T> | undefined { return this.sequences[0]?.sequence; }
  get numberOfItems(): number { return this.master?.numberOfDataNodes ?? 0; }

  addSynchronizedSequence(
    sequence: Sequence<T>,
    apply: (data: T | undefined, itemNumber: number) => void,
    opts: { playback?: boolean; missingItemMode?: MissingItemMode } = {},
  ): void {
    // Slicer's compatibility contract is exactly: index name, unit, and type must match.
    const m = this.master;
    if (m && (m.indexName !== sequence.indexName || m.indexUnit !== sequence.indexUnit || m.indexType !== sequence.indexType)) {
      throw new Error(
        `sequence not compatible for browsing: index (${sequence.indexName},${sequence.indexUnit},${sequence.indexType}) ` +
        `!= master (${m.indexName},${m.indexUnit},${m.indexType})`,
      );
    }
    this.sequences.push({
      sequence, apply,
      playback: opts.playback ?? true,
      missingItemMode: opts.missingItemMode ?? "createFromPrevious",
    });
    if (this.selectedItemNumber < 0 && sequence.numberOfDataNodes) this.setSelectedItemNumber(0);
  }

  setSelectedItemNumber(i: number): void {
    this.selectedItemNumber = i;
    this.continuousItem = i;
    this.updateProxies();
  }

  setSelectedItemByIndexValue(index: string, exactMatchRequired = false): void {
    const m = this.master;
    if (!m) return;
    const i = m.getItemNumberFromIndexValue(index, exactMatchRequired);
    if (i >= 0) this.setSelectedItemNumber(i);
  }

  /** Mirrors SelectNextItem: wraps when looped, otherwise stops playback and rewinds. */
  selectNextItem(increment = 1): void {
    const n = this.numberOfItems;
    if (n <= 0) return;
    let i = this.selectedItemNumber + increment;
    if (i >= n || i < 0) {
      if (this.playbackLooped) i = ((i % n) + n) % n;
      else { this.playbackActive = false; i = increment >= 0 ? 0 : n - 1; }
    }
    this.setSelectedItemNumber(i);
  }

  /** Call once per rendered frame with a monotonic clock in seconds. Returns true if the
   *  displayed position changed (i.e. the view needs a redraw / a kick). */
  tick(nowSec: number, continuous = false): boolean {
    if (!this.playbackActive || this.numberOfItems <= 0) { this.lastTimeSec = nowSec; return false; }
    if (this.lastTimeSec === null) { this.lastTimeSec = nowSec; return false; }
    const elapsed = nowSec - this.lastTimeSec;
    if (continuous) {
      // Smooth: advance a fractional position so CineField can interpolate between phases.
      const n = this.numberOfItems;
      let p = this.continuousItem + elapsed * this.playbackRateFps;
      if (p >= n) { if (this.playbackLooped) p = p % n; else { p = n - 1; this.playbackActive = false; } }
      this.lastTimeSec = nowSec;
      this.continuousItem = p;
      this.selectedItemNumber = Math.floor(p);
      this.updateProxies();
      return true;
    }
    // Slicer's arithmetic: accumulate until at least one whole item is due, then jump.
    const increment = Math.floor(elapsed * this.playbackRateFps + 0.5);
    if (increment <= 0) return false;
    this.lastTimeSec = nowSec;
    this.selectNextItem(this.playbackItemSkippingEnabled ? increment : 1);
    return true;
  }

  /** Fan out the current index to every synchronized sequence (UpdateProxyNodesFromSequences). */
  updateProxies(): void {
    const m = this.master;
    if (!m) return;
    const indexValue = m.getNthIndexValue(this.selectedItemNumber);
    for (const s of this.sequences) {
      if (!s.playback) continue;
      let item: T | undefined;
      let itemNumber = this.selectedItemNumber;
      if (s.sequence === m) {
        item = m.getNthDataNode(this.selectedItemNumber);
      } else if (indexValue !== undefined) {
        const exact = s.sequence.getItemNumberFromIndexValue(indexValue, true);
        if (exact >= 0) { itemNumber = exact; item = s.sequence.getNthDataNode(exact); }
        else if (s.missingItemMode === "createFromPrevious") {
          const prev = s.sequence.getItemNumberFromIndexValue(indexValue, false);
          if (prev >= 0) { itemNumber = prev; item = s.sequence.getNthDataNode(prev); }
        } else if (s.missingItemMode === "ignore") continue;
      }
      s.apply(item, itemNumber);
    }
  }
}
