# IDC Explorer — roadmap

Companion to [`README.md`](README.md), which holds the idea and the frames/rows/parts model.
This file is the build order, the reuse inventory, and an honest list of what will break.

## Sequencing

Ordered so that nothing which works today stops working. **`examples/spine` and
`examples/remind` are not modified at any step** — they are the reference implementations, and
the decision to keep IDC Explorer self-contained is deliberate: two instances do not define an
abstraction, so the shared core is deferred until a third collection earns it.

**0. Placeholder** — *(done: this directory)*. Docs and non-executing sketches.

**1. Prove the index builder.** `worker/build_index.py`: one `/v3/sql` query plus `/v3/stats`
and `/v3/citations` → a generic index JSON. **Acceptance:** regenerate the `remind` index from
SQL alone and diff the totals against the committed `examples/remind/remind-index.json` —
114 cases, 1346 series, 43.5 GB. Cheap, and it validates the whole v3 bet before anything is
built on it.

**2. Copy, don't extract.** Bring the decode worker and loader into `lib/` as *copies*.
Duplication is the deliberate price of keeping this self-contained; revisit at step 6.

**3. Generic viewer shell** on the frames/rows/parts model, driven by a hand-written profile
for ONE new collection. Roughly 700 of ReMINDer's 1039 browser lines are already
collection-agnostic — the compare row, TF editor, crosshair plumbing, maximize, column chips,
case picker and resize.

**4. Generic dashboard** — stat tiles, coverage grid, case table, drill modal, with the
`postMessage` protocol generalized to `jumpPart` / `stepPart` / `closeDrill`.

**5. Third collection as the acceptance test.** Pick one that *stresses* the model rather than
one that fits it — variable-timepoint longitudinal oncology is the likeliest to break it.
Target: a profile plus fewer than 150 lines of custom code.

**6. Only then** decide whether to promote `lib/` to a top-level `idc/` and migrate spine and
remind onto it.

> **Do not open at the profile interface.** Written after steps 1–5 it describes code that
> works; written first it is a guess from two data points. The sketches in `profiles/` exist
> to show the *shape*, not to be implemented as specified.

## Reuse inventory

Verified present in the repo. Do not rewrite any of it.

**The decode path**
- `examples/remind/remind-worker.js` — multi-frame instances (every ReMIND ultrasound series is
  one 8-bit ~193-frame object up to 197 MB), SEG rasterisation onto a **caller-supplied** grid,
  and isotropic downsample *before* transfer. A strict superset of
  `render/vendor/idc_tools/idc-worker.js`, and the single largest as-is win available.
- `examples/remind/remind-data.ts` (`runWorker`, the concurrency slot queue, `loadVolume`,
  `loadSeg`) — already collection-agnostic.
- `render/vendor/idc_tools/s3.js` — `s3ListKeys`, `fetchRetry`, `idcS3`, `ohifViewerURL`.

**Rendering + patient space**
- `render/slice-renderer.ts` — `setMirrorFrame`, `viewToRas`, `rasToView`, `spanMmFor`,
  `zoomAbout`. The patient-space contract, single-sourced; nothing collection-shaped in it.
  **The radiological sign convention lives here and must not be re-derived anywhere else.**
- `render/fields.ts` `ImageField` (incl. `setClim`), `render/scene-renderer.ts`,
  `render/bake.ts`, `render/scene-volume.ts` `lutFromTransferFunctions`, `render/zarr.ts`.
- `logic/segmentation-logic.ts`, `algorithms/editable-segmentation.ts`,
  `algorithms/geom.ts` `resampleIsotropic`.

**Shared demo UI** — `render/demos/{slice-control,camera-control,crosshair,view-grid,sl-chrome,idc-info}.ts`.
Both existing demos already use exactly these six.

**Stranded generic code worth rescuing** (currently living inside `examples/spine`)
- `spine-compare-scene.ts` — `invertAffine`, `resampleLabels`, and `levelGeometry`, which
  computes centroid **and** RAS bbox per label. ReMINDer's `addSeg` is the lossier duplicate
  (centroid only) and would gain from the merge.
- `spine-compare-scene.ts` — the extent/visibility machinery, including the "hidden labels
  become background so outer shells cap the contact face" trick. Hard-won, and generic over any
  part-labelled shell.

**Build / test**
- `deno bundle` for the viewer entry; plain HTML + inline module for the dashboard.
- `harness/cdp.ts` — `CDP.eval` / `waitFor` / `screenshot` / `drag` / `wheel`. Both existing
  drivers re-implement this inline; the generic driver should not. Register in
  `harness/run-all.ts` `BROWSER`.
- The `dataviz` skill and its `validate_palette.js`. The toolkit can ship the *validators*; it
  cannot ship the judgement — see the colour note in `examples/remind/remind-data.ts` for what
  one real palette decision costs.

## Features worth adding

A menu, not commitments.

**Cohort building** — a builder UI driven by `/v3/attributes` with live counts from
`/v3/cohort/counts` before anything downloads; a raw-SQL escape hatch for what filters cannot
express; save/share a cohort as a URL; cross-collection cohorts (*all brain MR with a tumour
SEG, wherever it lives*).

**Dashboard** — chart primitives keyed to the part-metric shape: coverage grid (boolean),
parallel coordinates (scalar per part), **swimlane** (variable-cardinality timepoints, which
both current demos would fail); clinical joins from `/v3/clinical/tables/{t}/rows` for
survival / stage / treatment arm — an axis neither demo has, and where the science is;
cohort provenance straight from `/v3/citations` and `/v3/licenses`; "what will this cost me"
before the click, from `index.series_size_MB` and `instanceCount`, with the obliquity and
regular-spacing QC flags from `volume_geometry_index` alongside (that table carries neither
dims nor spacing, and skips multi-frame series entirely — see `worker/README.md`).

**Viewer** — declarative hanging protocols instead of always rows × orientations; checkerboard
and difference blends alongside the existing rock/fade/toggle; `Frame.registrationGroup` so
unregistered multi-modal cohorts do not pretend to share a crosshair; 4D/cine frames
(`render/cine-field.ts` and `render/sequence.ts` already exist); export to screenshot or an
`mrson` scene that reopens in Slicer.

**Scale** — index sharding (both demos ship one ~370 KB JSON for ~120 cases); a per-frame
progressive resolution ladder (spine's `ct_low → ct_med` swap, generalized); remote render for
volumes too big for the client, via the Producer/Reconstructor path in
`docs/UNIFIED-RENDERING-PLAN.md`.

## Where this will leak

Named now so nobody is surprised later.

- **Variable-cardinality longitudinal** (2–12 timepoints per patient). Frames and rows survive;
  the *dashboard* does not — variable columns break a coverage grid and per-case axis counts
  break parallel coordinates. Needs the swimlane primitive and a part order that is a function
  of the case. Also reintroduces a real date axis, which ReMINDer conspicuously lacks: every
  `StudyDate` in that collection is `1982-12-25`.
- **Unregistered multi-modal cohorts.** ReMINDer's premise is that rows *are* registered. A
  chest CT beside a brain MR makes one RAS focus meaningless. Cheap fix, worth reserving now:
  a registration group per frame, and a map of focus points rather than one.
- **PET/CT fusion.** Structurally two frames, but it wants one row with two blended image
  layers and a fused colormap — the row-owns-one-image assumption fails. Leave the seam; hold
  one image per frame in v1. Also needs SUV scaling in the worker.
- **4D / cine / DCE / multi-b DWI.** A 4D series is a frame with a time axis. Don't block it,
  don't build it.
- **Cohort scale.** Set a v1 ceiling — low thousands of cases, a few MB of index — and make
  index loading an interface rather than a `fetch` of one file. Don't build sharding on spec.
- **Automated colour.** A profile that picks eight arbitrary hues will fail the same
  colour-blindness gates ReMINDer's palette had to pass. Ship the validators, not the
  judgement.
- **Browser-side metrics.** State the rule and hold it: profile metric functions are **pure
  over the index**. Anything needing voxels is the worker's job.

## Verification

- **Placeholder:** nothing here is imported or built, so the proof is that everything else is
  unchanged — `deno bundle examples/remind/remind-compare-browser.ts` and both ReMINDer drivers
  stay green.
- **Step 1:** regenerate the `remind` index from `/v3/sql` and diff counts against the
  committed index.
- **Steps 3–4:** one generic CDP driver on `harness/cdp.ts` asserting the class of numeric
  ground truth ReMINDer's driver does — decoded geometry, SEG voxel counts and centroids, every
  row's slice offset resolving to the *same* RAS point after one jump, and that the page
  downloads nothing on open. Headed Chrome, on screen, never headless.

## Open decisions

1. **Which collection is the first target?** It decides whether the abstraction gets a real
   test. Longitudinal oncology stresses parts and timepoints; a PET/CT collection stresses
   frames; a large multi-institution CT collection stresses scale.
2. Does ReMINDer eventually migrate onto the shared core, or stay a frozen reference?
3. Is the cohort builder part of IDC Explorer, or a separate page that emits a cohort JSON the
   explorer consumes?
