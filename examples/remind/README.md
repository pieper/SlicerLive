# examples/remind — ReMINDer: the ReMIND collection, and one operation at a time

The [ReMIND collection](https://doi.org/10.7937/3rag-d070) in the Imaging Data
Commons — the Brain Resection Multimodal Imaging Database from Brigham and
Women's Hospital — is 114 patients who had image-guided brain-tumour resection
between 2018 and 2022, each imaged **before** the operation and **again during
it**. ReMINDer is a dashboard over what is in there, and a full-screen drilldown
that puts one patient's operation on screen as a stack of **comparisons** — pairs
of acquisitions you toggle between, registered in patient space.

Unlike `examples/spine`, nothing is pre-baked into a bucket: the viewer streams
DICOM **straight from IDC's public object store** and reconstructs it in the
browser. The only artefact is a metadata index.

## The collection, as the index sees it

| | |
|---|---|
| patients | 114, each with exactly **2 studies** |
| series | 1346 — 670 MR, 320 US, 356 SEG |
| size | 43.5 GB total, median 362 MB per case |

Two facts make the timeline reconstructable from metadata alone, and both are
checked rather than assumed by `worker/build_index.py`:

- **Which study is intra-operative.** Every deidentified StudyDate in the
  collection is `1982-12-25`, so dates order nothing. The study that *contains
  ultrasound* is the intra-operative one — true for 114/114 patients.
- **Where in the operation each acquisition sits.** The series descriptions say
  so: `US_pre_dura` → `US_post_dura` → `US_pre_imri`, giving the full order

      pre-op MRI → iUS before dura opening → iUS after dura opening
                 → iUS before intra-op MRI → intra-op MRI

- **What each SEG belongs to.** Every segmentation is named
  `<structure> seg - MR ref: <SeriesDescription>`, which resolves to exactly one
  MR series in the same study for all 356 of them (the script reports rather than
  guesses if a reference is ambiguous).

## Pages

- **`reminder.html`** — the dashboard. Stat tiles, the five-stage surgical
  timeline with per-stage case coverage, a per-case coverage grid (one row per
  case × 5 stages + 6 segmented structures, incomplete cases sorted to the top),
  MR-sequence and structure histograms, and filters. Metadata only — no pixels
  are fetched until you click a case, which opens the viewer in a drilldown.
- **`remind-compare.html`** + **`remind-compare-{browser,scene}.ts`** — the viewer, and it
  is **compare-centric**. Looking at one series at a time answers almost nothing about an
  operation; the questions are all differences. So the unit of display is not a series, it is
  a **pair**: every row is A ⇄ B over the same anatomy, and you read it by toggling. A case
  opens on one comparison and offers two more, each answering a different question:

  | row | pair | question |
  |---|---|---|
  | 1 | pre-op T1+Gd ⇄ pre-dura US | is the tumour where the plan said? |
  | 2 | pre-dura US ⇄ final US | how far has the resection got? |
  | 3 | pre-op T1+Gd ⇄ intra-op MR | what does the post-resection MR show against the plan? |

  Roles resolve through fallback ladders (`pickRole` in `remind-data.ts`), because the ideal
  pair exists in only 85–92% of cases and an exact intra-op sequence match in 52% — a case
  with no `T1_postcontrast` degrades to `T1_precontrast`, one with no pre-dura US to
  post-dura. With the ladders, all three pairs resolve for **114/114 cases**.

  **One set of compare controls drives every row and every column at once** — fade, rock,
  toggle, and `space` to flip A/B — so the whole grid stays phase-locked and differences
  across rows are comparable. What is per-row is only the pair itself: each row has its own A
  and B selectors over every series in the case, plus swap and remove.

  Only the volumes some row references are resident, and a shared volume is loaded once
  however many rows use it (three rows typically need four volumes, not six). Dropping a row
  or re-pointing a selector frees whatever nothing else needs.
  `?case=<pid>&rows=1|2|3`.

### Navigating it

- **Slice gestures** are the shared SlicerLive ones — `attachSliceControls` owns them for
  every MPR demo in the repo, so this one does not invent a second dialect: wheel = scroll,
  left-drag = scroll, middle/shift+left = pan, right-drag or ctrl/⌘+wheel = zoom,
  shift+move = crosshair, double-click = maximize.
- **Everything is linked in patient space.** A gesture drives the row under the cursor; the
  resulting frame is then read back *out* of that renderer as a RAS centre and a field of view
  in millimetres and pushed to every other row. Read-back rather than re-derivation is the
  point: the plane basis and the radiological sign convention stay single-sourced in
  `SliceRenderer`, and rows on different grids stay registered.
- **Slice ↔ 3D** are two expressions of the same thing — a centre and a span — so zooming a
  slice dollies the 3D camera and dollying the 3D zooms the slices (`Link 3D`, on by default).
  Orbiting is deliberately *not* coupled: it changes direction, not extent.
- **Framing** starts from the **smallest** resident volume's extent, not a bounding-sphere
  diagonal. In a comparison that is the region anyone actually cares about — an ultrasound
  block is ~10 cm inside a 25 cm head — and every other row zooms to the same patient-space
  window. It re-frames as each volume lands and stops the moment the user moves anything.
- **Compare (rock / fade / toggle)** draws A and B to two *stacked canvases* — both already
  render the same patient-space frame, so they are pixel-registered by construction — and the
  blend is B's alpha. Nothing in the slice or volume shaders has to learn about a second
  volume, and because both canvases keep their last render, rocking animates by touching one
  opacity per frame: no re-render, no GPU work between view changes.
- **Transfer functions are per volume**, because the volumes are not comparable in scalar
  units (raw MR next to 8-bit ultrasound). The `TF` panel shows that volume's own intensity
  histogram with draggable opacity control points (click to add, alt/right-click to remove), a
  colour ramp, and window/level. Dragging a handle rewrites 256 LUT entries in place via the
  repo's `lutFromTransferFunctions` — no pipeline rebuild, so it is interactive. Ultrasound
  defaults to the warm `amber` ramp; MR to `grey`.

## `remind-worker.js` — the decode path

Adapted from `render/vendor/idc_tools/idc-worker.js`, generalised for three
things the roulette's one-image-plus-one-SEG shape cannot express:

- **Multi-frame volumes.** Every ReMIND ultrasound series is a *single instance*
  — Multi-frame Grayscale Byte SC, 8-bit, ~193 frames, geometry in the
  Shared/PerFrame functional groups. The roulette worker only ever walked
  one-frame-per-instance series. Frames are ordered by their position along the
  slice normal, never by stored index.
- **SEG onto a caller-supplied grid**, so one MR row can stack tumour +
  cerebrum + ventricles without reloading, each rasterised against the grid that
  row already lives on. (This path also fixes an assumption in the vendored
  version: frames are bit-packed *contiguously*, not byte-aligned per frame, and
  the SEG's own Rows/Columns govern — not the image's.)
- **Downsample before transfer.** Native ultrasound is 0.125 × 0.125 × 0.5 mm =
  92 M voxels, 371 MB as the f32 an `ImageField` wants. The isotropic trilinear
  resample happens in the worker, so that never crosses `postMessage` or reaches
  the GPU. Defaults: longest extent → 224 voxels, ≤ 8 M voxels total
  (`?maxdim=`, `?maxvox=`).

Display window comes from the data (2nd–98th percentile of a sampled histogram):
ReMIND ultrasound carries no `WindowCenter`/`Width` at all, and the MR values are
raw scanner units, so a fixed guess blows out one row and blacks out the next.

## Colour

Two encodings, both validated rather than chosen by eye (see
`remind-data.ts` for the full note):

- **Timeline** = composite data (ordered stage × modality), so it gets a
  composite encoding: hue says modality (blue MR / orange US), lightness advances
  with the operation. Two one-hue *ordinal* ramps, each validated monotone with
  visible step gaps against both this repo's near-black viewer surface and the
  dashboard's light one.
- **Structures** = categorical. Checked all-pairs against mid-grey anatomy for
  the sets that actually co-occur in this collection. Five colour-carrying
  structures at once is reachable in only 2 of 114 cases, and at that width no
  five-hue set clears the all-pairs floors — so identity also rides the secondary
  encoding the viewer always draws: a per-segment outline in 2D, structure names
  in every row label, and direct-labelled jump chips.

## Rebuilding the index

    python3 examples/remind/worker/build_index.py -o examples/remind/remind-index.json

Queries the IDC public API (no auth, no BigQuery) and writes ~370 KB. Re-run it
when IDC publishes a new data version; the file records which one it came from.

## Tests

    deno run -A examples/remind/test/remind-compare-run.ts [case]   # the viewer
    deno run -A examples/remind/test/reminder-dashboard-run.ts      # the dashboard

Both drive the headed harness Chrome (`:9222`) and check numbers, not
screenshots: that the viewer opens on the intended pair and loads **only** those
two volumes; real decoded geometry (the ultrasound block must come out ~10 cm on
a side and *oblique*, sitting inside the head the MR covers — its axis-aligned
bounding box is legitimately much larger, which is the trap); segmentations
landing non-empty on their own row's grid; every resident volume's slice offset
resolving back to the *same* RAS point after one `jumpTo`; that adding rows walks
the staged defaults and that shared volumes are loaded once rather than per row;
and that one blend reaches every row's every column. The dashboard's counts are
recomputed from the index rather than trusted from the page.

## Build

    deno bundle examples/remind/remind-compare-browser.ts -o examples/remind/remind-compare.js
    # deploy: reminder.html, remind-compare.{html,js}, remind-worker.js, remind-index.json
