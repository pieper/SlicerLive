// Reading an MRCOM scene bundle.
//
// Spec: docs/MRCOM-SCENE-BUNDLE.md section 11 is the reader's conformance list, and this implements
// it. The rules that matter:
//
//   - find the block BY CREATOR, never by assuming a block number
//   - slice payloads to their TYPED lengths, not the element length, because DICOM pads to even
//   - verify every digest BEFORE use, and REFUSE rather than loading with a warning
//   - reference sequences present but the creator absent means a STRIPPED bundle, not an
//     unrecognized file - conformant de-identification removes private attributes by default
//
// DOM-free (docs/MRCOM-PLAN.md section 5).

import type { MrsonNode } from "../../render/mrson.ts";
import { inflateBytes, nameOfDigest, sha256Bytes, utf8Decode, utf8Encode } from "../bytes.ts";
import { type Dcmjs, getDcmjs } from "./dcmjs.ts";
import {
  MRCOM_CREATOR,
  MRCOM_GROUP,
  type MrcomEncoding,
  type MrcomManifest,
  type MrcomMode,
  modeFromCS,
  MRCOM_BLOB_TAGS,
  MRCOM_TAGS,
} from "./format.ts";

/** What a bundle turned out to be. */
export type BundleKind =
  /** A bundle with its private block intact. */
  | "mrcom"
  /**
   * A Secondary Capture that names source series but has no MRCOM creator: a bundle whose scene was
   * stripped, almost certainly by de-identification. The references are still usable.
   */
  | "stripped"
  /** Not an MRCOM bundle. */
  | "other";

export interface BundlePeek {
  kind: BundleKind;
  manifest?: MrcomManifest;
  mode?: MrcomMode;
  bundleUID?: string;
  formatVersion?: string;
  producer?: string;
  /** Series the bundle names in standard attributes, primary parent first. */
  referencedSeries: { seriesInstanceUID: string; instances: string[] }[];
  /** Set when kind is "stripped" or a digest check failed. */
  problem?: string;
}

export interface ReadBundle extends BundlePeek {
  kind: "mrcom";
  manifest: MrcomManifest;
  mode: MrcomMode;
  /** The scene document. */
  nodes: Record<string, MrsonNode>;
  /** Embedded blobs, by mrson blob name ("sha256-..."). */
  blobs: Map<string, Uint8Array>;
  /** Hashes the scene names that this instance does not carry. */
  required: string[];
  /** The screenshot, as stored. */
  screenshot?: { rows: number; columns: number; rgb: Uint8Array };
}

export interface ReadOptions {
  /** Default true. False downgrades a digest mismatch to a `problem` instead of throwing. */
  verify?: boolean;
  /** Default true. False skips decoding PixelData. */
  screenshot?: boolean;
}

type Dict = Record<string, { vr: string; Value: unknown[] }>;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

/** Is this parsed dataset an MRCOM bundle? One short LO, ahead of the pixels. */
export function isMrcomBundle(dict: Dict, dcmjs: Dcmjs): boolean {
  return !!dcmjs.data.findPrivateBlock(dict as never, MRCOM_GROUP, MRCOM_CREATOR);
}

/**
 * Identify a bundle and read its manifest WITHOUT touching the payload or the pixels.
 *
 * The private block sorts before PixelData (group 0x4D43 < 0x7FE0), which is what makes this
 * possible from a prefix read - the structural opposite of SlicerDataBundle, whose payload had to
 * be found by seeking back from the end of the file.
 *
 * @param bytes Part 10 bytes
 * @returns what it is, and the manifest when there is one
 */
export async function peekMrcomManifest(bytes: Uint8Array): Promise<BundlePeek> {
  const dcmjs = await getDcmjs();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  // Stop at PixelData: everything MRCOM needs precedes it.
  const read = dcmjs.data.DicomMessage.readFile(buffer, { untilTag: "7FE00010" });
  return describe(read.dict as Dict, dcmjs);
}

/** Identify a bundle from an already-parsed dataset. */
export async function describeBundle(dict: Dict): Promise<BundlePeek> {
  return describe(dict, await getDcmjs());
}

function describe(dict: Dict, dcmjs: Dcmjs): BundlePeek {
  const referencedSeries = readReferencedSeries(dict);
  const block = dcmjs.data.findPrivateBlock(dict as never, MRCOM_GROUP, MRCOM_CREATOR);

  if (!block) {
    // A stripped bundle is recoverable-or-absent, never silently corrupt: say which it is.
    if (referencedSeries.length && isSecondaryCapture(dict)) {
      return {
        kind: "stripped",
        referencedSeries,
        problem:
          "a Secondary Capture that names source series but carries no MRCOM private block - " +
          "most likely de-identified, which removes private attributes by default (PS3.15 Annex E). " +
          "The referenced series are still usable; the scene is gone.",
      };
    }
    return { kind: "other", referencedSeries };
  }

  const value = (name: string): unknown => {
    const element = MRCOM_TAGS[name];
    const got = element && block.get(element.offset);
    return got ? got.Value[0] : undefined;
  };

  let manifest: MrcomManifest | undefined;
  let problem: string | undefined;
  const manifestJson = value("MRCOMManifest");
  if (typeof manifestJson === "string") {
    try {
      manifest = JSON.parse(manifestJson) as MrcomManifest;
    } catch (cause) {
      problem = `the MRCOM manifest is not valid JSON: ${String((cause as Error).message)}`;
    }
  } else {
    problem = "the MRCOM manifest element is missing";
  }

  return {
    kind: "mrcom",
    manifest,
    mode: modeFromCS(value("MRCOMBundleMode") as string | undefined) ?? undefined,
    bundleUID: value("MRCOMBundleUID") as string | undefined,
    formatVersion: value("MRCOMFormatVersion") as string | undefined,
    producer: value("MRCOMProducer") as string | undefined,
    referencedSeries,
    problem,
  };
}

/**
 * Read a bundle fully: the scene, the embedded blobs, and the screenshot.
 *
 * @param bytes Part 10 bytes
 * @param options verify defaults to true, and a failed digest THROWS
 * @returns the scene and everything that came with it
 */
export async function readMrcomBundle(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<ReadBundle> {
  const verify = options.verify !== false;
  const dcmjs = await getDcmjs();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const read = dcmjs.data.DicomMessage.readFile(buffer);
  const dict = read.dict as Dict;

  const peek = describe(dict, dcmjs);
  if (peek.kind !== "mrcom") {
    throw new Error(
      peek.problem ?? "not an MRCOM bundle: no private block with creator " + MRCOM_CREATOR,
    );
  }
  if (!peek.manifest) throw new Error(peek.problem ?? "the MRCOM manifest is unreadable");

  const block = dcmjs.data.findPrivateBlock(dict as never, MRCOM_GROUP, MRCOM_CREATOR)!;
  const manifest = peek.manifest;
  const problems: string[] = [];

  const get = (name: string) => {
    const element = MRCOM_TAGS[name];
    return element ? block.get(element.offset) : undefined;
  };

  // ---- the manifest's own digest ---------------------------------------------------------------
  const manifestDigest = get("MRCOMManifestDigest")?.Value[0];
  if (typeof manifestDigest === "string") {
    const actual = await sha256Bytes(utf8Encode(String(get("MRCOMManifest")!.Value[0])));
    if (actual !== manifestDigest) {
      problems.push(
        `the manifest digest does not match: declared ${manifestDigest}, computed ${actual}`,
      );
    }
  }

  // ---- the scene ------------------------------------------------------------------------------
  const sceneElement = get("MRCOMScene");
  if (!sceneElement) {
    throw new Error(
      "this bundle has no scene element - it may have been partially stripped. " +
        "The referenced series are in the manifest.",
    );
  }
  // Slice to the TYPED length: DICOM pads an odd-length value field, so the element is up to one
  // byte longer than the payload. docs/MRCOM-SCENE-BUNDLE.md section 2.4.
  const declaredLength = Number(get("MRCOMSceneLength")?.Value[0] ?? manifest.scene.length);
  const stored = new Uint8Array(sceneElement.Value[0] as ArrayBuffer).slice(0, declaredLength);
  const encoding = String(
    get("MRCOMSceneEncoding")?.Value[0] ?? manifest.scene.encoding,
  ).toLowerCase() as MrcomEncoding;
  // A damaged payload fails to inflate before any digest can be computed. Report that as an MRCOM
  // verification failure with the context a user needs, rather than letting a bare "corrupt deflate
  // stream" out of the decompressor.
  let sceneBytes: Uint8Array | null = null;
  if (encoding === "deflate") {
    try {
      sceneBytes = await inflateBytes(stored);
    } catch (cause) {
      problems.push(
        `the scene payload could not be decompressed (${String((cause as Error).message)}) - ` +
          `${stored.byteLength} bytes declared as ${encoding}. The instance has most likely been ` +
          `altered since it was written.`,
      );
    }
  } else {
    sceneBytes = stored;
  }

  const declaredSceneDigest = String(get("MRCOMSceneDigest")?.Value[0] ?? manifest.scene.digest);
  if (sceneBytes) {
    const actualSceneDigest = await sha256Bytes(sceneBytes);
    if (actualSceneDigest !== declaredSceneDigest) {
      problems.push(
        `the scene digest does not match: declared ${declaredSceneDigest}, computed ${actualSceneDigest}`,
      );
    }
  }

  let nodes: Record<string, MrsonNode> = {};
  if (sceneBytes) {
    try {
      // not named `document`: this module must never touch the DOM global, and a local that
      // shadows it makes that harder to see (logic/mrcom/no-dom.test.ts enforces the absence)
      const sceneDoc = JSON.parse(utf8Decode(sceneBytes)) as { nodes?: Record<string, MrsonNode> };
      nodes = sceneDoc.nodes ?? (sceneDoc as Record<string, MrsonNode>);
    } catch (cause) {
      problems.push(`the scene is not valid JSON: ${String((cause as Error).message)}`);
    }
  }

  // ---- embedded blobs --------------------------------------------------------------------------
  const blobs = new Map<string, Uint8Array>();
  const sequenceElement = get("MRCOMBlobSequence");
  if (sequenceElement) {
    const key = (offset: number) =>
      hex4(MRCOM_GROUP) + hex4(((block.block << 8) | offset) >>> 0);
    for (const raw of sequenceElement.Value as Dict[]) {
      const hashHex = String(raw[key(MRCOM_BLOB_TAGS.MRCOMBlobHash.offset)]?.Value[0] ?? "");
      const data = raw[key(MRCOM_BLOB_TAGS.MRCOMBlobData.offset)]?.Value[0] as
        | ArrayBuffer
        | undefined;
      if (!hashHex || !data) {
        problems.push("a blob sequence item is missing its hash or its data");
        continue;
      }
      const blobLength = Number(
        raw[key(MRCOM_BLOB_TAGS.MRCOMBlobLength.offset)]?.Value[0] ?? (data as ArrayBuffer).byteLength,
      );
      let payload: Uint8Array = new Uint8Array(new Uint8Array(data).slice(0, blobLength));
      const blobEncoding = String(
        raw[key(MRCOM_BLOB_TAGS.MRCOMBlobEncoding.offset)]?.Value[0] ?? "STORED",
      ).toUpperCase();
      if (blobEncoding === "DEFLATE") {
        try {
          payload = await inflateBytes(payload);
        } catch (cause) {
          problems.push(
            `blob ${hashHex} could not be decompressed (${String((cause as Error).message)})`,
          );
          continue;
        }
      }

      // STORED means these bytes are what a blob store would serve, so the hash must still verify.
      const actual = await sha256Bytes(payload);
      if (actual !== hashHex) {
        problems.push(`blob ${hashHex} does not match its content (computed ${actual})`);
        continue;
      }
      blobs.set(nameOfDigest(hashHex), payload);
    }
  }

  // ---- the screenshot --------------------------------------------------------------------------
  let screenshot: ReadBundle["screenshot"];
  if (options.screenshot !== false) {
    const rows = Number(dict["00280010"]?.Value[0] ?? 0);
    const columns = Number(dict["00280011"]?.Value[0] ?? 0);
    const pixelData = dict["7FE00010"]?.Value[0] as ArrayBuffer | undefined;
    if (rows > 0 && columns > 0 && pixelData) {
      screenshot = {
        rows,
        columns,
        rgb: new Uint8Array(pixelData).slice(0, rows * columns * 3),
      };
    }
  }

  // A reader that cannot verify a digest MUST refuse the data, not load it with a warning.
  if (problems.length && verify) {
    throw new Error(
      "this MRCOM bundle failed verification, so it was not loaded:\n  " + problems.join("\n  ") +
        "\nPass { verify: false } to load it anyway, accepting that the contents may differ from " +
        "what the author wrote.",
    );
  }

  return {
    ...peek,
    kind: "mrcom",
    manifest,
    mode: peek.mode ?? manifest.mode,
    nodes,
    blobs,
    required: (manifest.bulk?.required ?? []).map((r) => r.hash),
    screenshot,
    problem: problems.length ? problems.join("; ") : peek.problem,
  };
}

function isSecondaryCapture(dict: Dict): boolean {
  return String(dict["00080016"]?.Value[0] ?? "") === "1.2.840.10008.5.1.4.1.1.7";
}

/** ReferencedSeriesSequence, primary parent first - the order is normative. */
function readReferencedSeries(dict: Dict): { seriesInstanceUID: string; instances: string[] }[] {
  const sequence = dict["00081115"]?.Value as Dict[] | undefined;
  if (!sequence) return [];
  const out: { seriesInstanceUID: string; instances: string[] }[] = [];
  for (const item of sequence) {
    const seriesInstanceUID = String(item["0020000E"]?.Value[0] ?? "");
    if (!seriesInstanceUID) continue;
    const instanceSequence = item["0008114A"]?.Value as Dict[] | undefined;
    out.push({
      seriesInstanceUID,
      instances: (instanceSequence ?? [])
        .map((reference) => String(reference["00081155"]?.Value[0] ?? ""))
        .filter((uid) => uid.length > 0),
    });
  }
  return out;
}
