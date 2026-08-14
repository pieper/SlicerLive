# profiles/ — what a profile is

A **profile** is the small declaration that turns a generic dashboard + viewer into a study of
one IDC collection or cohort. Everything else — decoding, patient-space linking, compare
modes, transfer functions, the drill modal, the test driver — is supposed to be collection-
agnostic machinery that a profile parameterises.

**Nothing here is wired up.** These are sketches, written so the shape can be argued with
before it is built. Per [`../PLAN.md`](../PLAN.md) the real interface is written at step 6,
*after* a generic viewer exists — written now, it would be a guess from two data points.

| file | what it is for |
|---|---|
| `profile-shape.sketch.ts` | the strawman interface; encodes the frames/rows/parts model |
| `remind.sketch.ts` | ReMINDer as a profile — **N frames, one row each** |
| `spine.sketch.ts` | spine-review as a profile — **one frame, two rows** |

All three typecheck (`deno check profiles/*.sketch.ts`) but import nothing from the repo and
are imported by nothing, so they cannot rot into a half-built implementation.

## The contract in one paragraph

A **frame** is a sampling grid: an image volume plus the labelmaps rasterised *onto that grid*.
It owns renderers, transfer function, window/level and residency — and because rasterising a
SEG onto a grid is a physical fact, **overlays attach to frames, never to rows**. A **row** is
`(frame, layer-selection)`: what the viewer stacks vertically. A **part** is a named sub-case
unit — a vertebral level, a structure, a surgical stage — that is simultaneously the
dashboard's axis, the viewer's jump chip, and the deep-link unit.

## Why the two sketches are worth reading together

They are the two shapes that a "one row per series" model cannot both express:

- **`remind.sketch.ts`** — nine frames, nine rows, one apiece. Every row is a different
  acquisition on a different grid (a 1 mm MR of the whole head beside a 0.125 mm oblique
  ultrasound block), so the only thing registering them is patient space.
- **`spine.sketch.ts`** — **one** frame, **two** rows. Both rows are the same CT on the same
  grid and differ only in which labelmap layer they select.

Read the second one and the payoff should be visible: *"rows sharing a frame share a
`SliceRenderer`"* is not a flag anyone has to set — it falls out of two rows naming one frame.
The existing spine implementation reaches the same place by hand, with one shared
`SliceRenderer` and a `bindRowSlice(key)` that swaps the overlay before each draw.

## Two things the sketches deliberately leave unsettled

1. **ReMINDer wants parts on two axes.** Its stages are the coverage-grid columns, but its
   *structures* (tumour, cerebrum, ventricles) are what you actually jump to — and only
   structures are spatial. One `parts` axis cannot be both. The third collection should settle
   whether `parts` splits into a facet axis and a locatable axis, not this sketch.
2. **`spine.sketch.ts` needs the deferred external-results join.** The SPINEPS masks are not in
   IDC; they were computed on Jetstream2 and live in a public JS2 bucket, so one frame spans
   two source kinds. That is why `SourceRef` is a union even though v1 only needs one arm.

## Rules that should survive whatever the interface becomes

- **Metric functions are pure over the index.** Anything that needs voxels is the worker's job,
  computed once at index-build time. A profile that opens a DICOM file is a bug.
- **Index building stays out of the profile.** The builder is offline Python that cannot run in
  a browser; the index *format* is the seam. A field describing a script this code cannot
  execute would rot.
- **`suggestedRows` marks, it does not fetch.** A case can be 780 MB. The page downloads
  nothing until a human asks.
- **Colour is judgement, not configuration.** Both sketches carry palettes that were validated
  against colour-blindness gates for the sets that actually co-occur — see the note in
  `examples/remind/remind-data.ts`. The toolkit can ship the validators; a profile that picks
  eight arbitrary hues will fail them.
