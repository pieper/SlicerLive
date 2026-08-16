# The semantic editor — what SlicerLive's segmentation tools should actually be

Status: **direction, 2026-08-14. Nothing implemented.** This doc **supersedes the tool-palette
framing** of [SEGMENTATION-TOOLS-PLAN.md](SEGMENTATION-TOOLS-PLAN.md) and the field survey in
[SEGMENTATION-FIELD-SURVEY.md](SEGMENTATION-FIELD-SURVEY.md). Those two remain valid as *inventory*
— they record what exists and what users of it value — but the conclusion drawn from them ("port the
6 GPU shapes, then expose a guided pipeline") is not the direction. This doc states the direction and
what survives of the earlier plan.

## 1. The turn

The premise of every tool in the survey — ITK-SNAP, Mimics, Amira, Dragonfly, MIM, syngo.via,
Cornerstone3D — is that a human specifies a boundary, assisted by math. Better brushes, better level
sets, better snapping. The lineage is ours: Slicer's Segment Editor and its GPU grow-cut are what
NiiVue and Cornerstone3D are re-implementing today. Continuing that line means shipping a better
version of a 2005 idea.

The premise here is different: **the boundary is not the input, it is the answer to a question.** A
user points and asks; the system knows what the thing *is*, whether it is *abnormal*, and what its
*extent* means under a specified interpretation. What we would be building is not a brush that snaps
to gradients — it is a system that has read the textbook and can look at the scan.

Four things asked for, verbatim in spirit:

- Point at something and ask **what is it** and **is it pathological**.
- Ask for **extents under different interpretations** — "the likely resectable tumor" and "the margin
  in this patient given proximity to critical structures" are different boundaries of the same object.
- Know not just "bone" but **femur, left, lower limb, with its SNOMED code**.
- Point at the thumb and get a **range-of-motion-based delineation**: how strongly this skin surface
  is coupled to the joint when it articulates.

## 2. What actually dies (and what does not)

The honest split, because getting this wrong wastes a year either way:

**Dies — the palette and its interaction model.** A tool row the user picks from. Adaptive brush,
sculptor brush, repulsor, level tracing, draw tube, magic wand, engrave, the SNAP wizard's
speed-image dialog. All of it is a human doing boundary math by hand with better ergonomics. The
repulsor and sculptor additions made two days ago (`A-3n`/`A-3s`) are exactly the corpse-looting to
drop: they optimize *correcting pixels* when the correction should be **"no, that includes the renal
vein — exclude vessels."**

**Does not die — the field algebra.** This is the part worth being precise about, because it looks
like old tooling and is not. A margin is not a brush; it is `sdf ≤ −5 mm`. "Resectable given
proximity to critical structures" is
`tumor_sdf ≤ 0 ∧ ¬(critical_sdf ≤ margin)` — one expression over two distance fields. A neural
network's fuzzy probability output becomes a topologically sane surface by level-set regularization.
Articulation coupling is a heat-diffusion field over the voxel grid. **The semantic layer cannot
produce geometry without an actuator, and the field algebra is that actuator** — evaluated on the
GPU, live, in the same SDF that is already resident for rendering. Margin/boolean/interpolation/
level-set are not tools we are porting; they are the instruction set the knowledge layer compiles to.

So: keep S2 (distance-field algebra), S5/S6 (front propagation and level set, now as *regularizers
and solvers*, not user tools), and a minimal S1 (a click and a scribble are **prompts**, not
drawings). Drop the rest as user-facing tools; keep connected components and morphology only as
sanity operators applied to model output.

## 3. Architecture — knowledge proposes, fields actuate, evidence verifies

```
┌──────────────────────────────────────────────────────────────────────┐
│ KNOWLEDGE LAYER    "what is being asked, about what structure,       │
│                     under what interpretation, and what would        │
│  · LLM/agent        settle it?"                                      │
│  · anatomical ontology (FMA/SNOMED/RadLex; DICOM coded terminology)  │
│  · atlas + population priors                                         │
│  · SEGMENTATION-SKILL.md's probe loop  ← we already wrote this       │
│  · medical VLM for open-vocabulary identification                    │
└───────────────┬──────────────────────────────────────────────────────┘
                │ emits: an INTERPRETATION (§4) — a question + constraints
                ▼            + coded identity + the probes that will verify it
┌──────────────────────────────────────────────────────────────────────┐
│ FIELD LAYER        every quantity is a GPU field over the same grid  │
│  intensity · learned embedding/features · SDF · probability ·        │
│  deviation-from-expected · geodesic/diffusion coupling · uncertainty │
│  OPERATIONS = algebra: threshold, offset (margin), boolean (min/max),│
│  distance-to(X), diffuse-from(X), evolve(level set), sample          │
│  [ = algorithms/ + render/sdf-bake.ts + algorithms/features/ today ] │
└───────────────┬──────────────────────────────────────────────────────┘
                │ produces: derived boundaries, ranges, coupling maps
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ EVIDENCE LAYER     every claim carries what produced it              │
│  probes run on the native array (never on a rendering) · confidence ·│
│  alternatives considered and rejected · human overrides w/ reason    │
│  → all of it in the mrson op stream = replayable, forkable, auditable│
└──────────────────────────────────────────────────────────────────────┘
```

Two properties fall out that no surveyed tool has:

1. **"Why is this boundary here?" is answerable.** The op stream already records intent; now it
   records *rationale*. A segmentation stops being an opaque array.
2. **Every human override is labeled training signal, with its reason attached** — automatically,
   as a side effect of normal use. That is the flywheel.

## 4. The data-model change: a segment becomes an *interpretation*

Today a segment is `{labelValue, color, name}` plus voxels. The change:

```
Interpretation {
  question:    "resectable extent of this lesion with a 5 mm margin"
  identity:    { code: SCT:71341001 "Femur", laterality: left,
                 region: lower limb, parents: [...] }        ← §5.3
  expression:  a field expression, not a stored mask
               e.g.  lesion.sdf ≤ 0  ∧  ¬(critical.sdf ≤ 5mm)
  confidence:  scalar + a spatial uncertainty field
  evidence:    the probes, their values, the alternatives rejected
  provenance:  who/what authored it, from which model/atlas/utterance
}
```

Consequences that matter:

- **The mask is derived, cached, and re-derivable.** Change the margin from 5 mm to 8 mm and the
  boundary re-derives in a frame — no re-segmentation, no re-editing.
- **Several interpretations of one object coexist and are compared visually.** "Gross tumor",
  "enhancing core", "resectable with margin", "what the other reader would have drawn." This is what
  the ambiguity literature (probabilistic U-Net, PHiSeg, the QUBIQ challenge) says is the honest
  representation of a boundary, and what SAM's multi-mask output concedes for a single click.
- **mrson carries interpretations, not just labelmaps** — a natural extension of the ops work, and
  the reason the recorder/fork/merge machinery pays off here.
- **Manual override remains, as an escape hatch, and is recorded as an override with a reason.**
  Never trap the user inside the model's opinion.

## 5. The four asks, decomposed — and what is actually buildable

### 5.1 "What is this?"

Decomposes into: a dense anatomical prior + an open-vocabulary fallback + an ontology lookup.

- **Buildable now.** A TotalSegmentator-class model gives ~120 structures densely, and its label set
  already carries a **SNOMED-CT mapping** used for DICOM SEG harmonization. A point query becomes a
  lookup, with the model's own uncertainty attached.
- **Buildable now, less reliably.** Open-vocabulary: text-prompted volumetric segmentation is a real
  and fast-moving capability (SAT, built on a **knowledge tree of 6 502 anatomical terminologies**;
  BiomedParse/BiomedParse-V; SegVol; Text3DSAM). "Point at it and name it" is within reach; "point at
  anything and name it correctly" is not yet.
- **The honest line:** answer with a ranked hypothesis list plus the evidence, never a bare string.

### 5.2 "Is it pathological?"

The weakest of the four, and worth saying so plainly. Current grounded medical VLMs are documented to
ground **anatomy** far better than **findings**, and audits of frontier VLMs on medical VQA report
grounding failures and format collapse. Structure-specific normative comparison (the NeuroQuant idea
generalized: expected size/shape/intensity for this structure at this age and sex) is tractable and
verifiable; general "is this abnormal" is not, today.

**Therefore:** frame it as *deviation from expectation, with the expectation stated* — "this kidney
is 2.3 SD below expected volume for age/sex; this region's texture is unlike the contralateral side."
That is checkable. A verdict is not.

### 5.3 Named, coded, located

Almost entirely plumbing that exists, and the highest certainty-to-value ratio of the four:

- DICOM SEG already encodes semantics as **category + type + type modifier**, with **laterality
  encoded separately** rather than folded into the modifier — exactly the "femur / left / lower limb"
  decomposition.
- SNOMED-CT is DICOM's preferred terminology for segmentation properties; TotalSegmentator's SNOMED
  mapping and Slicer's terminology contexts are usable sources.
- What we add: **the hierarchy is live and queryable** (`femur ⊂ lower limb ⊂ appendicular skeleton`),
  so "show me everything in the left lower limb" is a query, not a manual selection — and the export
  is standards-clean by construction rather than by a later mapping step.

### 5.4 Range-of-motion coupling (the thumb)

The most speculative ask, and the most tractable geometry of the four. It decomposes cleanly:

1. **Bones** — segmentation (available).
2. **Joints** — which bones articulate, the axis, degrees of freedom, and the limits. This is
   *knowledge*, not image content: it comes from the anatomical knowledge layer, keyed on the coded
   identity from §5.3. This is precisely why §5.3 is a prerequisite, not a nicety.
3. **Coupling** — how much a given soft-tissue voxel moves when that joint articulates. This is the
   auto-rigging problem, and its classical solution is **steady-state heat diffusion from the bones
   through the volume** (Baran & Popović; geodesic voxel binding is the voxel-native variant). We
   already run the same class of solver: the JFA distance field and the grow-cut CA are the same
   machinery. A diffusion solve over an occupancy grid is a compute shader we can write.
4. **Delineation** — the deliverable is a **scalar field**, "displacement sensitivity to this joint's
   motion," which the SDF renderer already knows how to show, and whose isosurfaces *are* the
   requested delineation ("the skin that moves with the thumb" = a threshold on that field).

**Honest limit:** this yields *plausible* coupling from geometry plus atlas knowledge. It is not
validated patient-specific biomechanics — no dynamic imaging is being fitted. Present it as a
motion-coupling model, and it is genuinely useful; present it as truth and it is wrong.

## 6. What this does to the roadmap

Re-anchored, not discarded:

| Earlier step | Fate |
|---|---|
| **A-2 apply-with-rules** | **Promoted, reframed.** It is the *constraint evaluator* — masking rules were always constraints; now they are the general mechanism by which an interpretation restricts a field expression. Still first. |
| **A-4a SDF algebra** (margin, hollow, shape-based interpolation) | **Promoted to the core.** This is the interpretation engine of §5 and the answer to "extents under different interpretations." Highest value in the plan. |
| **S5/S6 grow-cut, FIM, level set** | **Kept as solvers**, not tools: level set regularizes neural output into a smooth, topologically sane surface; diffusion/Eikonal solvers produce the §5.4 coupling fields. No VCR, no bubbles, no user-facing snake. |
| **A-9/A-9+ classifier + features** | **Becomes the evidence layer.** `algorithms/features/` already evaluates radiology-designed, calibrated per-voxel operators on the GPU — that is the probe substrate of `SEGMENTATION-SKILL.md`. |
| **A-11 client-side AI (nnLive)** | **Promoted to a prerequisite**, not a late nicety. Point-and-ask needs a resident model. |
| **A-7 mrson emission** | **Promoted.** Interpretations, evidence, and overrides only mean something if they are recorded, replayable, and forkable. |
| **A-3n repulsor, A-3s sculptor, A-3 polygon/vertex editing, A-4b brush family, A-10 the SNAP snake as a user tool** | **Dropped.** These are the palette. |
| **A-6 layers/overlap, A-8 undo** | **Kept** — both are more necessary here, not less: coexisting interpretations *are* overlapping segments, and undo over a derived boundary means undoing an *interpretation change*. |

The thread that already pointed this way: **`docs/SEGMENTATION-SKILL.md` is the knowledge layer's
procedure**, written before there was an engine to run it. This doc makes `algorithms/` its actuator
rather than a re-implementation of somebody else's tool row.

## 7. What would make this fail

Stated up front so they can be designed against:

1. **Confident wrong answers.** The failure mode of every VLM in this space. Mitigation is structural,
   not exhortative: every claim must carry the probe values that support it, computed on the native
   array; the system must be able to say "I don't know which of these two it is."
2. **Verification burden.** If checking the system's answer costs more than drawing the boundary, it
   has failed. The evidence display *is* the product, not an appendix.
3. **The escape hatch closing.** If a user cannot override, they will not adopt. Overrides must be
   first-class, cheap, and recorded.
4. **PHI and licensing.** Client-side inference is the reason this is even proposable without a data
   egress conversation; anything that quietly routes voxels to an API breaks that property.
5. **Clinical framing.** "Resectable extent" is decision support and hypothesis exploration, not a
   plan. The interpretation object should carry that framing rather than leave it to a disclaimer.

## 8. The first provable step

Smallest thing that demonstrates the whole thesis end to end, on a real IDC case in the existing
seged app:

**S-1 — point, identify, and derive.** Click a voxel → the system returns a coded identity
(SNOMED + laterality + region, from a resident model), the evidence behind it, and its confidence →
then derives **three named interpretations of the same object as live SDF expressions** (e.g. the
structure itself, the structure with an *N* mm margin, and the margin clipped by proximity to a named
critical neighbor), each toggleable and re-derivable by changing *N* in a frame.

That single demo exercises: resident model → coded ontology → interpretation object → field algebra →
live SDF render → op-stream provenance. If it works, the rest is elaboration. If the identity step is
unreliable on real data, we learn that before building a knowledge layer on top of it.

**S-2 — the thumb.** §5.4 end to end: bones → coded joint → diffusion coupling field → the
delineation as an isosurface of that field, with the joint's range annotated. Nothing in the survey
can do this, and it makes the argument better than any comparison table.

---

## Sources

Text/knowledge-driven volumetric segmentation:
[SAT — anatomical knowledge tree, 6 502 terminologies](https://www.nature.com/articles/s41746-025-01964-w) ·
[BiomedParse-V](https://link.springer.com/chapter/10.1007/978-3-032-23496-4_7) ·
[Text3DSAM](https://openreview.net/forum?id=egbzGkOWVf) ·
[Bio2Vol](https://papers.miccai.org/miccai-2025/paper/1852_paper.pdf).
Ambiguity as the honest representation:
[Probabilistic U-Net](https://proceedings.neurips.cc/paper/2018/hash/473447ac58e1cd7e96172575f48dca3b-Abstract.html) ·
[QUBIQ challenge](https://www.academia.edu/122981821/QUBIQ_Uncertainty_Quantification_for_Biomedical_Image_Segmentation_Challenge) ·
[review of Bayesian uncertainty in segmentation](https://arxiv.org/html/2411.16370v1).
Coded identity:
[DICOM PS3.16 coded terminology](https://dicom.nema.org/medical/dicom/current/output/chtml/part16/ps3.16.html) ·
[anatomic region codes & laterality](https://dicom.nema.org/medical/dicom/current/output/chtml/part16/chapter_l.html) ·
[dcmqi coding-scheme guide](https://qiicr.gitbook.io/dcmqi-guide/opening/coding_schemes/existing_dicom_code) ·
[AI anatomy-model concordance / TotalSegmentator SNOMED mapping](https://arxiv.org/pdf/2512.15921).
Grounding reliability (the §5.2 caveat):
[MedSIGHT — pixel-level grounding gap](https://arxiv.org/pdf/2606.06760) ·
[auditing frontier VLMs for medical VQA](https://arxiv.org/pdf/2604.27720) ·
[spatially grounded radiology VLMs](https://arxiv.org/html/2606.20477v2).
Articulation coupling:
[Baran & Popović, automatic rigging (heat diffusion)](https://www.researchgate.net/publication/220183717_Automatic_rigging_and_animation_of_3D_characters) ·
[geodesic voxel binding](https://www.researchgate.net/publication/262271901_Geodesic_voxel_binding_for_production_character_meshes).
