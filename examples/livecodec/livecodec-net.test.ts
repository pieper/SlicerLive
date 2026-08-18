/** Delivery-layer tests. The race's correctness lives here and is invisible in a
 *  screenshot: whether a cached replay hands the decoders exactly the bytes the
 *  network would have, and whether the simulated link actually paces them.
 *
 *    deno test --allow-net examples/livecodec/livecodec-net.test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  byteChunks, cacheClear, cacheHas, cacheSize, LinkPacer, prefetch,
  setSimulatedBandwidth, streamFetch,
} from "./livecodec-net.ts";

const BUCKET = "https://js2.jetstream-cloud.org:8001/livecodec-demo/";
const URL_SMALL = BUCKET + "versions/prior2/13b2886c6cafa1e8/coarse.gz";

async function drain(url: string, pacer?: LinkPacer): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of byteChunks(url, pacer)) { parts.push(c); n += c.byteLength; }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return all;
}

Deno.test("cached replay delivers byte-identical content", async () => {
  cacheClear();
  setSimulatedBandwidth(null);
  const live = await drain(URL_SMALL);              // straight from the network
  assert(live.byteLength > 1000, "expected a real payload");
  assert(!cacheHas(URL_SMALL), "byteChunks must not populate the cache implicitly");

  await prefetch(URL_SMALL);
  assert(cacheHas(URL_SMALL));
  const replay = await drain(URL_SMALL);            // now from memory
  assertEquals(replay.byteLength, live.byteLength);
  assertEquals(replay, live, "replayed bytes differ from the network bytes");
});

Deno.test("streamFetch reports monotonic cumulative progress, cached and not", async () => {
  for (const cached of [false, true]) {
    cacheClear();
    setSimulatedBandwidth(null);
    if (cached) await prefetch(URL_SMALL);
    const seen: number[] = [];
    const buf = await streamFetch(URL_SMALL, (t) => seen.push(t));
    assert(seen.length > 0, "no progress callbacks");
    for (let i = 1; i < seen.length; i++) {
      assert(seen[i] >= seen[i - 1], "progress went backwards");
    }
    assertEquals(seen[seen.length - 1], buf.byteLength, "final progress != total");
  }
});

Deno.test("the simulated link paces a cached replay", async () => {
  cacheClear();
  await prefetch(URL_SMALL);
  const bytes = cacheSize();
  const bps = 2_000_000;                            // 2 Mbps
  setSimulatedBandwidth(bps);
  const t0 = performance.now();
  await drain(URL_SMALL, new LinkPacer());
  const secs = (performance.now() - t0) / 1000;
  const expected = bytes * 8 / bps;
  setSimulatedBandwidth(null);
  // The pacer admits bytes no earlier than their scheduled arrival, so replay
  // must take at least the link time; timer slop only ever adds.
  assert(secs >= expected * 0.9,
    `replay finished in ${secs.toFixed(2)}s, faster than the ${expected.toFixed(2)}s link`);
  assert(secs < expected * 3, `replay took ${secs.toFixed(2)}s for a ${expected.toFixed(2)}s link`);
});

Deno.test("an unthrottled link does not pace", async () => {
  cacheClear();
  await prefetch(URL_SMALL);
  setSimulatedBandwidth(null);
  const t0 = performance.now();
  await drain(URL_SMALL, new LinkPacer());
  assert(performance.now() - t0 < 250, "unthrottled replay should be immediate");
});
