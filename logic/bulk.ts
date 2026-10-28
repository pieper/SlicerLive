// Walking the bulk an mrson scene reaches: the reachable closure, which is the unit of
// replication, of export, and of an MRCOM bundle.
//
// These are pure functions over mrson nodes and they used to live in render/sessions/session-store.ts,
// which transitively imports session-fs.ts and its DOM types. logic/mrcom/* has to stay DOM-free so
// SlicerAlbula's Deno server can import it (docs/MRCOM-PLAN.md section 5), and by this repo's own
// convention DOM-free testable logic belongs in logic/. session-store.ts re-exports them, so every
// existing caller is unchanged.
//
// The field list mirrors `bulkFields` in mrson/schema/bulk.schema.json. If the two disagree, an
// export silently drops bulk - which is exactly how the missing `normals` walk shipped.

import type { MrsonDicomRef, MrsonNode } from "../render/mrson.ts";

/** Flat node fields that can hold a content-addressed blob name. Mirrors `bulkFields` in
 *  mrson/schema/bulk.schema.json — if the two disagree, an export silently drops bulk.
 *  (`normals` was missing here while the schema listed it: a mesh's normals were reachable in the
 *  scene and absent from every export. mrson/conformance.test.ts now pins this both ways.) */
const BULK_FIELDS = ["points", "triangles", "polys", "normals", "labelmap"] as const;

const addIfHash = (refs: Set<string>, v: unknown): void => {
  if (typeof v === "string" && v.startsWith("sha256-")) refs.add(v);
};

/** One bulk item a scene reaches, with where it came from. The MRCOM writer needs exactly this to
 *  split the closure into "embed these" (no DICOM origin — a painted segmentation, a mesh, markups)
 *  and "reference those" (the image series an archive already holds). Lives beside blobRefs() so the
 *  reachability rules stay in one place and cannot disagree. */
export interface BulkSource {
  hash: string;
  nodeId: string;
  /** For a zarr chunk, its "k.j.i" grid coordinate; absent for a whole-array blob. */
  grid?: string;
  /** The node field or `blobs` role the descriptor sat in, e.g. "zarr", "points", "blobs/normals". */
  field: string;
  /** Present when the owning node declares a DICOM origin, i.e. this bulk is referenceable. */
  dicom?: MrsonDicomRef;
}

/** Every blob the given nodes reach, each tagged with its owning node, field and DICOM origin. */
export function bulkSources(nodes: MrsonNode[]): BulkSource[] {
  const out: BulkSource[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const rec = n as unknown as Record<string, unknown>;
    const dicom = rec.dicom as MrsonDicomRef | undefined;
    const push = (hash: string, field: string, grid?: string) => {
      const key = `${hash}\u0000${n.id}\u0000${field}\u0000${grid ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ hash, nodeId: n.id, field, ...(grid ? { grid } : {}), ...(dicom ? { dicom } : {}) });
    };
    const walk = (v: unknown, field: string) => {
      if (typeof v === "string") { if (v.startsWith("sha256-")) push(v, field); return; }
      if (!v || typeof v !== "object") return;
      const o = v as { chunkHashes?: Record<string, string>; hash?: unknown };
      if (o.chunkHashes) for (const [grid, h] of Object.entries(o.chunkHashes)) { if (typeof h === "string") push(h, field, grid); }
      if (typeof o.hash === "string") push(o.hash, field);
    };
    walk(rec.zarr, "zarr");
    for (const k of BULK_FIELDS) walk(rec[k], k);
    const blobs = rec.blobs;
    if (blobs && typeof blobs === "object" && !Array.isArray(blobs)) {
      for (const [role, v] of Object.entries(blobs as Record<string, unknown>)) walk(v, `blobs/${role}`);
    }
  }
  return out;
}

/** Every blob the given nodes reach: the reachable closure, and the unit of replication/export. */
export function blobRefs(nodes: MrsonNode[]): Set<string> {
  const refs = new Set<string>();
  const addBulk = (v: unknown): void => {
    if (typeof v === "string") return addIfHash(refs, v);
    if (!v || typeof v !== "object") return;
    const o = v as { chunkHashes?: Record<string, string>; hash?: unknown };
    // a zarr descriptor: every chunk is its own blob
    if (o.chunkHashes) for (const h of Object.values(o.chunkHashes)) addIfHash(refs, h);
    // the legacy BulkRef(hash) form { hash, dtype, count, comps, size } — a bare 32-hex name, so it
    // is added verbatim rather than through the sha256- filter.
    if (typeof o.hash === "string") refs.add(o.hash);
  };
  for (const n of nodes) {
    const rec = n as unknown as Record<string, unknown>;
    addBulk(rec.zarr);
    for (const k of BULK_FIELDS) addBulk(rec[k]);
    // `blobs` map: { role: BulkRef } — any role, since mrson is an open model
    const blobs = rec.blobs;
    if (blobs && typeof blobs === "object" && !Array.isArray(blobs)) {
      for (const v of Object.values(blobs as Record<string, unknown>)) addBulk(v);
    }
  }
  return refs;
}
