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
