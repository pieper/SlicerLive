# `algorithms/` — a WebGPU-compute segment-editing engine for SlicerLive

Status: **A-0 built + verified (2026-08-04)**; A-1…A-7 are the reviewable plan below.

`algorithms/` lives at the **top level of the SlicerLive repo, a sibling of `render/`** (not
under it). It imports from `render/` (`device.ts`, `mat4.ts`, `bake.ts`, `fields.ts`) but
**`render/` never imports `algorithms/`** — one-way dependency, so the editor stays independent
of the renderer. Naming is plain (`EditableSegmentation`, `PaintEffect`, `SegEditDriver`) — the
`Live*` convention belongs to `LiveStory`, which is a *Slicer module*; this is repo-internal.

This is the SlicerLive re-envisioning of the Slicer Segment Editor: re-built WebGPU-compute-first,
so painting / growcut / morphology are clean, and the result feeds the renderer's GPU buffers
directly with no CPU round-trip.

---

## Core principles (from review)

1. **No UI in SlicerLive (yet).** We don't know how the SlicerLive editing UI should look, so we
   build **no tool palette**. Effects are driven entirely by the **mrson `SegEdit` op stream**
   coming from Slicer (live over the WS, or replayed from a recording). This doubles as the test
   harness: a test feeds `SegEdit` ops (synthetic or recorded) instead of human events, and asserts
   on the resulting labelmap / render.

2. **Real-time incremental apply.** Effects apply **as the stroke moves**, per incremental sample —
   *not* buffered until mouse-up. Slicer could never do this (synchronous rendering + slow polydata
   3D surfaces); SlicerLive has neither constraint. If live surface re-bake can't keep up with a
   fast stroke, a lightweight **2D slice-layer proxy** of the brush stamp bridges the gap on the
   active slice until the full re-bake lands.

3. **Three independent engines, glued by a logic layer.** `algorithms/` (editing) and `render/`
   (rendering) import **nothing from each other**; a **`logic/`** layer is the *only* module that
   depends on both. Effects mutate `EditableSegmentation`'s GPU master buffer and fire `onDirty()`;
   `SegmentationLogic` re-derives the presence texture and hands the renderer a field. GPU→GPU,
   decoupled. (Slicer-idiomatic: a "Logic" mediates model↔display like a `vtkSlicerModuleLogic`.)

4. **Surface render mode.** Segmentation is rendered like the **Carve / SegmentSurfaces** selftest
   in `SlicerWGPU/SceneRendering` — the **`surface`** mode (gradient-opacity, soft edges), not the
   hard **`iso`** band-shell SlicerLive's `SegmentField` uses today. It updates **live** as effects
   apply.

5. **Layered segmentation, top-to-bottom compositing.** A segmentation is a stack of labelmap
   **layers**; when a ray sample hits more than one layer, opacity-color contributions composite in
   **top→bottom layer order** (slice + 3D). Designed in from the start, but the *implementation* of
   multiple layers is **deferred to a later step** — we start single-layer, `r8uint`.

---

## Architecture — three independent engines (algorithms ⊥ render), glued by logic

```
   mrson SegEdit op stream  (from Slicer WS live, or a replayed recording)
        │  Stroke / Click / Draw / Scissors / Seeds / Threshold / Param / Activate …
        ▼
┌──────────────────────────────────────────────┐
│ SegEditDriver                                 │  parses the op stream, tracks active segment +
│  (algorithms/seg-edit-driver.ts)              │  effect + params, dispatches INCREMENTAL samples
└──────────────────────────────────────────────┘
        │ drives
        ▼
┌──────────────────────────────────────────────┐
│ EFFECTS  (algorithms/effects/*.ts)            │  each writes the MODIFIER buffer only
│  Paint · Erase · Draw · Scissors · Threshold  │  (compute shaders; screen→RAS→IJK inside)
│  Grow(growcut) · Islands · Margin · Smooth    │
└──────────────────────────────────────────────┘
        │ writes
        ▼  modifierLabelmap (scratch r8uint, STORAGE)
┌──────────────────────────────────────────────┐
│ APPLY-WITH-RULES  (one shared compute pass)   │  the "core operations" layer:
│  overwrite mode (all/visible/none =           │  reads modifier + master + source-intensity,
│  don't-paint-over) · editable intensity range │  composites the modifier into the master
│  (threshold) · mask-by-segment / edit-area    │  subject to the mask rules
└──────────────────────────────────────────────┘
        │ writes, then fires onDirty(extent)
        ▼
┌──────────────────────────────────────────────┐
│ EditableSegmentation  (THE SHARED BUFFER)     │  owns the master label texture(s) —  [algorithms/]
│  algorithms/editable-segmentation.ts          │  r32uint 3D, TEXTURE|STORAGE|COPY_SRC|COPY_DST.
│  layers[] (start: 1) · activeSegmentId ·      │  + dims, ijkToRAS, onDirty. Imports NO render/.
│  dims · ijkToRAS · onDirty                     │  THE editable buffer.
└──────────────────────────────────────────────┘
        │ masterTexture() read-only                 onDirty() →
        ▼
┌──────────────────────────────────────────────┐
│ SegmentationLogic  (THE GLUE)                 │  the ONLY module importing BOTH engines. [logic/]
│  logic/segmentation-logic.ts                  │  master → ColorizeBaker (σ smooth) → presenceTex;
│                                               │  onDirty → rebake in place → onRedraw.
└──────────────────────────────────────────────┘
        │ field()
        ▼
   SegmentField (render/, mode:"surface")  reads presenceTex, re-renders live  [render/]
```

The load-bearing decoupling: **`render/` owns rendering, `algorithms/` owns editing, they import
nothing from each other, and `logic/SegmentationLogic` is the glue.** Today the seg path is
Slicer → zarr → CPU `writeTexture` → `ColorizeBaker`. This adds a GPU-native path:
effect compute → shared master texture → (logic) presence → surface field, no CPU transit.
(`algorithms/geom.ts` holds the couple of voxel-geometry helpers the editing engine needs, so it
depends on no `render/` math either.)

---

## Data model

- **Master labelmap = `r32uint` 3D** — one segment id per voxel (values 0..255, the r8uint
  *semantics*), one layer to start (Slicer's default shared-labelmap layer). Usage
  `TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC | COPY_DST` so compute writes it *and* it can be
  serialized to zarr (A-7) / diffed for deltas. **Why r32uint, not r8uint:** WebGPU core has no
  writable `r8uint` storage format, so a GPU-writable master must be `r32uint`; `ColorizeBaker` reads
  it as `texture_3d<u32>` unchanged.
- **Layers** — `EditableSegmentation.layers[]`, each an `r8uint` master + a layer order. A voxel may
  be occupied in several layers; the surface field composites them top→bottom. Single-layer until A-6.
- **Modifier scratch labelmap** = Slicer's `modifierLabelmap`: every effect stamps into it, then the
  shared apply-pass composites it in. This is what makes "a shape can come from paint **or** scissor
  **or** draw" uniform — every effect yields a modifier region; the apply-pass is universal.
- **Everything geometric is RAS** ([[coordinate-systems-discipline]]); effects convert
  screen→RAS→IJK in-shader via `ijkToRAS`.

### `ColorizeBaker` refactor

`ColorizeBaker` (render/bake.ts) currently **owns** its `labelTex` privately and `updateLabelmap`
re-uploads from **CPU**. A-0 lifts the label texture up into `EditableSegmentation` (external, GPU-
writable) and makes the baker / surface field *read* it. Small surgical change; the existing
Slicer→zarr→upload path keeps working by writing into the same shared texture.

---

## Rendering: `surface` mode (live)

Ported the Carve selftest's `_seg_surface_field_wgsl`
(`SlicerWGPU/SceneRendering/SceneRenderingLib/wgpu_vtk_inject.py`) as a **`mode: "iso" | "surface"`
option on the existing `SegmentField`** (render/fields.ts) — the two differ by a single α line
(everything else, sampling/gradient/Phong, is shared), so a flag is DRY and leaves all existing `iso`
callers untouched. Surface mode:

- **Gradient-opacity emission:** `dα/ds = opacity · |grad v|`, integrated across a surface crossing →
  ≈ `opacity` regardless of transition thickness — matching Slicer's polydata surface look (a
  30%-opaque segment accumulates ~0.3 α per crossing, front + back faces add).
- **or SDF-in-alpha:** `alpha = clamp(0.5 - sdf/band, 0, 1)` — soft, mathematically smooth boundary.
- **Live update:** on `onDirty(extent)` the field re-bakes (only the dirty extent when practical),
  so an in-progress stroke is visible as it's drawn, in slices and 3D.
- **Layer compositing (A-6):** per ray sample, resolve layers top→bottom; the OVER-composite runs in
  layer order so the top layer's color/opacity dominates.

### Surface quality — findings (2026-08-04) + the terrace-free path

A controlled probe (same sphere; vary σ, opacity, resolution independently; metric = soft-rim /
total green px) settled *why* the first A-0 render looked fuzzier than the Carve example — **it is
not the ray-march sample grid**:

| lever | effect |
|---|---|
| **opacity 0.6 → 1.0** | the dominant fuzz: 0.6 = translucent front+back faces (cloudy). 1.0 = solid surface-model silhouette. rim/green 0.69 → 0.52. |
| **σ (presence blur, mm)** | σ=1.5 vox @2mm = a 3 mm shell on a 30 mm sphere. Tighter σ concentrates the shell → crisper edge (→ 0.44). |
| **resolution** | helps only *indirectly* — shrinks σ-in-mm for the same σ-in-voxels. |

The Gaussian-presence method always trades edge-crispness against **voxel terracing** (tighten σ too
far at low res and onion-rings appear). **A-1r ✅ built the proper fix**: the **SDF path** —
`render/sdf-bake.ts` `JfaSdfBaker` computes a signed-distance field by 3D **jump flooding** (seed the
boundary voxels with their RAS position; flood nearest-seed over ⌈log2 N⌉ halving passes; finalize to
signed mm), and `SegmentField` gained **`mode:"sdf"`** (crisp shell `a = 1 - |sdf|/band`, normal from
the SDF gradient). `SegmentationLogic` picks the path via `renderMode` (**`sdf` is now the default**;
`surface` = the Gaussian path). **GOTCHA**: raw JFA distance is distance-to-nearest-seed-*voxel* →
piecewise-linear → its gradient is Voronoi-**faceted** (golf-ball shading). Fix = a light Gaussian
**smooth of the SDF** (σ≈1 voxel) — barely moves the zero level set (silhouette stays crisp) but
smooths the normal. Result: crisper than Gaussian (rim/green 0.36 vs 0.45) and terrace-free.
**Cost**: SDF re-bake ≈8 ms at 96³ vs Gaussian ≈1.6 ms — fine interactively, but O(N³ log N), so large
volumes will want a banded/edit-local JFA (or the Gaussian fast-proxy during an active stroke). The
demo's **Render: SDF/Gaussian** button A/Bs the two live.

### Band-limited solid (2026-10-27) — what the smoothing control is for

A labelmap is a **sampled indicator function**, so its voxel staircase is *aliasing*, not anatomy. The
faithful surface is the 0.5 level set of that indicator **reconstructed at the grid's Nyquist limit**.
The renderer therefore carries `p = G_σ * 1(label != 0)` in the attr texture's `.b` (the baker's
finalize writes the 0/1 indicator, the attr blur low-passes it) and takes the surface to be `p = 0.5`.
σ — the smoothing control — is the *reconstruction width*, and it moves the geometry.

It had previously been established that smoothing must NOT move the surface, because blurring at σ=1
closed the four-voxel disc space between two vertebrae and fused them. That is a property of blurring
an **unbounded signed distance** (the field reaches −10 voxels inside a vertebra but only +2 in the
gap, so averaging pulls the gap negative), not of smoothing: a **bounded** indicator at the centre of a
4-voxel gap is `2·Φ(-2) ≈ 0.05`, nowhere near 0.5. The remaining cost is the curvature term, ≈ σ²/2R
inward on a convex ridge of radius R — a quarter voxel at σ=1 on a 2-voxel vertebral process.

Measured (`render/test/bandlimited-solid.ts`, a voxelized sphere at ≈10 px/voxel, silhouette RMS vs its
best-fit circle — the staircase in the *geometry*, not the shading):

| σ (vox) | 0.25 | 0.5 | 1.0 | 1.5 | 2.0 |
|---|---|---|---|---|---|
| before (surface pinned to the voxel face) | 1.71 px | 1.60 | 1.39 | 1.35 | 1.34 |
| band-limited | 1.16 px | 1.00 | 0.62 | 0.48 | 0.46 |

Two gotchas, both found on real spine data:

- **GEOMETRY AND NORMAL MUST COME FROM THE SAME FIELD.** The previous design froze the surface at the
  voxel face and sent σ only to the shading normal. A stepped silhouette lit by a velvet normal is what
  reads as "chunky and over-smoothed at the same time" — the two cues contradict each other.
- **Difference the gradient over a FULL voxel.** `attr.b` is read trilinearly, so the field is only C0
  and its gradient jumps at every voxel-face plane. A half-voxel central difference stays inside one
  cell and reports that cell's gradient, which paints a rectangular lattice of dark creases — a maze —
  over the surface, worst at small σ where the field is steepest. A full-voxel difference straddles the
  discontinuity. (Shading roughness on the sphere at σ=0.25: 0.199 → 0.092.)

**No shell band at all: an interval crossing test.** A band wants the PERPENDICULAR distance to the
surface, and the only way to get that from a scalar field is `(0.5 - p)/|grad p|` — which falls apart
exactly where `|grad p|` collapses: concave creases where two surfaces meet, and thin features. There
the estimated distance diverges, no sample lands in the band, and an OPAQUE segment renders dusty with
background showing through it. That is what "parts of the vertebra get cut off as I rotate" was, and it
predates the band-limited work (it was worse under the old shell).

`p > 0.5` has no such failure. The surface is found by asking whether THIS ray interval contains the
crossing, which cannot miss one at any σ, curvature or incidence. `Field.intervalSampling` supplies the
exact distance back to this field's previous sample, so consecutive intervals tile the ray with no gap
and no overlap — which is what makes the test exact under the per-step ray jitter and across an
empty-space leap. One crossing contributes exactly the target opacity T, so no band, no profile
integral, and no dependence on the sample step (verified: 4× finer stepping is byte-identical).

Measured (`render/test/shell-opacity.ts`, an opacity-1 segment over a blue background; any blue left in
its eroded interior is background leaking through a surface that should be solid):

| | σ 0.25 | 0.5 | 1.0 | 2.0 | T=0.25 | T=0.5 | T=0.75 |
|---|---|---|---|---|---|---|---|
| leak, shell band | 2.85% | 0.79% | 0.78% | 0.78% | 0.296 | 0.569 | 0.811 |
| leak, crossing test | 0.06% | 0.05% | 0.06% | 0.09% | **0.438** | **0.750** | **0.938** |

The last three columns are the composited opacity of a translucent segment, which must be `1-(1-T)²`
(front face and back face, as a pair of polydata surfaces). The shell band under-delivered it by 20-30%
— the same defect as the leak, seen head-on. The crossing test hits it exactly.

**GOTCHA when measuring any of this**: the present target is `rgba8unorm-srgb`, so a read-back byte is
gamma-encoded. Differencing raw bytes reads a correct `1-(1-T)²` composite as ~1.3 crossings and sends
you hunting a renderer bug that is not there.

**Solid, not a shell.** Clip planes are handled by the same test: the ray enters the kept half-space
already inside the solid, with no surface crossing, so the previous sample being on the discarded side
IS the face, and it takes the plane's normal. The sphere-trace skip horizon is clamped to the nearest
plane while inside the solid, or it sails past the cap. Measured rim/centre brightness over the cut
disc: 0.62 (hollow) → 1.00 (flat cap); the uncapped multi-material path, unchanged, sits at 0.55.

**Cost**: the soft band also gave sub-pixel silhouette AA, and a binary crossing test does not — edges
are one pixel harder in a single frame. The accumulation path's sub-pixel camera jitter covers it where
it runs; `renderToView` (what the spine demo settles to) does not.

### Sizing the SDF to the device, not to the data (2026-10-28)

The JFA-SDF pipeline costs **60 B per padded voxel** — seed ping-pong (rgba32float ×2), sdf, attr and
one shared blur scratch (rgba16float), plus the r32uint master. A flat 256-per-axis cap on a chest CT
is ~880 MB, and a comparison view holds TWO. WebGPU has no VRAM query, so allocation simply keeps
succeeding until the device is LOST and every canvas on the page goes white with nothing actionable
in the console. Reported from the field: "it loads for some time, then flicks some images, but then
turns white, browser loses responsiveness".

`render/gpu-budget.ts` is a budget, not a measurement, because there is nothing to measure:
`navigator.deviceMemory` (clamped — a dev machine here reports **32**, outside the spec's own 0.25-8
range, which is why the clamp and the ceiling both exist), `isFallbackAdapter`, a 25% share, and a
hard **0.75 GB** ceiling. `?gpumem=<GB>` overrides it. Callers hand the result to
`resampleIsotropic(..., maxVoxels)` and surface `coarsened` — on the reported case, 1.76 GB → 750 MB,
219×219×256 → 171×171×200 @ 2.92 mm, and the header says so.

**Dynamic low-memory mode**: losing the device IS the answer to the question the API will not answer,
so remember it. `device.lost` offers "reload at lower resolution", which halves the budget into
`sessionStorage` (not local — the cause may be another tab, which is not worth remembering past the
session) so the reload does not walk back into it.

Two easy wins found while accounting: the sdf and attr blurs each held their own scratch texture,
same format and size and never used at the same time (8 B/voxel of pure duplication, 12% of the
pipeline); and the seed ping-pong is 32 of the remaining 52, so packing seeds as a voxel INDEX
rather than RAS+label would be the next big cut if resolution needs to come back up.

### Region re-flood: the "clipping plane" that was really a partial bake (2026-10-28)

Per-label visibility takes a fast path — rewrite the changed labels' box in the labelmap and re-flood
only that box. It is worth keeping: a level step costs **~14 ms against ~390 ms** for a full rebake on
a 256³ grid (spine-compare, both rows), which is the difference between holding an arrow key down and
waiting on each press. It was also wrong in two ways that a user reads as "the renderer is clipping my
data, and it moves when I rotate":

- **The jump-flood schedule was sized to the BOX.** Its largest step was ~the box extent, so a voxel
  inside the box whose nearest surface lay outside found **no seed at all**, reported 1e3 mm, and the
  sphere-trace skip leapt straight through the surface that was really there — the shell came back cut
  along a flat plane. Fix: dispatch over the box but run the **full-grid** step schedule. The taps read
  the ping-pong copy of the previous full flood outside the box, which is what lets a large step find a
  valid exterior seed; it is a handful more passes over a few per cent of the grid.
- **The re-init halo (8 voxels) was narrower than the gap to the next structure.** Seeds just outside
  the box still pointed at the surface deleted inside it, so a box voxel inherited a phantom: the label
  you just hid, still standing. Fix: halo 24 voxels (`SegmentationLogic.regionToIjk`), which has to
  exceed the spacing to the next real structure (~15-20 mm between vertebrae).

Two more, found by sweeping EVERY level of the spine and comparing each arrow step against a full
rebake of the same level (22 steps × 2 rows × 3 extent modes):

- **A region patch needs a flood to patch.** Going from "this method has no label in range" to its
  first one patches a seed texture with no seeds in it at all, and comes back as a scatter of
  speckles: 511 lit px against 5500. The spine demo now takes the full bake when the previous bake
  was empty — once per row, on the step where a method's labels first come into range.
- **The flood must not read outside the ring it re-seeded.** Letting the schedule run to the full
  grid lets a tap land on a seed from an older bake, pointing at a surface since removed. The
  schedule is capped at the halo width (`SegmentationLogic.haloMaxStep`), and a voxel whose nearest
  surface is beyond the halo honestly has no seed — the skip refuses to leap on that, so the ray
  marches and still finds it.

**Known residual**: at ±3 a walk down the spine still reaches one state where the patched bake renders
~5% less than a full one — reproducibly via that walk, not reproducibly on the transition alone, and
not explained. The fast path is therefore scoped to the modes verified clean end to end ("1 vert" and
±1, max deviation 0.6%); ±3 takes the full bake. Stepping stays ~40 ms median.

Belt and braces in the renderer: `skip_seg` now refuses to leap on `|sd| > 500 mm`. That is not a
distance, it is "the flood never got here", and leaping on it is what turns a partial bake into a
visible cut. No real SDF grid here spans 500 mm.

Measured on myeloma/Myel_046 in "1 vert": one arrow step rendered **3221 lit px where a full rebake of
the same level rendered 4994**; five steps left a **whole extra vertebra** drawn. After: 4994 vs 4994,
and 5873 vs 5870. `examples/spine/test/level-step-equivalence.ts` checks step-vs-full equivalence on the
real case — note it passes on the unfixed code too, so it is an invariant check, not a proven guard for
this specific regression.

**The colour-seam blur is NOT the geometry σ.** It used to be `min(1, σ)`, so asking for a smoother
SURFACE also dissolved the label boundaries — and in a comparison view the boundary is the entire
signal. Worst case was the SPINEPS disc layer: a near-white disc between two saturated vertebra
colours, blurred a full voxel, reads as a milky smear across both bones instead of a disc. The seam
blur's only job is hiding the per-voxel staircase of the flooded region colour, so it is now capped at
0.4 voxel (`JfaSdfBaker.seamSigma`) independently of σ.

---

## Milestones (each is a reviewable stop)

| Step | Deliverable | Reviewable proof |
|---|---|---|
| **A-0** ✅ | Three-engine scaffolding: `algorithms/EditableSegmentation` (master `r32uint`, `stampSphere`/`loadLabelmap`/`onDirty`, imports no render/) + `logic/SegmentationLogic` (glue: master→`ColorizeBaker`→presence→`SegmentField`) + `render/` surface mode as a **`mode:"surface"` flag** on `SegmentField` (one α line; existing `iso` callers untouched). `ColorizeBaker` reads an external label texture. GPU sphere-stamp poke. **No editing UI.** | **DONE** — synthetic seg renders in **surface mode** (solid Phong surface, opacity 1/σ 1; not the iso shell); a GPU sphere-stamp through the shared master grows the render live (headless: green px 21735→34204; `algorithms/test/render-algorithms.ts`). Layering verified: `algorithms ⊥ render`, glued only by `logic`. Browser demo `algorithms/demos/algorithms.html`. |
| **A-1a** ✅ | `PaintEffect` (`algorithms/effects/paint.ts`): a spherical brush swept over the stroke polyline (capsule min-distance), **interpolating** sparse samples into one continuous tube; one compute dispatch/stroke; add/remove; writes master + `markDirty()`. | **DONE** — two samples 80 mm apart w/ a 6 mm brush fill a continuous tube incl. the midpoint (labelmap readback); bent 3-pt stroke renders as a smooth elbow. `algorithms/test/paint-stroke.ts`. |
| **A-1b** ✅ | `SegEditDriver` (`algorithms/seg-edit-driver.ts`): consumes the mrson `SegEdit` stream — **no UI** — `unwrap`s all 3 carriers (recorder event / `cmd:segEdit` / bare), maps brush→radius, segmentId→label, mode; `applyEdit` (replay, whole stroke) + `beginStroke`/`addPoint`/`endStroke` (**incremental real-time**, a stroke = a pointer-drag stream like a camera drag). | **DONE** — a committed stroke op paints a tube; incremental arc grows monotonically (866→7705 px). `algorithms/test/seg-edit-driver.ts`. Browser **Paint stroke** button drives an incremental arc live. |
| **A-1c** | Wire the driver to a **real** stream: replay the recorder's `SegEdit` events during scrub, + live `cmd:segEdit` over the WS from Slicer (needs `mrson_live` to emit stroke intent, not just the seg result). Fast 2D slice proxy if surface re-bake lags. | Paint in Slicer → the stroke paints live in SlicerLive; scrub a recording → strokes replay. |
| **A-1r** ✅ | **SDF render path** (`render/sdf-bake.ts` JFA + `SegmentField mode:"sdf"` + `SegmentationLogic renderMode`, sdf default): terrace-free surface-model look; light SDF blur kills JFA facets. | **DONE** — crisper than Gaussian (rim 0.36 vs 0.45), terrace-free; ≈8 ms/bake @96³. `algorithms/test/sdf-compare.ts`. Demo **Render:** toggle. |
| **A-1m** ✅ | **Multi-label colour**: the colorized SDF stores per-label colour in the texture (rgba16float: rgb=palette colour, a=signed mm); JFA seed carries the region label. `SegmentField.colorFromTexture`, `SegmentationLogic` palette + `setLabelColor`. Works in both sdf & surface modes. | **DONE** — one merged surface shows each label in its own colour with a seam where neighbours meet (`algorithms/test/multi-label.ts`, 3 colours both modes). Demo Poke/Paint each add a new coloured label. |
| **A-1o** ✅ | **Per-segment opacity + shading mode**: `attrTex` (rgba16float) carries per-segment `.r` = opacity (palette alpha) and `.g` = shading mode (a mode palette). The SDF `SegmentField` samples it (`bindingCount` 2) and **blends** surface (crisp SDF shell) ↔ volume (DVR interior fill) by the fractional mode. `SegmentationLogic.setLabelOpacity` / `setLabelShading`. **The attr channels are seam-blurred in refine** (same Gaussian as colour) so the opacity/surface-vs-volume *classification* transitions smoothly — the fix for jaggies where an opaque-surface segment meets a translucent-volume one (the hard classification edge, not the JFA per se). | **DONE** — opaque surface occludes (red-over-blue 0), translucent reveals (46, `opacity.ts`); volume is see-through DVR (surface 0 vs volume 4333, `shading.ts`); mixed opaque-surface/translucent-volume boundary renders smooth (`mixed-boundary.ts`). Demo **Randomize look** / **Reset look**. |
| **A-1s** ✅ | **Two-phase bake (smooth static renders)**: `JfaSdfBaker.bake()` = fast approximate JFA (live editing), `refine()` = JFA+2 near-exact Voronoi/SDF + a **colour-seam blur** (pre-blends the voxel-staircase label boundaries) run once the edit settles. `SegmentationLogic` fast-bakes on every edit + schedules a debounced `refine()` (180 ms). Crispness comes from a **tight shell band** (≈0.65 voxel), not under-smoothing (which re-facets). | **DONE** — refine smooths seams (blended-pixel count 77→206) and fixes close-segment JFA errors; surface stays smooth + crisp. A static labelmap renders from the resident high-quality texture, so orbiting is cheap. `algorithms/test/multi-label.ts` (fast vs `-refined` PNGs). |
| **A-2** | **Apply-with-rules** shared pass: overwrite mode (all/visible/none = *don't-paint-over*), editable intensity range (*threshold paint*), mask-by-segment. Used by every effect. | Threshold-paint fills only in-range voxels; "overwrite none" refuses to touch other segments. |
| **A-3** | **Shape effects → rasterization**: Draw (polygon fill), Scissors (2D-through-slice + 3D projected cut/fill). Unifies "shapes = paint/scissors/draw" as modifier regions. | Draw a polygon → fills; scissors cut removes a swath through the volume. |
| **A-4** | **Compute set**: Erase, Logical ops (add/subtract/intersect/copy), Islands (GPU connected-components), Margin (morphological grow/shrink), Smoothing (median/gaussian). | Grow a 3 mm margin; keep-largest-island removes specks. |
| **A-5** | **Grow-from-seeds / growcut** (GPU compute; prior GPU-growcut experience). Seeds = mrson `Seeds` op. | Scribble fg/bg seeds → region grows interactively. |
| **A-6** | **Multiple labelmap layers** + top→bottom compositing in the surface field (slice + 3D). | Two overlapping segments on separate layers composite with the top layer's color winning. |
| **A-7** | **mrson emission (producer role)**: a SlicerLive-authored edit emits the `SegEdit` intent op **and** a content-addressed labelmap **Apply-delta**, so SlicerLive *authors* mrson, not just consumes it. | A SlicerLive edit produces a valid `SegEdit` + Apply-delta commit that verifies. |

---

## Exact EDT — investigated, NOT ported (2026-08-05)

Evaluated an exact Euclidean distance transform (separable Felzenszwalb–Huttenlocher + feature
transform) as a "deeper-idle" refinement tier to de-noise the JFA. Built + verified the **CPU
reference** (`render/edt-cpu.ts`) against a brute-force nearest-seed scan — exact (max 1.9e-6 mm,
correct nearest-region, anisotropic). Then **measured whether it would change the render**
(`render/test/edt-vs-jfa.ts`, via `JfaSdfBaker.readDistance`): raw JFA+2 vs exact EDT signed distance
near surfaces is **max 0.003 mm, mean 0.0005 mm, 0 % of voxels differing by even ½ voxel.**

Conclusion: **JFA+2 is already effectively exact**, so an exact EDT tier would produce a visually
identical image — the boundary faceting is inherent to voxel-discrete seeds (smoothed by the blur in
both paths), not JFA approximation error. **Not worth the intricate GPU port for image quality.** The
CPU EDT + the measurement are kept as reference/evidence. If microCT resolution ever needs the memory
win, the cheap path is `rgba16float` voxel-index JFA seeds (f16 exact ≤ 2048), *not* the EDT.

## Deliberately deferred (held for separate design)

- **Multiple layers** — designed in, implemented at **A-6**.
- **SlicerLive → Slicer segmentation sync** (old "M3 v2") — held; don't push Slicer out of its
  design space yet.
- **Google-docs collaborative editing + fork/merge suggestion flow** — held for its own design pass
  ([[mrson-store-auth-sharing]], [[mrson-parity-recorder-collab]]). A-7 is shaped so `algorithms/`
  cleanly *emits* the same `SegEdit` + Apply ops; how those flow into shared/forked streams stays an
  orthogonal layer, so A-0…A-6 pre-commit none of that.

## Related

- Intent/authoritative capture on the Slicer side: [[segedit-mrson]] (M0–M2 done; the `SegEdit` op
  contract this driver consumes). NOTE: A-1's real-time incremental apply wants the Slicer capture to
  emit **incremental** stroke samples during a stroke, not only one op on mouse-up — a coordination
  point with `mrson_recorder` / `mrson_live`.
- Recorder/replay this plugs into: [[scene-recorder-system]].
- Renderer backbone: [[slicerlive-webgpu-backbone]]; the iso vs surface shell: [[segmentfield-iso-shell]].
</content>
</invoke>
