// T1: the format module is a typed VIEW of mrson/schema/mrcom.schema.json. These tests assert the
// view and the schema agree, so the TypeScript writer and the pydicom reader cannot drift apart.
import { assert, assertEquals } from "../../mrson/assert.ts";
import MRCOM_SCHEMA from "../../mrson/schema/mrcom.schema.json" with { type: "json" };
import {
  blobBaseSource,
  dicomSources,
  modeFromCS,
  modeToCS,
  MRCOM_BLOB_TAGS,
  MRCOM_CREATOR,
  MRCOM_FORMAT_VERSION,
  MRCOM_GROUP,
  MRCOM_TAGS,
  mrcomTimestamp,
  type MrcomManifest,
  requiredHashes,
  SC_FORBIDDEN,
  SC_SOP_CLASS_UID,
  SC_TRANSFER_SYNTAX_UID,
} from "./format.ts";

Deno.test("the private block identity matches the schema, and the group is legal", () => {
  assertEquals(MRCOM_GROUP, 0x4d43);
  assertEquals(MRCOM_CREATOR, "MRCOM.MRSON.1");
  assertEquals(MRCOM_FORMAT_VERSION, "1");
  // PS3.5 7.8.1: private data elements live in ODD groups. 0x4D52 ("MR") is even, hence 0x4D43.
  assertEquals(MRCOM_GROUP % 2, 1);
  // and it must sort before PixelData, so the manifest is reachable from a prefix read
  assert(MRCOM_GROUP < 0x7fe0, "the block must precede (7FE0,0010)");
  // it is NOT SlicerDataBundle's group - a reader has to be able to tell them apart
  assert(MRCOM_GROUP !== 0xcadb);
});

Deno.test("every schema element is exposed, with its offset inside the block", () => {
  for (const row of MRCOM_SCHEMA.privateBlock.elements) {
    if (row.name === "PrivateCreator") continue;
    const entry = MRCOM_TAGS[row.name];
    assert(entry, `${row.name} is in the schema but not in MRCOM_TAGS`);
    assertEquals(entry.vr, row.vr, `${row.name} VR`);
    assertEquals(entry.offset, parseInt(row.el, 16) & 0xff, `${row.name} offset`);
  }
  // and nothing extra was invented
  assertEquals(
    Object.keys(MRCOM_TAGS).sort(),
    MRCOM_SCHEMA.privateBlock.elements
      .filter((e) => e.name !== "PrivateCreator")
      .map((e) => e.name)
      .sort(),
  );
});

Deno.test("the blob item elements match too", () => {
  assertEquals(
    Object.keys(MRCOM_BLOB_TAGS).sort(),
    ["MRCOMBlobData", "MRCOMBlobEncoding", "MRCOMBlobHash", "MRCOMBlobLength"],
  );
  assertEquals(MRCOM_BLOB_TAGS.MRCOMBlobData.vr, "OB");
  assertEquals(MRCOM_BLOB_TAGS.MRCOMBlobLength.vr, "UL");
  assertEquals(MRCOM_BLOB_TAGS.MRCOMBlobHash.offset, 0x21);
});

Deno.test("the elements needed for detection and payload location are required", () => {
  for (const name of [
    "MRCOMBundleMode",
    "MRCOMBundleUID",
    "MRCOMFormatVersion",
    "MRCOMManifest",
    "MRCOMManifestDigest",
    "MRCOMDigestAlgorithm",
  ]) {
    assert(MRCOM_TAGS[name].required, `${name} should be required`);
  }
  // the scene itself is optional: a de-identifier may legitimately have stripped it
  assert(!MRCOM_TAGS.MRCOMScene.required, "a stripped bundle is still a bundle");
});

Deno.test("lengths are typed UL, digests are LO - the SlicerDataBundle lessons", () => {
  // SlicerDataBundle smuggled its payload size into the creator STRING because typed elements
  // "didn't survive the dump2dcm step". Here they are UL.
  assertEquals(MRCOM_TAGS.MRCOMSceneLength.vr, "UL");
  assertEquals(MRCOM_BLOB_TAGS.MRCOMBlobLength.vr, "UL");
  // digests are LO, which is why they are bare hex: "sha256-" + 64 hex is 71 > 64
  assertEquals(MRCOM_TAGS.MRCOMSceneDigest.vr, "LO");
  assertEquals(MRCOM_TAGS.MRCOMManifestDigest.vr, "LO");
  // the manifest is UT, which has no length limit, so it can stay uncompressed and readable
  assertEquals(MRCOM_TAGS.MRCOMManifest.vr, "UT");
});

Deno.test("the Secondary Capture contract comes from the schema", () => {
  assertEquals(SC_SOP_CLASS_UID, "1.2.840.10008.5.1.4.1.1.7");
  assertEquals(SC_TRANSFER_SYNTAX_UID, "1.2.840.10008.1.2.1");
  // a picture of a screen is not a registered slice
  for (const name of ["FrameOfReferenceUID", "ImagePositionPatient", "ImageOrientationPatient"]) {
    assert(SC_FORBIDDEN[name], `${name} must be listed as forbidden, with a reason`);
  }
});

Deno.test("modes round trip through their CS values", () => {
  for (const mode of ["embed", "reference", "hybrid"] as const) {
    assertEquals(modeFromCS(modeToCS(mode)), mode);
  }
  assertEquals(modeToCS("hybrid"), "HYBRID");
  // tolerate what a real file might carry
  assertEquals(modeFromCS(" hybrid "), "hybrid");
  assertEquals(modeFromCS("HYBRID"), "hybrid");
  assertEquals(modeFromCS("zip"), null);
  assertEquals(modeFromCS(undefined), null);
});

const manifest = (over: Partial<MrcomManifest> = {}): MrcomManifest => ({
  mrcom: 1,
  mode: "hybrid",
  scene: { length: 10, encoding: "deflate", digest: "a".repeat(64) },
  ...over,
});

Deno.test("manifest accessors pick the sources apart", () => {
  const m = manifest({
    bulk: {
      required: [{ hash: "sha256-" + "b".repeat(64), grid: "0.0.0" }, { hash: "sha256-" + "c".repeat(64) }],
      sources: [
        { kind: "dicom-series", instances: ["1.2.3.1"], seriesInstanceUID: "1.2.3", nodeId: "img1" },
        { kind: "blob-base", url: "https://example.invalid/blobs/" },
        { kind: "dicom-seg", instances: ["1.2.4.1"], seriesInstanceUID: "1.2.4" },
      ],
    },
  });
  assertEquals(requiredHashes(m), ["sha256-" + "b".repeat(64), "sha256-" + "c".repeat(64)]);
  assertEquals(dicomSources(m).map((s) => s.kind), ["dicom-series", "dicom-seg"]);
  assertEquals(blobBaseSource(m), "https://example.invalid/blobs/");

  const bare = manifest();
  assertEquals(requiredHashes(bare), []);
  assertEquals(dicomSources(bare), []);
  assertEquals(blobBaseSource(bare), null);
});

Deno.test("the timestamp is DICOM-ish and fixed width", () => {
  const stamp = mrcomTimestamp(new Date(2026, 0, 2, 3, 4, 5));
  assertEquals(stamp, "20260102T030405");
  assertEquals(mrcomTimestamp().length, 15);
});
