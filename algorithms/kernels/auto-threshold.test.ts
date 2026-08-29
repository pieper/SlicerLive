// T1 unit (W5): auto-threshold calculators on synthetic distributions.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { autoThreshold, huang, isodata, otsu, triangle } from "./auto-threshold.ts";
import { histogram } from "./histogram.ts";

// bimodal: a cluster near 30 and a cluster near 170 (0..255), well separated
function bimodal(): Int32Array {
  const d: number[] = [];
  for (let i = 0; i < 5000; i++) d.push(30 + Math.round(4 * Math.sin(i)));   // ~[26,34]
  for (let i = 0; i < 5000; i++) d.push(170 + Math.round(4 * Math.cos(i)));  // ~[166,174]
  return Int32Array.from(d);
}
// a threshold that separates the two clusters: all lows <= t, all highs > t

Deno.test("otsu finds a threshold between the two modes of a bimodal distribution", () => {
  const t = autoThreshold("otsu", bimodal(), 256);
  assert(t > 32 && t < 168, `Otsu separates the clusters, got ${t}`);
});

Deno.test("isodata (Ridler-Calvard) lands in the valley too", () => {
  const t = autoThreshold("isodata", bimodal(), 256);
  assert(t > 32 && t < 168, `IsoData separates the clusters, got ${t}`);
});

Deno.test("triangle finds a threshold on the tail side of a single skewed peak", () => {
  // one tall peak near 20 with a long right tail
  const d: number[] = [];
  for (let i = 0; i < 8000; i++) d.push(20 + Math.round(4 * Math.sin(i)));
  for (let i = 0; i < 1500; i++) d.push(20 + (i % 200));   // long tail to ~220
  const t = autoThreshold("triangle", Int32Array.from(d), 256);
  assert(t > 20 && t < 230, `triangle threshold on the tail, got ${t}`);
});

Deno.test("huang returns a value inside the data range", () => {
  const h = histogram(bimodal(), { bins: 256 });
  const t = huang(h);
  assert(t >= h.min && t <= h.max, `huang in range, got ${t}`);
  assert(t > 32 && t < 168, `huang separates the clusters, got ${t}`);
});

Deno.test("constant data -> threshold at the single value", () => {
  const t = autoThreshold("otsu", Int32Array.from(new Array(1000).fill(42)), 128);
  assert(Math.abs(t - 42) < 5, `constant -> ~42, got ${t}`);
});

Deno.test("direct calculators agree with autoThreshold dispatch", () => {
  const h = histogram(bimodal(), { bins: 256 });
  assertEquals(otsu(h), autoThreshold("otsu", bimodal(), 256));
  assertEquals(isodata(h), autoThreshold("isodata", bimodal(), 256));
  assertEquals(triangle(h), autoThreshold("triangle", bimodal(), 256));
});
