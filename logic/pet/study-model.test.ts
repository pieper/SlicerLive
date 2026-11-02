// T1: PET/CT timepoint grouping — AC/NAC roles, duplicate-study collapse, CT-only prior rejection.
// Built from the real shape of ACRIN-NSCLC-FDG-PET-131, which has all three messes at once.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { SeriesRow } from "../idc/sql.ts";
import { comparatorsFor, groupTimepoints } from "./study-model.ts";

let uid = 0;
function series(p: Partial<SeriesRow> & { Modality: string; StudyInstanceUID: string }): SeriesRow {
  return {
    SeriesInstanceUID: `1.2.${++uid}`,
    crdc_series_uuid: `uuid-${uid}`,
    aws_bucket: "idc-open-data-two",
    instanceCount: 1,
    SeriesNumber: 1,
    SeriesDescription: null,
    PatientID: "ACRIN-NSCLC-FDG-PET-131",
    collection_id: "acrin_nsclc_fdg_pet",
    license_short_name: "CC BY 3.0",
    source_DOI: null,
    StudyDate: null,
    Units: null,
    DecayCorrection: null,
    CorrectedImage: null,
    geometry: null,
    ...p,
  } as SeriesRow;
}

const AC = ["RAN", "DTIM", "NORM", "ATTN", "SCAT", "DECY"];
const NAC = ["RAN", "DTIM", "NORM", "DECY"];

/** One PET/CT study: CT 297, AC 186 (BQML), NAC 371 (PROPCPS), plus optional SEGs. */
function petCtStudy(study: string, date: string, segs: string[] = []): SeriesRow[] {
  return [
    series({ StudyInstanceUID: study, StudyDate: date, Modality: "CT", SeriesNumber: 3, instanceCount: 297, SeriesDescription: "CT WB  5.0  B31f" }),
    series({ StudyInstanceUID: study, StudyDate: date, Modality: "PT", SeriesNumber: 4, instanceCount: 186, SeriesDescription: "PET WB", Units: "BQML", CorrectedImage: AC }),
    series({ StudyInstanceUID: study, StudyDate: date, Modality: "PT", SeriesNumber: 5, instanceCount: 371, SeriesDescription: "PET WB Uncorrected", Units: "PROPCPS", CorrectedImage: NAC }),
    ...segs.map((d) => series({ StudyInstanceUID: study, StudyDate: date, Modality: "SEG", SeriesNumber: 300, SeriesDescription: d })),
  ];
}

Deno.test("roles: AC and NAC are separated by CorrectedImage, not by description", () => {
  const [tp] = groupTimepoints(petCtStudy("S1", "19600108"));
  assertEquals(tp.ct?.instanceCount, 297);
  assertEquals(tp.ac?.instanceCount, 186);
  assertEquals(tp.ac?.Units, "BQML");
  assertEquals(tp.nac?.instanceCount, 371);
  assertEquals(tp.nac?.Units, "PROPCPS");
});

Deno.test("CT-only studies are not PET/CT timepoints", () => {
  const rows = [
    ...petCtStudy("S1", "19600108"),
    series({ StudyInstanceUID: "CTONLY", StudyDate: "19600511", Modality: "CT", instanceCount: 144, SeriesDescription: "ThoraxRoutine 5.0 B40s" }),
    ...petCtStudy("S2", "19600608"),
  ];
  const tps = groupTimepoints(rows);
  assertEquals(tps.length, 2);
  assertEquals(tps.map((t) => t.studyDate), ["19600108", "19600608"]);
});

Deno.test("CT-only studies ARE kept when requirePet is off", () => {
  const rows = [
    ...petCtStudy("S1", "19600108"),
    series({ StudyInstanceUID: "CTONLY", StudyDate: "19600511", Modality: "CT", instanceCount: 144 }),
  ];
  assertEquals(groupTimepoints(rows, { requirePet: false }).length, 2);
});

Deno.test("duplicate studies collapse, and the one with more segmentations wins", () => {
  // The real ACRIN case: two StudyInstanceUIDs on 1960-06-08 with identical imaging, but only one
  // carries the radiologist-corrected segmentation.
  const rows = [
    ...petCtStudy("S1", "19600108", ["AIMI lung and FDG tumor AI segmentation"]),
    ...petCtStudy("DUP_A", "19600608", ["AIMI lung and FDG tumor AI segmentation"]),
    ...petCtStudy("DUP_B", "19600608", [
      "AIMI lung and FDG tumor AI segmentation",
      "AIMI lung and FDG tumor radiologist 1 corrected segmentation",
    ]),
  ];
  const tps = groupTimepoints(rows);
  assertEquals(tps.length, 2, "the 1960-06-08 duplicate must collapse to one timepoint");
  const followUp = tps[1];
  assertEquals(followUp.studyInstanceUID, "DUP_B");
  assertEquals(followUp.segs.length, 2);
});

Deno.test("two genuinely different studies on one date are NOT collapsed", () => {
  // Same day, different acquisitions: the slice counts differ, so the signature differs.
  const rows = [
    ...petCtStudy("A", "19600608"),
    ...petCtStudy("B", "19600608").map((s) =>
      s.Modality === "CT" ? { ...s, instanceCount: 144 } : s
    ),
  ];
  assertEquals(groupTimepoints(rows).length, 2);
});

Deno.test("pickBest prefers a reconstructable volume over a topogram", () => {
  const rows = [
    series({ StudyInstanceUID: "S", StudyDate: "19600108", Modality: "CT", SeriesNumber: 1, instanceCount: 1, SeriesDescription: "Topogram" }),
    series({ StudyInstanceUID: "S", StudyDate: "19600108", Modality: "CT", SeriesNumber: 3, instanceCount: 297, SeriesDescription: "CT WB", geometry: { origin: [0, 0, 0], iop: [1, 0, 0, 0, 1, 0], spacing: 2.5, dims: [512, 512, 297], ijkToRAS: [] } }),
    series({ StudyInstanceUID: "S", StudyDate: "19600108", Modality: "PT", SeriesNumber: 4, instanceCount: 186, Units: "BQML", CorrectedImage: AC }),
  ];
  const [tp] = groupTimepoints(rows);
  assertEquals(tp.ct?.SeriesDescription, "CT WB");
  assertEquals(tp.others.length, 1, "the topogram stays available, just not as the reading CT");
});

Deno.test("timepoints are chronological: baseline first, current last", () => {
  const tps = groupTimepoints([
    ...petCtStudy("LATE", "19600608"),
    ...petCtStudy("EARLY", "19600108"),
  ]);
  assertEquals(tps.map((t) => t.studyDate), ["19600108", "19600608"]);
  const c = comparatorsFor(tps)!;
  assertEquals(c.baseline, 0);
  assertEquals(c.prior, 0);
  assertEquals(c.current, 1);
});

Deno.test("comparators with a single timepoint have no baseline or prior", () => {
  const c = comparatorsFor(groupTimepoints(petCtStudy("S", "19600108")))!;
  assertEquals(c, { baseline: null, prior: null, current: 0 });
  assertEquals(comparatorsFor([]), null);
});

Deno.test("a PET-only study (no CT) still forms a timepoint", () => {
  const rows = [series({ StudyInstanceUID: "P", StudyDate: "19600108", Modality: "PT", instanceCount: 186, Units: "BQML", CorrectedImage: AC })];
  const [tp] = groupTimepoints(rows);
  assert(tp.ac);
  assertEquals(tp.ct, null);
});
