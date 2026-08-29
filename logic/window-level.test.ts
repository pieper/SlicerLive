// T1: window/level math — histogram percentiles, auto W/L, adjust gain, min/max round-trip.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { adjustWindowLevel, autoWindowLevel, histogramPercentiles, minMaxToWl, wlMinMax } from "./window-level.ts";

Deno.test("histogramPercentiles: uniform integer ramp -> near the ends", () => {
  const n = 100000, d = new Int16Array(n);
  for (let i = 0; i < n; i++) d[i] = i % 1001;                 // 0..1000 uniform
  const [lo, hi] = histogramPercentiles(d, 0.001, 0.999);
  assertAlmostEquals(lo, 1, 2); assertAlmostEquals(hi, 999, 2);
});

Deno.test("histogramPercentiles: constant volume -> [v,v]", () => {
  assertEquals(histogramPercentiles(new Int16Array(1000).fill(42)), [42, 42]);
});

Deno.test("autoWindowLevel: symmetric distribution -> level at the centre", () => {
  const n = 200000, d = new Int16Array(n);
  for (let i = 0; i < n; i++) d[i] = -500 + (i % 1001);        // -500..500
  const wl = autoWindowLevel(d);
  assertAlmostEquals(wl.level, 0, 2); assert(wl.window > 990 && wl.window < 1002);
});

Deno.test("adjustWindowLevel: Slicer's gain (range/min(vw,vh))", () => {
  const range: [number, number] = [-1000, 1000], vw = 512, vh = 256;   // gain = 2000/256 = 7.8125
  const r = adjustWindowLevel({ window: 400, level: 40 }, 40, 10, range, vw, vh);
  assertAlmostEquals(r.window, 400 + 7.8125 * 40, 1e-6);
  assertAlmostEquals(r.level, 40 + 7.8125 * 10, 1e-6);
  // window never goes negative
  assertEquals(adjustWindowLevel({ window: 10, level: 0 }, -1000, 0, range, vw, vh).window, 0);
});

Deno.test("wlMinMax round-trips", () => {
  const wl = { window: 400, level: 40 };
  const [lo, hi] = wlMinMax(wl);
  assertEquals(lo, -160); assertEquals(hi, 240);
  const back = minMaxToWl(lo, hi);
  assertAlmostEquals(back.window, 400, 1e-9); assertAlmostEquals(back.level, 40, 1e-9);
});
