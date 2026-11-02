// T1: SUV scale factors — parity against @cornerstonejs/calculate-suv's published vendor fixtures,
// against a measured IDC series, and the QIBA guard conditions.
//
// The 8 fixtures in ./fixtures are the naturalized per-instance metadata from calculate-suv's
// test suite (MIT, Precision Imaging Metrics), with the expected suvbw factors from
// test/calculateSUV_SampleData.test.ts. They cover the cases that actually break implementations:
// Philips CNTS with both private factors, AcquisitionDateTime earlier than SeriesDateTime, and a
// missing RadiopharmaceuticalStartDateTime.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  bodySurfaceArea,
  calculateScanTimes,
  calculateStartTime,
  coerceFactor,
  leanBodyMassJames,
  leanBodyMassJanmahasatian,
  parseDA,
  parseDT,
  parseTM,
  type PetInstanceMeta,
  petDisplayUnits,
  seriesSuvFactor,
  suvScalingFactors,
} from "./suv.ts";

const here = new URL(".", import.meta.url).pathname;
const load = (name: string): PetInstanceMeta[] =>
  JSON.parse(Deno.readTextFileSync(`${here}fixtures/${name}-instances.json`));

// From calculate-suv test/calculateSUV_SampleData.test.ts (tolerance there is < 1e-6).
const EXPECTED_SUVBW: Record<string, number> = {
  "SIEMENS": 0.00042748316187197236,
  "GE_MEDICAL_AND_BQML": 0.0005367387681819742,
  "PHILIPS_BQML": 0.0007463747013889488,
  "PHILIPS_CNTS_AND_BQML_SUV": 0.000551,
  "PHILIPS_CNTS_AND_SUV": 0.000728,
  "BQML_AC_DT_lessThan_S_DT_SIEMENS": 0.0004069156854009332,
  "CPS_AND_BQML_AC_DT_-_S_DT": 0.00026503312764157046,
  "RADIOPHARM_DATETIME_UNDEFINED": 0.0003721089202818729,
};

for (const [name, expected] of Object.entries(EXPECTED_SUVBW)) {
  Deno.test(`suvScalingFactors: calculate-suv fixture ${name}`, () => {
    const instances = load(name);
    const results = suvScalingFactors(instances);
    assertEquals(results.length, instances.length);
    for (const r of results) {
      assert(r.ok, `expected a factor, got: ${r.ok ? "" : r.reason}`);
      assertAlmostEquals(r.suvbw, expected, 1e-9, `${name} suvbw`);
    }
  });
}

Deno.test("PHILIPS_BQML: the Philips private group is present but must be IGNORED for BQML", () => {
  const instances = load("PHILIPS_BQML");
  assert(instances[0].PhilipsPETPrivateGroup, "fixture should carry the private group");
  const r = seriesSuvFactor(instances);
  assert(r.ok);
  // If (7053,1000) had been used the answer would be that factor, not the weight/dose one.
  assertAlmostEquals(r.suvbw, EXPECTED_SUVBW["PHILIPS_BQML"], 1e-9);
});

Deno.test("PHILIPS_CNTS_AND_BQML_SUV: (7053,1000) wins over (7053,1009)", () => {
  const r = seriesSuvFactor(load("PHILIPS_CNTS_AND_BQML_SUV"));
  assert(r.ok);
  assertAlmostEquals(r.suvbw, 0.000551, 1e-9);
});

// --- the measured ACRIN series (see the plan's "Verified SUV reference vector") -----------------
// ACRIN-NSCLC-FDG-PET-131, baseline 1960-01-08, PET WB (AC), crdc 30e8b31d-…, 186 instances.
// Computed independently with Slicer 5.x's pydicom from the downloaded DICOM.
const ACRIN: PetInstanceMeta = {
  CorrectedImage: ["RAN", "DTIM", "NORM", "ATTN", "SCAT", "DECY"],
  Units: "BQML",
  DecayCorrection: "START",
  RadionuclideHalfLife: 6586.2,
  RadionuclideTotalDose: 662299987.79297,
  PatientWeight: 66.738,
  SeriesDate: "19600108",
  SeriesTime: "142947.140000",
  AcquisitionDate: "19600108",
  AcquisitionTime: "143905.671000",
  RadiopharmaceuticalStartTime: "134547.000000",
  PatientSex: "F",
};

Deno.test("ACRIN-NSCLC-FDG-PET-131 baseline AC: SUVbw scale matches the measured value", () => {
  const r = seriesSuvFactor([ACRIN]);
  assert(r.ok, r.ok ? "" : r.reason);
  assertAlmostEquals(r.suvbw, 1.330421135985e-04, 1e-15);
  // SUVbw max reported by the reference computation over the full volume.
  const maxBqml = 848881.25;
  assertAlmostEquals(r.suvbw * maxBqml, 112.936951, 1e-5);
});

Deno.test("ACRIN: SeriesTime precedes AcquisitionTime, so QIBA uses SeriesTime", () => {
  const scans = calculateScanTimes([ACRIN])!;
  const start = calculateStartTime(ACRIN)!;
  assertAlmostEquals(scans[0] - start, 2640.14, 1e-6);   // 44.002 min
});

Deno.test("ACRIN NAC series (PROPCPS) is not SUV-convertible and is not labelled SUV", () => {
  const nac: PetInstanceMeta = {
    ...ACRIN,
    Units: "PROPCPS",
    CorrectedImage: ["RAN", "DTIM", "NORM", "DECY"],   // no ATTN
  };
  const r = seriesSuvFactor([nac]);
  assert(!r.ok);
  assert(r.reason.includes("attenuation"), r.reason);
  const d = petDisplayUnits([nac]);
  assertEquals(d.quantitative, false);
  assert(d.label !== "SUV/W");
});

// --- guards -------------------------------------------------------------------------------------

Deno.test("DecayCorrection ADMIN is refused by default (QIBA), allowed when opted out", () => {
  const admin = { ...ACRIN, DecayCorrection: "ADMIN" };
  assert(!seriesSuvFactor([admin]).ok);
  assert(seriesSuvFactor([admin], { requireDecayCorrectionStart: false }).ok);
});

Deno.test("missing PatientWeight fails loudly rather than returning a number", () => {
  const r = seriesSuvFactor([{ ...ACRIN, PatientWeight: undefined }]);
  assert(!r.ok);
  assert(r.reason.includes("PatientWeight"), r.reason);
});

Deno.test("negative decay time is reported, not turned into a >1 scale factor", () => {
  const r = seriesSuvFactor([{ ...ACRIN, RadiopharmaceuticalStartTime: "235900.000000" }]);
  assert(!r.ok);
  assert(r.reason.includes("negative"), r.reason);
});

Deno.test("coerceFactor rejects a truthy-but-non-numeric bulkdata reference", () => {
  assertEquals(coerceFactor({ BulkDataURI: "http://example/x" }), null);
  assertEquals(coerceFactor("0.000728"), 0.000728);
  assertEquals(coerceFactor(0), null);
  assertEquals(coerceFactor(0.000551), 0.000551);
});

Deno.test("CNTS with an unusable private factor fails rather than guessing", () => {
  const r = seriesSuvFactor([{
    ...ACRIN,
    Units: "CNTS",
    PhilipsPETPrivateGroup: { SUVScaleFactor: { BulkDataURI: "http://x" } },
  }]);
  assert(!r.ok);
  assert(r.reason.includes("CNTS"), r.reason);
});

Deno.test("GML means SUVbw already, unless SUV Type says otherwise", () => {
  const gml = { ...ACRIN, Units: "GML" };
  const r = seriesSuvFactor([gml]);
  assert(r.ok);
  assertEquals(r.suvbw, 1);
  assert(!seriesSuvFactor([{ ...gml, SUVType: "LBM" }]).ok);
});

// --- DA/TM/DT parsing ---------------------------------------------------------------------------

Deno.test("parseDA / parseTM / parseDT", () => {
  assertEquals(parseDA("20201217"), { year: 2020, month: 12, day: 17 });
  assertEquals(parseDA("2020121"), null);
  assertEquals(parseTM("104829.000000"), { hours: 10, minutes: 48, seconds: 29 });
  assertEquals(parseTM("134551"), { hours: 13, minutes: 45, seconds: 51 });
  assertEquals(parseTM("13"), { hours: 13, minutes: 0, seconds: 0 });
  assertEquals(parseTM("xx"), null);
  // trailing space, as in the SIEMENS fixture
  assert(parseDT("20201217083045.000000 ") !== null);
  assertEquals(parseDT("20201217083045") , parseDT("20201217083045.000000 "));
});

// --- body habitus -------------------------------------------------------------------------------

Deno.test("Janmahasatian LBM matches calculate-suv's published vectors (75 kg, 1.85 m)", () => {
  assertAlmostEquals(leanBodyMassJanmahasatian(75, 1.85, "M")!, 60915.335886519744, 1e-6);
  assertAlmostEquals(leanBodyMassJanmahasatian(75, 1.85, "F")!, 49214.37996837613, 1e-6);
});

Deno.test("Du Bois BSA matches calculate-suv's published vector", () => {
  assertAlmostEquals(bodySurfaceArea(75, 1.85)!, 19813.758427117766, 1e-6);
});

Deno.test("James male uses the published 128, deliberately differing from calculate-suv's 120", () => {
  // calculate-suv reports 62777.57487216947 using coefficient 120.
  const ours = leanBodyMassJames(75, 1.85, "M")!;
  const theirs = 62777.57487216947;
  const delta = 8 * Math.pow(75 / 185, 2) * 1000;      // (128-120) * (W/H)^2, in grams
  assertAlmostEquals(ours, theirs - delta, 1e-6);
  // Female coefficient is 148 in both.
  assertAlmostEquals(leanBodyMassJames(75, 1.85, "F")!, 55925.67567567568, 1e-6);
});
