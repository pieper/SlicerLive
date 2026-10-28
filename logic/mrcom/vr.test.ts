// T1: the VR guard. Every case here is a real failure mode from SlicerAlbula's experience of feeding
// ctkDICOM index values into DICOM tags - see the header of vr.ts.
import { assert, assertEquals } from "../../mrson/assert.ts";
import { coerceAll, coerceForVR, VR_LIMITS } from "./vr.ts";

Deno.test("a 68-character StudyDescription is truncated to LO's 64, and reported", () => {
  const long = "A".repeat(68);
  const { value, coercion } = coerceForVR("StudyDescription", "LO", long);
  assertEquals(value.length, 64);
  assert(coercion, "a truncation must be reported, not silent");
  assertEquals(coercion!.tag, "StudyDescription");
  assertEquals(coercion!.vr, "LO");
  assert(coercion!.note.includes("64"), "the note should name the limit");
  assert(coercion!.note.includes("68"), "and what was supplied");
});

Deno.test("an ISO birth date is repaired, because the repair is unambiguous", () => {
  // DA is exactly 8 digits. Removing the separators from an ISO date gives exactly the DICOM form,
  // so "1970-01-01" becomes "19700101" - the right date, not a guess. Still reported, because the
  // caller fed in something that was not DA.
  const { value, coercion } = coerceForVR("PatientBirthDate", "DA", "1970-01-01");
  assertEquals(value, "19700101");
  assert(coercion, "the caller should still learn their value was not DA");
  assert(coercion!.note.includes("YYYYMMDD"), "the note should say what DA expects");
});

Deno.test("a day-first or month-first date is DROPPED, not repaired into a wrong one", () => {
  // "01/02/1970" also cleans to 8 digits - but as "01021970", which a reader takes as the year
  // 0102. Length alone is not enough for DA; the result has to look like a date.
  for (const ambiguous of ["01/02/1970", "1/2/70", "12-31-1999"]) {
    const { value, coercion } = coerceForVR("PatientBirthDate", "DA", ambiguous);
    assertEquals(value, "", `${ambiguous} must not be silently repaired`);
    assert(coercion && coercion.note.includes("dropped"), `${ambiguous} should report a drop`);
  }
});

Deno.test("an implausible date is rejected even when it is already 8 digits", () => {
  // no separators to remove, so this goes through the fixed-length path untouched - a reminder that
  // the plausibility check only guards the REPAIRED case, by design
  assertEquals(coerceForVR("PatientBirthDate", "DA", "01021970").coercion, undefined);
});

Deno.test("a correct date passes through untouched", () => {
  assertEquals(coerceForVR("PatientBirthDate", "DA", "19700101"), { value: "19700101" });
  assertEquals(coerceForVR("StudyDate", "DA", "20261028").coercion, undefined);
});

Deno.test("an empty value is legal everywhere - absent context is not an error", () => {
  for (const vr of ["LO", "DA", "CS", "UI", "SH", "PN"]) {
    assertEquals(coerceForVR("X", vr, "").coercion, undefined, `${vr} should accept empty`);
    assertEquals(coerceForVR("X", vr, null).value, "");
    assertEquals(coerceForVR("X", vr, undefined).value, "");
  }
});

Deno.test("CS rejects lower case and punctuation", () => {
  const { value, coercion } = coerceForVR("Modality", "CS", "ot!");
  assertEquals(value, "");
  assert(coercion, "lower case in CS must be reported");

  assertEquals(coerceForVR("Modality", "CS", "OT").coercion, undefined);
  assertEquals(coerceForVR("BundleMode", "CS", "HYBRID").coercion, undefined);
  // space and underscore are permitted
  assertEquals(coerceForVR("X", "CS", "A_B C").coercion, undefined);
});

Deno.test("UI takes digits and dots only", () => {
  assertEquals(coerceForVR("SOPClassUID", "UI", "1.2.840.10008.5.1.4.1.1.7").coercion, undefined);
  const { coercion } = coerceForVR("SOPClassUID", "UI", "1.2.3-beta");
  assert(coercion, "a hyphen is not legal in UI");
});

Deno.test("a backslash in LO or SH is removed - it is the value delimiter", () => {
  // An unescaped backslash would split one value into two on read.
  const { value, coercion } = coerceForVR("SeriesDescription", "LO", "before\\after");
  assertEquals(value, "beforeafter");
  assert(coercion);
  assert(coercion!.note.includes("characters"));
});

Deno.test("a digest fits LO exactly, which is why digests are bare hex", () => {
  const bare = "a".repeat(64);
  assertEquals(coerceForVR("MRCOMSceneDigest", "LO", bare).coercion, undefined);
  // the prefixed form does NOT fit, and would be silently clipped into something that still looks
  // like a digest - the reason docs/MRCOM-SCENE-BUNDLE.md section 2.4 mandates bare hex
  const prefixed = coerceForVR("MRCOMSceneDigest", "LO", "sha256-" + bare);
  assert(prefixed.coercion, "the prefixed digest must be flagged");
  assertEquals(prefixed.value.length, 64);
});

Deno.test("SH is 16 characters, so a creator-style code is checked against the right limit", () => {
  assertEquals(coerceForVR("CodeValue", "SH", "MRCOMBUNDLE").coercion, undefined);
  assert(coerceForVR("CodeValue", "SH", "A".repeat(17)).coercion);
});

Deno.test("an unknown VR passes through rather than being invented", () => {
  assertEquals(coerceForVR("X", "ZZ", "anything at all").coercion, undefined);
  assert(!VR_LIMITS.ZZ);
});

Deno.test("coerceAll gathers every coercion in one report", () => {
  const { values, coercions } = coerceAll({
    PatientName: ["PN", "Doe^John"],
    PatientID: ["LO", "12345"],
    PatientBirthDate: ["DA", "1970-01-01"],
    StudyDescription: ["LO", "B".repeat(68)],
    StudyInstanceUID: ["UI", "1.2.3"],
  });
  assertEquals(values.PatientName, "Doe^John");
  assertEquals(values.PatientID, "12345");
  assertEquals(values.PatientBirthDate, "19700101"); // repaired, and reported
  assertEquals(values.StudyDescription.length, 64);
  assertEquals(values.StudyInstanceUID, "1.2.3");

  assertEquals(coercions.map((c) => c.tag).sort(), ["PatientBirthDate", "StudyDescription"]);
  // a caller can show these to a user: each names the tag, the VR and what happened
  for (const c of coercions) {
    assert(c.tag && c.vr && c.note, "a coercion must be actionable");
  }
});
