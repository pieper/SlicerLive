// The MRCOM bundle format: constants, types, and the manifest.
//
// Spec: docs/MRCOM-SCENE-BUNDLE.md. The element table and the private block identity are READ FROM
// mrson/schema/mrcom.schema.json rather than restated here, so the TypeScript writer, the pydicom
// reader (tools/mrcom_check.py) and the spec cannot disagree about a tag. The schema is the single
// source; this module is a typed view of it.
//
// DOM-free (docs/MRCOM-PLAN.md section 5).

import MRCOM_SCHEMA from "../../mrson/schema/mrcom.schema.json" with { type: "json" };
import type { MrsonDicomRef, MrsonNode } from "../../render/mrson.ts";

// --- the private block -------------------------------------------------------------------------

const PB = MRCOM_SCHEMA.privateBlock;

/** Private group 0x4D43 - odd, as DICOM requires, and "MC" in a hex dump. */
export const MRCOM_GROUP: number = parseInt(PB.group, 16);

/**
 * The private creator. THE ONLY IDENTITY: a reader locates the block by matching this, never by
 * assuming a block number, because which block a creator holds is decided by whoever wrote the file.
 * It carries no data and will not change - the block LAYOUT is versioned in MRCOMFormatVersion.
 */
export const MRCOM_CREATOR: string = PB.creator;

/** Block layout version, element (4D43,xx03). */
export const MRCOM_FORMAT_VERSION: string = String(
  PB.elements.find((e) => e.name === "MRCOMFormatVersion")?.value ?? "1",
);

export const MRCOM_DIGEST_ALGORITHM = "SHA256";

/** One element of the private block, as the schema declares it. */
export interface MrcomElement {
  /** Element offset WITHIN the block, e.g. 0x01 for MRCOMBundleMode. */
  readonly offset: number;
  readonly vr: string;
  readonly name: string;
  readonly required: boolean;
}

function elementTable(rows: typeof PB.elements | typeof PB.blobItem): Record<string, MrcomElement> {
  const out: Record<string, MrcomElement> = {};
  for (const row of rows) {
    if (row.name === "PrivateCreator") continue; // the creator is the block, not an element of it
    out[row.name] = {
      // The schema spells elements as full 4-hex (1001); within a block the offset is the low byte.
      offset: parseInt(row.el, 16) & 0xff,
      vr: row.vr,
      name: row.name,
      required: !!(row as { req?: boolean }).req,
    };
  }
  return out;
}

/** The bundle's own elements, by name. Offsets are within the reserved block. */
export const MRCOM_TAGS: Record<string, MrcomElement> = elementTable(PB.elements);

/** The elements of one item of MRCOMBlobSequence. */
export const MRCOM_BLOB_TAGS: Record<string, MrcomElement> = elementTable(PB.blobItem);

/** Secondary Capture attributes the carrier must set, from the schema. */
export const SC_REQUIRED: Record<string, unknown> = MRCOM_SCHEMA.secondaryCapture.required;
export const SC_SOP_CLASS_UID: string = MRCOM_SCHEMA.secondaryCapture.sopClassUID;
export const SC_TRANSFER_SYNTAX_UID: string = MRCOM_SCHEMA.secondaryCapture.transferSyntaxUID;
/** Attributes a Secondary Capture must NOT carry, and why. */
export const SC_FORBIDDEN: Record<string, string> = MRCOM_SCHEMA.secondaryCapture.forbidden;

// --- modes -------------------------------------------------------------------------------------

/** How a bundle carries its bulk. See docs/MRCOM-SCENE-BUNDLE.md section 5.1. */
export type MrcomMode = "embed" | "reference" | "hybrid";

/**
 * What a caller asks for. "auto" resolves to "hybrid": reference the image series, embed the
 * authored bulk. A CT series already exists in an archive; a painted segmentation exists nowhere
 * else, so embedding the first is waste and referencing the second is data loss.
 */
export type MrcomModeRequest = MrcomMode | "auto";

/** The CS value written to MRCOMBundleMode. */
export const modeToCS = (mode: MrcomMode): string => mode.toUpperCase();

/** Parse MRCOMBundleMode, case-insensitively. */
export function modeFromCS(value: string | undefined): MrcomMode | null {
  const v = (value ?? "").trim().toLowerCase();
  return v === "embed" || v === "reference" || v === "hybrid" ? v : null;
}

// --- the manifest ------------------------------------------------------------------------------

export type MrcomEncoding = "none" | "deflate";

/** One location hint. Ordered: fast path first, durable path second. NEVER holds credentials. */
export interface RetrieveHint {
  scheme: string;
  [key: string]: unknown;
}

/** Where a referenced object came from, and how to get it back. */
export interface DicomSourceRef extends MrsonDicomRef {
  /** The mrson node this bulk belongs to. */
  nodeId?: string;
}

/** A source with no DICOM origin: a remote content-addressed blob store. */
export interface BlobBaseSource {
  kind: "blob-base";
  url: string;
}

export type MrcomSource = DicomSourceRef | BlobBaseSource;

/** A hash the scene names that is NOT in this instance. */
export interface RequiredBulk {
  hash: string;
  bytes?: number;
  /** The mrson nodes that reach it. */
  nodes?: string[];
  /** For a zarr chunk, its "k.j.i" grid coordinate. */
  grid?: string;
}

/**
 * The contract between writer and reader, carried uncompressed in MRCOMManifest so a reader can
 * decide whether it can open a bundle from a prefix read - without touching the payload or the
 * pixels. docs/MRCOM-SCENE-BUNDLE.md section 4.
 */
export interface MrcomManifest {
  mrcom: 1;
  mode: MrcomMode;
  bundleUID?: string;
  created?: string;
  producer?: { name: string; version?: string; mrson?: number };
  scene: {
    length: number;
    encoding: MrcomEncoding;
    /** BARE hex sha256 of the DECODED scene JSON. */
    digest: string;
    nodes?: number;
    blobBase?: string;
  };
  context?: {
    studyInstanceUID?: string;
    patientID?: string;
    /** MUST equal ReferencedSeriesSequence item 0 - the normative primary parent. */
    primaryParentSeries?: string;
  };
  bulk?: {
    embedded?: { count: number; bytes: number };
    required?: RequiredBulk[];
    sources?: MrcomSource[];
  };
  screenshot?: { rows: number; columns: number };
}

// --- reachability ------------------------------------------------------------------------------

/**
 * Every blob hash the manifest says a reader still has to fetch.
 *
 * @param manifest the bundle manifest
 * @returns the hashes, in manifest order
 */
export function requiredHashes(manifest: MrcomManifest): string[] {
  return (manifest.bulk?.required ?? []).map((r) => r.hash);
}

/** The DICOM sources a manifest names, excluding a blob-base entry. */
export function dicomSources(manifest: MrcomManifest): DicomSourceRef[] {
  return (manifest.bulk?.sources ?? []).filter(
    (s): s is DicomSourceRef => (s as { kind?: string }).kind !== "blob-base",
  );
}

/** The remote blob store a manifest names, if any. */
export function blobBaseSource(manifest: MrcomManifest): string | null {
  const found = (manifest.bulk?.sources ?? []).find(
    (s): s is BlobBaseSource => (s as { kind?: string }).kind === "blob-base",
  );
  return found ? found.url : null;
}

/**
 * The DICOM source descriptor a node declares, if it has one. In reference mode this is what stands
 * in for the node's bulk, and what a resolver verifies against before accepting re-reconstructed
 * data (docs/MRCOM-SCENE-BUNDLE.md section 6.1).
 */
export function nodeDicomRef(node: MrsonNode): MrsonDicomRef | undefined {
  const ref = (node as unknown as Record<string, unknown>).dicom;
  return ref && typeof ref === "object" ? (ref as MrsonDicomRef) : undefined;
}

/** A DICOM-ish datetime, YYYYMMDDTHHMMSS, for the manifest's `created`. */
export function mrcomTimestamp(at: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `T${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}
