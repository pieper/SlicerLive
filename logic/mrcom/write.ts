// Writing an MRCOM scene bundle: one DICOM Secondary Capture carrying an mrson scene.
//
// Spec: docs/MRCOM-SCENE-BUNDLE.md. Uint8Array in, Uint8Array out, DOM-free, so SlicerAlbula's Deno
// server and a browser page use the same code (docs/MRCOM-PLAN.md section 5).

import type { MrsonNode } from "../../render/mrson.ts";
import { blobRefs, bulkSources } from "../bulk.ts";
import {
  bytesToArrayBuffer,
  deflateBytes,
  sha256Bytes,
  utf8Encode,
} from "../bytes.ts";
import { getDcmjs } from "./dcmjs.ts";
import {
  MRCOM_BLOB_TAGS,
  MRCOM_CREATOR,
  MRCOM_DIGEST_ALGORITHM,
  MRCOM_FORMAT_VERSION,
  MRCOM_GROUP,
  MRCOM_TAGS,
  type MrcomEncoding,
  type MrcomManifest,
  type MrcomMode,
  type MrcomModeRequest,
  type MrcomSource,
  modeToCS,
  mrcomTimestamp,
  type RequiredBulk,
  SC_TRANSFER_SYNTAX_UID,
} from "./format.ts";
import { type CapturedFrame, framePixels, placeholderPixels, type ScPixels } from "./sc-pixels.ts";
import { type Coercion, coerceAll } from "./vr.ts";

/** Composite context and lineage, from the images the scene was authored over. */
export interface ReferenceContext {
  /** A NATURALIZED reference instance. */
  dataset?: Record<string, unknown>;
  /** Or raw Part 10 bytes, which the writer parses. Implicit VR is tolerated. */
  bytes?: Uint8Array;
  /**
   * Series to record in ReferencedSeriesSequence. ITEM 0 IS THE PRIMARY PARENT, normatively - it is
   * what lets a provenance index find a bundle's parent from standard attributes alone.
   */
  referencedSeries?: {
    seriesInstanceUID: string;
    sopClassUID?: string;
    instances?: string[];
  }[];
  /** Overrides which series is recorded as the primary parent; defaults to referencedSeries[0]. */
  primaryParentSeries?: string;
}

export interface WriteBundleOpts {
  nodes: Record<string, MrsonNode> | Map<string, MrsonNode>;
  /** Fetch a blob by hash. SessionStore#cachedBlob or LocalBlobStore#get both fit. */
  blobs?: (hash: string) => Promise<Uint8Array | null>;
  /** Default "auto", which resolves to "hybrid". */
  mode?: MrcomModeRequest;
  /** RAW pixels. No canvas, no Blob - see sc-pixels.ts. Omitted means a placeholder. */
  screenshot?: CapturedFrame;
  /** Caps the capture's long edge; see sc-pixels.ts DEFAULT_MAX_EDGE. */
  maxEdge?: number;
  reference?: ReferenceContext;
  seriesDescription?: string;
  seriesNumber?: string | number;
  producer?: string;
  producerVersion?: string;
  /** Default "deflate". */
  sceneEncoding?: MrcomEncoding;
  /** Default 512 MiB. A bundle is built as one buffer, so embed mode of a whole study blows up. */
  maxBytes?: number;
  /** Where a reader can fetch blobs this bundle does not carry. */
  blobBase?: string;
}

export interface WrittenBundle {
  bytes: Uint8Array;
  sopInstanceUID: string;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  manifest: MrcomManifest;
  mode: MrcomMode;
  embeddedBlobs: number;
  /** Hashes a reader will have to fetch or re-derive. */
  referencedHashes: string[];
  /** Hashes that were meant to be embedded but could not be fetched. */
  missingBlobs: string[];
  /** Every inherited value that had to be changed to be VR-legal. */
  coercions: Coercion[];
  pixels: { rows: number; columns: number };
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** The composite context inherited from a reference instance, with each attribute's VR. */
const INHERITED: Record<string, string> = {
  PatientName: "PN",
  PatientID: "LO",
  PatientBirthDate: "DA",
  PatientSex: "CS",
  PatientAge: "AS",
  StudyInstanceUID: "UI",
  StudyID: "SH",
  StudyDate: "DA",
  StudyTime: "TM",
  StudyDescription: "LO",
  AccessionNumber: "SH",
  ReferringPhysicianName: "PN",
};

/**
 * Write an MRCOM scene bundle.
 *
 * @param options see WriteBundleOpts
 * @returns the Part 10 bytes and a report of what went into them
 */
export async function writeMrcomBundle(options: WriteBundleOpts): Promise<WrittenBundle> {
  const dcmjs = await getDcmjs();
  const { DicomMetaDictionary, datasetToDict, DicomMessage } = dcmjs.data;
  const { SecondaryCapture } = dcmjs.derivations;

  const nodes = options.nodes instanceof Map
    ? Object.fromEntries(options.nodes)
    : { ...options.nodes };
  const nodeList = Object.values(nodes);

  // ---- 1. the closure, split into what travels and what is referenced --------------------------
  const mode = resolveMode(options.mode ?? "auto");
  const sources = bulkSources(nodeList);
  const reachable = blobRefs(nodeList);

  // A hash is referenceable only if EVERY node that reaches it declares a DICOM origin: if one
  // node has the bytes from a file and another painted them, they have to travel.
  const referenceable = new Set<string>();
  const notReferenceable = new Set<string>();
  for (const source of sources) {
    (source.dicom ? referenceable : notReferenceable).add(source.hash);
  }
  for (const hash of notReferenceable) referenceable.delete(hash);

  const toEmbed = new Set<string>();
  const toReference = new Set<string>();
  for (const hash of reachable) {
    const byReference = mode === "reference" || (mode === "hybrid" && referenceable.has(hash));
    (byReference ? toReference : toEmbed).add(hash);
  }

  // ---- 2. the scene document -------------------------------------------------------------------
  const sceneJson = JSON.stringify({
    mrson: 0,
    blobBase: options.blobBase ?? "blobs/",
    nodes,
  });
  const sceneBytes = utf8Encode(sceneJson);
  const sceneDigest = await sha256Bytes(sceneBytes);
  const sceneEncoding: MrcomEncoding = options.sceneEncoding ?? "deflate";
  const sceneEncoded = sceneEncoding === "deflate" ? await deflateBytes(sceneBytes) : sceneBytes;

  // ---- 3. the blobs that travel ----------------------------------------------------------------
  const fetchBlob = options.blobs ?? (() => Promise.resolve(null));
  const embedded: { hash: string; bytes: Uint8Array }[] = [];
  const missingBlobs: string[] = [];
  let embeddedBytes = 0;
  for (const hash of toEmbed) {
    const bytes = await fetchBlob(hash);
    if (!bytes) {
      missingBlobs.push(hash);
      continue;
    }
    embedded.push({ hash, bytes });
    embeddedBytes += bytes.byteLength;
  }

  // ---- 4. the reference instance, and its composite context ------------------------------------
  const referenceDataset = options.reference?.dataset ??
    (options.reference?.bytes
      // Implicit VR is tolerated on READ; what matters is that the output is not implicit, which
      // the SecondaryCapture derivation pins. docs/MRCOM-SCENE-BUNDLE.md section 1.2.
      ? DicomMetaDictionary.naturalizeDataset(
        DicomMessage.readFile(bytesToArrayBuffer(options.reference.bytes)).dict,
      ) as Record<string, unknown>
      : undefined);

  // Coerce BEFORE the derivation inherits, so it never sees an illegal value. Every change is
  // reported - this is the SlicerAlbula trap (vr.ts header).
  const toCoerce: Record<string, [string, unknown]> = {};
  for (const [tag, vr] of Object.entries(INHERITED)) {
    if (referenceDataset && referenceDataset[tag] !== undefined) {
      toCoerce[tag] = [vr, referenceDataset[tag]];
    }
  }
  const { values: context, coercions } = coerceAll(toCoerce);

  const derivationReference: Record<string, unknown> = {
    ...(referenceDataset ?? {}),
    ...context,
    // The derivation reads _meta for the transfer syntax; it pins Explicit VR LE itself, but an
    // absent _meta would make it fall back to the reference's. Give it an explicit one.
    _meta: { TransferSyntaxUID: { vr: "UI", Value: [SC_TRANSFER_SYNTAX_UID] } },
  };

  // ---- 5. the carrier --------------------------------------------------------------------------
  const pixels: ScPixels = options.screenshot
    ? framePixels(options.screenshot, { maxEdge: options.maxEdge })
    : placeholderPixels();

  const referencedSeries = (options.reference?.referencedSeries ?? []).map((series) => ({
    SeriesInstanceUID: series.seriesInstanceUID,
    instances: (series.instances ?? []).map((instance) => ({
      SOPClassUID: series.sopClassUID,
      SOPInstanceUID: instance,
    })),
  }));

  const capture = new SecondaryCapture([derivationReference], {
    SeriesDescription: options.seriesDescription ?? "MRCOM Scene Bundle",
    SeriesNumber: String(options.seriesNumber ?? 9701),
    Manufacturer: options.producer ?? "SlicerLive",
    ManufacturerModelName: "MRCOM",
    SoftwareVersions: options.producerVersion ?? "0",
    ...(referencedSeries.length ? { referencedSeries } : {}),
  });
  capture.setPixels({
    rows: pixels.rows,
    columns: pixels.columns,
    pixelData: pixels.pixelData,
    samplesPerPixel: pixels.samplesPerPixel,
    bitsAllocated: pixels.bitsAllocated,
    photometricInterpretation: pixels.photometricInterpretation,
  });

  const dataset = capture.dataset as Record<string, unknown>;

  // Re-assert the coerced context on the dataset. DerivedDataset#derive() inherits a FIXED list
  // that does not include StudyDescription, so relying on it would silently drop attributes the
  // caller supplied. Assigning what we coerced makes the bundle's context independent of that
  // list - and these values are already VR-legal, which is the whole point of coercing first.
  for (const [tag, value] of Object.entries(context)) {
    if (value !== "") dataset[tag] = value;
  }

  // PixelData's dictionary VR is "ox" - OB or OW, depending on BitsAllocated - so dcmjs has to be
  // told which. A capture is 8 bits per sample, which makes it a byte stream: OB. Without this,
  // every write logged "No value representation given for PixelData" and dcmjs guessed OW.
  const vrMap = (dataset._vrMap ?? {}) as Record<string, string>;
  dataset._vrMap = { ...vrMap, PixelData: "OB" };

  const sopInstanceUID = String(dataset.SOPInstanceUID ?? "");
  const seriesInstanceUID = String(dataset.SeriesInstanceUID ?? "");
  const studyInstanceUID = String(dataset.StudyInstanceUID ?? "");
  dataset.DerivationDescription = derivationDescription(
    mode,
    nodeList.length,
    referencedSeries.length,
  );

  // ---- 6. the manifest -------------------------------------------------------------------------
  const required: RequiredBulk[] = [...toReference].map((hash) => {
    const owners = sources.filter((s) => s.hash === hash);
    const entry: RequiredBulk = { hash };
    if (owners.length) {
      entry.nodes = [...new Set(owners.map((o) => o.nodeId))];
      if (owners[0].grid) entry.grid = owners[0].grid;
    }
    return entry;
  });

  const manifestSources: MrcomSource[] = [];
  const seenNodes = new Set<string>();
  for (const source of sources) {
    if (!source.dicom || seenNodes.has(source.nodeId)) continue;
    seenNodes.add(source.nodeId);
    manifestSources.push({ ...source.dicom, nodeId: source.nodeId });
  }
  if (options.blobBase && /^https?:/i.test(options.blobBase)) {
    manifestSources.push({ kind: "blob-base", url: options.blobBase });
  }

  const primaryParentSeries = options.reference?.primaryParentSeries ??
    referencedSeries[0]?.SeriesInstanceUID;

  const manifest: MrcomManifest = {
    mrcom: 1,
    mode,
    bundleUID: DicomMetaDictionary.uid(),
    created: mrcomTimestamp(),
    producer: {
      name: options.producer ?? "SlicerLive",
      ...(options.producerVersion ? { version: options.producerVersion } : {}),
      mrson: 0,
    },
    scene: {
      length: sceneEncoded.byteLength,
      encoding: sceneEncoding,
      digest: sceneDigest,
      nodes: nodeList.length,
      blobBase: options.blobBase ?? "blobs/",
    },
    ...(studyInstanceUID || primaryParentSeries || context.PatientID
      ? {
        context: {
          ...(studyInstanceUID ? { studyInstanceUID } : {}),
          ...(context.PatientID ? { patientID: context.PatientID } : {}),
          ...(primaryParentSeries ? { primaryParentSeries } : {}),
        },
      }
      : {}),
    bulk: {
      embedded: { count: embedded.length, bytes: embeddedBytes },
      ...(required.length ? { required } : {}),
      ...(manifestSources.length ? { sources: manifestSources } : {}),
    },
    screenshot: { rows: pixels.rows, columns: pixels.columns },
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestDigest = await sha256Bytes(utf8Encode(manifestJson));

  // ---- 7. the private block --------------------------------------------------------------------
  const dicomDict = datasetToDict(dataset);
  const block = dicomDict.privateBlock(MRCOM_GROUP, MRCOM_CREATOR);
  if (!block) throw new Error("could not reserve the MRCOM private block");

  const set = (name: string, values: unknown) => {
    const element = MRCOM_TAGS[name];
    if (!element) throw new Error(`no such MRCOM element: ${name}`);
    block.set(element.offset, element.vr, values);
  };

  set("MRCOMBundleMode", [modeToCS(mode)]);
  set("MRCOMBundleUID", [manifest.bundleUID]);
  set("MRCOMFormatVersion", [MRCOM_FORMAT_VERSION]);
  set("MRCOMManifest", [manifestJson]);
  set("MRCOMManifestDigest", [manifestDigest]);
  set("MRCOMDigestAlgorithm", [MRCOM_DIGEST_ALGORITHM]);
  set("MRCOMScene", [bytesToArrayBuffer(sceneEncoded)]);
  set("MRCOMSceneEncoding", [sceneEncoding.toUpperCase()]);
  set("MRCOMSceneLength", [sceneEncoded.byteLength]);
  set("MRCOMSceneDigest", [sceneDigest]);
  set("MRCOMSceneNodeCount", [nodeList.length]);
  set("MRCOMProducer", [options.producer ?? "SlicerLive"]);
  set("MRCOMProducerVersion", [options.producerVersion ?? "0"]);

  if (embedded.length) {
    // One sequence item per blob. The natural mrson chunking IS the fragmentation strategy, so
    // items stay small and there is no archive - docs/MRCOM-SCENE-BUNDLE.md section 5.2.
    const items = embedded.map(({ hash, bytes }) => {
      const item: Record<string, unknown> = {};
      // reservation is per dataset, so each item carries its own creator
      item[creatorKey(block.block)] = { vr: "LO", Value: [MRCOM_CREATOR] };
      const put = (name: string, values: unknown) => {
        const element = MRCOM_BLOB_TAGS[name];
        item[blockKey(block.block, element.offset)] = { vr: element.vr, Value: values };
      };
      // STORED: these bytes are byte-identical to what a blob store would serve, so neither side
      // recompresses. The hash is stored BARE, since LO cannot hold the prefixed name.
      put("MRCOMBlobHash", [hash.replace(/^sha256-/, "")]);
      put("MRCOMBlobLength", [bytes.byteLength]);
      put("MRCOMBlobEncoding", ["STORED"]);
      put("MRCOMBlobData", [bytesToArrayBuffer(bytes)]);
      return item;
    });
    set("MRCOMBlobSequence", items);
    set("MRCOMBlobCount", [embedded.length]);
    set("MRCOMBlobTotalLength", [embeddedBytes]);
  }

  // ---- 8. bytes --------------------------------------------------------------------------------
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const estimate = sceneEncoded.byteLength + embeddedBytes + pixels.pixelData.byteLength;
  if (estimate > maxBytes) {
    throw new Error(
      `MRCOM bundle would be about ${mib(estimate)} MiB, over the ${mib(maxBytes)} MiB cap. ` +
        `A bundle is built as one buffer, so embedding a whole study exhausts memory before it ` +
        `exhausts DICOM - use mode "reference" or "hybrid", or raise maxBytes deliberately.`,
    );
  }

  const bytes = new Uint8Array(dicomDict.write());

  return {
    bytes,
    sopInstanceUID,
    seriesInstanceUID,
    studyInstanceUID,
    manifest,
    mode,
    embeddedBlobs: embedded.length,
    referencedHashes: [...toReference],
    missingBlobs,
    coercions,
    pixels: { rows: pixels.rows, columns: pixels.columns },
  };
}

const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const creatorKey = (block: number) => hex4(MRCOM_GROUP) + hex4(block);
const blockKey = (block: number, offset: number) => hex4(MRCOM_GROUP) + hex4((block << 8) | offset);

/** "auto" means hybrid: reference the image series, embed what was authored. */
function resolveMode(request: MrcomModeRequest): MrcomMode {
  return request === "auto" ? "hybrid" : request;
}

function derivationDescription(mode: MrcomMode, nodes: number, series: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `MRCOM mrson scene bundle (${mode}), ${plural(nodes, "node")}, ${
    plural(series, "source series")
  }`;
}
