# MRCOM scene bundles — an mrson scene inside a DICOM instance

Status: **specification, v1 (layout version `1`), 2026-10-27.** Implements MRCOM P6 from
[`MRSON-LIVESCENE.md`](MRSON-LIVESCENE.md) §1b.

MRCOM (*Medical Reality Communications*) is the DICOM-facing binding of mrson. An **MRCOM scene
bundle** is one DICOM Secondary Capture instance that carries a complete mrson scene: the screenshot
is the pixel data, so any DICOM viewer shows a picture, and the scene itself rides in a private block.
Bulk data is either **embedded** in the instance or **referenced** back to the DICOM instances the
scene was authored from.

The point is that lossless scene exchange rides the installed base — a VNA, a DIMSE network or a
dicomWeb server moves these without knowing anything about mrson.

> This supersedes 3D Slicer's `SlicerDataBundle` (`DICOMSlicerDataBundlePlugin.py`, private group
> `0xCADB`). §9 is a weakness-by-weakness comparison, and §10 covers reading the old format.

---

## 1. The carrier

One **Secondary Capture Image** instance per bundle, `SOPClassUID 1.2.840.10008.5.1.4.1.1.7`,
Explicit VR Little Endian (`1.2.840.10008.1.2.1`), in its own series inside the reference study.

| Attribute | Value |
|---|---|
| `(0008,0060)` Modality | `OT` |
| `(0008,0064)` ConversionType | `WSD` |
| `(0008,0008)` ImageType | `DERIVED\SECONDARY\OTHER` |
| `(0008,0005)` SpecificCharacterSet | `ISO_IR 192` (UTF-8) |
| `(0020,0013)` InstanceNumber | `1` |
| `(0028,0301)` BurnedInAnnotation | **`YES`** — the capture contains view labels and chrome |
| `(0028,2110)` LossyImageCompression | `00` |
| `(0008,103E)` SeriesDescription | `MRCOM Scene Bundle`, or the session name |
| `(0020,0011)` SeriesNumber | `9701` (sorts last) |

Pixel data is the scene screenshot as **uncompressed RGB**: `SamplesPerPixel 3`,
`PhotometricInterpretation RGB`, `PlanarConfiguration 0`, `BitsAllocated 8`, `BitsStored 8`,
`HighBit 7`, `PixelRepresentation 0`, and `(7FE0,0010)` exactly `Rows × Columns × 3` bytes. Default
long edge 1280 px (box-filter downscale), so the carrier stays ~2–3 MB.

Uncompressed rather than JPEG because the bytes are trivially verifiable by `dcmdump` and pydicom,
and because a bundle's value does not depend on squeezing the screenshot.

**`PixelData` is type 1 and must exist.** A writer given no screenshot synthesizes a flat placeholder
rather than failing — a scene must never be unsaveable because a capture did not work.

### 1.1 No frame of reference on the image

A bundle carries **no `ImagePositionPatient`, no `ImageOrientationPatient`, and no
`FrameOfReferenceUID` on the image itself.** A Secondary Capture is a picture of a screen, not a
spatially registered slice. Scene geometry lives in mrson (RAS, see
[`MRSON-LIVESCENE.md`](MRSON-LIVESCENE.md) §1a) and the frame of reference the scene was *derived
from* is recorded in the manifest and the reference sequences (§3). A viewer therefore shows a picture
and can never mis-register it into a volume.

### 1.2 Composite context comes from real tags

Patient and study attributes are inherited from a **real reference instance** — a DICOM file, parsed —
and never from a database index.

> **Never feed ctkDICOMDatabase *index* values into DICOM tags.** The index stores display
> concatenations and reformatted values that violate VR limits: a 68-character `StudyDescription`
> against `LO`'s 64, an ISO-format birth date against `DA`'s 8 digits. The symptom is an opaque
> "Value Representation violated" from whatever writes the file next. (Hard-won in SlicerAlbula; the
> old `DICOMSlicerDataBundlePlugin` has the same bug from the other direction, passing composite
> context as `img2dcm -k Key=Value` arguments — its own comment concedes *"It could be safer to pass
> these fields through the reference file instead."*)

Inherited: `PatientName`, `PatientID`, `PatientBirthDate`, `PatientSex`, `PatientAge`,
`StudyInstanceUID`, `StudyID`, `StudyDate`, `StudyTime`, `StudyDescription`, `AccessionNumber`,
`ReferringPhysicianName`. Fresh: `SOPInstanceUID`, `SeriesInstanceUID`, `SeriesNumber`,
`SeriesDescription`, `SeriesDate`/`SeriesTime`, `ContentDate`/`ContentTime`.

Every inherited value is checked against its VR before writing, and **every coercion is reported to
the caller** rather than silently truncated.

Two reading rules follow:

1. **Do not assume explicit VR** when parsing a reference instance. Implicit-VR-LE series exist in the
   wild and a checker that assumes explicit VR passes them silently.
2. **Do not inherit the reference instance's file meta.** A bundle is always Explicit VR LE; a writer
   that copies `_meta` from an implicit-VR reference silently emits implicit VR. (This is a real trap
   in dcmjs: `DerivedDataset` copies `_meta` from the reference.)

---

## 2. The private block

### 2.1 Group and creator

**Group `0x4D43`** — odd, as DICOM requires for private data, and it reads as `MC` in a hex dump.
(`0x4D52`, "MR", is even and therefore not a legal private group.)

**Private creator `"MRCOM.MRSON.1"`** at `(4D43,0010)`, reserving block `0x10`, so data elements are
`(4D43,10xx)` per PS3.5 §7.8.1.

Group `0x4D43` was checked against the private dictionaries available locally and is unclaimed:

| Dictionary | Entries / owners | `4D43` | Notes |
|---|---|---|---|
| dcmjs `src/dictionary.private.data.js` | 51 distinct groups | absent | no `4Dxx` group at all |
| DCMTK `dcmdata/data/private.dic` | 2836 entries | absent | no `4Dxx` group at all |
| GDCM `Source/DataDictionary/privatedicts.xml` | 144 owner groups | absent | the only `4Dxx` is `4d4d`, GDCM's own conformance-test group |

**The creator string is the identity; the group number is advisory.** A conformant reader locates the
block by scanning `(4D43,0010)`–`(4D43,00FF)` for a creator equal to `MRCOM.MRSON.1`, and must not
assume the block offset is `0x10`. Writers allocate the lowest free slot. (dcmjs keys its private
dictionary `(group, CREATOR, element)` for exactly this reason, and Slicer already ships
`DICOMPlugin.findPrivateTag(ds, group, element, privateCreator)`.)

**The creator string carries no data and will never change.** The block *layout* is versioned in
`(4D43,1003)` and in the manifest. This is the primary lesson from `SlicerDataBundle`, whose creator
is `"3D Slicer <zipSize>"` — a byte count smuggled into an identity string, which then became the
only reliable place to read it from.

### 2.2 The block sorts before PixelData

`0x4D43 < 0x7FE0`, so in a tag-ordered dataset the entire private block precedes `(7FE0,0010)`.
**The manifest is therefore reachable from a prefix read or an HTTP range request**, without touching
the payload or the pixels.

This is deliberate and it is the structural opposite of `SlicerDataBundle`, which depends on
`0xCADB > 0x7FE0` so that its payload lands *last* in the file and can be recovered by seeking
backwards from EOF.

### 2.3 Element table

All elements in group `0x4D43`, inside the block reserved by the creator. `1001`–`1016` are small and
precede the bulk.

| Element | VR | VM | Name | Semantics |
|---|---|---|---|---|
| `0010` | LO | 1 | `PrivateCreator` | `MRCOM.MRSON.1` — **the only detection key** |
| `1001` | CS | 1 | `MRCOMBundleMode` | `EMBED` \| `REFERENCE` \| `HYBRID` |
| `1002` | UI | 1 | `MRCOMBundleUID` | fresh UID, stable across copies; lets a reader dedupe |
| `1003` | SH | 1 | `MRCOMFormatVersion` | `1` — block layout version |
| `1004` | UT | 1 | `MRCOMManifest` | the manifest (§4) as UTF-8 JSON, non-ASCII `\u`-escaped |
| `1005` | LO | 1 | `MRCOMManifestDigest` | digest of `1004`, **bare lowercase hex** |
| `1006` | CS | 1 | `MRCOMDigestAlgorithm` | `SHA256`; applies to every digest in the block and the manifest |
| `1010` | OB | 1 | `MRCOMScene` | the `scene.mrson.json` bytes, encoded per `1011` |
| `1011` | CS | 1 | `MRCOMSceneEncoding` | `NONE` \| `DEFLATE` |
| `1012` | UL | 1 | `MRCOMSceneLength` | exact **encoded** byte count of `1010` |
| `1013` | LO | 1 | `MRCOMSceneDigest` | digest of the **decoded** JSON bytes, bare hex |
| `1014` | UL | 1 | `MRCOMSceneNodeCount` | node count; cheap sanity check and browser display |
| `1015` | LO | 1 | `MRCOMProducer` | e.g. `SlicerLive` |
| `1016` | LO | 1 | `MRCOMProducerVersion` | version or git sha |
| `1020` | SQ | 1 | `MRCOMBlobSequence` | 0..N items, one per embedded content-addressed blob |
| `1021` | LO | 1 | `MRCOMBlobHash` | *in item* — bare 64-hex; the mrson blob name is `sha256-` + this |
| `1022` | UL | 1 | `MRCOMBlobLength` | *in item* — exact stored byte count of `1024` |
| `1023` | CS | 1 | `MRCOMBlobEncoding` | *in item* — `STORED` \| `DEFLATE` (§5.2) |
| `1024` | OB | 1 | `MRCOMBlobData` | *in item* — the bytes |
| `1030` | UL | 1 | `MRCOMBlobCount` | item count, for a pre-read size report |
| `1031` | UL | 1 | `MRCOMBlobTotalLength` | summed `1022`, for a pre-read size report |

Each item of `MRCOMBlobSequence` **carries its own `(4D43,0010)` creator**: private block reservation
is per-dataset, and a sequence item is a dataset.

### 2.4 Two encoding rules that are not optional

**Digests are bare lowercase hex, with the algorithm named once in `1006`.** `LO` is 64 characters and
writers truncate silently; `"sha256-"` + 64 hex characters is 71 and would be clipped to something
that still looks like a digest. The `sha256-` prefix that mrson uses in blob names is *reconstructed*
by the reader, never stored in an `LO`.

**Explicit lengths are mandatory, because DICOM pads to even.** An `OB` value of odd length is written
with a trailing pad byte and the element's value length reports the *padded* count. A reader must
therefore slice `1010` to `1012` bytes and each `1024` to its item's `1022` bytes, not trust the
element length. (This is observable in dcmjs: `BinaryRepresentation.writeBytes` returns the padded
count and `Tag.write` stores it.)

### 2.5 Detection

A reader decides "is this an MRCOM bundle?" by one short `LO` that sits ahead of the pixels:

- **Web / Deno** — parse the prefix only. dcmjs's `readFile(buf, { untilTag })` stops early, so neither
  `1010` nor `(7FE0,0010)` is read to answer the question.
- **3D Slicer** — declare the creator tag in a `DICOMPlugin`'s `self.tags`, which is what gets it
  precached into `ctkDICOMTagCache` (see `Modules/Scripted/DICOM/DICOM.py`, where every plugin's tags
  are merged into `slicer.dicomDatabase.tagsToPrecache`). `examineFiles()` is then a cache hit.

Unlike `SlicerDataBundle`, nothing needed for detection or for locating the payload is smuggled into
the creator string: lengths are typed `UL` and digests are real.

---

## 3. Standard references — the part that is not private

Every mode writes these. **Lineage must be legible without the private block.**

```
(0008,1115) ReferencedSeriesSequence        ← ITEM 0 IS NORMATIVELY THE PRIMARY PARENT
              (0020,000E) SeriesInstanceUID
              (0008,114A) ReferencedInstanceSequence   ← items in author / geometric order
                  (0008,1150) ReferencedSOPClassUID
                  (0008,1155) ReferencedSOPInstanceUID
(0008,1200) StudiesContainingOtherReferencedInstancesSequence  ← a referenced SEG in another study
(0008,2112) SourceImageSequence (+ PurposeOfReferenceCodeSequence)
(0008,2111) DerivationDescription
            "MRCOM mrson scene bundle (hybrid), 42 nodes, 2 source series"
(0008,9215) DerivationCodeSequence
```

This is the Common Instance Reference module (PS3.3 C.12.2), type U on the Secondary Capture IOD — the
standard-legal home for exactly this information.

Two consequences are load-bearing:

1. **`ReferencedSeriesSequence` item 0 is the primary parent** — the series the main view shows. That
   gives a provenance index a deterministic single parent `SeriesInstanceUID` **from standard
   attributes alone**, and it lets a browser that nests derived series under their parent nest a
   bundle correctly without knowing what MRCOM is. (SlicerAlbula's `provenance.sqlite` is exactly such
   an index: one row per created object giving its immediate parent, never touching
   `ctkDICOM.sql`'s schema.)
2. **A bundle is recoverable-or-absent, never silently corrupt.** Conformant de-identifiers remove
   private attributes by default (PS3.15 Annex E), so the private block can legitimately disappear. A
   reader that finds the reference sequences but no `MRCOM.MRSON.1` creator must report *"an MRCOM
   bundle whose scene was stripped"* — and in `REFERENCE` mode the right images are still named, so
   the loss is graceful.

### 3.1 Coded terminology

Coding scheme designator **`99MRCOM`**, declared in `CodingSchemeIdentificationSequence`. Standard
`DCM`/`SCT` codes are used wherever one exists; `99MRCOM` only for MRCOM-specific concepts.

`CodeValue` is `SH` — **16 characters** — so codes are short (`MRCOMBUNDLE`) and the human-readable
text goes in `CodeMeaning`, which is `LO`/64 (`MRCOM mrson scene bundle`).

### 3.2 Additive only

A writer emits **new instances only**. It never rewrites a source instance, never modifies an existing
series, and never touches a database schema. Producing the bytes and inserting them into an archive
are separate steps, and insertion is additive too.

---

## 4. The manifest

`(4D43,1004)`, always present, always uncompressed, always small. It is the contract between writer
and reader, and it is what makes embed-or-reference one format rather than two.

```jsonc
{
  "mrcom": 1,
  "mode": "hybrid",                        // embed | reference | hybrid
  "bundleUID": "1.2.826.0.1.3680043.…",
  "created": "20261027T143012",
  "producer": { "name": "SlicerLive", "version": "<sha>", "mrson": 0 },

  "scene": { "length": 182334, "encoding": "deflate", "digest": "<hex>",
             "nodes": 42, "blobBase": "blobs/" },

  "context": { "studyInstanceUID": "1.3…", "patientID": "…",
               "primaryParentSeries": "1.3…" },

  "bulk": {
    "embedded": { "count": 312, "bytes": 8421330 },

    // hashes the scene names that are NOT in this instance
    "required": [ { "hash": "sha256-…", "bytes": 1048576,
                    "nodes": ["img1"], "grid": "3.1.2" } ],

    "sources": [
      { "kind": "dicom-series", "nodeId": "img1",
        "studyInstanceUID": "1.3…", "seriesInstanceUID": "1.3…",
        "sopClassUID": "1.2.840.10008.5.1.4.1.1.2",
        "frameOfReferenceUID": "1.3…",
        "instances": ["1.3….1", "1.3….2", "…"],      // AUTHORITATIVE, in geometric order
        "recon": { "reader": "mrcom/dicom-series/1",
                   "dims": [512, 512, 120],
                   "ijkToRAS": [ /* 16, row-major */ ],
                   "dtype": "<i2", "rescale": "applied",
                   "chunks": [64, 128, 128],
                   "voxelDigest": "<hex>" },
        "retrieve": [                                  // ORDERED hints, fast path first (§6.2)
          { "scheme": "s3", "bucket": "idc-open-data", "prefix": "<crdc_series_uuid>/" },
          { "scheme": "idc", "studyInstanceUID": "1.3…", "seriesInstanceUID": "1.3…" },
          { "scheme": "wado-rs", "url": "https://…/studies/1.3…/series/1.3…" },
          { "scheme": "local-study" }
        ] },

      { "kind": "dicom-seg", "nodeId": "seg1", "seriesInstanceUID": "1.3…",
        "instances": ["1.3…"], "onGridOf": "img1",
        "segments": [ { "labelValue": 1, "segmentNumber": 1, "name": "Kidney",
                        "code": { "scheme": "SCT", "value": "64033007",
                                  "meaning": "Kidney" } } ],
        "recon": { "reader": "mrcom/dicom-seg/1", "voxelDigest": "<hex>" } },

      { "kind": "blob-base", "url": "https://…/blobs/" }
    ]
  },

  "screenshot": { "rows": 768, "columns": 1024 }
}
```

`sources[].kind` is one of `dicom-series`, `dicom-seg`, `dicom-surface` (reserved, §7.3) or
`blob-base`.

---

## 5. Modes, and why there is no zip

### 5.1 The three modes

| | `EMBED` | `REFERENCE` | `HYBRID` |
|---|---|---|---|
| `MRCOMBlobSequence` | one item per hash the scene reaches | absent | items only for bulk with **no** DICOM origin |
| `bulk.required` | `[]` | every hash the scene names | the DICOM-sourced hashes |
| `ReferencedSeriesSequence` | written, as provenance | **required**, with instances | required |
| Opens with no network | yes | no | partially |
| Typical size | study-sized | tens of KB + screenshot | screenshot + segmentations |

**`HYBRID` is the default** (a writer's `mode: "auto"` resolves to it), because it is the only one that
matches how scenes are actually made: **reference the image series, embed everything authored.** A CT
series is hundreds of megabytes and already exists in an archive; a painted segmentation is kilobytes
and exists nowhere else. Embedding the first is waste; referencing the second is data loss.

### 5.2 The blob sequence *is* the fragmentation strategy

`SlicerDataBundle` puts an entire `.mrb` zip into one explicit-length `OB`. MRCOM has no archive at
all, because mrson's bulk is **already chunked and content-addressed**: volume and segmentation voxels
are zlib-deflated chunks of at most `[64,128,128]` named `sha256-<hex>`, and mesh geometry is one blob
per array. One blob is one sequence item, so items are typically ≤1–2 MB.

That yields four properties for free:

- **No fragment arithmetic and no huge element.** The natural chunking is the fragmentation.
- **No recompression.** A chunk is already deflated in exactly the flavour the loader inflates, so
  `MRCOMBlobEncoding STORED` means *these bytes are byte-identical to what a blob store would serve*.
  Zero extra CPU, zero extra copy. `DEFLATE` exists for blobs that are not already compressed.
- **Per-item integrity, for free.** The hash *is* the name, so a corrupt blob is named exactly.
- **Dedup across bundles, and skippable reads.** Two bundles over the same study share chunk bytes by
  hash, and a reader can skip items it already has cached.

---

## 6. Resolving referenced bulk

### 6.1 What is recorded, and what is verified

An mrson `image` node names chunk hashes. Those hashes are of *deflated chunks of a reconstructed
volume*, so re-reconstructing from DICOM will not reproduce them bit-for-bit unless the chunking rule,
the compression level and the reconstruction algorithm are all byte-identical — which is not a promise
worth making across versions.

**So MRCOM does not try to make the hashes match.** A reader reconstructs, **verifies**, re-chunks, and
rewrites the node's bulk descriptor with honest hashes for the bytes it actually has. From that point
the scene is an ordinary mrson scene and nothing downstream knows the difference.

Verification is by three recorded facts, not by trust:

| Recorded | Checked on load |
|---|---|
| `instances[]` — the ordered SOPInstanceUID list | the authoritative identity; slice order is never re-guessed |
| `dims` | exact equality |
| `ijkToRAS` | equality within `1e-6` |
| `voxelDigest` | exact equality |
| `reader` | which reconstruction algorithm produced the above |

**`voxelDigest` is defined byte-for-byte** (§6.3) and is a *better* equality test than chunk-hash
equality, because it is independent of the chunking rule.

> **Reference mode is render-lossless, not byte-lossless.** The scene is provably the same voxels in
> the same geometry, but its chunk hashes differ from the author's, so a bundle is not reproducible
> hash-for-hash across a reference round trip. `EMBED` is the byte-lossless mode. The manifest records
> the author's geometry and the digest of the mrson document, so the *scene* is verifiable either way.

A mismatch **fails loudly** by default, naming the field that differed. A reader may opt into
degrading to a warning, but the default must be refusal: showing different pixels under a scene's
name is worse than not opening it.

### 6.2 Retrieve hints are ordered, and resolution is pluggable

`retrieve[]` is an **ordered list**, and a writer records more than one entry: **the fast path first,
the durable path second.**

For a scene authored over a public IDC study that is `{scheme:"s3", bucket, prefix}` (one listing plus
N gets) followed by `{scheme:"idc", studyInstanceUID, seriesInstanceUID}` — a round trip, but bucket
layouts move and DICOM UIDs do not. Fast-first is safe because a stale `crdc_series_uuid` prefix
404s rather than returning the wrong data, and `voxelDigest` catches anything that slips through.

A reader walks the hints in recorded order, dispatches each to the resolver registered for its
`scheme`, takes the first that can serve it, and falls through on failure — to the next hint, then to
`blob-base`, then to a failure report naming every attempt.

| `scheme` | Resolves by | Notes |
|---|---|---|
| `local-study` | instances already loaded, or a host-supplied lookup | covers a local ctkDICOMDatabase and a granted folder; the lookup is injected, so no new code per source |
| `s3` | bucket + prefix | anonymous public buckets |
| `idc` | **SeriesInstanceUID alone**, via the IDC REST API, then the bucket | the durable path: a bundle still opens after a bucket layout changes |
| `wado-rs` | DICOMweb `/studies/…/series/…/instances/…` | also covers a local Orthanc |
| `mcp` | a host-supplied MCP tool call | an agent session resolves through an attached IDC MCP without this format knowing the API shape |

Further sources — credentialed AWS, GCS, Azure Blob, token-authenticated dicomWeb — are a resolver
registration and nothing more. Two rules keep that true:

- a resolver that has no credential available **declines**, so resolution falls through to the next
  hint instead of failing the bundle; and
- **credentials are never written into a bundle.** A hint names a *location* and a *scheme*. The
  reader's environment supplies the authority.

### 6.3 `voxelDigest`, defined

Pinned to the byte, because a TypeScript writer and a Python reader must agree:

1. Reconstruct the volume to its final numeric values — **after** `RescaleSlope`/`RescaleIntercept`
   are applied, if `recon.rescale == "applied"`.
2. Lay the samples out in **C order `(z, y, x)`**: `z` slowest, `x` fastest.
3. Use the **native dtype** named in `recon.dtype` (NumPy-style, e.g. `<i2`, `<f4`, `|u1`),
   **little-endian**.
4. **No padding** of any kind — no chunk padding, no row padding, no trailing alignment.
5. `voxelDigest` = lowercase hex SHA-256 of exactly those bytes.

The byte count is therefore exactly `dims[0] * dims[1] * dims[2] * itemsize`.

*(A worked example against the project's synthetic 4×3×5 fixture is in
`logic/mrcom/resolve.test.ts`, which is the normative cross-check: the same digest is asserted from
TypeScript and from `tools/mrcom_check.py`.)*

---

## 7. Scope of this version

### 7.1 Images — by reference or embedded
Full support, both modes.

### 7.2 Segmentations — embedded, referenced as provenance
A DICOM SEG the scene displays is listed in `ReferencedSeriesSequence` and described in
`bulk.sources` with `kind: "dicom-seg"`, so lineage and terminology are recorded. But the **voxels are
embedded**, not resolved from the SEG, in this version: a binary labelmap deflates to very little, and
the SEG rasterizer (overlap layering, per-frame plane geometry, coded terminology) currently lives
inside a decode worker rather than in a reusable reader. The descriptor shape is specified now so that
resolving a SEG later changes no bytes in the format.

### 7.3 Meshes and surfaces — embedded; `dicom-surface` reserved
Mesh geometry is embedded as content-addressed blobs. A `dicom-surface` source kind is **reserved**
for referencing a standard surface instance — Surface Segmentation (`1.2.840.10008.5.1.4.1.1.66.5`) or
Encapsulated STL / OBJ / MTL (`…104.3` / `…104.4` / `…104.5`) — and a writer records it when a caller
supplies one, so provenance can be captured before resolution is implemented.

### 7.4 Size, and why there is a cap
A bundle is built as a single byte buffer, so an `EMBED` of a whole study will exhaust memory before it
exhausts DICOM. A writer refuses above a configured cap (default 512 MiB) and says to use `REFERENCE`
or `HYBRID` instead, which is almost always the right answer anyway.

`MRCOMBundleUID` is a UID rather than a flag so that a future version can split one scene across
several instances without a format break. **This version does not split**, and a reader may assume one
bundle is one instance.

---

## 8. Privacy

Three hazards, each with a rule:

1. **The screenshot is burned-in annotation.** It contains patient-identifying view labels and chrome.
   `BurnedInAnnotation` is therefore always `YES` — conformant, and honest to any downstream de-id
   tool, which will then know not to pass the pixels through untouched.
2. **A private block can smuggle PHI past a de-identifier.** Conformant de-id removes private
   attributes by default, which is a *safety* property here; but a de-id profile configured to retain
   private tags (the "retain safe private" option) must enumerate MRCOM's elements explicitly before
   doing so. Any mrson `dicom` carry-forward bag is restricted to a **declared whitelist** of
   attributes; a bundle must never become an unlisted channel for the tags a de-identifier just
   removed from the dataset around it.
3. **`REFERENCE` mode names UIDs.** SOPInstanceUIDs and SeriesInstanceUIDs are themselves identifiers
   under most profiles. A bundle shared outside the environment that produced it must be
   de-identified as a whole — UIDs remapped consistently across the private block, the manifest *and*
   the reference sequences — not merely stripped of its private group.

---

## 9. Compared with `SlicerDataBundle`

3D Slicer's `DICOMSlicerDataBundlePlugin.py` + `DICOMLib/DICOMExportScene.py`, private group `0xCADB`,
got the idea right: an `.mrb` in a private tag of a Secondary Capture whose pixel data is a screen
grab, so that conventional DICOM infrastructure can move a scene. What follows is what changed.

| `SlicerDataBundle` | MRCOM |
|---|---|
| Payload recovered by **seeking backwards from EOF** by a byte count — works only because `0xCADB > 0x7FE0` puts it last in the file | Group `< 0x7FE0`; typed lengths; read by a real parser; manifest reachable from a prefix read |
| Byte count **smuggled into the private creator string** (`"3D Slicer <zipSize>"`) because typed elements "didn't survive the dump2dcm step" | `UL` lengths; the creator carries nothing but identity |
| `(cadb,1008)` written but documented as unreliable | every length and digest is typed and authoritative |
| No integrity check of any kind | three digest levels — manifest, scene, per-blob — algorithm declared once |
| One explicit-length `OB` holding a multi-hundred-MB zip | content-addressed blob sequence, ~1–2 MB items, no archive, no recompression |
| Scene data always embedded; a scene over existing DICOM duplicates it | `REFERENCE`/`HYBRID`, resolving through a pluggable source registry |
| Requires `dcmdump` + `dump2dcm` + `img2dcm` and a textual dump intermediate | pure in-process write; pure pydicom read |
| Composite context passed as `img2dcm -k Key=Value` command-line arguments | inherited from a parsed reference instance, VR-checked, coercions reported |
| `load()` calls `OpenSlicerDataBundle` → `vtkMRMLScene::Connect()`, which **clears the scene**, then diffs node sets to guess what arrived | load is an additive merge that returns the ids it added |
| Export never inserts the result into the DICOM database | writing produces bytes; insertion is a separate, additive step |
| Lineage discoverable only by opening the payload | lineage in standard attributes, primary parent normative |

---

## 10. Reading the old format

`SlicerDataBundle` instances exist and must not be stranded. A reader is specified as a **migration
path**, not a mode of this format: detect `(cadb,0010)`, take the byte count from the creator string
(`"3D Slicer <n>"`, the only reliable source), slice the payload out of `(cadb,1010)` by length —
**not** by seeking from EOF, which is unnecessary once the element is parsed properly — unzip the
`.mrb`, and convert its `.mrml` to mrson. The result is an ordinary mrson scene and can be rewritten
as an MRCOM bundle.

---

## 11. Conformance

A **conformant writer** must: use the creator `MRCOM.MRSON.1`; allocate the block by scanning for a
free slot; write `1001`–`1006` and, when a scene is present, `1010`–`1014`; write typed lengths and
bare-hex digests; populate `ReferencedSeriesSequence` with the primary parent first; set
`BurnedInAnnotation YES`; derive composite context from a parsed reference instance, never an index;
and emit Explicit VR Little Endian regardless of the reference instance's transfer syntax.

A **conformant reader** must: locate the block by creator, not by assumed offset; slice payloads to
their typed lengths rather than element lengths; verify the manifest, scene and blob digests before
use; verify `dims`, `ijkToRAS` and `voxelDigest` before accepting resolved bulk; walk `retrieve[]` in
order and fall through on failure; and, when the reference sequences are present but the creator is
not, report a stripped bundle rather than an unrecognized file.

A reader that cannot verify a digest **must refuse the data**, not load it with a warning.
