# Segmentation tool sets: ITK-SNAP vs Slicer Segment Editor (+ ExtraEffects) → the SlicerLive plan

> **SUPERSEDED as a direction (2026-08-14, same day).** See
> **[SEMANTIC-EDITOR.md](SEMANTIC-EDITOR.md)**: the tool set is *not* being ported. Boundaries get
> derived from questions by a knowledge layer, with the field algebra (SDF offset/boolean, level set,
> diffusion) as its actuator. This doc and the field survey stay valid as **inventory** — what exists,
> what users of it value, and what each primitive costs — and §4.2's GPU-shape taxonomy still governs
> how the surviving primitives get built. The palette, the wizard, and the A-3n/A-3s/A-4b tool
> additions are dropped; see SEMANTIC-EDITOR.md §6 for the step-by-step fate of every milestone below.

Status: **research + plan only (2026-08-14). Nothing implemented.** Companion to
[ALGORITHMS.md](ALGORITHMS.md), which owns the engine architecture and the A-0…A-7 milestones; this
doc surveys the two reference applications and proposes what the SlicerLive *tool set* should be.

The wider field — Mimics, Amira/Avizo, Dragonfly, ilastik, MONAI Label, syngo.via, MIM, the RT
planning systems, Brainlab, Cornerstone3D/OHIF, NiiVue, the annotation platforms, and the current
interactive-AI models — is surveyed separately in
[SEGMENTATION-FIELD-SURVEY.md](SEGMENTATION-FIELD-SURVEY.md), including what users of those systems
report as critical. Four editing primitives found there are folded into §4.4 below (A-3n, A-3s,
A-4a+, A-9+).

---

## 1. ITK-SNAP — feature inventory

ITK-SNAP (Yushkevich/Gerig; v4.4 as of 09/2025) is deliberately **one application with one
opinionated semi-automatic pipeline**, plus enough manual tooling to fix its output.

### 1.1 The SNAP pipeline — the distinctive part

A wizard, not a palette. Enter *Active Contour (snake) mode*, then:

1. **ROI box** — restrict everything downstream to a sub-volume.
2. **Presegmentation → a "speed image"** *g* ∈ [−1,1], by one of four methods:
   - **Thresholding** (lower/upper, smoothness parameter),
   - **Edge attraction** — *g*(|∇I|) after Gaussian blur, with contrast/scale parameters,
   - **Classification** — a **random forest trained interactively on user scribbles**, over
     **multiple co-registered modalities at once**; output = foreground probability map,
   - **Clustering** — unsupervised GMM/EM over the modalities; pick which clusters are foreground.
3. **Bubbles** — seed spheres placed at the cursor, radius adjustable; or an existing label as init.
4. **Snake evolution** — level-set PDE, **region competition** or **edge-based**, with three forces
   the user tunes: **propagation** (balloon), **curvature** (regularization), **advection**
   (edge attraction). Driven with **VCR controls** (play / pause / step / rewind) while the 3D
   surface updates live.
5. **Finish** — the evolved level set is merged into the segmentation under the current drawing
   label, subject to the paint-over rule. Repeat per structure.

### 1.2 Manual tools

| Tool | Notes |
|---|---|
| **Polygon tool** | Draw a closed polygon on a slice; **editable vertices** (box-select, move, insert, delete); accept → fill. **Paste last polygon** — the serial-contouring workflow. |
| **Paintbrush** | Round / square / **adaptive** styles; **3D (isotropic) brush** option; size in voxels. |
| **Adaptive brush** | Within the brush footprint, paints only voxels of **similar intensity that are contiguous with the crosshair** — a brush-scoped flood fill. No Slicer core equivalent. |
| **Eraser** | Painting with the `Clear` label — erasure is not a separate mechanism. |
| **3D-view editing** | **Scalpel** (cut the rendered segmentation with a drawn plane), **spray paint** (deposit label/seeds onto the 3D rendering). |
| **Label editor** | Label table: name, color, opacity, visibility; **drawing label** + **paint-over rule** (paint over *all* labels / *visible* labels / *one* label / nothing). |
| **Tools menu** | **Interpolate Labels** (fill in unsegmented in-between slices), **Smooth Labels** (multi-label smoothing), **Volumes & Statistics** (voxel count, mm³, intensity mean/SD, export), image contrast curve, annotation (rulers, landmarks, text). |
| **Undo/redo** | Deep history over segmentation state. |

### 1.3 Platform features

Four linked views (3 orthogonal + 3D) with a shared crosshair · multi-layer **multi-modality** with
a Layer Inspector (contrast curve, colormap, opacity, tiled vs stacked overlay, RGB/multi-channel) ·
**4D images** with time-point navigation and playback · **mesh layers** (load external VTK/VTP, show
in 3D *and* as contours on slices — 4.4) · volume rendering in the 3D window (4.0) · **registration
module** (interactive manual + automatic rigid/affine via the *greedy* engine; transform
composition/inversion; ITK-compatible matrices) · **workspaces** (`.itksnap`) plus the `itksnap-wt`
CLI and the `c3d`/`greedy` companion tools · DICOM/NIfTI/NRRD/MINC, native float32/64, NaN handling ·
**free rotation** for oblique segmentation (4.2) · dark mode, i18n, **iPad + Apple Pencil**.

### 1.4 AI / remote

- **Distributed Segmentation Service (DSS)** — package the workspace as a ticket, submit to a remote
  service (nnU-Net-class models), poll, receive the result back as a label layer.
- **4.4: nnInteractive integration** — **point / scribble (paintbrush) / lasso (polygon) prompts**,
  executed on a **remote or cloud GPU**, plus a new Python **Deep-Learning Segmentation (DLS)**
  backend over network/SSH.

> The 4.4 direction matters strategically: ITK-SNAP's answer to interactive AI segmentation is
> *ship the pixels to a GPU server*. SlicerLive already has [[nnlive-deploy]] — the same class of
> model running **client-side in WebGPU**, no server, no PHI egress.

---

## 2. Slicer Segment Editor + SegmentEditorExtraEffects — feature inventory

Slicer's model is the opposite: **a composable toolbox** over a rich segmentation node (multiple
representations, shared labelmap layers, overlap, DICOM terminology).

**Core effects:** Threshold · Paint (sphere mode) · Draw · Erase · Level tracing · **Grow from
seeds** (GrowCut) · **Fill between slices** (morphological contour interpolation) · Margin · Hollow ·
Smoothing (median / opening / closing / Gaussian / **joint**) · Scissors (free-form / circle /
rectangle; erase/fill, inside/outside, through-slab or projected) · Islands (keep largest, remove
small, split to segments, keep/remove/add clicked) · Logical operators (copy, add, subtract,
intersect, clear, fill) · Mask volume (fill inside/outside a scalar volume, soft edge).

**Masking layer, shared by every effect** — this is the architectural idea Slicer has and ITK-SNAP
does not: **editable area** (restrict to a segment/region), **editable intensity range** (threshold
gate), **modify other segments** (overwrite all / overwrite visible / **allow overlap**).

**ExtraEffects extension:** Local Threshold · Flood Filling · Watershed (seeded, smooth-surface,
slow) · Fast Marching (grow with a target-volume leak control) · Surface Cut (3D blob from
surface points) · Draw Tube (tubular structures from a few path points) · Split Volume · Engrave ·
Mask Volume (since moved to core).

**Around the effects:** segment table with visibility/color/**status flags** and terminology · live
**Show 3D** surface · undo/redo (10 states) · dense keyboard shortcuts · per-effect *apply to visible
segments* · Segment Statistics as a separate module · AI via *extensions* (SlicerNNInteractive,
MONAI Label, TotalSegmentator) rather than in the editor itself.

---

## 3. Comparison

### 3.1 Equivalence map

| ITK-SNAP | Slicer | Notes |
|---|---|---|
| Polygon tool (+ vertex edit, paste last) | Draw | Slicer's Draw has no vertex editing and no polygon paste — ITK-SNAP is materially better for serial contouring. |
| Paintbrush (round/square, 3D brush) | Paint (+ sphere mode) | Even. |
| **Adaptive brush** | Local Threshold / Flood Filling (ExtraEffects) — *not brush-scoped* | ITK-SNAP-only as a **brush**: contiguity + similarity confined to the footprint. |
| Eraser = paint with `Clear` | Erase | Slicer's erase interacts with masking (erased area added to the mask segment). |
| Paint-over rule (all/visible/one) | Modify other segments (overwrite all/visible/allow overlap) | Same concept; Slicer generalizes it with editable-area + intensity-range gating. |
| Interpolate Labels | Fill between slices | Even (both morphological). |
| Smooth Labels | Smoothing (joint) | Even. |
| Scalpel (3D) | Scissors (3D projected) | Even. |
| Spray paint (3D) | Paint in the 3D view | Even. |
| Volumes & Statistics | Segment Statistics module | Even. |
| Snake: threshold presegmentation | Threshold effect | Even. |
| Snake: **edge / region-competition level set with propagation·curvature·advection + VCR** | — | **ITK-SNAP only.** Fast Marching and Watershed are *not* the same thing: no curvature regularization, no reversible live evolution. |
| Snake: **random-forest classification over multiple modalities** | — | **ITK-SNAP only** in-app. |
| Snake: **GMM clustering presegmentation** | — | **ITK-SNAP only** in-app. |
| ROI box for semi-auto | (per-effect masking / ROI in some effects) | ITK-SNAP's is global to the pipeline. |
| DSS / nnInteractive (remote GPU) | SlicerNNInteractive / MONAI Label / TotalSegmentator (extensions) | Both are "call a server". |
| — | **Grow from seeds (GrowCut), Islands, Margin, Hollow, Logical ops, Level tracing, Draw Tube, Surface Cut, Split Volume, Mask Volume** | **Slicer only.** |
| — | **Masking layer (editable area + intensity range) shared by all effects** | **Slicer only** — the strongest architectural idea in either app. |
| — | **Overlapping segments via labelmap layers; terminology; multiple representations** | **Slicer only.** |

### 3.2 The honest summary

- **ITK-SNAP wins on**: a *guided path from nothing to a segmentation* (ROI → speed image → bubbles →
  evolve → finish), multi-modal classification built in, level-set regularization (results have
  smooth, plausible surfaces without a separate smoothing step), and a small enough tool count that
  a clinician learns it in an afternoon.
- **Slicer wins on**: breadth, composability, the masking layer, overlapping/multi-segment data
  model, extensibility, and everything around the editor (registration is a real module, terminology,
  DICOM, Python).
- **Both are constrained by CPU/ITK**: effects are apply-on-mouse-up filters, the live 3D surface is
  polydata (Slicer's *Show 3D* is the classic reason to turn 3D off while editing), undo is a
  bounded snapshot ring, and interactive AI means shipping voxels to a GPU server.

### 3.3 What neither has — SlicerLive's actual opening

1. **Real-time incremental apply with a live high-quality 3D surface.** SlicerLive already re-bakes a
   colorized JFA-SDF surface per edit (≈8 ms at 96³, two-phase fast/refine).
2. **A GPU-resident level set.** Narrow-band level-set evolution is a stencil compute shader — the
   *most* GPU-friendly algorithm in either application's catalog, and SlicerLive already has the JFA
   machinery needed to reinitialize the distance field. ITK-SNAP's snake, at interactive rates, in a
   browser tab, is achievable and is the single most differentiating feature available.
3. **Client-side interactive AI.** nnLive-class inference in WebGPU = ITK-SNAP 4.4's headline feature
   without the GPU server or the data egress.
4. **Op-stream provenance.** Every edit is already an mrson `SegEdit` intent — replayable, scrubbable,
   diffable, forkable ([[scene-recorder-system]], [[mrson-parity-recorder-collab]]). Neither app can
   tell you *how* a segmentation was made.
5. **No representation conversion.** SlicerLive renders the labelmap through an SDF; there is no
   marching-cubes "closed surface representation" to keep in sync, and no cost to showing 3D while
   editing.

---

## 4. The SlicerLive plan

### 4.0 Principles (carried forward from ALGORITHMS.md, plus two new)

Kept: **no tool palette yet** (effects driven by the mrson `SegEdit` op stream, which doubles as the
test harness) · **real-time incremental apply** · **algorithms ⊥ render, glued by logic** ·
**layered labelmaps, top-to-bottom compositing** · **RAS everywhere** ([[coordinate-systems-discipline]]).

New:

6. **Don't clone the palette — port the *primitives*, then re-compose.** 23 effects across the two
   apps reduce to ~6 GPU shapes (§4.2). Build the shapes; the "effects" are then thin parameterized
   entry points, and a guided ITK-SNAP-style *pipeline* is as cheap to expose as a palette.
7. **The SDF is the geometry engine, not just the renderer.** Margin, Hollow, shape-based
   interpolation, smoothing, and level-set reinitialization are all one distance field away — and
   SlicerLive already computes it every edit for display. Compute it once, use it for both.

### 4.1 Two load-bearing primitives, before any new effect

- **P1 — Modifier + apply-with-rules** (this is **A-2**, already planned, now clearly the top
  priority). Every effect writes only the scratch `modifierLabelmap`; one shared compute pass
  composites it into the master subject to: overwrite mode (all / visible / **allow overlap**),
  **editable intensity range**, **mask by segment**. This single pass subsumes *both* Slicer's masking
  layer *and* ITK-SNAP's paint-over rule. Nothing else should be built first — every effect below
  assumes it.
- **P2 — Undo/redo over a GPU master.** Neither reference app's design transfers. Proposal: **hybrid
  op-log + snapshot ring** — the `SegEdit` op log is already the authoritative history (free, and
  it's provenance); keep a bounded ring of dirty-extent snapshots (`COPY_SRC` sub-region readback or
  a GPU-side ring texture) so undo is O(extent) instead of a replay, and fall back to replay-from-
  last-keyframe when the ring evicts. Decide the VRAM budget explicitly ([logic/seg-budget.ts](../logic/seg-budget.ts)).

### 4.2 Effect taxonomy — 6 GPU shapes

| # | Shape | Covers | Technique | Status |
|---|---|---|---|---|
| **S1** | **Stamp / rasterize** — one dispatch, closed-form per-voxel test | Paint, Erase, 3D brush, Draw/Polygon, Scissors, Draw Tube, Surface Cut, Spray paint, Scalpel | Distance-to-capsule / point-in-polygon / extruded contour, all in-shader | Paint ✅, Scissors ✅ |
| **S2** | **Distance field** — one JFA, then threshold | **Margin** (thresh SDF at ±d, *exact* and anisotropy-correct), **Hollow** (band \|sdf\|<t), SDF-based **smoothing** (curvature-flow-lite), **shape-based interpolation** (interpolate the SDF between drawn slices, then threshold — the better Fill-between-slices / Interpolate-Labels) | Reuse [render/sdf-bake.ts](../render/sdf-bake.ts) `JfaSdfBaker`; needs the **banded/edit-local JFA** already flagged in ALGORITHMS.md | JFA ✅, uses ✗ |
| **S3** | **Local neighborhood iteration** | Smoothing (median / Gaussian / opening / closing / joint), Level tracing | Separable passes; median via bitonic-in-registers on a small footprint | ✗ |
| **S4** | **Flood / label propagation** | Islands (connected components), Flood filling, Local Threshold, **Adaptive brush** (= S4 confined to a brush footprint) | GPU CCL by label-propagation + pointer jumping; converge-flag readback | ✗ |
| **S5** | **Front propagation / competition** | **Grow from seeds** (GrowCut), **Fast Marching** (Eikonal via the Fast Iterative Method), **Watershed** (approximated by seeded competition — priority-flood does not parallelize) | Iterative CA / FIM sweeps | GrowCut ✅ |
| **S6** | **Level set (the SNAP snake)** | Region-competition & edge-based evolution: propagation + curvature + advection, VCR controls, live 3D | Narrow-band update in a compute shader; **reinitialize with the existing JFA**; one dispatch per iteration → run N iterations per frame and *show* it | ✗ — the headline |

And the inputs S6/S5 need, **speed-image construction** (a separate small tier):

| Method | Technique | Note |
|---|---|---|
| Threshold | trivial per-voxel | |
| Edge attraction | Gaussian blur + gradient magnitude → *g*(·) | separable, cheap |
| Clustering (GMM/EM) | E-step per-voxel on GPU, M-step by reduction | matches ITK-SNAP |
| Classification | scribble-trained forest: **train on CPU/WASM, evaluate per-voxel on GPU** | matches ITK-SNAP; multimodal |
| **Learned embedding** | nnLive-class features, per-voxel, in WebGPU | the modern replacement; the substrate [SEGMENTATION-SKILL.md](SEGMENTATION-SKILL.md) already assumes |

### 4.3 Cross-cutting work (needed regardless of which effects ship)

- **Multi-segment / layered master + overlap** (A-6) — prerequisite for *allow overlap* and for
  paint-over rules to mean anything.
- **Banded / edit-local JFA** — O(N³ log N) full re-bake caps volume size today; S2 makes the SDF
  load-bearing for *editing*, so this moves from "perf nicety" to "required".
- **Segment model parity** — name, color, opacity, visibility, status, terminology; comes free-ish
  from the mrson parity work ([[mrson-parity-recorder-collab]]).
- **Statistics** — voxel count, mm³, intensity mean/SD per segment, by GPU reduction. Partially
  present already in [render/demos/seged-app-scene.ts](../render/demos/seged-app-scene.ts).
- **Interaction surface**. Today there is no editing UI by design. Three drivers, in this order:
  (1) the mrson `SegEdit` stream from Slicer (live + replay) — done/A-1c; (2) the **agent** API
  (`window.seged`, [[seged-claude-seg]]); (3) *then* a human UI. Pointer→RAS already exists via
  `SceneRenderer.pick()` + [[slicerlive-pick-crosshair]]; a brush cursor overlay is the missing piece.
- **4D / sequences** — the editor must not assume a single time point once [SEQUENCES-CINE.md](SEQUENCES-CINE.md) lands.

### 4.4 Proposed milestones (extending A-2…A-7)

| Step | Deliverable | Reviewable proof |
|---|---|---|
| **A-2** | **P1: modifier + apply-with-rules** (overwrite all/visible/overlap, editable intensity range, mask-by-segment). Retrofit Paint/Scissors/GrowCut to write the modifier only. | Threshold-paint fills only in-range voxels; "overwrite none" refuses to touch another segment; overlap mode keeps both. |
| **A-3** | **S1 completion**: Draw/polygon (with **editable vertices + paste-last**, ITK-SNAP's advantage), scissors modes (inside/outside, slab/projected), Draw Tube. | Draw a polygon → fills; re-drag a vertex before accepting; paste the contour onto the next slice. |
| **A-3n** † | **Repulsor / push editing** (OsiriX): drag a circle, the boundary is pushed ahead of it. With a resident SDF this is **level-set advection** along the drag vector — exact, no polygon surgery, and only we already have the distance field. | Drag across a lobe of an auto-contour → the boundary follows the cursor and *nothing else moves*; topology preserved. |
| **A-3s** † | **Sculptor brush** (Cornerstone3D): brush radius **adapts to the local border** — inside the region it expands, outside it erases. The local SDF value *is* the distance to the border, so the radius is a texture read. | One brush, no mode switch: the same drag grows a too-small segment and trims a too-large one. |
| **A-4a** | **S2 from the existing SDF**: Margin, Hollow, shape-based **interpolation between slices**. | 3 mm margin is exact under anisotropic spacing; segment every 5th slice → interpolation fills the rest. |
| **A-4a+** † | **Two-plane outline → 3D object** (Brainlab SmartBrush) + **mask propagation across a slice range** (RedBrick/Encord). Same shape-based SDF interpolation as A-4a, with two *orthogonal* contours instead of two parallel ones. | Outline a lesion on axial + coronal → a plausible 3D object; propagate one slice's mask over a 20-slice range. |
| **A-4b** | **S3/S4**: Smoothing set, Islands (GPU CCL), Flood filling, Local Threshold, **Adaptive brush**, plus **magic wand / dynamic region growing with a live sensitivity slider** (Mimics/Amira/NiiVue), **Split Mask** (two-seed split of a touching pair), **Smart Fill** (cavity/gap closing). | Keep-largest-island removes specks; adaptive brush straddling a boundary fills only the contiguous side; dragging the sensitivity slider re-floods live; two seeds split touching bones. |
| **A-5** | **S5**: GrowCut ✅ + Fast Marching (FIM) + seeded-watershed approximation. | Grow with a target-volume leak control reproduces the ExtraEffects behavior. |
| **A-6** | **Layers + overlap** (as planned) — unblocks the full rule matrix in A-2. | Two overlapping segments composite top→bottom. |
| **A-8** | **P2: undo/redo** (hybrid op-log + dirty-extent ring). | 50 strokes, undo 30, redo 30 → byte-identical labelmap; VRAM stays inside the budget. |
| **A-9** | **Speed images**: threshold, edge, GMM; multimodal scribble-trained classifier. | Two-modality scribbles → a foreground probability map that separates a structure intensity alone cannot. |
| **A-9+** † | **Live-retraining classifier** (ilastik's loop, not ITK-SNAP's batch step): retrain and re-predict *as scribbles are added*, with an **uncertainty overlay** steering the next scribble. Per-voxel feature evaluation is already a compute shader — [algorithms/features/runner.ts](../algorithms/features/runner.ts) + [kernels.ts](../algorithms/features/kernels.ts). | Add one scribble → the prediction visibly updates in well under a second; the uncertainty map highlights where the next scribble should go. |
| **A-10** | **S6: the level-set snake** — bubbles, propagation/curvature/advection, VCR (play/pause/step/**rewind**), live SDF surface while evolving. | A bubble in a caudate evolves to the ITK-SNAP result; ≥30 iterations/s at 128³ with the 3D surface updating; rewind is exact. |
| **A-11** | **Client-side interactive AI**: nnLive point/scribble/lasso prompts feeding the same modifier pass. | ITK-SNAP 4.4's workflow with no server in the loop; result lands as a normal, undoable, `SegEdit`-logged modifier. |
| **A-7** | **mrson emission** (as planned) — every one of the above emits intent + Apply-delta. | A SlicerLive-authored snake run replays deterministically from its op log. |

† = added from the wider-field survey ([SEGMENTATION-FIELD-SURVEY.md](SEGMENTATION-FIELD-SURVEY.md)),
not present in either ITK-SNAP or Slicer. Each attaches to the step whose machinery it reuses, so
none of them is a new tier.

Ordering rationale: **A-2 unblocks everything**; A-4a is nearly free given the SDF work already
done (best value-per-effort in the list); A-10 is the differentiator and depends on A-9 + the banded
JFA; A-11 depends on nothing here and can run in parallel with any of it. Of the survey additions,
**A-3n/A-3s are the highest-value pair** — the survey's clearest finding is that *fixing* an existing
contour, not drawing one, is what users call critical, and both primitives are a texture read away
once the SDF is resident.

### 4.5 Explicitly *not* porting (and why)

- **Mask volume / Split volume** — they author *scalar volumes*, a data-management concern, not
  editing. Later, if ever.
- **Engrave** — novelty.
- **Registration** (ITK-SNAP's module) — belongs to a transforms layer, not the editor.
- **Mesh/closed-surface representation conversion** — SlicerLive renders labelmaps through the SDF;
  there is no second representation to keep in sync. *Export* of a mesh is a separate, later concern.
- **A 23-item tool palette** — see principle 6. The ITK-SNAP lesson is that a *guided path* beats a
  large palette for everyone except power users, and SlicerLive has a third option neither app has:
  an **agent** driving the same op stream.
- **The clinical tier — quantification against a normative reference, longitudinal registration and
  lesion tracking, structured reporting, presentation transforms (rib unfolding / curved MPR)** —
  these are items 5–8 of what users of clinical systems call critical
  ([SEGMENTATION-FIELD-SURVEY.md](SEGMENTATION-FIELD-SURVEY.md) §7), and each is a program of work in
  its own right. SlicerLive stays scoped to the editing engine; recorded here so the choice stays
  visible rather than accidental.

### 4.6 Open questions to settle before A-2

1. **Undo budget** — how much VRAM may the snapshot ring hold before falling back to replay?
2. **Level set: 2-phase or evolving-SDF?** The narrow-band level set *is* a signed distance field —
   should A-10 reuse `JfaSdfBaker`'s output as the level-set state (one field, two consumers), or
   keep evolution state separate and bake for display? One-field is elegant and risks coupling.
3. **Guided pipeline vs palette** — should the first human-facing UI be a SNAP-style wizard
   (ROI → speed → seeds → evolve → finish) rather than a tool row?
4. **Where does the agent sit?** Is the agent a *driver of effects* (writes `SegEdit` ops) or a
   *speed-image author* (writes probability fields that S5/S6 consume)? The second is more powerful
   and matches [SEGMENTATION-SKILL.md](SEGMENTATION-SKILL.md).

---

## Sources

ITK-SNAP: [full manual](http://itksnap.org/docs/fullmanual.php) ·
[semi-automatic segmentation tutorial](http://itksnap.org/pmwiki/pmwiki.php?n=Documentation.TutorialSectionAutoSegmentation) ·
[v4.x documentation](https://www.itksnap.org/pmwiki/pmwiki.php?n=Documentation.SNAP4) ·
[release notes](https://github.com/pyushkevich/itksnap/blob/master/ReleaseNotes.md) ·
[3.6 new features](http://www.itksnap.org/pmwiki/uploads/Documentation/promo_3.6_small.pdf).
Slicer: [Segment Editor module docs](https://slicer.readthedocs.io/en/latest/user_guide/modules/segmenteditor.html) ·
[image segmentation guide](https://slicer.readthedocs.io/en/latest/user_guide/image_segmentation.html) ·
[SegmentEditorExtraEffects](https://github.com/lassoan/SlicerSegmentEditorExtraEffects).
