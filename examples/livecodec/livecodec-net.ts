/** Transport for the codec race: simulated link pacing, throughput measurement,
 *  and a byte cache that makes a comparison reproducible.
 *
 *  Split out from livecodec-scene.ts because none of it touches WebGPU, so it
 *  can be exercised head-less — the render module cannot, and the delivery layer
 *  is exactly the part whose correctness is invisible in a screenshot.
 */

let simBps: number | null = null;

/** Simulate a link speed (bits/s) for the race, or null for unthrottled. */
export function setSimulatedBandwidth(bitsPerSec: number | null): void {
  simBps = bitsPerSec;
}

/** One simulated link per codec row: all of a row's concurrent fetches share it,
 *  so each method receives bytes exactly as fast as the chosen network would
 *  deliver them if it were used alone. Bytes are admitted no earlier than their
 *  scheduled arrival time; the clock starts at the row's first byte. */
export class LinkPacer {
  private t0 = 0;
  private bytes = 0;

  async admit(n: number): Promise<void> {
    if (simBps == null) return;
    if (!this.t0) this.t0 = performance.now();
    this.bytes += n;
    const due = this.t0 + (this.bytes * 8 / simBps) * 1000;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/** Measured throughput per stream, aggregated per row. Streams record first-
 *  request to last-byte wall time; the row summary unions overlapping intervals
 *  (fine.gz + dc.gz download in parallel) so time is never double-counted. */
export interface StreamStat { name: string; bytes: number; t0: number; t1: number }

export class BandwidthMeter {
  stats: StreamStat[] = [];

  begin(name: string) {
    const s: StreamStat = { name, bytes: 0, t0: performance.now(), t1: performance.now() };
    this.stats.push(s);
    return {
      at: (cumulative: number) => { s.bytes = cumulative; s.t1 = performance.now(); },
      add: (n: number) => { s.bytes += n; s.t1 = performance.now(); },
    };
  }

  summary(): { bytes: number; seconds: number; mbps: number; streams: StreamStat[] } {
    const iv = this.stats.map((s) => [s.t0, s.t1] as [number, number]).sort((a, b) => a[0] - b[0]);
    let seconds = 0, end = -Infinity;
    for (const [a, b] of iv) {
      seconds += Math.max(0, b - Math.max(a, end));
      end = Math.max(end, b);
    }
    seconds /= 1000;
    const bytes = this.stats.reduce((t, s) => t + s.bytes, 0);
    return { bytes, seconds, mbps: seconds > 0 ? bytes * 8 / seconds / 1e6 : 0, streams: this.stats };
  }
}

/** ─── byte cache ──────────────────────────────────────────────────────────
 *  Downloading during a race means the link is measured, not simulated: real
 *  bandwidth wanders, the two arms see different conditions minutes apart, and
 *  re-running the same comparison at a new rate costs another full download.
 *  Prefetching every byte once and replaying from memory makes delivery exactly
 *  reproducible, so the ONLY thing setting the pace is the simulated link — flip
 *  the bandwidth or the encoding and the next run starts instantly.
 *
 *  This removes network variance. It does NOT remove main-thread contention,
 *  which is the separate reason fair mode runs one arm at a time. */
const byteCache = new Map<string, Uint8Array>();

/** Replay granularity. Real network reads arrive in tens of KB; feeding the
 *  pacer one giant buffer would make progress bars jump and starve the decoders
 *  of the interleaving they get on a real link. */
const REPLAY_CHUNK = 64 * 1024;

export function cacheHas(url: string): boolean { return byteCache.has(url); }
export function cacheClear(): void { byteCache.clear(); }
export function cacheSize(): number {
  let n = 0;
  for (const v of byteCache.values()) n += v.byteLength;
  return n;
}

/** Pull a URL into the cache at full speed. Unpaced by design: prefetch is not
 *  part of any measured race. */
export async function prefetch(url: string, onBytes?: (n: number) => void): Promise<number> {
  const hit = byteCache.get(url);
  if (hit) { onBytes?.(hit.byteLength); return hit.byteLength; }
  const buf = await rawFetch(url, onBytes);
  byteCache.set(url, buf);
  return buf.byteLength;
}

async function rawFetch(url: string, onBytes?: (n: number) => void): Promise<Uint8Array> {
  // no-store: scan data is never served from the HTTP cache, so an uncached race
  // is a real download (codec runtimes — decoder weights, wasm — may cache; both
  // rows benefit symmetrically, as deployed static assets would).
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    onBytes?.(buf.byteLength);
    return buf;
  }
  const parts: Uint8Array[] = [];
  const rd = resp.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    onBytes?.(total);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return all;
}

/** The one byte source every stream in the race reads from. Yields chunks from
 *  the cache when warm and from the network otherwise, pacing either way, so a
 *  cached and an uncached run are indistinguishable to the consumer. */
export async function* byteChunks(
  url: string,
  pacer?: LinkPacer,
): AsyncGenerator<Uint8Array> {
  const hit = byteCache.get(url);
  if (hit) {
    for (let o = 0; o < hit.byteLength; o += REPLAY_CHUNK) {
      const c = hit.subarray(o, Math.min(o + REPLAY_CHUNK, hit.byteLength));
      await pacer?.admit(c.byteLength);
      yield c;
    }
    return;
  }
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    await pacer?.admit(buf.byteLength);
    yield buf;
    return;
  }
  const rd = resp.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    await pacer?.admit(value.byteLength);
    yield value;
  }
}

/** Fetch a URL, reporting cumulative progress DURING delivery (the progress bars
 *  are the whole point of this demo), paced by the simulated link. */
export async function streamFetch(
  url: string,
  onBytes?: (total: number) => void,
  pacer?: LinkPacer,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of byteChunks(url, pacer)) {
    parts.push(c);
    total += c.byteLength;
    onBytes?.(total);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return all;
}

/** Inflate a gzip stream with the native DecompressionStream (no bundled zlib). */
export async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const buf = await new Response(new Response(gz as BufferSource).body!.pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

// ── neural latent decode helpers (pure CPU, no DOM / no ort dependency) ──────
