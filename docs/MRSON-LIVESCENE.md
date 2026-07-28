# mrson + LiveScene — a schema'd, platform-neutral scene format with incremental updates

Status: **architecture planning (2026-07-28).** Not built. Formalizes and extends what already exists —
does not replace it. **Decision (2026-07-28, resolves §7.4):** mrson is a **platform-neutral
medical-reality model in its own right** that *draws on decades of MRML* but **strips the 3D-Slicer-
specific cruft** — not "MRML-as-JSON." It targets the use cases that previously relied on in-memory
Slicer/VTK C++ semantics or OpenIGTLink abstractions, and it carries DICOM forward **losslessly** while
treating DICOM as an **import/export/archival** boundary — the **MRCOM** binding (*Medical Reality
Communications*, §1b) that rides VNA/DIMSE/dicomWeb — never a runtime constraint (see §1a).

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

## 1a. Design commitment — a neutral medical-reality model (not MRML-as-JSON)

mrson takes the lead as its own standard. It keeps what decades of MRML got *right* (a
reference-linked graph of typed objects, RAS world space, separation of data from display, a live
scene others observe) and drops what is Slicer/VTK-implementation cruft (`vtkMRML…` class names as the
type; the display-node explosion; layout/singleton conventions; storage-node bookkeeping; node-ID
formats). The test for every field: *is this a fact about the medical reality, or an artifact of one
program's C++ object graph?* Only the former survives.

**Neutral typing.** An object's `type` is a **neutral noun**, not a class name:

| mrson `type` | subsumes (MRML / OpenIGTLink / DICOM) |
|---|---|
| `image` | Scalar/Vector/DiffusionVolume · IGTL `IMAGE`/`NDARRAY`/`IMGMETA` · DICOM image/multiframe/enhanced |
| `transform` | Linear/BSpline/Grid/Thin-plate transforms · IGTL `TRANSFORM`/`POSITION`/`QTDATA` · DICOM Spatial Registration / Frame-of-Reference |
| `mesh` | Model · IGTL `POLYDATA` · DICOM Surface / encapsulated geometry |
| `segmentation` | Segmentation (labelmap + closed surfaces + terminology) · DICOM SEG / RTSTRUCT |
| `markup` (`kind`: point\|line\|curve\|plane\|roi\|angle) | Markups · IGTL `POINT` · DICOM presentation-state annotations / SR-linked measurements |
| `field` (transfer function / colormap / VOI) | VolumeProperty + Color nodes + display · DICOM VOI-LUT / Presentation State / Palette |
| `camera`·`view`·`slice`·`layout` | Camera/View/Slice/Layout nodes · DICOM Hanging Protocol (loosely) |
| `stream` | *(new — the realtime face)* IGTL `TDATA`/`TRACKINGDATA`/`SENSOR`/live `IMAGE` |
| `text`·`status`·`command` | Text/Table nodes · IGTL `STRING`/`STATUS`/`COMMAND` |
| `subject`·`study`·`series` | Subject-hierarchy folders · DICOM Patient/Study/Series |

**Neutral envelope** (extends §2's record): `{ id, type, name?, frame?, refs?, attrs, blobs?, dicom?, source? }`.
- `type` is neutral; `attrs` is schema'd per type (not per vtk class).
- `frame` names the **frame of reference** the object lives in; mrson tracks frames + the `transform`s
  between them explicitly (a DICOM Frame-of-Reference UID becomes a named frame). World is **RAS**.
- `dicom?` / `source?` — lossless carry-forward + provenance (below). Runtime never reads them.

**Subsuming in-memory Slicer/VTK C++ semantics.** What the C++ object graph gave you — a live scene of
reference-linked nodes, displayable managers reacting to node changes, a modified-event bus, transform
hierarchies composed to world — mrson provides *as data + protocol*: the node graph is the mrson
document; the modified-event bus is the **op stream** (§3); the displayable-manager reaction is a
`place` applying ops (`onNodeUpdate`/`onNodeRemove`); transform composition is `frame`→`frame`
`transform`s resolved to world. So a process that used to embed Slicer to hold a scene can instead hold
an mrson scene (in memory, or in the shared-memory arena, §5) — no C++, no VTK, no Qt.

**Subsuming OpenIGTLink.** IGTLink is a realtime *message* protocol (a `TRANSFORM` at 60 Hz, an
`IMAGE`, `TDATA`). mrson's `stream` objects + the op channel (patch ops at rate, Lamport-versioned,
drop-to-latest — §3) **are** that realtime channel, but stateful and schema'd rather than a bare
message. Mapping: IGTL `TRANSFORM`→`transform` patch op; `TDATA`/`QTDATA`→a `stream` of transform
patches; live `IMAGE`→`image` sample op (new hash per frame); `POINT`→`markup`; `POLYDATA`→`mesh`;
`STRING`/`STATUS`→`text`/`status`; `COMMAND`→`cmd` op; `CAPABILITY`→the participant contract's
capability set. **LiveScene-over-WS with mrson ops is the successor transport;** an IGTL bridge stays as
an interop/import path (the `source:"igtl"` boundary), the same status DICOM gets.

**DICOM stance — a boundary, not a runtime.**
- **Lossless carry-forward.** On import, an object keeps a `dicom` bag of its source attributes
  (`{ sopClassUID, frameOfReferenceUID, uids:{patient,study,series,instance}, tags:{…} }`) — enough to
  **round-trip back to DICOM byte-for-byte** where required (archival, clinical hand-off). Runtime uses
  mrson's own clean fields; the bag is inert metadata.
- **Use DICOM conventions where they're good and not limiting.** Coded terminology (segment names,
  anatomy, units) uses DICOM/SNOMED code tuples `{scheme, value, meaning}`; the Patient/Study/Series
  hierarchy maps to `subject`/`study`/`series` grouping objects; Frame-of-Reference UIDs seed mrson
  `frame`s so spatial relationships survive.
- **Reject DICOM where it limits research/expressiveness/performance.** Runtime space is **RAS**, not
  DICOM **LPS** (the LPS↔RAS map lives only at the import/export boundary, consistent with the
  non-negotiable coordinate discipline — no flips at runtime); bulk pixels are **content-addressed
  chunked arrays** (zarr/hash, streamable, dedup'd, GPU-ready), not DICOM transfer syntaxes/tag soup;
  the object model is open (arbitrary `attrs`, new `type`s, a `stream` concept DICOM has no equivalent
  for), not the fixed IOD lattice. DICOM is how data *arrives and is archived*, never how it *runs*.

**Provenance is first-class.** `source: { from: "dicom"|"mrml"|"igtl"|"native", … }` records where an
object entered mrson, so any boundary (DICOM export, IGTL bridge, Slicer round-trip) can reconstruct
faithfully and so research edits are traceable. This is what lets mrson be *lossless across* formats
without being *constrained by* any of them.

## 1b. MRCOM — the DICOM binding (Medical Reality Communications)

The DICOM boundary of §1a gets a name and a design: **MRCOM** = *Medical Reality Communications* — the
DICOM-facing binding of mrson, deliberately parallel to DICOM (*Digital Imaging and Communications in
Medicine*). Where mrson/LiveScene is the research/runtime world, **MRCOM is how Medical Reality rides the
entire installed base of medical-imaging infrastructure** — no new archives, networks, or web services
to deploy. It has two parts:

**(1) The directly-mappable subset (`profile: "dicom"`).** The subset of mrson `type`s + `attrs` with
exact DICOM IOD equivalents, which round-trip losslessly (with the §1a `dicom` bag):

| mrson | DICOM IOD |
|---|---|
| `image` | CT/MR/PET/US, Enhanced/Multiframe, Secondary Capture |
| `segmentation` | Segmentation (SEG), RT Structure Set |
| `mesh` | Surface Segmentation / Encapsulated 3D (STL/OBJ) |
| `markup` (measurements/annotations) | SR (TID 1500 measurements), Presentation State (GSPS) |
| `field` (window/level, VOI, palette) | VOI-LUT, Presentation State, Palette Color LUT |
| `transform` | Spatial Registration / Deformable Registration |
| `frame` | Frame-of-Reference UID |
| `subject`/`study`/`series` | Patient / Study / Series |

**(2) Coercion of the extra metadata.** mrson is more expressive than any IOD (arbitrary `attrs`, `stream`,
neutral vocabulary, research fields). MRCOM carries the surplus in DICOM-legal containers so nothing is
lost and plain DICOM systems still work — **graceful degradation**:
- structured extras → a **registered MRCOM private block** (private creator + odd-group tags);
- the **whole mrson closure** → an **encapsulated companion instance** (mrson JSON as an encapsulated
  document, referencing the standard instances it accompanies). A DICOM-only viewer sees the mappable
  subset; an **MRCOM-aware reader pulls the companion and reconstitutes full-fidelity mrson.**

**Reusing the three DICOM transports (no new plumbing):**
- **VNA** — MRCOM objects are just DICOM instances, so any Vendor-Neutral Archive stores/retrieves them
  (including the encapsulated mrson companion) — long-term archival for free.
- **DIMSE** — C-STORE / C-FIND / C-MOVE / C-GET over existing PACS networks move MRCOM objects.
- **dicomWeb** — STOW-RS (store) / QIDO-RS (query) / WADO-RS (retrieve). This is the natural fit for the
  web-native stack: dicomWeb is HTTP+JSON, alongside the content-addressed bucket channel; a SlicerLive
  place can pull an existing study straight from a dicomWeb server and lift it into mrson at the edge.

**Where MRCOM sits.** It is one **transport binding** of the format (§5), the DICOM-infrastructure
binding — peer to HTTP-bucket, WS-hot-channel, SHM, and p2p. Directionally: **mrson/LiveScene for
research + interaction + realtime; MRCOM for import, clinical hand-off, and archival.** DICOM (via
MRCOM) is how content *enters and is stored*; it never dictates how content *runs* (§1a). MRCOM is P6.

## 2. The mrson document (materialized state)

A JSON-Schema'd formalization of the current format, reconciling its three known inconsistencies.

**Envelope.** `{ "mrson": "<semver>", "blobBase": "<dir-or-url>/", "nodes": { <id>: <Node> } }`
(`blobBase` resolves relative to the document, not the page). A bare `{<id>:Node}` map stays accepted
for back-compat.

**Node record.** `{ id, type, name?, frame?, refs?, attrs, blobs?, dicom?, source? }` (the §1a neutral
envelope).
- `type` — the **neutral** discriminator (`image`, `transform`, `mesh`, … — §1a), not a `vtkMRML…`
  class. The original MRML class (when the object came from Slicer) is carried in `source`, not used at
  runtime. *(Transitional: the shipped scenes still key on `class`; the P1 schema accepts both and the
  P2 exporter emits neutral `type` + `source.mrmlClass`.)*
- `refs` — the graph edges, **always arrays of node-id strings keyed by a neutral role**
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

One schema per **neutral `type`** (`oneOf` on `type`, §1a); the class names below are the MRML sources
each neutral type absorbs. Minimal covering set:

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

## 5. The roles = transport bindings of one format

| role | today | with mrson |
|---|---|---|
| **Slicer export (LiveStory)** | `serialize.py` re-emits the whole scene, one-shot | MRML → mrson **document** on export; MRML node observers → mrson **ops** for live push. Widen to the full node set; fix `blobs` map + content-address volume chunks. |
| **Network sync** (Slicer↔SL, SL↔SL) | HTTP bucket (cold, ✅) + WS hot-channel (deltas, ✅) | Both carry mrson: HTTP serves the document + `blob?hash=`; WS carries mrson ops. Same authority model. SL↔SL is symmetric — both are LiveScene places mirroring the same closure. |
| **Shared memory** (cooperating processes) | ❌ | mrson node-state in a **seqlock'd region** (read-version → read → re-read-version, retry on change); blobs in a mapped **hash arena** (write-once-by-hash → readers of `abc` never block a writer producing `def` — no locks on the big volume, ever). The WebServer owns the arena + GC + is the SHM→HTTP/WS bridge for browsers (which can't map SHM). This is the substrate for **loop impedance-matching + parallelization**: each Tier-A/B/C loop (interaction architecture §4) reads/writes the same mrson state at its own rate, coupled only through it — the same discipline `SceneRenderer.syncUniforms` already realizes locally (mrson node-state variable → GPU uniform, `ARCHITECTURE-2026-07-24.md §7`). |
| **DICOM infrastructure — MRCOM** (§1b) | ❌ | The DICOM binding: mappable subset ↔ IODs + extra metadata coerced into a private block / encapsulated mrson companion, riding **VNA** (archive), **DIMSE** (PACS network), **dicomWeb** (STOW/QIDO/WADO). For import, clinical hand-off, archival — *not* the runtime path. |

## 6. Phasing (small, verifiable steps)

- **P1 — Write the schema.** JSON Schema for the node record + the covering class set (§4), matching the
  shipped scenes. Validate every existing `live/scenes/*.json` and `legacy/scenes/*.json` against it;
  fix the `blobs` list→map + zarr/hash inconsistencies in the format, add a `mrson` version field.
  (No behavior change — the loader already parses this; the schema just pins it.)
- **P2 — Widen + neutralize + version the Slicer exporter.** `serialize.py` covers the full node set
  again (Model/Segmentation/View/SliceComposite/Transform/ColorTable), emits **neutral `type`** +
  `source.mrmlClass` (§1a), and stamps `mrson` + Lamport `v` per node. Validate against P1's schema in CI.
- **P3 — mrson ops.** Define the op record (§3) + a tiny apply/patch library shared by TS + Python;
  re-express a `.story.json` page as an op-set; make the WS hot-channel carry mrson ops (it already
  carries deltas — formalize the payload). Lease + drop-to-latest + echo-suppression reused.
- **P4 — SHM binding.** The seqlock node-state region + hash arena (§5) behind the WebServer; prove it
  with two local processes (renderer + a module) sharing one mrson scene without copying the volume.
- **P5 — content-address volume chunks** (the one data-model change), enabling dedup/delta/SHM for
  volumes uniformly.
- **P6 — boundary adapters: MRCOM + IGTL.** **MRCOM** (§1b): the DICOM-mappable subset round-trip +
  extra-metadata coercion (private block + encapsulated mrson companion), tested over dicomWeb
  (STOW/QIDO/WADO) first — pull an existing study into mrson and store an mrson-carrying study back.
  Plus an OpenIGTLink bridge (`stream`/`transform`/`image` ↔ IGTL). These prove "boundary, not runtime"
  (§1a) and let mrson ride the installed base without adopting either format's constraints.

## 7. Decisions

**Resolved (2026-07-28):**
- **Neutral standard, not MRML-mirror** (was the deepest fork) — mrson is its own platform-neutral model
  (§1a); MRML / OpenIGTLink / DICOM are *sources it maps to/from*, not its identity.
- **Public spec** — mrson ships as a public, versioned, Slicer-independent specification (own schema
  URL / repo). Slicer (via LiveStory) becomes *one producer* of mrson, not its definition.
- **DICOM = boundary, RAS runtime** — lossless carry-forward + DICOM conventions where non-limiting;
  DICOM never constrains runtime space / performance / expressiveness (§1a).

**Still open (yours to call):**
1. **Op log as source of truth (CQRS)** per-closure opt-in vs never — affects undo/redo + replay (§3).
   Recommendation: opt-in, hub keeps it.
2. **Content-addressing volumes now (P5) or later** — the one real change to the on-disk data model.
3. **Neutral vocabulary depth (per type):** how far to abstract from MRML naming — e.g. is a transfer
   function a `field` appearance, a first-class `transferFunction`, or both? A per-type pass naming
   things by the *medical reality*, keeping the MRML/DICOM/IGTL mapping tables lossless. (Now a
   *vocabulary* task, no longer an *identity* fork.)
4. **Governance:** versioning + extension policy (reserved vs vendor `x-` fields) so others can adopt —
   sketch with P1.

## 8. References
- `docs/ARCHITECTURE.md` §2 (LiveScene two-channel protocol), §5 (authority/lease/Lamport), §6
  (content-addressing + shared memory), §Appendix (vocabulary map).
- `docs/MRML-COUCH-DESIGN.md` §3–4 (doc-per-node, hot/cold), §6a–c (echo/lease/drop-to-latest), §6b/§10.3
  (event-sourcing/CQRS fork), §2/§8 (blob delta encoding), §10 (deferred, gating question).
- `docs/DISTRIBUTED-MRML-ARCHITECTURE.md` (closure = unit of distribution).
- `docs/ARCHITECTURE-2026-07-24.md` §4 (interaction tiers = loop impedance), §7 (LiveScene var → GPU uniform).
- Producer `LiveStory/LiveStoryLib/serialize.py` + `story.py`; consumer `render/scene-volume.ts`.
- Sample scenes: `live/scenes/CTACardio.json`, `live/legacy/scenes/{MRHead.json, MRHead.story.json, TotalSegmentator-CT.json}`.
