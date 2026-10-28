# MRCOM — plan, status and how to pick it up

Status: **in progress, 2026-10-28.** This is the working plan for MRCOM, kept in the repository so
anyone joining the work can start from it rather than from a conversation.

Read this first, then [`MRCOM-SCENE-BUNDLE.md`](MRCOM-SCENE-BUNDLE.md) for the format itself.

---

## 1. What this is, in one paragraph

**MRCOM** (*Medical Reality Communications*) is the DICOM binding of **mrson**, SlicerLive's scene
format. An **MRCOM scene bundle** is one DICOM Secondary Capture instance that carries a complete
mrson scene: the screenshot is the pixel data, so any DICOM viewer shows a picture, and the scene
itself rides in a private block. Bulk data is either **embedded** in the instance or **referenced**
back to the DICOM instances the scene was authored from.

The point is that lossless scene exchange rides the installed base — a VNA, a DIMSE network or a
dicomWeb server moves these without knowing anything about mrson. It supersedes 3D Slicer's
`SlicerDataBundle` (an `.mrb` zip in private group `0xCADB`), whose weaknesses are catalogued in
[`MRCOM-SCENE-BUNDLE.md`](MRCOM-SCENE-BUNDLE.md) §9.

[`MRSON-LIVESCENE.md`](MRSON-LIVESCENE.md) §1b named this binding and marked it P6, unbuilt. This is
that work.

---

## 2. Decisions already taken

Do not re-litigate these without a reason; each cost some analysis.

| | |
|---|---|
| **Carrier** | One Secondary Capture per bundle. Screenshot as uncompressed RGB pixel data. The mrson scene in an MRCOM private block. |
| **Private group / creator** | `0x4D43` ("MC"), creator `"MRCOM.MRSON.1"`. Checked unclaimed against dcmjs, DCMTK (2836 entries, no `4Dxx` at all) and GDCM (only `4d4d`, its own test group). **The creator is the identity; the block number is never assumed.** |
| **Modes** | `EMBED` / `REFERENCE` / `HYBRID`, with **hybrid the default**: reference the image series, embed the authored bulk. A CT series already exists in an archive; a painted segmentation exists nowhere else. |
| **No archive format** | mrson bulk is already chunked and content-addressed, so one blob = one sequence item. The natural chunking *is* the fragmentation strategy. No zip. |
| **Digests** | Bare lowercase hex, algorithm declared once. `"sha256-"` + 64 hex is 71 characters and `LO` is 64 — it would be silently truncated. |
| **Reference mode is render-lossless, not byte-lossless** | Chunk hashes cannot be reproduced bit-for-bit across versions, so a reader reconstructs, **verifies** against a recorded `voxelDigest`, re-chunks, and rewrites the descriptor with honest hashes. `EMBED` is the byte-lossless mode. |
| **Resolution is pluggable** | A resolver registry keyed on a hint's `scheme`. M1 ships `local-study`, `s3`, **`idc`** (REST and MCP paths) and `wado-rs`. Credentialed clouds are a new file plus one registration. **Credentials are never written into a bundle.** |
| **Meshes** | Embed-only for now. The `dicom-surface` descriptor is reserved in the spec; its resolver is deferred. |
| **Slicer plugin** | pydicom, not the `dcmdump`/`dump2dcm`/`img2dcm` chain. |
| **ctkDICOMDatabase** | Read-only, two backends (see §5). |
| **Nothing in `logic/mrcom/` may touch the DOM** | So Deno and headless callers can use it. The screenshot is an injected raw-pixel buffer, never a canvas grab. |

---

## 3. Status

### Done and green

Tasks 1-13 and 15 of §6. The hermetic tier passes; `logic/mrcom/` and `mrson/` are lint-clean.

- **[`MRCOM-SCENE-BUNDLE.md`](MRCOM-SCENE-BUNDLE.md)** — the format spec. Private block element
  table, manifest, the three modes, SC attributes, lineage rules, detection, resolution,
  `voxelDigest` defined byte-for-byte, the `SlicerDataBundle` comparison, privacy.
- **[`../mrson/`](../mrson/)** — the schema `MRSON-LIVESCENE.md` cited at a repo that never existed,
  plus `validate.ts`, a stdlib-only `validate.py`, and conformance + TS/Python parity tests over
  **real producer output**. [`../mrson/README.md`](../mrson/README.md) records **eight
  doc-versus-code divergences** the schema work adjudicated.
- **`render/vendor/dcmjs/`** — the vendored ESM + UMD builds (§4), with both loaders repointed.
- **`logic/bytes.ts`** — the blob-channel helpers, with the zlib-wrapper commitment tested.
- **`logic/bulk.ts`** — `blobRefs()` and `bulkSources()`, moved out of
  `render/sessions/session-store.ts` so `logic/mrcom/` stays DOM-free. `blobRefs()` now walks mesh
  `normals` and any `blobs` map; it did not, so a mesh's normals were reachable in a scene and
  silently absent from every export.
- **`logic/mrcom/format.ts`** — a typed view of `mrson/schema/mrcom.schema.json`, so the TypeScript
  writer, the pydicom reader and the spec cannot disagree about a tag.
- **`logic/mrcom/vr.ts`** — the VR guard for the ctkDICOM-index trap (§5.4).
- **`logic/mrcom/sc-pixels.ts`** — raw pixels in, Image Pixel module out, box-filter downscale,
  placeholder for when capture fails.
- **`logic/mrcom/write.ts`** — the writer. Embed / reference / hybrid, the closure split, coerced
  composite context, STORED blob items, the size cap.
- **`logic/mrcom/read.ts`** — the reader. `peekMrcomManifest()` from a prefix read, digest
  verification that **refuses** rather than warns, typed-length slicing, and "stripped bundle"
  reporting.
- **`logic/mrcom/load.ts`** — a non-destructive merge: `put` ops only, collision renaming, and what
  is still missing.
- **`logic/mrcom/no-dom.test.ts`** — enforces the contract §5.1 depends on.
- **`logic/readers/synthetic-dicom.ts`** — shared fixtures, tied to the validated geometry oracle.

### Next

- **14** reference resolution: `logic/mrcom/{resolve,resolvers}.ts`, `logic/mrcom/sources/*`, and
  extracting the IDC study→series lookup out of `render/demos/bir-browser.ts` into
  `logic/idc/index-api.ts`. **This is the next task and the biggest remaining one in M1.**
- **16-17** `render/capture.ts` (the only DOM/GPU part) and the UI panel
- **18-20** browser round trip, the real IDC round trip, external validation with pydicom and
  `dcmdump`, and an import into an unmodified Slicer
- **21** CI and harness docs

---

## 4. The dcmjs dependency — read before touching it

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
**SlicerLive vendors a build from that branch** rather than waiting for upstream merge, because
upstream merge is not expected soon.

> **These PRs are under review and must not be amended, rebased or force-pushed** without the
> maintainer's say-so — dcmjs is in production use elsewhere. Treat `mrcom-integration` as read-only
> input. If MRCOM needs a further dcmjs change, raise it rather than committing it.

Verified end-to-end on that branch: an mrson scene deflated into a private block of a Secondary
Capture, digest verified after inflate, screenshot pixels byte-exact, Explicit VR LE **despite an
implicit-VR reference**, block located by creator, `ReferencedSeriesSequence` intact.

**Integration gotchas**

- The private block must be written on the **`DicomDict`** — after `datasetToDict()` denaturalizes —
  not on the naturalized dataset. Private tags are not in `nameMap` unless their names are registered
  first (which is what #625 enables).
- An odd-length `OB` comes back **one byte longer**, with a trailing pad: DICOM value fields are even
  length. This is why the format carries an explicit typed length per payload and a reader slices to
  it rather than trusting the element length.
- Do **not** inherit a reference instance's file meta. `datasetToDict` keeps whatever
  `TransferSyntaxUID` it finds, so an implicit-VR reference silently yields implicit-VR output. #627
  pins it; anything else building a dataset from a reference must do the same.

---

## 5. For SlicerAlbula

[SlicerAlbula](https://github.com/rkikinis/SlicerAlbula) is the first external consumer: the aim is
that MRCOM bundles replace `.albula` folders for sharing a scene. This section is the context needed
to plan that side of it.

### What MRCOM gives Albula

A bundle is **one ordinary DICOM instance**. It goes in an Albula database the same way any other
instance does, Slicer opens it, a PACS stores it, and a viewer that knows nothing about mrson still
shows the screenshot. In reference mode a scene over a public IDC study is tens of kilobytes that
reloads from the public buckets with no credentials.

### Constraints Albula imposes on MRCOM, already honoured

1. **Two runtimes, not one.** Albula is a Deno desktop app (`node:sqlite` inside its own Deno); the
   browser tab has File System Access plus a WASM SQLite. So anything touching a ctkDICOMDatabase is
   one interface with two backends, mirroring the `MemoryFS`/`DenoFS`/`FsaFS` split in
   `render/sessions/session-fs.ts`. And **nothing in `logic/mrcom/` touches the DOM**: the writer is
   `Uint8Array` in, `Uint8Array` out, and the screenshot is an injected raw-pixel buffer, so a Deno
   server can `import` the whole surface. The vendored dcmjs ships **both** an ESM and a UMD build for
   this reason.
2. **Additive only.** A writer emits new instances; it never rewrites a source instance, never
   modifies an existing series, and never touches a database schema. Producing the bytes and
   inserting them are separate steps.
3. **Lineage in standard attributes.** `ReferencedSeriesSequence` **item 0 is normatively the primary
   parent**, with `ReferencedInstanceSequence` for instance granularity and
   `DerivationDescription`/`DerivationCodeSequence` for the kind. So a provenance index like Albula's
   `provenance.sqlite` can record a bundle's parent **without parsing the private block** — which also
   matters because conformant de-identification removes private attributes by default (PS3.15 Annex
   E). A bundle is recoverable-or-absent, never silently corrupt.
4. **Two traps honoured in the writer**, both learned from Albula:
   - **Never feed ctkDICOMDatabase *index* values into DICOM tags.** The index stores display
     concatenations and reformatted values that violate VR limits — a 68-character `StudyDescription`
     against `LO`'s 64, an ISO-format birth date against `DA`'s 8 digits. Composite context comes from
     the **reference series' real tags**, and every coercion is reported to the caller rather than
     silently truncated.
   - **Do not assume explicit VR** when reading a reference instance. Implicit-VR-LE series exist.

### What Albula would need to do

- Consume `logic/mrcom/*` from SlicerLive (DOM-free, so importable from the Deno server) plus the
  vendored **ESM** dcmjs build.
- Supply a screenshot as raw pixels (`{rgba|rgb, width, height}`) — a WKWebView frame grab, or none at
  all, in which case the writer synthesizes a placeholder rather than failing.
- Supply a reference instance as **bytes or a parsed dataset**, from a file found through its own
  database.
- Write the resulting `Uint8Array` with `Deno.writeFile`, then index it additively, as its
  `DICOMProvenance` module already does for SEG and Basic Text SR objects.

### Open questions for Albula specifically

These are genuinely undecided and are the right things to plan around:

1. **Surfaces.** Albula already has a DICOM-compliant surface round trip. MRCOM currently embeds mesh
   bulk and only *reserves* a `dicom-surface` descriptor. Which IOD does Albula write — Surface
   Segmentation (`1.2.840.10008.5.1.4.1.1.66.5`) or Encapsulated STL/OBJ/MTL (`…104.3/.4/.5`)? The
   answer decides whether referencing surfaces is cheap or a real mapping effort.
2. **Which database backend first.** The Deno/`node:sqlite` backend is the one Albula needs and the
   simpler of the two; the plan has it as M3, before the browser backend.
3. **The browser derived-series nesting.** Albula's browser nests derived series under their parent
   and that behaviour is a requirement of the promoted component, not a nice-to-have — an MRCOM bundle
   *is* a derived series. Worth comparing Albula's rules against what the promoted browser does.
4. **Albula's SlicerLive checkout is ahead of `pieper/SlicerLive` main** (it has
   `algorithms/surface-nets.ts`, `docs/GREASED-LIGHTNING.md`, a `DENO_VERSION` pin and a `node:sqlite`
   desktop server). MRCOM is landing on `pieper/SlicerLive` main, so a rebase is coming; M1 is
   deliberately confined to new files plus docs to keep that cheap.

---

## 6. Milestones

**M1 — the format and the TypeScript writer/reader.** Tasks, in order; 1–5 are done.

| # | Task | Files |
|---|---|---|
| 1 | Format spec; reconcile the mrson doc with reality | `docs/MRCOM-SCENE-BUNDLE.md`, `docs/MRSON-LIVESCENE.md` |
| 2 | `mrson/`: schema, `validate.ts`, `validate.py`, unit tests | `mrson/**` |
| 3 | Conformance: real producer output validates; TS↔Python parity | `mrson/{conformance,validate-parity}.test.ts`, `mrson/fixtures/` |
| 4 | mrson type additions; closure fixes | `render/mrson.ts`, `render/sessions/session-store.ts` |
| 5 | dcmjs write support | five PRs, see §4 |
| 6 | Vendor dcmjs; repoint the loaders | `render/vendor/dcmjs/*`, `logic/readers/dicom-series.ts`, `render/vendor/idc_tools/idc-worker.js` |
| 7 | Shared byte helpers | `logic/bytes.ts` |
| 8 | Format module + VR guard | `logic/mrcom/{format,vr}.ts` |
| 9 | SC pixel builder | `logic/mrcom/sc-pixels.ts` |
| 10 | Shared synthetic DICOM fixtures | `logic/readers/synthetic-dicom.ts` |
| 11 | Writer: embed, then reference/hybrid | `logic/mrcom/write.ts` |
| 12 | Reader, incl. `peekMrcomManifest` | `logic/mrcom/read.ts` |
| 13 | Non-destructive scene load | `logic/mrcom/load.ts` |
| 14 | Reference resolution + `voxelDigest` + the resolver registry | `logic/mrcom/{resolve,resolvers}.ts`, `logic/mrcom/sources/*`, `logic/idc/index-api.ts` |
| 15 | DOM-free guard test | `logic/mrcom/no-dom.test.ts` |
| 16 | Screenshot capture | `render/capture.ts` |
| 17 | UI panel + test hooks | `render/demos/mrcom-panel.ts` |
| 18 | Browser round trip, synthetic | `harness/mrcom.browser.test.ts` |
| 19 | Real IDC round trip, `SL_NET`-gated | `harness/mrcom-idc.browser.test.ts` |
| 20 | External validation: pydicom checker, `dcmdump` recipe, unmodified-Slicer import | `tools/mrcom_check.py` |
| 21 | CI + harness docs | `.github/workflows/test.yml`, `docs/HARNESS.md` |

**M2 — Slicer plugin.** `DICOMMRCOMPlugin.py` with pydicom. `examineFiles` keys on a precached
`"4d43,0010"`; `load()` is an **additive merge**, never `vtkMRMLScene::Connect()` (which clears the
scene — the old plugin's worst behaviour); `export` writes the bundle **and inserts it into the DICOM
database**, which `DICOMExportScene.py` never did. Grows out of `tools/mrcom_check.py`.

**M3 — ctkDICOMDatabase adapter, Deno backend.** `logic/dicomdb/db.ts` + `NodeSqliteDatabase`,
read-only. **Resolve instances by reading `Images.Filename`** — a path relative to the database
directory — never by reconstructing paths. `UseShortStoragePath` defaults to **true**, so the hashed
layout is the normal case. Two limitations to surface rather than discover: `Images.Filename` may be
absolute (files indexed in place, outside a granted handle), and `Images.URL` needs its own path.

**M4 — browser backend + the browser UI.** `FsaWasmDatabase`, then promote SlicerRad's
`pacs-browser.ts` + `catalog/rollups.ts` + `catalog/handle-store.ts` into SlicerLive. Reconcile
**three** existing browsers — CTK's two generations, SlicerRad's, and Albula's. Adopt CTK's two
layers: `ColumnDisplayProperties` for the table, and Punzo's visual-browser **role set** for cards
(`IsCloud`, `InstancesLoaded`, `ThumbnailPath`, filtered-versus-total counts kept separate).

**M5 — dicomWeb transport and more sources.** STOW-RS, QIDO discovery, then DIMSE/VNA through Slicer.
The credentialed resolvers (`s3-signed`, `gcs`, `azure-blob`, token `wado-rs`) land here.

**M6 — the rest of the mappable subset by reference.** `logic/readers/dicom-seg.ts` (rasterizer
extracted from `idc-worker.js`), then `dicom-surface` resolution interoperating with Albula's surface
writer, then RTSTRUCT and markup→SR/GSPS.

**M7 — do not orphan the old bundles.** A reader for `(cadb,*)` `SlicerDataBundle` instances that
converts the embedded `.mrb` to mrson, so a decade of saved scenes can migrate rather than strand.

---

## 7. How to run things

```
deno test -A --no-check mrson/            # schema, conformance, TS↔Python parity (needs python3)
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

## 8. Open risks

1. **De-identification is the one to get right now, not later.** The screenshot is burned-in
   annotation (`BurnedInAnnotation` is always `YES`), and a private block can carry PHI past a tool
   configured to retain private tags. Any mrson `dicom` carry-forward bag is restricted to a declared
   whitelist. Reference mode also names UIDs, which are identifiers under most profiles — a bundle
   shared outside its origin must be de-identified **as a whole**, with UIDs remapped consistently
   across the private block, the manifest *and* the reference sequences.
2. **`voxelDigest` must stay pinned to the byte** (C order `(z,y,x)`, post-rescale, native dtype,
   little-endian, unpadded) or TypeScript and pydicom will disagree — the same class of failure
   `render/test/commits-conformance.test.ts` exists to prevent for canonical numbers.
3. **Reference-mode trust.** If a source series is re-encoded, `voxelDigest` fails. Default is to
   **fail loudly**; showing different pixels under a scene's name is worse than not opening it.
4. **Size.** A bundle is built as one byte buffer, so `EMBED` of a whole study exhausts memory before
   it exhausts DICOM. The writer refuses above a cap and says to use reference mode. `MRCOMBundleUID`
   is reserved as the splitting point for a future multi-instance bundle; this version does not split.
5. **WebGPU canvas readback** for the screenshot: `drawImage(gpuCanvas)` is only reliable in the same
   task as the present. The robust path is render-to-texture plus `copyTextureToBuffer`. Keep the
   placeholder path so a write never fails because capture did.
