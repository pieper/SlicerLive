# mrson + LiveScene — a schema'd, Slicer-independent scene format with incremental updates

Status: **architecture planning (2026-07-28).** Not built. Formalizes and extends what already exists —
does not replace it.

> **Goal (verbatim intent).** Standardize the JSON scene representation. Keep **LiveScene** as the
> SlicerLive protocol brand, and introduce **mrson** — *Medical Reality Scripted Object Notation* — a
> fully-schema'd JSON conversion of MRML that is **not Slicer-specific**, supports **incremental
> updates**, and serves three roles at once: (1) the export format from 3D Slicer for LiveStory, (2) a
> wire format to **synchronize** cooperating systems (Slicer↔SlicerLive, SlicerLive↔SlicerLive), and
> (3) the **in-memory** representation for cooperating processes sharing data through shared memory —
> for loop impedance-matching, robustness, and parallelization.

## 0. We are not starting from scratch

The scene files the gallery already loads *are* the format. Every scene is:

```json
{ "blobBase": "<url-or-relative-dir>/",
  "nodes": { "<nodeId>": { "id", "class", "name", "refs":{role:[id,…]}, "attrs":{…}, "blobs":{role:{hash,…}} }, … } }
```

and the architecture corpus already **names this "LiveScene"** and specifies it as a **two-channel
protocol** ([`ARCHITECTURE.md`](ARCHITECTURE.md) §2): a **node-state channel** (JSON, one record per
MRML node — the scene graph as a document graph) + a **content-addressed blob channel** (`hash → bytes`,
immutable-by-hash). It already commits to: content-addressing as the load-bearing enabler; refs =
closure (the reference-reachable sub-graph = the unit of replication); hub-authoritative with a
per-node single-writer **interaction lease**, role priority `human > agent > module > automated`,
Lamport-LWW `(logicalTime, origin, role)` fallback (never wall-clock); a WS **hot-channel** for
interaction deltas; and four transport bindings (HTTP✅, WS✅, shared-memory❌, p2p❌). CouchDB/CRDT are
**deferred behind a gating question**, not adopted. See also [`MRML-COUCH-DESIGN.md`](MRML-COUCH-DESIGN.md)
(doc-per-node, hot/cold split, drop-to-latest, echo suppression) and the vocabulary map in
`ARCHITECTURE.md §Appendix`.

**So mrson is not a new architecture. It is three concrete additions the corpus already asks for but
hasn't specified:** (1) a *written schema* for the node-state document, (2) a *real incremental/delta
serialization* (today Slicer re-emits the whole scene; only `.story.json` pages and the WS hot-channel
are delta-like), and (3) unifying volume bulk onto the content-addressed channel per the stated "bulk
referenced by hash, never inlined" principle.

## 1. Naming: LiveScene is the protocol; mrson is the format (two layers)

Keep both — they name different layers, and the split is the point:

| | **LiveScene** | **mrson** |
|---|---|---|
| what | the SlicerLive **protocol + runtime**: channels, closures, authority/lease, transport bindings, RenderMode, the tiered loops | the **document + operation format**: the schema of a node record and of an incremental patch |
| analogy | "HTTP / the Language Server Protocol" | "JSON / JSON-RPC payload" |
| branding | SlicerLive-specific (fits LiveRenderer/LiveInterface/LiveModule) | **vendor-neutral** — the thing a *non-Slicer* system adopts |
| scope | how state moves + who may write it | what the bytes on the wire / in shared memory mean |

Recommendation: **MRML → mrson** is the export; **LiveScene** is the protocol that transports and
mirrors mrson documents + operations across places. A file is `scene.mrson.json` (or `.mrson`); a
running SlicerLive session is a LiveScene of mrson nodes. This lets mrson be pushed as a portable
standard (the stated non-Slicer goal) while LiveScene stays the SlicerLive system brand.

The **"scripted"** in the name is load-bearing: mrson is not only a static document. It defines both a
**materialized document** (snapshot state) *and* a **stream of scripted operations** (the incremental
updates) — the two faces of the CQRS/event-sourcing fork the corpus flagged ([`MRML-COUCH-DESIGN.md`](MRML-COUCH-DESIGN.md)
§6b/§10.3). See §3.

## 2. The mrson document (materialized state)

A JSON-Schema'd formalization of the current format, reconciling its three known inconsistencies.

**Envelope.** `{ "mrson": "<semver>", "blobBase": "<dir-or-url>/", "nodes": { <id>: <Node> } }`
(`blobBase` resolves relative to the document, not the page). A bare `{<id>:Node}` map stays accepted
for back-compat.

**Node record.** `{ id, class, name?, refs?, attrs, blobs? }`
- `class` — the MRML class name verbatim (`vtkMRMLScalarVolumeNode`, …). It is the schema discriminator.
- `refs` — the graph edges, **always arrays of node-id strings keyed by MRML reference role**
  (`"display":[…]`, `"volumeProperty":[…]`, `"transform":[…]`, `"referenceImageGeometryRef":[…]`), even
  for a single target. Reconstructed generically from MRML's own reference roles → faithful even where
  per-class `attrs` are shallow.
- `attrs` — class-specific state, schema'd per class (§4).
- `blobs` — **always a map** `{ role: BulkRef }` (fix: the current serializer emits `[]` for empty; the
  schema mandates `{}`).

**Invariants (schema-enforced, from the coordinate-discipline + code):**
- Matrices are **flat row-major 4×4 (16 floats)**; internal space is **RAS**; markup positions are RAS
  world; `ijkToRAS` comes straight from metadata and folds any linear parent transform to world.
- Volume `shape` is C-order `[nz,ny,nx]`; `dims` is `[nx,ny,nz]` — both present, deliberately.
- **Bulk descriptors** are one of two shapes, both reused everywhere:
  `BulkRef(hash) = {hash, dtype, count, comps, size}` (content-addressed) or
  `BulkRef(zarr) = {dir, dataset, shape, chunks, chunkGrid, dtype, bytes}` (chunked).

**Reconciliation the schema forces (the current gaps):**
1. `blobs` is a map, never a list.
2. **Volume bulk moves onto the content-addressed channel.** Today volume voxels live in `attrs.zarr`
   (chunk files by grid index) while meshes use hash blobs — divergent from "bulk by hash, never
   inlined." mrson keeps `zarr` as a *chunk layout* but each chunk is content-addressed, so the whole
   principle (dedup, immutable-by-hash, shared-memory arena, delta store) applies to volumes too. (This
   is the one real data-model change; everything else is tightening.)
3. The schema covers the **full node set the shipped scenes use**, not just the current serializer's
   subset (which drops Model/Segmentation/View/SliceComposite/Transform/ColorTable — see §4).

## 3. mrson increments (the "scripted" / delta face)

The unit of incremental update — for network sync, shared memory, LiveStory scripting, and undo.

**Operation.** `{ op, id, class?, path?, value?, v, origin, role }`
- `op ∈ { put, patch, del, cmd }` — replace a node, field-patch a node (JSON-Pointer `path` + `value`),
  delete a node, or a semantic command (e.g. `paint`, `seedSegment` — a LiveModule input).
- `v` = Lamport `(logicalTime, origin)`; `role` for priority. **Never wall-clock.**
- Blob-valued fields carry a **hash**, so an op is small even when it swaps a 14 GB volume; the bytes
  flow on the content-addressed channel out of band. A sub-region edit (segmentation paint) uses a
  **hash + delta-against-parent-hash** so it doesn't re-ship the whole blob.

**Discipline (reuse the committed authority model — do not re-derive):** per-node single-writer
**lease**; **drop-to-latest / coalesce, never queue** at the sync rate; **echo suppression** (never
republish a change you just applied — tag by `origin`+`v`); Lamport-LWW on the uncontended fallback;
CRDT only if peerless same-node concurrent editing becomes real (it rarely does — peers own different
nodes/views).

**The materialized-vs-log fork (decide once, cite in the doc):** mrson supports both. A place can hold
the **materialized document** (fast to mirror, what renderers need) and *optionally* keep the
**append-only op log** as source of truth (CQRS — enables undo/redo, replay, migration). Recommendation:
**materialized state is the default mirror; the op log is opt-in per closure** (the hub keeps it;
LiveRenderer places don't need it). This matches "hub-authoritative now."

**Prior art already in the tree:** a `.story.json` **page** *is* a coarse mrson patch — a `{camera,
slices, visibility{nodeId:0|1}}` delta over a named scene, plus narrative. LiveStory should re-express a
page as an mrson op-set (a named checkpoint = a labeled group of `patch` ops) so story authoring and
live sync use one delta model.

## 4. Schema coverage — the node set (union of serializer + shipped scenes + displayer survey)

One schema file per class (or one file, `oneOf` on `class`). Minimal covering set:

- **Data:** `ScalarVolume` (`zarr|blob` + `dims` + `comps` + `ijkToRAS`), `Segmentation`
  (`segments[{id,name,color,mesh{points,polys,normals}}]` + `labelmap` blob + geometry refs), `Model`
  (geometry in `blobs{points,polys,normals}`).
- **Display/appearance:** `ScalarVolumeDisplay` (`visibility`,`visibility3D`,`window`,`level`,`color`,
  `opacity`), `VolumeProperty` (`shade`,`interpolationType`, `color`/`scalarOpacity`/`gradientOpacity`
  control-point arrays — `[scalar,r,g,b]` / `[scalar,a]`), `GPURayCastVolumeRenderingDisplay`
  (`volumeProperty` ref, `croppingEnabled`), `SegmentationDisplay`, `SliceDisplay`, `ColorTable`
  (referenced by id).
- **Markups:** `MarkupsFiducial` (+ display) — `color` + `controlPoints[{label,position(RAS)}]`; a
  `type` discriminator reserved for line/curve/ROI/plane/angle.
- **Transforms:** `LinearTransform` (`matrixToParent[16]`); schema must **not** assume linear-only
  (the render demos already do nonlinear/TPS warps).
- **View/camera/slice:** `View`, `Camera` (`position,focalPoint,viewUp,viewAngle,parallel*`), `Slice`
  (`sliceToRAS[16]`,`xyToRAS[16]`,`dimensions`,`fieldOfView`,`orientation`), `SliceComposite`
  (background/foreground/label volume refs + opacities).
- **Story layer** (separate `*.story.mrson`, not MRML-node-shaped): ordered `pages[]`, each a labeled
  op-set + narrative — see §3.

## 5. The three roles = three bindings of one format

| role | today | with mrson |
|---|---|---|
| **Slicer export (LiveStory)** | `serialize.py` re-emits the whole scene, one-shot | MRML → mrson **document** on export; MRML node observers → mrson **ops** for live push. Widen to the full node set; fix `blobs` map + content-address volume chunks. |
| **Network sync** (Slicer↔SL, SL↔SL) | HTTP bucket (cold, ✅) + WS hot-channel (deltas, ✅) | Both carry mrson: HTTP serves the document + `blob?hash=`; WS carries mrson ops. Same authority model. SL↔SL is symmetric — both are LiveScene places mirroring the same closure. |
| **Shared memory** (cooperating processes) | ❌ | mrson node-state in a **seqlock'd region** (read-version → read → re-read-version, retry on change); blobs in a mapped **hash arena** (write-once-by-hash → readers of `abc` never block a writer producing `def` — no locks on the big volume, ever). The WebServer owns the arena + GC + is the SHM→HTTP/WS bridge for browsers (which can't map SHM). This is the substrate for **loop impedance-matching + parallelization**: each Tier-A/B/C loop (interaction architecture §4) reads/writes the same mrson state at its own rate, coupled only through it — the same discipline `SceneRenderer.syncUniforms` already realizes locally (mrson node-state variable → GPU uniform, `ARCHITECTURE-2026-07-24.md §7`). |

## 6. Phasing (small, verifiable steps)

- **P1 — Write the schema.** JSON Schema for the node record + the covering class set (§4), matching the
  shipped scenes. Validate every existing `live/scenes/*.json` and `legacy/scenes/*.json` against it;
  fix the `blobs` list→map + zarr/hash inconsistencies in the format, add a `mrson` version field.
  (No behavior change — the loader already parses this; the schema just pins it.)
- **P2 — Widen + version the Slicer exporter.** `serialize.py` covers the full node set again
  (Model/Segmentation/View/SliceComposite/Transform/ColorTable) and stamps `mrson` + Lamport `v` per
  node. Validate its output against P1's schema in CI.
- **P3 — mrson ops.** Define the op record (§3) + a tiny apply/patch library shared by TS + Python;
  re-express a `.story.json` page as an op-set; make the WS hot-channel carry mrson ops (it already
  carries deltas — formalize the payload). Lease + drop-to-latest + echo-suppression reused.
- **P4 — SHM binding.** The seqlock node-state region + hash arena (§5) behind the WebServer; prove it
  with two local processes (renderer + a module) sharing one mrson scene without copying the volume.
- **P5 — content-address volume chunks** (the one data-model change), enabling dedup/delta/SHM for
  volumes uniformly.

## 7. Open decisions (yours to call)

1. **Name push:** ship `mrson` as a public, versioned, Slicer-independent spec (own repo/schema URL), or
   keep it internal to SlicerLive? (Recommendation: public spec, since non-Slicer adoption is the point.)
2. **Op log as source of truth (CQRS)** per-closure opt-in vs never — affects undo/redo + replay
   (§3). Recommendation: opt-in, hub keeps it.
3. **Content-addressing volumes now (P5) or later** — it's the one real change to the on-disk data model.
4. **mrson identity vs MRML:** stay a faithful 1:1 MRML mirror (class names verbatim), or allow
   Slicer-independent abstractions (e.g. a neutral `Volume`/`TransferFunction` vocabulary) with an
   MRML↔mrson mapping table? (Faithful-mirror is simpler and reversible; a neutral vocabulary is more
   "not-Slicer-specific" but needs a bidirectional mapping.) This is the deepest fork — it decides
   whether mrson is "MRML-as-JSON" or "a new medical-scene standard that MRML happens to map onto."

## 8. References
- `docs/ARCHITECTURE.md` §2 (LiveScene two-channel protocol), §5 (authority/lease/Lamport), §6
  (content-addressing + shared memory), §Appendix (vocabulary map).
- `docs/MRML-COUCH-DESIGN.md` §3–4 (doc-per-node, hot/cold), §6a–c (echo/lease/drop-to-latest), §6b/§10.3
  (event-sourcing/CQRS fork), §2/§8 (blob delta encoding), §10 (deferred, gating question).
- `docs/DISTRIBUTED-MRML-ARCHITECTURE.md` (closure = unit of distribution).
- `docs/ARCHITECTURE-2026-07-24.md` §4 (interaction tiers = loop impedance), §7 (LiveScene var → GPU uniform).
- Producer `LiveStory/LiveStoryLib/serialize.py` + `story.py`; consumer `render/scene-volume.ts`.
- Sample scenes: `live/scenes/CTACardio.json`, `live/legacy/scenes/{MRHead.json, MRHead.story.json, TotalSegmentator-CT.json}`.
