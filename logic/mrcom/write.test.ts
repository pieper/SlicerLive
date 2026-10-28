// T1: the MRCOM bundle writer.
//
// Verified with RAW dcmjs rather than logic/mrcom/read.ts, deliberately: a writer checked only by
// its own reader can be self-consistently wrong. These assertions go through the same path a
// stranger's DICOM tool would.
import { assert, assertEquals } from "../../mrson/assert.ts";
import dcmjs from "../../render/vendor/dcmjs/dcmjs.es.js";
import { setDcmjs } from "./dcmjs.ts";
import type { MrsonNode } from "../../render/mrson.ts";
import { inflateBytes, sha256Bytes, sha256Name, utf8Decode, utf8Encode } from "../bytes.ts";
import { makeDicomSeries } from "../readers/synthetic-dicom.ts";
import { MRCOM_CREATOR, MRCOM_GROUP, type MrcomManifest } from "./format.ts";
import { writeMrcomBundle } from "./write.ts";

setDcmjs(dcmjs as never);
const { DicomMessage, DicomMetaDictionary, findPrivateBlock } = dcmjs.data;

const h = (c: string) => "sha256-" + c.repeat(64);

/**
 * A scene with one authored blob and one that came from DICOM.
 *
 * The blob hashes are the REAL content hashes, not placeholders, so the STORED guarantee - that an
 * embedded blob's bytes are byte-identical to what a blob store would serve, and therefore still
 * hash to their name - can actually be asserted.
 */
async function scene(): Promise<{ nodes: Record<string, MrsonNode>; blobs: Map<string, Uint8Array> }> {
  const authored = utf8Encode("painted segmentation voxels");
  const fromDicom = utf8Encode("reconstructed CT chunk");
  const authoredHash = await sha256Name(authored);
  const dicomHash = await sha256Name(fromDicom);
  const nodes: Record<string, MrsonNode> = {
    img1: {
      id: "img1",
      type: "image",
      name: "CT",
      dims: [4, 3, 5],
      ijkToRAS: [-0.5, 0, 0, 10, 0, -0.8, 0, 20, 0, 0, 2, 5, 0, 0, 0, 1],
      zarr: {
        shape: [5, 3, 4],
        chunks: [5, 3, 4],
        chunkGrid: [1, 1, 1],
        dtype: "<i2",
        chunkHashes: { "0.0.0": dicomHash },
      },
      dicom: {
        kind: "dicom-series",
        seriesInstanceUID: "1.2.3",
        instances: ["1.2.3.1", "1.2.3.2"],
        recon: { reader: "mrcom/dicom-series/1", dims: [4, 3, 5], voxelDigest: "e".repeat(64) },
        retrieve: [{ scheme: "s3", bucket: "idc-open-data", prefix: "p/" }],
      },
    } as never,
    seg1: {
      id: "seg1",
      type: "segmentation",
      name: "Seg",
      dims: [4, 3, 5],
      segments: [{ labelValue: 1, name: "S1" }],
      blobs: { labelmap: authoredHash },
    } as never,
  };
  return {
    nodes,
    blobs: new Map([[dicomHash, fromDicom], [authoredHash, authored]]),
  };
}

/** The two fixture hashes, for assertions. */
const DICOM_HASH = () => sha256Name(utf8Encode("reconstructed CT chunk"));
const AUTHORED_HASH = () => sha256Name(utf8Encode("painted segmentation voxels"));

const blobsOf = (map: Map<string, Uint8Array>) => (hash: string) =>
  Promise.resolve(map.get(hash) ?? null);

/** Read a bundle back the way a stranger would: parse, find the block by creator. */
function reopen(bytes: Uint8Array) {
  const read = DicomMessage.readFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const block = findPrivateBlock(read.dict, MRCOM_GROUP, MRCOM_CREATOR);
  assert(block, "the private block must be findable by creator");
  const manifest = JSON.parse(String(block!.get(0x04)!.Value[0])) as MrcomManifest;
  return { read, block: block!, manifest };
}

const reference = {
  dataset: {
    PatientName: "Doe^John",
    PatientID: "12345",
    PatientBirthDate: "19700101",
    StudyInstanceUID: "1.2.3.4",
    StudyID: "S1",
    StudyDate: "20261028",
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    SOPInstanceUID: "1.2.3.4.5",
  } as Record<string, unknown>,
  referencedSeries: [
    { seriesInstanceUID: "1.2.3", sopClassUID: "1.2.840.10008.5.1.4.1.1.2", instances: ["1.2.3.1", "1.2.3.2"] },
    { seriesInstanceUID: "1.2.4", sopClassUID: "1.2.840.10008.5.1.4.1.1.66.4", instances: ["1.2.4.1"] },
  ],
};

Deno.test("embed mode carries every reachable blob, and the scene round trips", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), mode: "embed", reference });

  assertEquals(written.mode, "embed");
  assertEquals(written.embeddedBlobs, 2);
  assertEquals(written.referencedHashes, []);
  assertEquals(written.missingBlobs, []);

  const { block, manifest } = reopen(written.bytes);
  assertEquals(manifest.mode, "embed");
  assertEquals(manifest.bulk!.embedded!.count, 2);
  assertEquals(manifest.bulk!.required, undefined);

  // the scene inflates and its digest verifies
  const length = Number(block.get(0x12)!.Value[0]);
  const stored = new Uint8Array(block.get(0x10)!.Value[0] as ArrayBuffer).slice(0, length);
  const sceneBytes = await inflateBytes(stored);
  assertEquals(await sha256Bytes(sceneBytes), manifest.scene.digest);

  const doc = JSON.parse(utf8Decode(sceneBytes));
  assertEquals(doc.mrson, 0);
  assertEquals(Object.keys(doc.nodes).sort(), ["img1", "seg1"]);
  assertEquals(doc.nodes.img1.dicom.instances, ["1.2.3.1", "1.2.3.2"]);
});

Deno.test("hybrid references DICOM-sourced bulk and embeds the rest", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), reference });

  // "auto" is the default and resolves to hybrid: the CT chunk is referenced, the painted
  // segmentation travels, because it exists nowhere else.
  assertEquals(written.mode, "hybrid");
  assertEquals(written.referencedHashes, [await DICOM_HASH()]);
  assertEquals(written.embeddedBlobs, 1);

  const { manifest } = reopen(written.bytes);
  assertEquals(manifest.bulk!.required!.map((r) => r.hash), [await DICOM_HASH()]);
  assertEquals(manifest.bulk!.required![0].nodes, ["img1"]);
  assertEquals(manifest.bulk!.required![0].grid, "0.0.0");
  assertEquals(manifest.bulk!.embedded!.count, 1);
  // the source descriptor is carried so a resolver knows what to fetch
  const sources = manifest.bulk!.sources!;
  assertEquals(sources.length, 1);
  assertEquals((sources[0] as { kind: string }).kind, "dicom-series");
});

Deno.test("reference mode embeds nothing at all", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: blobsOf(blobs),
    mode: "reference",
    reference,
  });
  assertEquals(written.embeddedBlobs, 0);
  assertEquals(written.referencedHashes.sort(), [await DICOM_HASH(), await AUTHORED_HASH()].sort());

  const { block, manifest } = reopen(written.bytes);
  assertEquals(manifest.bulk!.embedded!.count, 0);
  assertEquals(manifest.bulk!.required!.length, 2);
  assertEquals(block.has(0x20), false, "no blob sequence in reference mode");

  // and it is much smaller than embedding - the whole point
  const embedded = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), mode: "embed", reference });
  assert(
    written.bytes.byteLength < embedded.bytes.byteLength,
    "reference mode must be smaller than embed mode",
  );
});

Deno.test("a hash reached by BOTH an authored and a DICOM node travels", async () => {
  // If one node has bytes from a file and another painted the same bytes, referencing them would
  // lose the authored one. Shared bulk is only referenceable if EVERY owner has a DICOM origin.
  const shared = h("c");
  const nodes: Record<string, MrsonNode> = {
    img1: {
      id: "img1",
      type: "image",
      zarr: { shape: [1, 1, 1], chunks: [1, 1, 1], chunkGrid: [1, 1, 1], dtype: "|u1", chunkHashes: { "0.0.0": shared } },
      dicom: { kind: "dicom-series", instances: ["1.2.3.1"] },
    } as never,
    mesh1: { id: "mesh1", type: "mesh", points: shared } as never,
  };
  const written = await writeMrcomBundle({
    nodes,
    blobs: () => Promise.resolve(utf8Encode("shared")),
    reference,
  });
  assertEquals(written.referencedHashes, []);
  assertEquals(written.embeddedBlobs, 1);
});

Deno.test("the carrier is a Secondary Capture, Explicit VR LE, with the right pixel module", async () => {
  const { nodes, blobs } = await scene();
  const rgba = new Uint8Array(8 * 6 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = i & 0xff;
  const written = await writeMrcomBundle({
    nodes,
    blobs: blobsOf(blobs),
    reference,
    screenshot: { width: 8, height: 6, rgba },
  });

  const { read } = reopen(written.bytes);
  assertEquals(read.meta["00020010"].Value, ["1.2.840.10008.1.2.1"]);
  assertEquals(read.dict["00080016"].Value, ["1.2.840.10008.5.1.4.1.1.7"]);
  assertEquals(read.dict["00080060"].Value, ["OT"]);
  assertEquals(read.dict["00080064"].Value, ["WSD"]);
  assertEquals(read.dict["00280301"].Value, ["YES"]); // BurnedInAnnotation
  assertEquals(read.dict["00280002"].Value, [3]); // SamplesPerPixel
  assertEquals(read.dict["00280004"].Value, ["RGB"]);
  assertEquals(read.dict["00280006"].Value, [0]); // PlanarConfiguration
  assertEquals(read.dict["00280010"].Value, [6]); // Rows
  assertEquals(read.dict["00280011"].Value, [8]); // Columns
  assertEquals(new Uint8Array(read.dict["7FE00010"].Value[0] as ArrayBuffer).length, 8 * 6 * 3);
  assertEquals(written.pixels, { rows: 6, columns: 8 });

  // not spatially registered: a picture of a screen must not be placeable in patient space
  assertEquals(read.dict["00200052"], undefined); // FrameOfReferenceUID
  assertEquals(read.dict["00200032"], undefined); // ImagePositionPatient
});

Deno.test("a bundle with no screenshot still has legal pixel data", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), reference });
  const { read } = reopen(written.bytes);
  const pixels = new Uint8Array(read.dict["7FE00010"].Value[0] as ArrayBuffer);
  assertEquals(pixels.length, written.pixels.rows * written.pixels.columns * 3);
  assert(pixels.length > 0, "PixelData is type 1 - a write must not fail because capture did");
});

Deno.test("lineage is in standard attributes, primary parent first", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), reference });
  const { read, manifest } = reopen(written.bytes);

  const natural = DicomMetaDictionary.naturalizeDataset(read.dict) as Record<string, unknown>;
  const sequence = natural.ReferencedSeriesSequence as Record<string, unknown>[];
  assertEquals(sequence.length, 2);
  // ITEM 0 IS THE PRIMARY PARENT - what a provenance index reads without touching the private block
  assertEquals(sequence[0].SeriesInstanceUID, "1.2.3");
  assertEquals(manifest.context!.primaryParentSeries, "1.2.3");
  assertEquals(
    (sequence[0].ReferencedInstanceSequence as Record<string, unknown>[]).map((i) =>
      i.ReferencedSOPInstanceUID
    ),
    ["1.2.3.1", "1.2.3.2"],
  );
  assert(
    String(natural.DerivationDescription).includes("hybrid"),
    "the derivation description should name the mode",
  );
});

Deno.test("composite context is inherited, and coercions are reported not hidden", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: blobsOf(blobs),
    reference: {
      ...reference,
      dataset: {
        ...reference.dataset,
        // the SlicerAlbula trap: index values that violate VR limits
        StudyDescription: "D".repeat(68),
        PatientBirthDate: "1970-01-01",
      },
    },
  });

  const tags = written.coercions.map((c) => c.tag).sort();
  assertEquals(tags, ["PatientBirthDate", "StudyDescription"]);

  const { read } = reopen(written.bytes);
  assertEquals(String(read.dict["00081030"].Value[0]).length, 64); // StudyDescription within LO
  assertEquals(read.dict["00100030"].Value, ["19700101"]); // the ISO date repaired
  assertEquals(read.dict["00100010"].Value[0], { Alphabetic: "Doe^John" });
  assertEquals(read.dict["0020000D"].Value, ["1.2.3.4"]); // StudyInstanceUID inherited
});

Deno.test("an implicit VR reference instance does not make the bundle implicit VR", async () => {
  // The trap: dcmjs's datasetToDict keeps whatever TransferSyntaxUID it finds, and DerivedDataset
  // copies _meta from the reference.
  const series = makeDicomSeries(dcmjs as never, { transferSyntaxUID: "1.2.840.10008.1.2" });
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: blobsOf(blobs),
    reference: { bytes: new Uint8Array(series.buffers[0]) },
  });
  const { read } = reopen(written.bytes);
  assertEquals(read.meta["00020010"].Value, ["1.2.840.10008.1.2.1"]);
  // and the context came through from the parsed instance
  assertEquals(read.dict["00100020"].Value, ["TEST-1"]);
});

Deno.test("the private block carries typed lengths and bare hex digests", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), mode: "embed", reference });
  const { block, manifest } = reopen(written.bytes);

  assertEquals(block.get(0x01)!.Value, ["EMBED"]);
  assertEquals(block.get(0x03)!.Value, ["1"]);
  assertEquals(block.get(0x06)!.Value, ["SHA256"]);
  // typed UL, not a number smuggled into a string - the SlicerDataBundle lesson
  assertEquals(block.get(0x12)!.vr, "UL");
  assertEquals(typeof block.get(0x12)!.Value[0], "number");
  // bare hex, because LO is 64 characters
  const digest = String(block.get(0x13)!.Value[0]);
  assertEquals(digest.length, 64);
  assert(/^[0-9a-f]{64}$/.test(digest), "digests are bare lowercase hex");
  assertEquals(digest, manifest.scene.digest);

  // the manifest digest verifies too
  assertEquals(
    await sha256Bytes(utf8Encode(String(block.get(0x04)!.Value[0]))),
    String(block.get(0x05)!.Value[0]),
  );
});

Deno.test("embedded blobs are STORED, byte-identical, with their own length", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), mode: "embed", reference });
  const { read, block } = reopen(written.bytes);

  assertEquals(Number(block.get(0x30)!.Value[0]), 2); // MRCOMBlobCount

  // Read the sequence straight from the dict: it is private, so it has no keyword to naturalize to.
  const key = (offset: number) =>
    "4D43" + (((block.block << 8) | offset) >>> 0).toString(16).toUpperCase().padStart(4, "0");
  const sequence = read.dict[key(0x20)].Value as Record<string, { vr: string; Value: unknown[] }>[];
  assertEquals(sequence.length, 2);

  for (const item of sequence) {
    const hashHex = String(item[key(0x21)].Value[0]);
    assertEquals(hashHex.length, 64, "the blob hash is bare hex, not the prefixed name");
    assertEquals(item[key(0x23)].Value, ["STORED"]);

    const declared = Number(item[key(0x22)].Value[0]);
    const bytes = new Uint8Array(item[key(0x24)].Value[0] as ArrayBuffer).slice(0, declared);
    // STORED means the bytes are exactly what a blob store would serve, so the hash still verifies
    assertEquals(await sha256Bytes(bytes), hashHex);
    assertEquals(bytes.byteLength, blobs.get("sha256-" + hashHex)!.byteLength);
    assertEquals(bytes, blobs.get("sha256-" + hashHex)!);
  }
});

Deno.test("a blob that cannot be fetched is reported, not silently dropped", async () => {
  const { nodes } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: () => Promise.resolve(null),
    mode: "embed",
    reference,
  });
  assertEquals(written.embeddedBlobs, 0);
  assertEquals(written.missingBlobs.sort(), [await DICOM_HASH(), await AUTHORED_HASH()].sort());
});

Deno.test("the size cap refuses rather than exhausting memory, and says what to do", async () => {
  const { nodes } = await scene();
  let message = "";
  try {
    await writeMrcomBundle({
      nodes,
      blobs: () => Promise.resolve(new Uint8Array(200_000)),
      mode: "embed",
      reference,
      maxBytes: 1000,
    });
  } catch (error) {
    message = String((error as Error).message);
  }
  assert(message.includes("over the"), `expected a cap error, got ${JSON.stringify(message)}`);
  assert(message.includes("reference"), "the error should say which mode to use instead");
});

Deno.test("a Map of nodes works as well as a record", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({
    nodes: new Map(Object.entries(nodes)),
    blobs: blobsOf(blobs),
    reference,
  });
  const { manifest } = reopen(written.bytes);
  assertEquals(manifest.scene.nodes, 2);
});

Deno.test("writing with no reference at all still produces a valid bundle", async () => {
  // Albula may have no reference instance to hand; the bundle is then standalone.
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({ nodes, blobs: blobsOf(blobs), mode: "embed" });
  const { read, manifest } = reopen(written.bytes);
  assertEquals(manifest.mode, "embed");
  assertEquals(read.dict["00080016"].Value, ["1.2.840.10008.5.1.4.1.1.7"]);
  assertEquals(written.coercions, []);
});
