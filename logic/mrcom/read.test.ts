// T1: the MRCOM bundle reader, and its round trip with the writer.
import { assert, assertEquals } from "../../mrson/assert.ts";
import dcmjs from "../../render/vendor/dcmjs/dcmjs.es.js";
import { setDcmjs } from "./dcmjs.ts";
import type { MrsonNode } from "../../render/mrson.ts";
import { sha256Name, utf8Encode } from "../bytes.ts";
import { MRCOM_CREATOR, MRCOM_GROUP } from "./format.ts";
import { peekMrcomManifest, readMrcomBundle } from "./read.ts";
import { writeMrcomBundle } from "./write.ts";

setDcmjs(dcmjs as never);

const AUTHORED = utf8Encode("painted segmentation voxels");
const FROM_DICOM = utf8Encode("reconstructed CT chunk");

async function scene() {
  const authoredHash = await sha256Name(AUTHORED);
  const dicomHash = await sha256Name(FROM_DICOM);
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
      dims: [4, 3, 5],
      segments: [{ labelValue: 1, name: "S1" }],
      blobs: { labelmap: authoredHash },
    } as never,
  };
  const blobs = new Map([[dicomHash, FROM_DICOM], [authoredHash, AUTHORED]]);
  return { nodes, blobs, authoredHash, dicomHash };
}

const reference = {
  dataset: {
    PatientName: "Doe^John",
    PatientID: "12345",
    StudyInstanceUID: "1.2.3.4",
    StudyDescription: "A study",
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.2",
    SOPInstanceUID: "1.2.3.4.5",
  } as Record<string, unknown>,
  referencedSeries: [
    { seriesInstanceUID: "1.2.3", sopClassUID: "1.2.840.10008.5.1.4.1.1.2", instances: ["1.2.3.1", "1.2.3.2"] },
    { seriesInstanceUID: "1.2.4", sopClassUID: "1.2.840.10008.5.1.4.1.1.66.4", instances: ["1.2.4.1"] },
  ],
};

const rgba = (w: number, hgt: number) => {
  const out = new Uint8Array(w * hgt * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 5) & 0xff;
  return out;
};

async function embedBundle() {
  const { nodes, blobs, authoredHash, dicomHash } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: (hash) => Promise.resolve(blobs.get(hash) ?? null),
    mode: "embed",
    reference,
    screenshot: { width: 8, height: 6, rgba: rgba(8, 6) },
  });
  return { written, authoredHash, dicomHash, nodes };
}

Deno.test("round trip: embed mode gives back the scene and every blob", async () => {
  const { written, authoredHash, dicomHash, nodes } = await embedBundle();
  const bundle = await readMrcomBundle(written.bytes);

  assertEquals(bundle.kind, "mrcom");
  assertEquals(bundle.mode, "embed");
  assertEquals(bundle.problem, undefined);
  assertEquals(Object.keys(bundle.nodes).sort(), ["img1", "seg1"]);
  // the scene survives field for field, including the dicom descriptor
  assertEquals(bundle.nodes.img1.dims, nodes.img1.dims);
  assertEquals(
    (bundle.nodes.img1 as unknown as { dicom: { instances: string[] } }).dicom.instances,
    ["1.2.3.1", "1.2.3.2"],
  );
  assertEquals(bundle.blobs.size, 2);
  assertEquals(bundle.blobs.get(authoredHash), AUTHORED);
  assertEquals(bundle.blobs.get(dicomHash), FROM_DICOM);
  assertEquals(bundle.required, []);
});

Deno.test("round trip: the screenshot comes back at its stored size", async () => {
  const { written } = await embedBundle();
  const bundle = await readMrcomBundle(written.bytes);
  assert(bundle.screenshot, "the screenshot should be read");
  assertEquals([bundle.screenshot!.columns, bundle.screenshot!.rows], [8, 6]);
  assertEquals(bundle.screenshot!.rgb.length, 8 * 6 * 3);
  // and it can be skipped, for a reader that only wants the scene
  const lean = await readMrcomBundle(written.bytes, { screenshot: false });
  assertEquals(lean.screenshot, undefined);
});

Deno.test("round trip: hybrid reports what a reader still has to fetch", async () => {
  const { nodes, blobs, authoredHash, dicomHash } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: (hash) => Promise.resolve(blobs.get(hash) ?? null),
    reference,
  });
  const bundle = await readMrcomBundle(written.bytes);
  assertEquals(bundle.mode, "hybrid");
  assertEquals(bundle.required, [dicomHash]);
  // the authored blob travelled; the DICOM-sourced one did not
  assertEquals([...bundle.blobs.keys()], [authoredHash]);
  assertEquals(bundle.manifest.bulk!.sources!.length, 1);
});

Deno.test("peek reads the manifest without the payload or the pixels", async () => {
  const { written } = await embedBundle();
  const peek = await peekMrcomManifest(written.bytes);

  assertEquals(peek.kind, "mrcom");
  assertEquals(peek.mode, "embed");
  assertEquals(peek.formatVersion, "1");
  assertEquals(peek.producer, "SlicerLive");
  assertEquals(peek.manifest!.scene.nodes, 2);
  assertEquals(peek.bundleUID, written.manifest.bundleUID);
  // the lineage is legible from the standard attributes alone
  assertEquals(peek.referencedSeries.map((s) => s.seriesInstanceUID), ["1.2.3", "1.2.4"]);
  assertEquals(peek.referencedSeries[0].instances, ["1.2.3.1", "1.2.3.2"]);
});

Deno.test("the primary parent is the first referenced series", async () => {
  const { written } = await embedBundle();
  const peek = await peekMrcomManifest(written.bytes);
  // what a provenance index reads, without ever parsing the private block
  assertEquals(peek.referencedSeries[0].seriesInstanceUID, "1.2.3");
  assertEquals(peek.manifest!.context!.primaryParentSeries, "1.2.3");
});

Deno.test("a corrupted scene payload is REFUSED, not loaded with a warning", async () => {
  const { written } = await embedBundle();
  const bytes = new Uint8Array(written.bytes);

  // Flip a byte inside the deflated scene. Find it by locating the element's data.
  const read = dcmjs.data.DicomMessage.readFile(bytes.buffer.slice(0) as ArrayBuffer);
  const block = dcmjs.data.findPrivateBlock(read.dict as never, MRCOM_GROUP, MRCOM_CREATOR)!;
  const scenePayload = new Uint8Array(block.get(0x10)!.Value[0] as ArrayBuffer);
  // locate those bytes in the file and corrupt one well inside them
  const needle = scenePayload.slice(8, 24);
  let at = -1;
  outer: for (let i = 0; i < bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    at = i;
    break;
  }
  assert(at >= 0, "could not locate the scene payload in the file");
  bytes[at + 4] ^= 0xff;

  let message = "";
  try {
    await readMrcomBundle(bytes);
  } catch (error) {
    message = String((error as Error).message);
  }
  assert(message.includes("failed verification"), `expected a refusal, got ${JSON.stringify(message)}`);
  assert(message.includes("verify: false"), "the refusal should say how to override it deliberately");
});

Deno.test("verify:false downgrades a mismatch to a reported problem", async () => {
  const { written } = await embedBundle();
  const bytes = new Uint8Array(written.bytes);
  const read = dcmjs.data.DicomMessage.readFile(bytes.buffer.slice(0) as ArrayBuffer);
  const block = dcmjs.data.findPrivateBlock(read.dict as never, MRCOM_GROUP, MRCOM_CREATOR)!;
  // Corrupt the stored digest rather than the payload, so the scene still inflates.
  //
  // The scene digest appears TWICE in a bundle: inside the manifest JSON (element 0x04) and in its
  // own element (0x13), which sorts after it. lastIndexOf therefore targets 0x13 - corrupting the
  // first copy would alter the manifest and trip the MANIFEST digest check instead, which is a
  // different (also correct) refusal.
  const digest = String(block.get(0x13)!.Value[0]);
  const wrong = "0".repeat(64);
  const asText = new TextDecoder("latin1").decode(bytes);
  const at = asText.lastIndexOf(digest);
  assert(at >= 0, "could not find the digest in the file");
  for (let i = 0; i < 64; i++) bytes[at + i] = wrong.charCodeAt(i);

  let threw = false;
  try {
    await readMrcomBundle(bytes);
  } catch {
    threw = true;
  }
  assert(threw, "the default must refuse");

  const loaded = await readMrcomBundle(bytes, { verify: false });
  assert(loaded.problem && loaded.problem.includes("scene digest"), "the problem must be reported");
  assertEquals(Object.keys(loaded.nodes).sort(), ["img1", "seg1"]);
});

Deno.test("a tampered manifest is caught by its own digest", async () => {
  // The manifest is the only part a reader consults before deciding whether it can open a bundle,
  // so it carries its own digest. Editing it in place must not go unnoticed.
  const { written } = await embedBundle();
  const bytes = new Uint8Array(written.bytes);
  const asText = new TextDecoder("latin1").decode(bytes);
  const at = asText.indexOf('"mode":"embed"');
  assert(at >= 0, "could not find the manifest in the file");
  // same length, so nothing else shifts
  const forged = '"mode":"HYBRD"';
  for (let i = 0; i < forged.length; i++) bytes[at + i] = forged.charCodeAt(i);

  let message = "";
  try {
    await readMrcomBundle(bytes);
  } catch (error) {
    message = String((error as Error).message);
  }
  assert(message.includes("manifest digest"), `expected a manifest digest refusal, got ${message}`);
});

Deno.test("a stripped bundle is reported as stripped, not as an unknown file", async () => {
  // Conformant de-identification removes private attributes by default, so this is the realistic
  // failure mode - and a reader must say what happened, because the references still work.
  const { written } = await embedBundle();
  const read = dcmjs.data.DicomMessage.readFile(
    written.bytes.buffer.slice(0) as ArrayBuffer,
  );
  // drop the whole private group, as a de-identifier would
  for (const key of Object.keys(read.dict)) {
    if (key.startsWith("4D43")) delete (read.dict as Record<string, unknown>)[key];
  }
  const stripped = new Uint8Array(read.write());

  const peek = await peekMrcomManifest(stripped);
  assertEquals(peek.kind, "stripped");
  assert(peek.problem!.includes("de-identified"), "the problem should name the likely cause");
  // the lineage survives, which is why it lives in standard attributes
  assertEquals(peek.referencedSeries.map((s) => s.seriesInstanceUID), ["1.2.3", "1.2.4"]);

  let message = "";
  try {
    await readMrcomBundle(stripped);
  } catch (error) {
    message = String((error as Error).message);
  }
  assert(message.includes("de-identified"), `expected the stripped explanation, got ${message}`);
});

Deno.test("an ordinary DICOM instance is 'other', not an error", async () => {
  const { makeDicomSeries } = await import("../readers/synthetic-dicom.ts");
  const series = makeDicomSeries(dcmjs as never);
  const peek = await peekMrcomManifest(new Uint8Array(series.buffers[0]));
  assertEquals(peek.kind, "other");
  assertEquals(peek.referencedSeries, []);
  assertEquals(peek.manifest, undefined);
});

Deno.test("a corrupted blob is refused, and names which one", async () => {
  const { written, authoredHash } = await embedBundle();
  const bytes = new Uint8Array(written.bytes);
  // find the authored blob's bytes and corrupt them
  const asText = new TextDecoder("latin1").decode(bytes);
  const at = asText.indexOf("painted segmentation voxels");
  assert(at >= 0, "could not find the blob payload");
  bytes[at] = 0x58;

  let message = "";
  try {
    await readMrcomBundle(bytes);
  } catch (error) {
    message = String((error as Error).message);
  }
  assert(message.includes("does not match its content"), `got ${JSON.stringify(message)}`);
  assert(
    message.includes(authoredHash.replace("sha256-", "")),
    "the refusal should name the offending blob",
  );
});

Deno.test("an odd-length payload survives the DICOM pad byte", async () => {
  // DICOM pads a value field to even length, so an odd payload comes back one byte longer. The
  // typed length element is what makes it recoverable - docs/MRCOM-SCENE-BUNDLE.md section 2.4.
  const odd = utf8Encode("odd");
  const oddHash = await sha256Name(odd);
  assertEquals(odd.length % 2, 1);

  const nodes: Record<string, MrsonNode> = {
    m1: { id: "m1", type: "mesh", points: oddHash } as never,
  };
  const written = await writeMrcomBundle({
    nodes,
    blobs: () => Promise.resolve(odd),
    mode: "embed",
    reference,
  });
  const bundle = await readMrcomBundle(written.bytes);
  assertEquals(bundle.blobs.get(oddHash), odd, "the pad byte must not end up in the payload");
  assertEquals(bundle.blobs.get(oddHash)!.length, 3);
});

Deno.test("a scene with no blobs at all reads cleanly", async () => {
  const nodes: Record<string, MrsonNode> = {
    cam: { id: "cam", type: "camera", position: [0, 0, 100] } as never,
  };
  const written = await writeMrcomBundle({ nodes, mode: "embed", reference });
  const bundle = await readMrcomBundle(written.bytes);
  assertEquals(bundle.blobs.size, 0);
  assertEquals(bundle.required, []);
  assertEquals(Object.keys(bundle.nodes), ["cam"]);
});

Deno.test("an uncompressed scene reads too", async () => {
  const { nodes, blobs } = await scene();
  const written = await writeMrcomBundle({
    nodes,
    blobs: (hash) => Promise.resolve(blobs.get(hash) ?? null),
    mode: "embed",
    reference,
    sceneEncoding: "none",
  });
  assertEquals(written.manifest.scene.encoding, "none");
  const bundle = await readMrcomBundle(written.bytes);
  assertEquals(Object.keys(bundle.nodes).sort(), ["img1", "seg1"]);
});
