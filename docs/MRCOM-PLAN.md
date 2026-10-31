# MRCOM — plan, status and how to pick it up

Status: **in progress, revised 2026-10-31.** This is the working plan for MRCOM, kept in the
repository so anyone joining the work can start from it rather than from a conversation.

Read this first, then [`MRCOM-SCENE-BUNDLE.md`](MRCOM-SCENE-BUNDLE.md) for the format itself.

> **What changed in the 2026-10-31 revision.** Bulk no longer lives in the private block by default.
> Binary segmentations are written as **DICOM SEG** objects and triangle meshes as **Surface
> Segmentation** objects; the private block carries the scene's non-bulk state. Encapsulated
> STL/OBJ is dropped entirely. A scene save now produces a **derived series**. The database work is
> reordered: File System Access to a real `ctkDICOMDatabase` comes first, then a TypeScript-native
> mirror of the same schema and API. §3 and §6 are the new parts; §4 lists what this invalidates.

---

## 1. What this is, in one paragraph

**MRCOM** (*Medical Reality Communications*) is the DICOM binding of **mrson**, SlicerLive's scene
format. Saving a scene produces a **derived series** of ordinary DICOM instances: a Secondary
Capture carrying the scene's non-bulk state in a private block (with the screenshot as its pixel
data, so any viewer shows a picture), plus a standard **SEG** per binary segmentation and a standard
**Surface Segmentation** per mesh. Source images are referenced, never copied.

The point is that lossless scene exchange rides the installed base — a VNA, a DIMSE network or a
dicomWeb server moves these without knowing anything about mrson — and that everything with a
standard DICOM representation *gets* one, so other software can use the results rather than seeing
an opaque blob. It supersedes 3D Slicer's `SlicerDataBundle` (an `.mrb` zip in private group
`0xCADB`), whose weaknesses are catalogued in [`MRCOM-SCENE-BUNDLE.md`](MRCOM-SCENE-BUNDLE.md) §9.

[`MRSON-LIVESCENE.md`](MRSON-LIVESCENE.md) §1b named this binding and marked it P6, unbuilt. This is
that work.

---

## 2. Decisions already taken

Do not re-litigate these without a reason; each cost some analysis.

| | |
|---|---|
| **Carrier** | One Secondary Capture per scene save. Screenshot as uncompressed RGB pixel data. The scene's **non-bulk** state in an MRCOM private block. |
| **Bulk** | **Standard DICOM objects wherever one exists** (§3): SEG for binary segmentations, Surface Segmentation for meshes, the source image series referenced. The private block is the fallback for bulk with no standard representation. |
| **Encapsulated STL/OBJ/MTL** | **Rejected.** Not flexible enough: an opaque document with no segment identity, no coded terminology, no per-surface colour or display state, and no frame of reference. Surface Segmentation carries all of it. |
| **A scene save is a derived series** | New instances go in a new series derived from the source, never into the source series (§3.4). |
| **Private group / creator** | `0x4D43` ("MC"), creator `"MRCOM.MRSON.1"`. Checked unclaimed against dcmjs, DCMTK (2836 entries, no `4Dxx` at all) and GDCM (only `4d4d`, its own test group). **The creator is the identity; the block number is never assumed.** |
| **Digests** | Bare lowercase hex, algorithm declared once. `"sha256-"` + 64 hex is 71 characters and `LO` is 64 — it would be silently truncated. |
| **Reference is render-lossless, not byte-lossless** | Chunk hashes cannot be reproduced bit-for-bit across versions, so a reader reconstructs, **verifies** against a recorded `voxelDigest`, re-chunks, and rewrites the descriptor with honest hashes. |
| **Resolution is pluggable** | A resolver registry keyed on a hint's `scheme`: `local-study`, `s3`, **`idc`** (REST and MCP paths), `wado-rs`. Credentialed clouds are a new file plus one registration. **Credentials are never written into a bundle.** |
| **ctkDICOMDatabase** | Read-only. **File System Access to a real database first**, then a TypeScript-native mirror of the same schema and API (§6). |
| **Slicer plugin** | pydicom, not the `dcmdump`/`dump2dcm`/`img2dcm` chain. |
| **Nothing in `logic/mrcom/` touches the DOM** | So Deno and headless callers work. The screenshot is an injected raw-pixel buffer, never a canvas grab. Enforced by `logic/mrcom/no-dom.test.ts`. |

---

## 3. Where bulk lives

This is the part that changed, and the rest of the design follows from it.

### 3.1 The rule

**Anything with a standard DICOM representation gets one.** Only what has none goes in the private
block.

| mrson | DICOM | How |
|---|---|---|
| `image` bulk | the source series | **referenced** — never copied. The archive already holds it |
| `segmentation` bulk (binary labelmap) | **Segmentation** `1.2.840.10008.5.1.4.1.1.66.4` | a **new SEG instance** in the derived series, referenced from the scene |
| `mesh` (points / triangles / normals) | **Surface Segmentation** `1.2.840.10008.5.1.4.1.1.66.5` | a **new Surface Segmentation instance** in the derived series, referenced |
| `markup` measurements and annotations | SR TID 1500 / GSPS | **deferred** (M6); carried in mrson for now |
| everything else — camera, view, slice, layout, transforms, transfer functions, colour tables, display state, segment editor state, selection | *no standard representation* | the **mrson in the private block** |

So the private block's payload is now mostly small: scene state, not voxels. That is the intended
shape. `EMBED` becomes a fallback for a self-contained single file or for bulk that cannot be written
as a standard object (§3.5), not the normal case.

### 3.2 Why, rather than embedding

A segmentation embedded as a zarr labelmap in a private tag is readable by exactly one program. The
same segmentation written as a SEG is readable by OHIF, MITK, 3D Slicer, dcmqi and any PACS that
knows the IOD, *and* carries its coded terminology, recommended display colour and algorithm
identification in attributes those tools already understand. The same argument holds for a mesh and
Surface Segmentation. MRCOM's job is to put a scene on the installed base; hiding its substance in a
private block would defeat that.

### 3.3 Why Surface Segmentation and not Encapsulated STL/OBJ

Encapsulated STL/OBJ/MTL is a *document* — an opaque file in a DICOM wrapper. It has no segment
identity, no coded terminology, no per-surface colour, no display state, and its geometry sits in
whatever space the file used rather than a declared frame of reference. Surface Segmentation has
`SurfaceSequence` with per-surface points, normals and primitives, `SegmentSequence` with
terminology and `RecommendedDisplayCIELabValue`, an algorithm identification sequence, and a
`FrameOfReferenceUID`. It is the right object, and the mrson mesh blobs map onto it almost directly:

| mrson | Surface Segmentation |
|---|---|
| `points` (float32 xyz) | `PointCoordinatesData` (0066,0016), **OF** |
| `triangles` (uint32) | `TrianglePointIndexList` (0066,0023) **OW**, or `LongTrianglePointIndexList` (0066,0041) **OL** — see §3.5 |
| `normals` (float32) | `VectorCoordinateData` (0066,0021) in `SurfacePointsNormalsSequence`, **OF** |
| segment name, colour, terminology | `SegmentSequence`, `RecommendedDisplayCIELabValue` |

DICOM triangle indices are **1-based**; mrson's are 0-based, so the writer offsets them.

### 3.4 A scene save is a derived series

New instances never go into a source series. Each scene save creates new series under the **source
study**, all tied together so they are discoverable as one unit.

**Recommended structure, which needs your sign-off** (§9, question 1). DICOM makes `Modality` a
series-level attribute, and a Secondary Capture is `OT` while both Segmentation and Surface
Segmentation are `SEG` — so one literal series cannot hold all of them without mixing modalities,
which readers handle badly. The proposal is therefore **one derived series per modality per save**:

```
Study (the source study)
├── Series  CT        the source images                    (referenced, untouched)
├── Series  OT  NEW   1 instance   the MRCOM Secondary Capture: mrson + screenshot
└── Series  SEG NEW   n instances  the SEG and Surface Segmentation objects
```

What ties them together, in standard attributes so a provenance index never needs the private block:

- every new instance shares the source `StudyInstanceUID`;
- the SC's `ReferencedSeriesSequence` lists **the source series first** (normatively the primary
  parent) and then the new SEG series;
- each new instance carries the same `DerivationDescription` and `DerivationCodeSequence`;
- each new instance also carries the save's `MRCOMBundleUID` in an MRCOM private block, as a
  convenience — but the standard attributes above are authoritative, because de-identification
  removes private attributes by default.

### 3.5 When a standard object is not possible

Three cases, all real, all with a fallback rather than a failure:

1. **A SEG needs the source instances, not just their UIDs.** A conformant SEG carries
   `PerFrameFunctionalGroupsSequence` with per-frame `ImagePositionPatient`, and dcmjs's
   `Segmentation` derivation reads them from the actual source datasets. If a scene's segmentation
   sits on a volume that came from NRRD, or from DICOM the writer no longer holds, there is nothing
   to derive from — so that segmentation is **embedded** instead.
2. **A mesh over 65 535 points needs the `OL` VR, which dcmjs does not support.**
   `TrianglePointIndexList` is `OW`, so 16-bit indices cap a surface at 65 535 points.
   `LongTrianglePointIndexList` is `OL` in the current standard — and dcmjs has no `OL` at all
   (`VRinstances` has only `OB`, `OD`, `OF`, `OW`), while its dictionary still lists (0066,0041) as
   the pre-CP `UL`/`3-3n`. Albula's surface-nets output is **6 million vertices**, so this is not
   hypothetical. Options, in order of preference: add `OL` to dcmjs (§5, a clean sixth PR); split a
   large mesh across several `SurfaceSequence` items under the cap, re-indexing each; embed.
3. **A surface needs a `FrameOfReferenceUID`.** mrson meshes are in RAS world. If the scene derives
   from a DICOM series the frame comes from it; otherwise one has to be minted, and a minted frame
   is not interoperable with anything. Mint it and say so in the manifest.

The manifest records which path each piece of bulk took, so a reader never has to guess.

---

## 4. Status

### Done and green

Tasks 1–13 and 15 of §7. The hermetic tier passes; `logic/mrcom/` and `mrson/` are lint-clean;
136 MRCOM/mrson tests.

- **[`MRCOM-SCENE-BUNDLE.md`](MRCOM-SCENE-BUNDLE.md)** — the format spec.
- **[`../mrson/`](../mrson/)** — the schema `MRSON-LIVESCENE.md` cited at a repo that never existed,
  plus `validate.ts`, a stdlib-only `validate.py`, and conformance + TS/Python parity tests over
  **real producer output**. [`../mrson/README.md`](../mrson/README.md) records **eight
  doc-versus-code divergences** the schema work adjudicated.
- **`render/vendor/dcmjs/`** — the vendored ESM + UMD builds (§5), with both loaders repointed.
- **`logic/bytes.ts`** — the blob-channel helpers, with the zlib-wrapper commitment tested.
- **`logic/bulk.ts`** — `blobRefs()` and `bulkSources()`, moved out of
  `render/sessions/session-store.ts` so `logic/mrcom/` stays DOM-free. `blobRefs()` now walks mesh
  `normals` and any `blobs` map; it did not, so a mesh's normals were reachable in a scene and
  silently absent from every export.
- **`logic/mrcom/format.ts`** — a typed view of `mrson/schema/mrcom.schema.json`.
- **`logic/mrcom/vr.ts`** — the VR guard for the ctkDICOM-index trap (§6.4).
- **`logic/mrcom/sc-pixels.ts`** — raw pixels in, Image Pixel module out, box-filter downscale,
  placeholder for when capture fails.
- **`logic/mrcom/write.ts`**, **`read.ts`**, **`load.ts`** — the writer, the reader (prefix-read
  peek, digest verification that **refuses** rather than warns, typed-length slicing, stripped-bundle
  reporting), and a non-destructive merge.
- **`logic/mrcom/no-dom.test.ts`** — enforces the contract §6.1 depends on.
- **`logic/readers/synthetic-dicom.ts`** — shared fixtures, tied to the validated geometry oracle.

### What the §3 revision invalidates

This is the honest list of what now has to change. None of it is wasted — the carrier, the private
block, the manifest, the verification and the resolver seams are unaffected — but the bulk path is
different from what is built.

| Built | Now needs |
|---|---|
| `write.ts` embeds segmentation and mesh bulk as blobs | emit a **SEG** per segmentation and a **Surface Segmentation** per mesh, reference them from the scene, and embed only per §3.5 |
| `write.ts` produces one SC instance | produce a **derived series**: the SC plus the new SEG/surface instances, with the §3.4 lineage on each |
| `WrittenBundle` returns one `bytes` | return **a set of instances**, each with its SOP/series UIDs |
| `read.ts` restores bulk from the blob sequence | also **resolve the referenced SEG and surface instances**, which makes `logic/readers/dicom-seg.ts` an M1 task rather than M6 |
| ~~`mrson/schema/bulk.schema.json` reserved `dicom-surface` for Surface Segmentation **or** Encapsulated STL/OBJ~~ | **done** — the encapsulated option is dropped (§3.3) |
| ~~`MRCOM-SCENE-BUNDLE.md` §7.2–7.3 said segmentations and meshes are embedded~~ | **done** — §7 is rewritten to match §3 |
| `logic/mrcom/sources/*` was to ship `dicom-seg` as provenance only | `dicom-seg` and `dicom-surface` become **resolvable**, not just recorded |

### Next

- **14** reference resolution: `logic/mrcom/{resolve,resolvers}.ts`, `logic/mrcom/sources/*`, and
  extracting the IDC study→series lookup out of `render/demos/bir-browser.ts` into
  `logic/idc/index-api.ts`
- **14a (new)** `logic/dicom/segmentation.ts` — write and read a SEG, with the §3.5 fallback
- **14b (new)** `logic/dicom/surface-segmentation.ts` — write and read a Surface Segmentation
- **14c (new)** rework `write.ts`/`read.ts` to the derived-series shape
- **16–17** `render/capture.ts` (the only DOM/GPU part) and the UI panel
- **18–20** browser round trip, the real IDC round trip, external validation with pydicom and
  `dcmdump`, and an import into an unmodified Slicer
- **21** CI and harness docs

---

## 5. The dcmjs dependency — read before touching it

MRCOM needs write-path support that dcmjs did not have. That work is **five open PRs** in
`dcmjs-org/dcmjs`, all passing `build`, `lint-and-format`, `test (22)` and `test (24)`:

| PR | What |
|---|---|
| [#622](https://github.com/dcmjs-org/dcmjs/pull/622) | Explicit VR Big Endian byte order for binary value fields, plus the `ParsedUnknownValue` UN re-read fix |
| [#624](https://github.com/dcmjs-org/dcmjs/pull/624) | test only: a DS round trip through write and read |
| [#625](https://github.com/dcmjs-org/dcmjs/pull/625) | `registerTag` → `nameMap`; a registered tag could be read but never written |
| [#626](https://github.com/dcmjs-org/dcmjs/pull/626) | `privateBlock.js` + `DicomDict#privateBlock()` — PS3.5 §7.8.1 reservation, found **by creator, never by block** |
| [#627](https://github.com/dcmjs-org/dcmjs/pull/627) | `derivations/SecondaryCapture.js` |

**`origin/mrcom-integration`** in that repo is `master` + all five, merged. 29 suites / 397 tests.
**SlicerLive vendors a build from that branch** rather than waiting for upstream merge.

> **These PRs are under review and must not be amended, rebased or force-pushed** without the
> maintainer's say-so — dcmjs is in production use elsewhere. Treat `mrcom-integration` as read-only
> input. If MRCOM needs a further dcmjs change, raise it rather than committing it.

### A likely sixth PR: the `OL` value representation

§3.5 case 2. dcmjs's `VRinstances` has only `OB`, `OD`, `OF` and `OW`, so `OL` (Other Long, 32-bit)
and `OV` are unsupported, and `LongTrianglePointIndexList` cannot be written at all. Its dictionary
also still lists (0066,0041) as `UL`/`3-3n`, which is the pre-CP definition; the current standard
says `OL`/`1`. Both are small, well-scoped changes, and #622 already added the
`binaryVRWordWidths` table that an `OL: 4` entry belongs in. **Raise it; do not land it unilaterally.**

### Integration gotchas

- The private block must be written on the **`DicomDict`** — after `datasetToDict()` denaturalizes —
  not on the naturalized dataset. Private tags are not in `nameMap` unless their names are registered
  first (which is what #625 enables).
- An odd-length `OB` comes back **one byte longer**, with a trailing pad: DICOM value fields are even
  length. Hence an explicit typed length per payload, and a reader that slices to it.
- Do **not** inherit a reference instance's file meta. `datasetToDict` keeps whatever
  `TransferSyntaxUID` it finds, so an implicit-VR reference silently yields implicit-VR output. #627
  pins it; anything else building a dataset from a reference must do the same.
- `DerivedDataset#derive()` inherits a **fixed** attribute list that does **not** include
  `StudyDescription`. Do not rely on it; assert the context you mean.
- `PixelData`'s dictionary VR is `"ox"`, so declare it via `_vrMap` — `OB` for 8-bit samples, `OW`
  for 16-bit. Otherwise dcmjs logs and guesses.
- Surface Segmentation's SOP class UID is **not** in `sopClassNamesByUID`; use the literal
  `1.2.840.10008.5.1.4.1.1.66.5`. All its *attributes* are in the dictionary, so a dataset can be
  built by name.

---

## 6. For SlicerAlbula

[SlicerAlbula](https://github.com/rkikinis/SlicerAlbula) is the first external consumer: the aim is
that MRCOM bundles replace `.albula` folders for sharing a scene.

> **Assume Albula will have to rebase onto `pieper/SlicerLive` main, and that it will need fixes to
> adapt to SlicerLive and MRCOM.** Its checkout is ahead (it has `algorithms/surface-nets.ts`,
> `docs/GREASED-LIGHTNING.md`, a `DENO_VERSION` pin and a `node:sqlite` desktop server), and MRCOM is
> landing on main. Plan for the rebase and the adaptation rather than designing around the
> divergence. M1 is still deliberately confined to new files plus docs, to keep it cheap.

### What MRCOM gives Albula

A scene save is a **derived series of ordinary DICOM instances**. It goes into an Albula database the
way any other instances do, Slicer opens them, a PACS stores them, a viewer that knows nothing about
mrson still shows the screenshot — and the segmentations and surfaces are **standard objects other
software can use**, not an opaque blob. In reference mode a scene over a public IDC study is tens of
kilobytes that reloads from the public buckets with no credentials.

### 6.1 Bulk: Surface Segmentation, and what to do about size

Per §3: **use Surface Segmentation for mesh bulk unless it is really technically impossible**, and
put the non-bulk display state in the Secondary Capture's mrson.

The one thing that *is* close to impossible today is Albula's own scale. Surface-nets on
`ts:total` produced **6 061 448 vertices and 12 121 372 triangles**; `TrianglePointIndexList` is
`OW`, which caps a surface at 65 535 points, and the `OL` path dcmjs would need does not exist
(§3.5 case 2, §5). So for Albula specifically:

1. **Raise the `OL` PR** — it is the real fix and it is small.
2. Until then, either split a large mesh across `SurfaceSequence` items under the cap (legal,
   re-indexed, ugly) or embed that mesh and record it in the manifest.
3. Decimated or per-structure meshes are usually well under the cap, so this bites on whole-body
   output rather than on everything.

### 6.2 The ctkDICOMDatabase, in the order it is wanted

Reordered from the previous plan.

**First — File System Access to a real `ctkDICOMDatabase`.** The user grants the database directory;
the adapter reads `ctkDICOM.sql` (and `ctkDICOMTagCache.sql`) with a WASM SQLite over the granted
handle. Read-only, so Slicer stays the only writer and the `Displayed*` columns, the tag cache and
`ColumnDisplayProperties` can never be left inconsistent. Verified layout:

```
<dbdir>/ctkDICOM.sql            SchemaInfo.Version = '0.8.1'
<dbdir>/ctkDICOMTagCache.sql    TagCache(SOPInstanceUID, Tag, Value)  — tags upper-cased
<dbdir>/dicom/<study>/<series>/<instance>.dcm
<dbdir>/thumbs/<study>/<series>/<instance>.png
```

**Resolve instances by reading `Images.Filename`**, which is a path relative to the database
directory (`ctkDICOMDatabase::fileForInstance` → `ctk::absolutePathFromInternal`) — never by
reconstructing paths. `UseShortStoragePath` **defaults to true**, so the hashed layout is the normal
case. Two limitations to surface rather than discover: `Images.Filename` may be **absolute** (files
indexed in place, outside the granted handle) and `Images.URL` needs its own path.

**Then — a TypeScript-native mirror of the same schema and API**, for SlicerLive when there is no
external filesystem. Same tables, same column names, same query surface, backed by OPFS/IndexedDB
instead of a SQLite file. Two consequences worth stating: the API is defined by the FSA adapter
first and the native one conforms to it (not the reverse), and a **conformance test should run the
same query set against both backends and compare**, the way `mrson/validate-parity.test.ts` pins the
TypeScript and Python validators to each other.

Albula is a Deno app, so where it sits in this is an open question (§9, question 2): its web layer
may be able to use the FSA adapter, or it may want a third `node:sqlite` backend behind the same
interface. The interface is the deliverable; a third backend is a file.

### 6.3 Additive only, and lineage in standard attributes

A writer emits **new instances in a new derived series** (§3.4); it never rewrites a source
instance, never modifies an existing series, and never touches a database schema. Producing the bytes
and inserting them are separate steps.

`ReferencedSeriesSequence` **item 0 is normatively the primary parent**, with
`ReferencedInstanceSequence` for instance granularity and
`DerivationDescription`/`DerivationCodeSequence` for the kind. So a provenance index like Albula's
`provenance.sqlite` can record a save's parent **without parsing the private block** — which matters
because conformant de-identification removes private attributes by default (PS3.15 Annex E). A bundle
is recoverable-or-absent, never silently corrupt: a reader that finds the reference sequences but no
MRCOM creator reports a *stripped* bundle.

This is the same discipline Albula's `DICOMProvenance` module already uses for its SEG and Basic Text
SR objects, so the two should fit together rather than compete.

### 6.4 Two traps honoured in the writer, both learned from Albula

- **Never feed ctkDICOMDatabase *index* values into DICOM tags.** The index stores display
  concatenations and reformatted values that violate VR limits — a 68-character `StudyDescription`
  against `LO`'s 64, an ISO-format birth date against `DA`'s 8 digits. Composite context comes from
  the **reference series' real tags**, and every coercion is reported to the caller rather than
  silently truncated (`logic/mrcom/vr.ts`).
- **Do not assume explicit VR** when reading a reference instance. Implicit-VR-LE series exist, and
  the output must stay Explicit VR LE regardless (§5).

### 6.5 What Albula would need to do

- Consume `logic/mrcom/*` from SlicerLive (DOM-free, importable from the Deno server) plus the
  vendored **ESM** dcmjs build.
- Supply a screenshot as raw pixels (`{rgba|rgb, width, height}`) — a WKWebView frame grab, or none,
  in which case the writer synthesizes a placeholder rather than failing.
- Supply **the source instances**, not just their UIDs, for any segmentation that should become a
  SEG (§3.5 case 1). Albula has them in its own database, so this is a lookup rather than a problem.
- Write the resulting instances with `Deno.writeFile`, then index them additively.

---

## 7. Milestones

**M1 — the format, the standard objects, and the TypeScript writer/reader.** Tasks 1–13 and 15 are
done (§4); 14, 14a–14c and 16–21 remain.

| # | Task | Files |
|---|---|---|
| 1 | Format spec; reconcile the mrson doc with reality | `docs/MRCOM-SCENE-BUNDLE.md`, `docs/MRSON-LIVESCENE.md` |
| 2 | `mrson/`: schema, `validate.ts`, `validate.py`, unit tests | `mrson/**` |
| 3 | Conformance: real producer output validates; TS↔Python parity | `mrson/{conformance,validate-parity}.test.ts` |
| 4 | mrson type additions; closure fixes | `render/mrson.ts`, `logic/bulk.ts` |
| 5 | dcmjs write support | five PRs, §5 |
| 6 | Vendor dcmjs; repoint the loaders | `render/vendor/dcmjs/*`, `logic/readers/dicom-series.ts`, `idc-worker.js` |
| 7 | Shared byte helpers | `logic/bytes.ts` |
| 8 | Format module + VR guard | `logic/mrcom/{format,vr}.ts` |
| 9 | SC pixel builder | `logic/mrcom/sc-pixels.ts` |
| 10 | Shared synthetic DICOM fixtures | `logic/readers/synthetic-dicom.ts` |
| 11 | Writer | `logic/mrcom/write.ts` |
| 12 | Reader | `logic/mrcom/read.ts` |
| 13 | Non-destructive scene load | `logic/mrcom/load.ts` |
| 14 | Reference resolution + the resolver registry | `logic/mrcom/{resolve,resolvers}.ts`, `sources/*`, `logic/idc/index-api.ts` |
| **14a** | **SEG: write and read, with the §3.5 fallback** | `logic/dicom/segmentation.ts` |
| **14b** | **Surface Segmentation: write and read** | `logic/dicom/surface-segmentation.ts` |
| **14c** | **Rework the writer and reader to the derived-series shape** | `logic/mrcom/{write,read}.ts`, `mrson/schema/bulk.schema.json` |
| 15 | DOM-free guard test | `logic/mrcom/no-dom.test.ts` |
| 16 | Screenshot capture | `render/capture.ts` |
| 17 | UI panel + test hooks | `render/demos/mrcom-panel.ts` |
| 18 | Browser round trip, synthetic | `harness/mrcom.browser.test.ts` |
| 19 | Real IDC round trip, `SL_NET`-gated | `harness/mrcom-idc.browser.test.ts` |
| 20 | External validation: pydicom checker, `dcmdump`, unmodified-Slicer import | `tools/mrcom_check.py` |
| 21 | CI + harness docs | `.github/workflows/test.yml`, `docs/HARNESS.md` |

**M2 — Slicer plugin.** `DICOMMRCOMPlugin.py` with pydicom. `examineFiles` keys on a precached
`"4d43,0010"`; `load()` is an **additive merge**, never `vtkMRMLScene::Connect()` (which clears the
scene — the old plugin's worst behaviour); `export` writes the derived series **and inserts it into
the DICOM database**, which `DICOMExportScene.py` never did. Slicer already reads SEG; a Surface
Segmentation reader is the new part.

**M3 — ctkDICOMDatabase over File System Access.** `logic/dicomdb/db.ts` + `FsaSqliteDatabase`,
read-only (§6.2). This is the one that reads a real Slicer database.

**M4 — the TypeScript-native mirror.** Same schema, same API, OPFS/IndexedDB-backed, for SlicerLive
with no external filesystem — plus the two-backend conformance test (§6.2).

**M5 — the browser UI.** Promote SlicerRad's `pacs-browser.ts` + `catalog/rollups.ts` +
`catalog/handle-store.ts` into SlicerLive. Reconcile **three** existing browsers — CTK's two
generations, SlicerRad's, and Albula's. Adopt CTK's two layers: `ColumnDisplayProperties` for the
table, and Punzo's visual-browser **role set** for cards (`IsCloud`, `InstancesLoaded`,
`ThumbnailPath`, filtered-versus-total counts kept separate). Albula's derived-series nesting is a
requirement, not a nice-to-have — an MRCOM save *is* a derived series.

**M6 — dicomWeb, markups, and the rest.** STOW-RS, QIDO discovery, DIMSE/VNA through Slicer; the
credentialed resolvers (`s3-signed`, `gcs`, `azure-blob`, token `wado-rs`); markup → SR TID 1500 and
GSPS, which is where §2's private-SR-template layer finally gets built.

**M7 — do not orphan the old bundles.** A reader for `(cadb,*)` `SlicerDataBundle` instances that
converts the embedded `.mrb` to mrson, so a decade of saved scenes can migrate rather than strand.

---

## 8. How to run things

```
deno test -A --no-check mrson/            # schema, conformance, TS↔Python parity (needs python3)
deno test -A --no-check logic/mrcom/      # the writer, reader, load, VR guard, DOM-free guard
deno run -A mrson/validate.ts <file>      # validate a scene or an MRCOM manifest
python3 mrson/validate.py <file>          # the same, from Python
deno run -A test/run.ts                   # the hermetic T1 tier — what CI runs
deno run -A test/run.ts --all             # + GPU, browser, Slicer-parity tiers
```

The conformance suite also validates the published gallery scenes when `pieper/live` is checked out
beside this repo, or `SLICERLIVE_GALLERY` points at them; it skips rather than fails otherwise.
`serialize_mrson.py` output needs a running Slicer, so a fixture is captured once into
`mrson/fixtures/` — the recipe, and the warning to check a fixture for patient data first, are in
[`../mrson/fixtures/README.md`](../mrson/fixtures/README.md).

## 9. Open questions

1. **Does a scene save make one derived series per modality, or one per SOP class?** §3.4 proposes
   per modality — an `OT` series for the Secondary Capture and a `SEG` series holding both the
   Segmentation and Surface Segmentation instances, since both are `Modality SEG`. One series per
   SOP class is also defensible and some readers prefer it. Needs a decision before 14c.
2. **Where does Albula sit in §6.2?** Its web layer may be able to use the FSA adapter, or it may
   want a third `node:sqlite` backend behind the same interface.
3. **Minted frames of reference.** §3.5 case 3: a surface from a non-DICOM volume needs a
   `FrameOfReferenceUID` that nothing else shares. Mint and record, or refuse to write a surface at
   all in that case?
4. **The `OL` PR.** §5. Raise it now so it is in review by the time 14b needs it, or split large
   meshes in the meantime and raise it later?

## 10. Open risks

1. **De-identification is the one to get right now, not later.** The screenshot is burned-in
   annotation (`BurnedInAnnotation` is always `YES`), and a private block can carry PHI past a tool
   configured to retain private tags. Any mrson `dicom` carry-forward bag is restricted to a declared
   whitelist. Reference mode also names UIDs, which are identifiers under most profiles — a save
   shared outside its origin must be de-identified **as a whole**, with UIDs remapped consistently
   across every new instance, the private block, the manifest *and* the reference sequences. Writing
   real SEG and Surface Segmentation objects **increases** this surface, because each carries its own
   composite context.
2. **`voxelDigest` must stay pinned to the byte** (C order `(z,y,x)`, post-rescale, native dtype,
   little-endian, unpadded) or TypeScript and pydicom will disagree — the same class of failure
   `render/test/commits-conformance.test.ts` exists to prevent for canonical numbers.
3. **Reference-mode trust.** If a source series is re-encoded, `voxelDigest` fails. Default is to
   **fail loudly**; showing different pixels under a scene's name is worse than not opening it.
4. **Size.** A bundle is built as one byte buffer, so embedding a whole study exhausts memory before
   it exhausts DICOM. The writer refuses above a cap and says to use reference mode.
   `MRCOMBundleUID` is reserved as the splitting point for a future multi-instance bundle.
5. **WebGPU canvas readback** for the screenshot: `drawImage(gpuCanvas)` is only reliable in the same
   task as the present. The robust path is render-to-texture plus `copyTextureToBuffer`. Keep the
   placeholder path so a write never fails because capture did.
