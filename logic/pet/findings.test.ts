// T1: the longitudinal finding record — nadir, response against baseline AND nadir, total
// burden, and the edit-rate instrument the grant gates deployment on.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  assessFinding,
  changeBetween,
  editRate,
  type Finding,
  findingsAt,
  type LesionRecord,
  nadirRecord,
  newFinding,
  note,
  type StudyRef,
  totalBurden,
} from "./findings.ts";

const studies: StudyRef[] = [
  { studyInstanceUID: "s1", studyDate: "20240101", role: "baseline" },
  { studyInstanceUID: "s2", studyDate: "20240401", role: "prior" },
  { studyInstanceUID: "s3", studyDate: "20240701", role: "current" },
];

function rec(uid: string, peak: number, extra: Partial<LesionRecord> = {}): LesionRecord {
  return {
    studyInstanceUID: uid,
    studyDate: studies.find((s) => s.studyInstanceUID === uid)?.studyDate ?? null,
    suvMax: peak * 1.2,
    suvMean: peak * 0.6,
    suvPeak: peak,
    mtvMl: 10,
    tlg: 10 * peak * 0.6,
    voxels: 160,
    thresholdId: "eanm41",
    thresholdUsed: peak * 0.41,
    measuredAt: "2024-07-01T10:00:00Z",
    ...extra,
  };
}

function finding(records: LesionRecord[], init: Partial<Finding> = {}): Finding {
  const f = newFinding({ label: "right external iliac lymph node", ...init });
  for (const r of records) f.records[r.studyInstanceUID] = r;
  return f;
}

Deno.test("a new finding records its own creation, so the history is never empty", () => {
  const f = newFinding({ label: "node", source: "ai" });
  assertEquals(f.history.length, 1);
  assertEquals(f.history[0].action, "created");
  assertEquals(f.history[0].detail, "ai");
  assert(f.id.length > 1);
  // Lymph node is the default: this app is a lymph-node quantification reader.
  assertEquals(f.isLymphNode, true);
  assertEquals(f.petStatus, null);
});

Deno.test("two findings made in the same millisecond still get different ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newFinding({ label: "n" }).id));
  assertEquals(ids.size, 50);
});

Deno.test("the nadir is the lowest value reached, not the earliest or the previous", () => {
  const f = finding([rec("s1", 10), rec("s2", 4), rec("s3", 9)]);
  assertEquals(nadirRecord(f, studies)?.studyInstanceUID, "s2");
});

Deno.test("the nadir only looks at studies up to the one being read", () => {
  const f = finding([rec("s1", 10), rec("s2", 8), rec("s3", 2)]);
  // Reading s2, the later and lower s3 must not count as its nadir.
  assertEquals(nadirRecord(f, studies, "s2")?.studyInstanceUID, "s2");
  assertEquals(nadirRecord(f, studies, "s3")?.studyInstanceUID, "s3");
});

Deno.test("a finding with no measurements has no nadir", () => {
  assertEquals(nadirRecord(finding([]), studies), null);
});

Deno.test("SUVmax stands in when SUVpeak is missing, and says so", () => {
  const f = finding([rec("s1", 10), rec("s3", 5, { suvPeak: null })]);
  const a = assessFinding(f, studies, "s3", "s1");
  assert(a.degradedToMax);
  assert(a.notes.some((n) => n.includes("SUVpeak unavailable")));
  // 5 * 1.2 = 6 as SUVmax, against a peak of 10.
  assertAlmostEquals(a.vsBaseline!.fraction!, (6 - 10) / 10, 1e-12);
});

Deno.test("PERCIST needs BOTH a 30% relative and a 0.8-unit absolute change", () => {
  // 40% fall but only 0.4 units: relative yes, absolute no.
  const small = changeBetween(rec("s3", 0.6), rec("s1", 1.0));
  assertAlmostEquals(small.fraction!, -0.4, 1e-12);
  assertEquals(small.percistThreshold, false);
  // 40% fall of 5.0 units: both.
  const big = changeBetween(rec("s3", 3.0), rec("s1", 5.0));
  assertEquals(big.percistThreshold, true);
});

Deno.test("QIBA test-retest limits decide whether a change is real at all", () => {
  // -20% is within PET's own repeatability, so it is not distinguishable from noise.
  assertEquals(changeBetween(rec("s3", 8), rec("s1", 10)).significant, false);
  // -40% clears the -28% limit.
  assertEquals(changeBetween(rec("s3", 6), rec("s1", 10)).significant, true);
  // +39% is the increase limit.
  assertEquals(changeBetween(rec("s3", 14), rec("s1", 10)).significant, true);
  assertEquals(changeBetween(rec("s3", 13), rec("s1", 10)).significant, false);
});

Deno.test("a lesion that responded then regrew is stable vs baseline but progressing vs nadir", () => {
  // THE reason nadir is a required comparator rather than a convenience.
  const f = finding([rec("s1", 10), rec("s2", 3), rec("s3", 9.5)]);
  const a = assessFinding(f, studies, "s3", "s1");
  assertAlmostEquals(a.vsBaseline!.fraction!, -0.05, 1e-12);
  assertEquals(a.vsBaseline!.significant, false);          // looks stable
  assertAlmostEquals(a.vsNadir!.fraction!, (9.5 - 3) / 3, 1e-12);
  assertEquals(a.vsNadir!.significant, true);              // is actually progressing
  assertEquals(a.nadir!.studyInstanceUID, "s2");
});

Deno.test("a threshold changed between timepoints is flagged, because EANM forbids it", () => {
  const f = finding([rec("s1", 10, { thresholdId: "eanm41" }), rec("s3", 5, { thresholdId: "fixed40" })]);
  const a = assessFinding(f, studies, "s3", "s1");
  assert(a.notes.some((n) => n.includes("EANM requires one method")));
});

Deno.test("a manual alignment shift is recorded with the assessment", () => {
  const f = finding([rec("s1", 10), rec("s3", 5, { rowOffsetMm: -12 })]);
  assert(assessFinding(f, studies, "s3", "s1").notes.some((n) => n.includes("-12 mm alignment")));
});

Deno.test("a zero reference yields a null fraction rather than Infinity", () => {
  const c = changeBetween(rec("s3", 4), rec("s1", 0));
  assertEquals(c.fraction, null);
  assertEquals(c.significant, false);
  assertEquals(c.absolute, 4);
});

Deno.test("assessing a study the finding was never measured on returns nulls, not throws", () => {
  const a = assessFinding(finding([rec("s1", 10)]), studies, "s3", "s1");
  assertEquals(a.current, null);
  assertEquals(a.vsBaseline, null);
});

Deno.test("baseline defaults to the first study when none is named", () => {
  const f = finding([rec("s1", 10), rec("s3", 5)]);
  assertEquals(assessFinding(f, studies, "s3").baseline?.studyInstanceUID, "s1");
});

Deno.test("total burden sums across findings at one study", () => {
  const a = finding([rec("s3", 10, { mtvMl: 12, tlg: 60, suvMax: 11 })], { label: "a" });
  const b = finding([rec("s3", 4, { mtvMl: 8, tlg: 20, suvMax: 5 })], { label: "b" });
  const t = totalBurden([a, b], "s3");
  assertEquals(t.lesionCount, 2);
  assertAlmostEquals(t.tmtvMl, 20, 1e-12);
  assertAlmostEquals(t.totalTlg, 80, 1e-12);
  assertEquals(t.suvMaxOverall, 11);
});

Deno.test("a dismissed finding is excluded from burden -- that is what dismissing means", () => {
  const a = finding([rec("s3", 10, { mtvMl: 12, tlg: 60 })], { label: "a" });
  const b = finding([rec("s3", 4, { mtvMl: 8, tlg: 20 })], { label: "b", dismissed: true });
  const t = totalBurden([a, b], "s3");
  assertEquals(t.lesionCount, 1);
  assertAlmostEquals(t.tmtvMl, 12, 1e-12);
  assertEquals(findingsAt([a, b], "s3").map((f) => f.label), ["a"]);
});

Deno.test("burden on a study nothing was measured on is zero, with a null maximum", () => {
  const t = totalBurden([finding([rec("s1", 10)])], "s3");
  assertEquals(t, { lesionCount: 0, tmtvMl: 0, totalTlg: 0, suvMaxOverall: null });
});

Deno.test("edit rate counts candidates, not reader-created findings", () => {
  const accepted = note(finding([], { label: "a", source: "ai" }), "accepted");
  const corrected = note(note(finding([], { label: "b", source: "ai" }), "accepted"), "edited", "brush");
  const thrownOut = finding([], { label: "c", source: "ai", dismissed: true });
  const mine = finding([], { label: "d", source: "reader" });
  const r = editRate([accepted, corrected, thrownOut, mine]);
  assertEquals(r.candidates, 3);
  assertEquals(r.accepted, 2);
  assertEquals(r.dismissed, 1);
  assertEquals(r.edited, 1);
  assertEquals(r.readerAdded, 1);
  assertAlmostEquals(r.rate!, 1 / 3, 1e-12);
});

Deno.test("a relabel counts as an edit", () => {
  const f = note(note(finding([], { source: "ai", label: "x" }), "accepted"), "relabelled", "left iliac");
  assertEquals(editRate([f]).edited, 1);
});

Deno.test("edit rate is null with no candidates, not a misleading zero", () => {
  assertEquals(editRate([finding([], { source: "reader", label: "d" })]).rate, null);
  assertEquals(editRate([]).rate, null);
});

Deno.test("the whole report round-trips through JSON", () => {
  const f = note(finding([rec("s1", 10), rec("s3", 4)], { source: "ai", station: "right external iliac" }), "accepted");
  const back = JSON.parse(JSON.stringify({ patientId: "P1", studies, findings: [f] }));
  assertEquals(back.findings[0].records.s3.suvPeak, 4);
  assertEquals(back.findings[0].station, "right external iliac");
  const a = assessFinding(back.findings[0], back.studies, "s3", "s1");
  assertAlmostEquals(a.vsBaseline!.fraction!, -0.6, 1e-12);
});
