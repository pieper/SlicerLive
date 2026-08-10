# examples/spine — SPINEPS vs IDC reference, a real-world SlicerLive scenario

A complete worked example of using the SlicerLive rendering stack on a real
research question: *how often does SPINEPS disagree with the reference vertebra
segmentations in IDC, and what does the disagreement look like anatomically?*

121 cancer patients from the Imaging Data Commons — 55 spine-metastases cases
with expert labels (`Spine-Mets-CT-SEG`) and 66 multiple-myeloma cases with
nnU-Net labels — were segmented with SPINEPS on Jetstream2, compared per
vertebra (Dice + label-shift detection), and published to a public CORS bucket:

    https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/

## Pages (deployed to pieper.github.io/live/webgpu/)

- **`spine-review.html`** — the dashboard: an echarts parallel-coordinates chart
  (one line per case, one axis per vertebral level, value = 1 − Dice vs the
  same-named reference label), stat strip, filter presets, case table. Clicking
  a case swaps the snapshot for the live viewer in an iframe; the per-level Dice
  chips postMessage `{type:"jumpLevel", name}` into it.
- **`spine-compare.html`** + **`spine-compare-{scene,browser}.ts`** — the
  CompareVolumes-style viewer: SPINEPS and reference method rows × selectable
  {axial, sagittal, coronal, 3D} columns over the same CT, linked slicing, one
  shared shift+move crosshair, one camera linked across every 3D cell, and a big
  both-methods 3D view (flat method colours: SPINEPS warm / reference cool,
  tri-state opacity toggles, clip-box extent control from a single vertebra out
  to the full spine). Level buttons jump every view to that bone's centroid.
  `?case=<pid>&coll=<mets|myeloma>`.

What it exercises in SlicerLive: `ImageField` CT volume rendering,
`SliceRenderer` MPR with crisp (σ=0) label overlays, `SegmentationLogic`
JFA-SDF surface shells, `SceneRenderer` clip boxes + GPU picking, the shared
demo chrome (tri-state opacity controls), the crosshair primitives, and the
zarr loader (`render/zarr.ts`, streaming progress).

## Data pipeline (`worker/`)

- `build_cases.py` — merges the pid → IDC `crdc_series_uuid` crosswalks with the
  Dice records into the bucket's `cases.json`.
- `upload_bucket.py` — parallel Swift uploader used for the initial mask export
  (run it datacenter-side; home uplinks are slow).
- `zarr_worker.py` — per case: pulls the CT from the public `idc-open-data`
  bucket, rasterises the reference DICOM SEG in its native geometry, resamples
  everything onto 1.5 mm (`ct_med`, `spineps_med`, `ref_med`) and 4 mm
  (`ct_low`) grids, and uploads each volume as a **single-chunk** deflate zarr
  plus a `meta.json` (with RAS ijkToRAS) whose presence marks the case done —
  the run is resumable by re-running.

### Jetstream2 network traps (hard-won)

- Instances **without a floating IP** get bulk HTTPS to the object store
  blackholed through the shared SNAT — attach a floating IP and clamp the MTU
  (8900 → 1450) before debugging anything else.
- Even then the RGW throttles sustained PUTs to ~2.4 s/request **regardless of
  object size or connection reuse** — hence single-chunk zarr volumes (5 objects
  per case), not 64³ chunk grids (~540).

## Tests (`test/`)

- `spine-compare-run.ts` — CDP driver for the viewer in the headed harness
  Chrome (`:9222`): level geometry, centroid jumps, crosshair/offset linking,
  opacity round-trips, screenshot. Numeric ground truth over eyeballing.

## Build

    deno bundle examples/spine/spine-compare-browser.ts -o examples/spine/spine-compare.js
    # deploy: copy spine-compare.{html,js} + spine-review.html to pieper/live:webgpu/
