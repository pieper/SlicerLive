// T1: PET quantitative indices — MTV, TLG, thresholds and SUVpeak.
//
// The constructions are analytic where possible, so a failure says which arithmetic is wrong
// rather than "the number moved".
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  boxMask,
  measureLesion,
  peakKernel,
  PEAK_SPHERE_RADIUS_MM,
  regionStats,
  resolveThreshold,
  sphereMask,
  suvPeak,
  thresholdConnected,
  totalLesionGlycolysis,
  type Volume3D,
} from "./indices.ts";

const makeVol = (d: number, spacing: [number, number, number], fill: (i: number, j: number, k: number) => number): Volume3D => {
  const data = new Float32Array(d * d * d);
  for (let k = 0; k < d; k++) for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) data[(k * d + j) * d + i] = fill(i, j, k);
  return { data, dims: [d, d, d], spacing };
};

Deno.test("regionStats: known values over a uniform box", () => {
  const vol = makeVol(10, [2, 2, 2], () => 3);
  const mask = boxMask([10, 10, 10], [2, 2, 2], [4, 4, 4]);   // 3x3x3 = 27 voxels
  const s = regionStats(vol, mask)!;
  assertEquals(s.count, 27);
  assertAlmostEquals(s.mean, 3, 1e-9);
  assertAlmostEquals(s.min, 3, 1e-9);
  assertAlmostEquals(s.max, 3, 1e-9);
  assertAlmostEquals(s.stdDev, 0, 1e-9);
  // 27 voxels x 8 mm^3 = 216 mm^3 = 0.216 mL
  assertAlmostEquals(s.volumeMl, 0.216, 1e-9);
});

Deno.test("regionStats: mean, median and both standard deviations on a ramp", () => {
  // Values 0..9 along i, one voxel thick in j/k -> a known 10-sample set.
  const vol = makeVol(10, [1, 1, 1], (i) => i);
  const mask = boxMask([10, 10, 10], [0, 5, 5], [9, 5, 5]);
  const s = regionStats(vol, mask)!;
  assertEquals(s.count, 10);
  assertAlmostEquals(s.mean, 4.5, 1e-9);
  assertAlmostEquals(s.median, 4.5, 1e-9);
  assertAlmostEquals(s.sum, 45, 1e-9);
  // population variance of 0..9 is 8.25; sample variance is 9.1666…
  assertAlmostEquals(s.stdDevPopulation, Math.sqrt(8.25), 1e-6);
  assertAlmostEquals(s.stdDev, Math.sqrt(9.1666666667), 1e-6);
  assertEquals(s.argMax, [9, 5, 5]);
});

Deno.test("TLG is MTV x SUVmean, as EANM defines it", () => {
  const vol = makeVol(8, [1, 1, 10], () => 2.5);      // 10 mm^3 per voxel
  const mask = boxMask([8, 8, 8], [0, 0, 0], [3, 3, 3]);   // 64 voxels -> 640 mm^3 = 0.64 mL
  const s = regionStats(vol, mask)!;
  assertAlmostEquals(s.volumeMl, 0.64, 1e-9);
  assertAlmostEquals(totalLesionGlycolysis(s), 0.64 * 2.5, 1e-9);
});

Deno.test("resolveThreshold: EANM VOI41/VOI50 and background subtraction", () => {
  assertAlmostEquals(resolveThreshold({ kind: "percentMax", fraction: 0.41 }, 10), 4.1, 1e-9);
  assertAlmostEquals(resolveThreshold({ kind: "percentMax", fraction: 0.5 }, 10), 5, 1e-9);
  assertAlmostEquals(resolveThreshold({ kind: "absolute", value: 4 }, 10), 4, 1e-9);
  // (10 - 2) * 0.41 + 2 = 5.28 — materially different from 4.1 at low tumour-to-background.
  assertAlmostEquals(resolveThreshold({ kind: "percentMax", fraction: 0.41, backgroundSubtract: 2 }, 10), 5.28, 1e-9);
});

Deno.test("thresholdConnected keeps only the component containing the seed", () => {
  // Two separate hot blobs clearing the same level; only the seeded one may survive.
  const d = 20;
  const vol = makeVol(d, [1, 1, 1], (i, j, k) => {
    const a = i >= 2 && i <= 4 && j >= 2 && j <= 4 && k >= 2 && k <= 4;
    const b = i >= 14 && i <= 16 && j >= 14 && j <= 16 && k >= 14 && k <= 16;
    return a || b ? 10 : 0;
  });
  const whole = boxMask([d, d, d], [0, 0, 0], [d - 1, d - 1, d - 1]);
  const m = thresholdConnected(vol, whole, 5, [3, 3, 3]);
  assertEquals(regionStats(vol, m)!.count, 27, "only the seeded 3x3x3 blob");
});

Deno.test("thresholdConnected returns empty when the seed is below threshold", () => {
  const vol = makeVol(8, [1, 1, 1], () => 1);
  const whole = boxMask([8, 8, 8], [0, 0, 0], [7, 7, 7]);
  assertEquals(regionStats(vol, thresholdConnected(vol, whole, 5, [4, 4, 4])), null);
});

// --- SUVpeak ------------------------------------------------------------------------------------

Deno.test("peak sphere radius is the 1.0 mL radius PERCIST and PET-IndiC use", () => {
  assertAlmostEquals(PEAK_SPHERE_RADIUS_MM, 6.2035, 1e-3);
  assertAlmostEquals(2 * PEAK_SPHERE_RADIUS_MM, 12.407, 1e-2);   // ~1.2 cm diameter
});

Deno.test("peakKernel weights integrate to the sphere's volume in voxels", () => {
  const spacing: [number, number, number] = [2, 2, 2];
  const k = peakKernel(spacing);
  const voxelMm3 = 8;
  // Σw x voxel volume should recover 1000 mm^3 (1 mL) to within the supersampling error.
  assertAlmostEquals(k.weightSum * voxelMm3, 1000, 15);
  assert(k.weights.every((w) => w > 0 && w <= 1), "weights are volume fractions");
});

Deno.test("peakKernel partial weighting matters at coarse PET sampling", () => {
  // At 4 mm sampling a binary ball badly mis-sizes a 1 mL sphere; partial weights do not.
  const spacing: [number, number, number] = [4, 4, 4];
  const k = peakKernel(spacing);
  const exact = k.weightSum * 64;
  const binary = k.weights.filter((w) => w >= 0.5).length * 64;
  assertAlmostEquals(exact, 1000, 40, "partial-volume weighting recovers 1 mL");
  assert(Math.abs(binary - 1000) > 100, `a binary ball should be well off 1 mL, got ${binary}`);
});

Deno.test("suvPeak on a uniform region equals that uniform value", () => {
  const vol = makeVol(24, [2, 2, 2], () => 7);
  const mask = boxMask([24, 24, 24], [6, 6, 6], [17, 17, 17]);
  const r = suvPeak(vol, mask)!;
  assertAlmostEquals(r.peak, 7, 1e-6);
});

Deno.test("suvPeak is NOT simply the maximum voxel — it averages over 1 mL", () => {
  // A single hot voxel in a cold field: SUVmax is 100, but a 1 mL sphere mean is far lower.
  const vol = makeVol(24, [2, 2, 2], (i, j, k) => (i === 12 && j === 12 && k === 12 ? 100 : 0));
  const mask = boxMask([24, 24, 24], [6, 6, 6], [17, 17, 17]);
  const stats = regionStats(vol, mask)!;
  const r = suvPeak(vol, mask)!;
  assertEquals(stats.max, 100);
  assert(r.peak < 20, `a single hot voxel must be diluted by the sphere, got ${r.peak}`);
  assert(r.peak > 0);
});

Deno.test("suvPeak finds the plateau, not the spike — the placement is maximised", () => {
  // A broad warm plateau (value 10, 7x7x7) plus one isolated spike (value 60). The spike has the
  // higher SUVmax, but the 1 mL sphere mean is higher over the plateau, and EANM asks for the
  // position that maximises the average. cornerstone's top-10-hottest-voxel search would only
  // ever test centres on the spike.
  const d = 32;
  const vol = makeVol(d, [2, 2, 2], (i, j, k) => {
    const plateau = Math.abs(i - 10) <= 3 && Math.abs(j - 10) <= 3 && Math.abs(k - 10) <= 3;
    const spike = i === 24 && j === 24 && k === 24;
    return spike ? 60 : plateau ? 10 : 0;
  });
  const mask = boxMask([d, d, d], [0, 0, 0], [d - 1, d - 1, d - 1]);
  const r = suvPeak(vol, mask)!;
  assertAlmostEquals(r.peak, 10, 0.5, "the plateau mean wins");
  const [ci, cj, ck] = r.center;
  assert(Math.abs(ci - 10) <= 3 && Math.abs(cj - 10) <= 3 && Math.abs(ck - 10) <= 3,
    `peak should sit on the plateau, got ${r.center}`);
});

Deno.test("suvPeak interiorOnly refuses a lesion smaller than the sphere", () => {
  // PET-IndiC's behaviour: with the whole kernel required inside the mask, a 1-voxel lesion has
  // no valid placement at all.
  const vol = makeVol(24, [2, 2, 2], () => 5);
  const tiny = boxMask([24, 24, 24], [12, 12, 12], [12, 12, 12]);
  assertEquals(suvPeak(vol, tiny, { interiorOnly: true }), null);
  assert(suvPeak(vol, tiny, { interiorOnly: false }) !== null, "PERCIST reading still measures it");
});

// --- end to end ----------------------------------------------------------------------------------

Deno.test("measureLesion: 41% isocontour over a two-level lesion", () => {
  // Core of 10 (5x5x5) inside a halo of 3 (9x9x9). 41% of 10 = 4.1, so only the core survives.
  const d = 24;
  const vol = makeVol(d, [2, 2, 2], (i, j, k) => {
    const core = Math.abs(i - 12) <= 2 && Math.abs(j - 12) <= 2 && Math.abs(k - 12) <= 2;
    const halo = Math.abs(i - 12) <= 4 && Math.abs(j - 12) <= 4 && Math.abs(k - 12) <= 4;
    return core ? 10 : halo ? 3 : 0;
  });
  const roi = boxMask([d, d, d], [6, 6, 6], [18, 18, 18]);
  const m = measureLesion(vol, roi, [12, 12, 12], { kind: "percentMax", fraction: 0.41 })!;
  assertAlmostEquals(m.thresholdUsed!, 4.1, 1e-9);
  assertEquals(m.stats.count, 125, "the 5x5x5 core only");
  assertAlmostEquals(m.stats.mean, 10, 1e-9);
  assertAlmostEquals(m.mtvMl, (125 * 8) / 1000, 1e-9);
  assertAlmostEquals(m.tlg, m.mtvMl * 10, 1e-9);
  assertEquals(m.method, "41% of max");
});

Deno.test("measureLesion: a percentage and an absolute threshold genuinely disagree", () => {
  // Core 10 (5x5x5) inside a halo of 4.2 (9x9x9).
  //   41% of max = 4.1  -> the halo clears it, so VOI41 takes core + halo = 729 voxels
  //   fixed SUV 4.5     -> the halo does not clear it, so only the core = 125 voxels
  // This is why EANM insists the SAME VOI method is used across every timepoint in a patient:
  // switching convention mid-series changes MTV by a factor of nearly six on the same lesion.
  const d = 24;
  const vol = makeVol(d, [2, 2, 2], (i, j, k) => {
    const core = Math.abs(i - 12) <= 2 && Math.abs(j - 12) <= 2 && Math.abs(k - 12) <= 2;
    const halo = Math.abs(i - 12) <= 4 && Math.abs(j - 12) <= 4 && Math.abs(k - 12) <= 4;
    return core ? 10 : halo ? 4.2 : 0;
  });
  const roi = boxMask([d, d, d], [6, 6, 6], [18, 18, 18]);
  const pct = measureLesion(vol, roi, [12, 12, 12], { kind: "percentMax", fraction: 0.41 })!;
  const abs = measureLesion(vol, roi, [12, 12, 12], { kind: "absolute", value: 4.5 })!;
  assertAlmostEquals(pct.thresholdUsed!, 4.1, 1e-9);
  assertEquals(pct.stats.count, 729, "VOI41 takes core + halo");
  assertEquals(abs.stats.count, 125, "SUV>=4.5 takes the core only");
  assert(pct.mtvMl > abs.mtvMl * 5, "the two conventions disagree by nearly 6x here");
  assertEquals(abs.method, "fixed 4.5");
});

Deno.test("sphereMask builds PERCIST's reference regions at the right volume", () => {
  const dims: [number, number, number] = [60, 60, 60];
  const spacing: [number, number, number] = [2, 2, 2];
  // 3 cm diameter liver sphere = radius 15 mm, volume 14.14 mL
  const liver = sphereMask(dims, spacing, [30, 30, 30], 15);
  const vol = makeVol(60, spacing, () => 1);
  const s = regionStats(vol, liver)!;
  assertAlmostEquals(s.volumeMl, (4 / 3) * Math.PI * Math.pow(1.5, 3), 0.5);
  // 1 cm diameter aortic ROI = radius 5 mm
  const aorta = sphereMask(dims, spacing, [30, 30, 30], 5);
  assert(regionStats(vol, aorta)!.count < s.count);
});
