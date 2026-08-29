// T1 unit (W5): segment-editor effects on labelmap arrays (masking, threshold, islands, smoothing, margin).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyIslands, applyLogical, applyMargin, applySmoothing, applyThreshold, segmentMask, segmentStatistics } from "./segment-effects.ts";

const dims: [number, number, number] = [8, 8, 3];
const idx = (i: number, j: number, k: number) => k * 64 + j * 8 + i;
const count = (m: { length: number; [i: number]: number }, id: number) => { let n = 0; for (let p = 0; p < m.length; p++) if (m[p] === id) n++; return n; };

Deno.test("threshold sets the segment where source is in range (overwrite=none keeps other segments)", () => {
  const n = 8 * 8 * 3;
  const src = new Float32Array(n); for (let i = 0; i < n; i++) src[i] = i % 100;   // 0..99 ramp
  const lm = new Uint8Array(n); lm[0] = 2;                                          // an existing segment 2 at voxel 0 (source 0)
  const out = applyThreshold(lm, src, dims, { segment: 1, lower: 50, upper: 80, overwrite: "none" });
  // voxels with source in [50,80] become segment 1 (except where segment 2 already is, and it's out of range anyway)
  for (let i = 0; i < n; i++) { const v = src[i]; if (v >= 50 && v <= 80 && lm[i] === 0) assertEquals(out[i], 1); }
  assertEquals(out[0], 2, "existing segment untouched (out of range + overwrite none)");
});

Deno.test("islands: keepLargest keeps the big blob only", () => {
  const lm = new Uint8Array(8 * 8 * 3);
  for (let k = 0; k < 3; k++) for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) lm[idx(i, j, k)] = 1;  // 3x3x3 = 27
  lm[idx(6, 6, 1)] = 1;                                                                                        // stray voxel
  const out = applyIslands(lm, dims, { segment: 1, operation: "keepLargest" });
  assertEquals(count(out, 1), 27, "only the big island remains");
  assertEquals(out[idx(6, 6, 1)], 0, "stray removed");
});

Deno.test("islands: removeSmall drops islands below minSize", () => {
  const lm = new Uint8Array(8 * 8 * 3);
  lm[idx(0, 0, 0)] = 1; lm[idx(0, 1, 0)] = 1;                     // size-2 island
  lm[idx(5, 5, 1)] = 1;                                           // size-1 island
  const out = applyIslands(lm, dims, { segment: 1, operation: "removeSmall", minSize: 2 });
  assertEquals(count(out, 1), 2, "size-1 island removed, size-2 kept");
});

Deno.test("margin grow adds a shell; shrink removes one", () => {
  const lm = new Uint8Array(8 * 8 * 3);
  for (let k = 0; k < 3; k++) for (let j = 2; j <= 5; j++) for (let i = 2; i <= 5; i++) lm[idx(i, j, k)] = 1;
  const before = count(lm, 1);
  const grown = applyMargin(lm, dims, { segment: 1, marginMm: 1, spacingMm: [1, 1, 1] });
  assert(count(grown, 1) > before, "grow adds voxels");
  const shrunk = applyMargin(lm, dims, { segment: 1, marginMm: -1, spacingMm: [1, 1, 1] });
  assert(count(shrunk, 1) < before, "shrink removes voxels");
});

Deno.test("smoothing median removes an isolated speck of the active segment", () => {
  const lm = new Uint8Array(8 * 8 * 3); lm[idx(4, 4, 1)] = 1;
  const out = applySmoothing(lm, dims, { segment: 1, method: "median", radiusVoxels: 1 });
  assertEquals(out[idx(4, 4, 1)], 0, "speck smoothed away");
});

Deno.test("segmentMask extracts the active segment as 1/0", () => {
  const lm = Uint8Array.from([0, 1, 2, 1, 0]);
  assertEquals(Array.from(segmentMask(lm, 1)), [0, 1, 0, 1, 0]);
});

Deno.test("logical operators between two segments", () => {
  // segment 1 = {0,1,2}, segment 2 = {2,3}
  const lm = Uint8Array.from([1, 1, 1, 2, 2, 0]);   // voxels 0-2 seg1, 3-4 seg2... adjust: [1,1,1,2,2,0]
  // put overlap: make voxel 2 shared is impossible in a labelmap; use disjoint. seg1={0,1}, seg2={2,3}
  const m = Uint8Array.from([1, 1, 2, 2, 0, 0]);
  // union of seg1 with seg2 -> voxels 0,1,2,3 become seg1
  const u = applyLogical(m, [6, 1, 1], { segment: 1, operation: "union", other: 2 });
  assertEquals(Array.from(u), [1, 1, 1, 1, 0, 0]);
  // subtract seg2 from seg1 (disjoint) leaves seg1 unchanged
  const sub = applyLogical(m, [6, 1, 1], { segment: 1, operation: "subtract", other: 2 });
  assertEquals(sub[0], 1); assertEquals(sub[2], 2);
  // invert seg1 within the volume
  const inv = applyLogical(m, [6, 1, 1], { segment: 1, operation: "invert" });
  assertEquals(inv[0], 0); assertEquals(inv[4], 1);
});

Deno.test("segmentStatistics: voxel count, volume, bounds", () => {
  const dims: [number, number, number] = [4, 4, 1];
  const lm = new Uint8Array(16);
  lm[0] = 1; lm[1] = 1; lm[5] = 1;   // 3 voxels of segment 1
  const [s] = segmentStatistics(lm, dims, [1], [2, 2, 3]);
  assertEquals(s.voxels, 3);
  assertEquals(s.volumeMm3, 3 * 2 * 2 * 3);   // 36
  assertEquals(s.boundsIjk, [0, 1, 0, 1, 0, 0]);
});
