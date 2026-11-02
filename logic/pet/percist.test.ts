// T1: PERCIST measurability and response, Deauville reference levels, QIBA repeatability.
// Each case is built from the wording of the source, so a failure says which rule moved.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  assessPercist,
  deauvilleAid,
  isRealChange,
  liverComparable,
  measurabilityGate,
  percistTlgThreshold,
  referencePlausibility,
  QIBA_DECREASE,
  QIBA_INCREASE,
  type ReferenceRegion,
} from "./percist.ts";

const liver: ReferenceRegion = { mean: 2.0, stdDev: 0.3, volumeMl: 14.1 };
const bloodPool: ReferenceRegion = { mean: 1.6, stdDev: 0.2, volumeMl: 0.5 };

// --- measurability --------------------------------------------------------------------------

Deno.test("measurability: 1.5 x liver mean + 2 SD", () => {
  const g = measurabilityGate(liver, bloodPool)!;
  assertEquals(g.basis, "liver");
  assertAlmostEquals(g.threshold, 1.5 * 2.0 + 2 * 0.3, 1e-9);   // 3.6
});

Deno.test("measurability: a diseased liver falls back to 2.0 x blood pool + 2 SD", () => {
  const g = measurabilityGate(liver, bloodPool, true)!;
  assertEquals(g.basis, "bloodPool");
  assertAlmostEquals(g.threshold, 2.0 * 1.6 + 2 * 0.2, 1e-9);   // 3.6
});

Deno.test("measurability: no references means no gate, not a guessed one", () => {
  assertEquals(measurabilityGate(null, null), null);
  assertEquals(measurabilityGate(null, null, true), null);
  // Liver abnormal with no blood pool placed: still nothing to stand on.
  assertEquals(measurabilityGate(liver, null, true), null);
});

Deno.test("PERCIST TLG floor is liver mean + 3 SD, with 2 SD offered", () => {
  assertAlmostEquals(percistTlgThreshold(liver), 2.0 + 3 * 0.3, 1e-9);
  assertAlmostEquals(percistTlgThreshold(liver, 2), 2.0 + 2 * 0.3, 1e-9);
});

// --- response -------------------------------------------------------------------------------

Deno.test("PMR needs BOTH 30% and 0.8 absolute", () => {
  // 10 -> 6: -40% and -4.0 absolute. Both satisfied.
  const r = assessPercist({ current: 6, baseline: 10 });
  assertEquals(r.category, "PMR");
  assertAlmostEquals(r.percentChange, -40, 1e-9);
});

Deno.test("a 30% drop that is less than 0.8 SUL absolute is NOT a response", () => {
  // 2.0 -> 1.4: -30%, but only -0.6 absolute. PERCIST requires both.
  const r = assessPercist({ current: 1.4, baseline: 2.0 });
  assertEquals(r.category, "SMD");
  assert(r.reasons[0].includes("0.8"), `the reason should name the absolute rule: ${r.reasons[0]}`);
});

Deno.test("a 0.8 absolute drop that is less than 30% is NOT a response", () => {
  // 10 -> 9.1: -0.9 absolute but only -9%.
  const r = assessPercist({ current: 9.1, baseline: 10 });
  assertEquals(r.category, "SMD");
});

Deno.test("PMD needs both rules too, and is judged FROM THE NADIR", () => {
  // Baseline 10, nadir 3, now 4.5. Against baseline that is a 55% DROP; against the nadir it is a
  // 50% rise with +1.5 absolute, which is progression. "Progression is judged from best response."
  const r = assessPercist({ current: 4.5, baseline: 10, nadir: 3 });
  assertEquals(r.category, "PMD");
  assertEquals(r.comparedWith, "nadir");
  assertAlmostEquals(r.percentChange, 50, 1e-9);
});

Deno.test("a lesion still falling stays measured against baseline", () => {
  const r = assessPercist({ current: 5, baseline: 10, nadir: 5 });
  assertEquals(r.comparedWith, "baseline");
  assertEquals(r.category, "PMR");
});

Deno.test("CMR requires uptake below mean liver", () => {
  const r = assessPercist({ current: 1.5, baseline: 10, liver });
  assertEquals(r.category, "CMR");
  assert(r.reasons[0].includes("below mean liver"));
  // Just above liver is not CMR, however large the drop.
  assertEquals(assessPercist({ current: 2.4, baseline: 10, liver }).category, "PMR");
});

Deno.test("new lesions are progression regardless of the numbers", () => {
  const r = assessPercist({ current: 1.0, baseline: 10, liver, newLesions: true });
  assertEquals(r.category, "PMD");
  assert(r.reasons[0].includes("new FDG-avid"));
});

Deno.test("TLG growth above 75% with no SUL decline is progression", () => {
  const r = assessPercist({ current: 10.2, baseline: 10, tlgPercentChange: 90 });
  assertEquals(r.category, "PMD");
  assert(r.reasons[0].includes("TLG"));
  // The same TLG growth WITH a falling SUL is not.
  assertEquals(assessPercist({ current: 6, baseline: 10, tlgPercentChange: 90 }).category, "PMR");
});

// --- QIBA repeatability -----------------------------------------------------------------------

Deno.test("QIBA: +39% / -28% is the floor for a real change", () => {
  assertEquals(isRealChange(0.40), true);
  assertEquals(isRealChange(QIBA_INCREASE), true);
  assertEquals(isRealChange(0.35), false);
  assertEquals(isRealChange(-0.30), true);
  assertEquals(isRealChange(QIBA_DECREASE), true);
  assertEquals(isRealChange(-0.20), false);
});

Deno.test("a PERCIST response can still be inside the measurement noise, and says so", () => {
  // -32% with a 1.0 absolute drop is PMR by PERCIST, but -32% does not clear QIBA's -28%... it
  // does. Use -29%, which is PMR-qualifying only if absolute clears too.
  const r = assessPercist({ current: 6.8, baseline: 10 });      // -32%, -3.2 absolute
  assertEquals(r.category, "PMR");
  assertEquals(r.withinMeasurementNoise, false);
  // A 20% drop is neither PERCIST response nor a QIBA-real change.
  const q = assessPercist({ current: 8, baseline: 10 });
  assertEquals(q.category, "SMD");
  assertEquals(q.withinMeasurementNoise, true);
});

// --- Deauville --------------------------------------------------------------------------------

Deno.test("Deauville bands follow the Lugano wording", () => {
  const med = 1.6, liv = 2.5;
  assertEquals(deauvilleAid(0.3, med, liv).suggested, 1);     // no uptake above background
  assertEquals(deauvilleAid(1.4, med, liv).suggested, 2);     // <= mediastinum
  assertEquals(deauvilleAid(2.1, med, liv).suggested, 3);     // > mediastinum, <= liver
  assertEquals(deauvilleAid(3.5, med, liv).suggested, 4);     // moderately > liver
  assertEquals(deauvilleAid(9.0, med, liv).suggested, 5);     // markedly > liver
});

Deno.test("Deauville boundaries are inclusive the way the wording reads", () => {
  const med = 1.6, liv = 2.5;
  assertEquals(deauvilleAid(med, med, liv).suggested, 2, "'uptake <= mediastinum' includes equality");
  assertEquals(deauvilleAid(liv, med, liv).suggested, 3, "'<= liver' includes equality");
  // The 4/5 boundary is a convention, not a quoted number — it is exposed as a parameter.
  assertEquals(deauvilleAid(5.0, med, liv, { markedlyFactor: 2.0 }).suggested, 5);
  assertEquals(deauvilleAid(5.0, med, liv, { markedlyFactor: 3.0 }).suggested, 4);
});

Deno.test("Deauville never returns a band without both references, and always carries the caveat", () => {
  const only = deauvilleAid(3.0, null, 2.5);
  assertEquals(only.suggested, null, "no mediastinal ROI means no band");
  assert(only.relation.includes("mediastinal"), "it should say what is missing");
  const none = deauvilleAid(3.0, null, null);
  assertEquals(none.suggested, null);
  for (const a of [only, none, deauvilleAid(3.0, 1.6, 2.5)]) {
    assert(a.caveat.includes("VISUAL"), "the visual-scale caveat is always present");
    assert(a.caveat.includes("Waldeyer"), "and names the carve-outs Cheson gives");
  }
});

// --- comparability ------------------------------------------------------------------------------

Deno.test("PERCIST's liver stability check flags incomparable studies", () => {
  const a: ReferenceRegion = { mean: 2.0, stdDev: 0.3, volumeMl: 14 };
  assertEquals(liverComparable(a, { mean: 2.2, stdDev: 0.3, volumeMl: 14 }).ok, true);
  const bad = liverComparable(a, { mean: 2.6, stdDev: 0.3, volumeMl: 14 });
  assertEquals(bad.ok, false);
  assertAlmostEquals(bad.delta, 0.6, 1e-9);
  assert(bad.note.includes("may not be comparable"));
});

// --- reference plausibility ---------------------------------------------------------------------

Deno.test("a reference outside the plausible range is flagged, not silently used", () => {
  // The failure that motivated this: a liver sphere dropped outside the patient reads ~0.19, and
  // 1.5 x 0.19 + 2 x 0.10 = 0.49 — a gate under which essentially every lesion is "measurable".
  const air: ReferenceRegion = { mean: 0.19, stdDev: 0.10, volumeMl: 14 };
  const p = referencePlausibility("liver", air);
  assertEquals(p.ok, false);
  assert(p.note.includes("outside the patient") || p.note.includes("below the plausible"));

  const gate = measurabilityGate(air, null)!;
  assertAlmostEquals(gate.threshold, 0.485, 1e-9);
  assertEquals(gate.trustworthy, false, "the gate must declare itself untrustworthy");
});

Deno.test("a reference on a lesion is flagged too — PERCIST assumes a NORMAL liver", () => {
  const hot: ReferenceRegion = { mean: 7.0, stdDev: 1.0, volumeMl: 14 };
  const p = referencePlausibility("liver", hot);
  assertEquals(p.ok, false);
  assert(p.note.includes("NORMAL"));
  assertEquals(measurabilityGate(hot, null)!.trustworthy, false);
});

Deno.test("a normal liver and blood pool pass, and the gate is trustworthy", () => {
  assertEquals(referencePlausibility("liver", liver).ok, true);
  assertEquals(referencePlausibility("bloodPool", bloodPool).ok, true);
  assertEquals(measurabilityGate(liver, bloodPool)!.trustworthy, true);
  assertEquals(measurabilityGate(liver, bloodPool, true)!.trustworthy, true);
});
