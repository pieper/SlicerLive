// T1 unit (W3): CPU histogram + stats kernel.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { dataRange, histogram, imageStats, percentileFromCounts } from "./histogram.ts";

Deno.test("histogram: uniform ramp fills bins evenly", () => {
  const n = 1000, data = Float32Array.from({ length: n }, (_, i) => i);   // 0..999
  const h = histogram(data, { bins: 10 });
  assertEquals(h.bins, 10); assertEquals(h.min, 0); assertEquals(h.max, 999);
  let total = 0; for (const c of h.counts) total += c;
  assertEquals(total, n, "every sample counted");
  for (const c of h.counts) assert(Math.abs(c - 100) <= 1, `~100 per bin, got ${c}`);
});

Deno.test("histogram: constant data piles into one bin", () => {
  const data = new Float32Array(500).fill(42);
  const h = histogram(data, { bins: 8, range: [0, 100] });
  let total = 0; for (const c of h.counts) total += c;
  assertEquals(total, 500);
  const nonzero = [...h.counts].filter((c) => c > 0);
  assertEquals(nonzero.length, 1, "all in one bin");
});

Deno.test("histogram: values clamp into the first/last bin", () => {
  const data = Float32Array.from([-10, -10, 5, 200, 200]);
  const h = histogram(data, { bins: 4, range: [0, 100] });   // binWidth 25
  assertEquals(h.counts[0], 3, "-10,-10,5 -> bin 0");
  assertEquals(h.counts[3], 2, "200,200 -> last bin");
});

Deno.test("imageStats: mean/stdev/min/max on a known set", () => {
  const data = Float32Array.from([2, 4, 4, 4, 5, 5, 7, 9]);   // mean 5, stdev 2
  const s = imageStats(data);
  assertEquals([s.min, s.max, s.count], [2, 9, 8]);
  assertAlmostEquals(s.mean, 5, 1e-9);
  assertAlmostEquals(s.stdev, 2, 1e-9);
});

Deno.test("percentileFromCounts: median of a ramp ~ midpoint", () => {
  const data = Float32Array.from({ length: 1000 }, (_, i) => i);
  const h = histogram(data, { bins: 100 });
  assertAlmostEquals(percentileFromCounts(h, 0.5), 500, 10);
  assert(percentileFromCounts(h, 0.001) < 50, "low percentile near the bottom");
  assert(percentileFromCounts(h, 0.999) > 950, "high percentile near the top");
});

Deno.test("dataRange: single pass min/max", () => {
  assertEquals(dataRange(Float32Array.from([3, -1, 7, 2])), [-1, 7]);
  assertEquals(dataRange(new Float32Array(0)), [0, 0]);
});
