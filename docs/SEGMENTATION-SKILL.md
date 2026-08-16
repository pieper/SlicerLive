# SEGMENTATION-SKILL

**A portable procedure for segmenting anatomical structures by *active probing* of medical-image data, grounded in semantic/anatomical knowledge — not by an unattended pixel algorithm and not by frozen network weights.**

## Why this document exists

Trained networks (nnU-Net and kin) are today's only reliably-working automatic segmenters, but they:
- need dozens–hundreds of labeled examples per task,
- amortize expert judgment into weights that **cannot be inspected or reasoned about**, and
- fail on out-of-distribution data — new tumor types, post-surgical anatomy, unusual protocols — precisely because the judgment is frozen.

Classical automatic methods (region growing, level sets, graph cuts, atlases) are all **dead ends when run unattended**: each only works when a human supplies the semantic decisions at the hard moments (where to seed, when a boundary is real, whether a dark region is medulla or tumor).

This skill makes that judgment **explicit and portable**. It is written to be executed by an agent — ultimately a small language model coupled to a strong latent embedding of the medical-image space — that reads the anatomical description of a target structure, then **actively interrogates the volume** to find the thing that matches the description, checking itself the way an expert does. The skill is the generalization of the weights: the **method** is the inference engine; the **structure library** is the knowledge.

> Execution substrate note. Where this skill says "find regions that look like enhancing cortex" or "measure how heterogeneous this region is," a crude implementation uses hand-built image features (HU relative to a reference, local variance/entropy, gradient-to-fat). The intended implementation replaces those with **queries into a learned image embedding** ("nearest to cortex exemplars," "far from smooth-parenchyma manifold"). The *procedure and the decisions are identical*; only the similarity metric changes. Everything below is written so either substrate can execute it.

---

## PART A — The general active-probing method (structure-agnostic)

### A.0 Operating principles

1. **Work in the native data space, not in renderings.** Make per-voxel decisions on the array. Use renderings only to *gain context* and to *verify* — never to locate a boundary by eye. (Screenshot-level fractional estimates are too imprecise; they miss the target.)
2. **Segment the *object*, not an intensity class.** A structure is a **bounded region** with a semantic identity, not a range of values. Its edge is usually defined by a *neighboring tissue* (a wall), not by its own intensity.
3. **Prefer robust cues over fragile ones.** *Fragile:* absolute intensity (varies with contrast phase, timing, scanner, patient). *Robust:* (a) the gradient to a phase-invariant neighbor (e.g. fat), (b) intensity/texture **relative to a same-scan reference tissue**, (c) shape/topology/location. Build every decision on robust cues; use absolute intensity only after per-case normalization and never alone.
4. **Forest → trees → leaves, then back up.** Localize the organ semantically (forest) before defining its envelope (tree) before classifying sub-tissue (leaves) — and let the coarse level constrain the fine level. Never classify a voxel without knowing which organ it is in.
5. **Probe, interpret, decide, verify — in a loop.** Each probe returns a compact, interpretable result. *You* interpret it against the anatomical description, decide the next probe, and periodically verify against the whole picture. Record what you did and why.
6. **Know your failure modes before you start.** Read the structure library's failure list first; most bad segmentations are a known trap (cyst mistaken for tumor, medulla mistaken for lesion, leak through a fat-poor bare area).
7. **Detect confusers, don't threshold around them.** When two tissues are inseparable by intensity (kidney vs aorta, kidney vs liver), they are almost always trivially separable by *anatomy* (the aorta is a vertical midline tube; the liver is a large RUQ organ). Build a **detection layer** for each confuser — a probe that recognizes that named structure by its own anatomy (position relative to the coordinate frame + shape + continuity + intensity/texture, in that priority) — and **subtract it out**. A confuser removed is worth more than a threshold tuned.
8. **Partition the scene; rule out the knowns first.** Prefer to label *every* voxel as *something* recognizable — air, skin/body wall, fat, bone/spine, muscle, great vessels, liver, spleen, bowel — or as **"other" (recognized as unclassifiable)**. Segmenting the target is then largely **what remains** after the confident, easy labels are removed, plus a positive confirmation of the target's own signature. This is how an expert reads a scan, and it generalizes to new/varying anatomy without per-structure ground-truth training (the semantic-scope answer to TotalSegmentator).

### A.1 The probe loop

```
0. CONTEXT   Establish scan-level facts: modality, contrast phase, in-scan
             normalization anchors (a phase-invariant tissue like fat; a
             reference enhancing tissue like aorta/cortex; bone for spine).
1. LOCALIZE  Use the location/topology prior to place a search region and an
             expected count/arrangement of the structure.
2. CONFIRM   Find a high-confidence CORE of the structure inside the search
             region (a seed you are sure about). Cross-check with symmetry /
             expected count.
3. ENVELOPE  Grow the object from the core, bounded by its WALL (the robust
             neighbor-gradient), not by its own intensity. Watch the known
             leak sites.
4. REGULARIZE Impose the shape/topology prior: expected component count,
             compactness, closure across wall-gaps (bare areas).
5. RESOLVE   Split sub-structures inside the envelope using relative/textural
             cues (never absolute intensity). Apply the sub-structure gates
             (e.g. cyst gate) in order.
6. VERIFY    Scroll every slice; rotate the 3D. Check: contour smoothness,
             symmetry, plausibility of any lesion, no leak into neighbors,
             no missed component. Return to the failing step.
```

### A.2 Verification discipline (this is where amateurs and experts diverge)

An expert does not trust one view. After any candidate segmentation:
- **Scroll the full stack** in the primary plane; the mask must enter and leave the way the organ does.
- **Rotate the 3D** to at least two orthogonal viewpoints; the surface must be organ-shaped, not blobby or spiky.
- **Check symmetry / count / laterality** against the prior (e.g. two kidneys, right lower).
- **Interrogate every anomaly**: a bump, a hole, an asymmetry is either real pathology (keep, and explain it) or a leak/miss (fix it). Never leave an unexplained feature.
- **State confidence per sub-region.** "Cortex envelope: high. Medial hilar boundary: low, fat-poor. Tumor extent: medium." Low-confidence regions are where a human click or a second probe is worth the most.

### A.3 Where a human (or a second agent) is worth a click

The skill is **agent-in-the-loop by design**, not unattended. Spend scarce human/second-model attention exactly at the low-confidence moments the method surfaces:
- disambiguating a fat-poor bare-area boundary,
- confirming a lesion vs a normal dark sub-structure,
- seeding an unusual (OOD) case the priors don't fit (post-surgical, transplant, horseshoe kidney).
This is the opposite of nnU-Net's all-or-nothing: the method **knows where it is unsure** and asks there.

### A.4 The coordinate frame and the detection-layer library (the probe set)

The probes are implemented as a growing library of **detection layers** — GPU per-voxel scoring (the feature-cortex shaders: enhancement relative to in-scan anchors, fat, gradient, texture) combined with lightweight geometric reasoning (connected components, shape/continuity, position). Build order, easy → hard, each layer usable by every task:

1. **Air / body / skin** — the outer partition (HU, largest component bounded by air). Frees the field of everything outside the patient.
2. **Coordinate frame from the spine** — bone (high HU) → **midline x, SI axis, posterior direction, body half-width**, and the R/L sense from the volume's index→RAS. *Every other detector is defined against this frame.* (Robust in practice.)
3. **Fat** — phase-invariant low-HU envelope; the wall and a normalization anchor.
4. **Great vessels (aorta / IVC)** — vertical midline tubes anterior to the vertebral body: position + tubular thinness + vertical continuity, *not* brightness. Doubles as the **per-case enhancement reference** (aorta HU = arterial bolus level).
5. **Muscle (psoas / paraspinal)** — paravertebral soft-tissue landmarks the kidney sits lateral to.
6. **Large organs (liver, spleen, bowel)** — big regional masses in their expected quadrants; the kidney's bare-area neighbors.
7. **Target, defined relationally** — e.g. the kidney = the fat-wrapped, structured-enhancing paravertebral bean, lateral to psoas, below the liver/spleen dome, that is **none of the above detectors**, bilateral, right-lower.

Each detection layer carries a **semantic definition** (what the structure *is*) and is calibrated on labeled data; each new test case can add a layer or refine one, and expert corrections append here. Anything no layer claims → **"other."**

---

## PART B — Structure library

Each entry supplies: the **semantic description** (what the thing *is*), the **robust cues**, the **probe recipe** (the loop instantiated), the **decision rules & gates**, and the **failure modes**. This is the replaceable "knowledge" layer.

---

### B.1 — KIDNEY and RENAL TUMOR (RCC) on CT

*Grounded in: RadioGraphics/AJR renal-enhancement and RCC reviews, Radiopaedia/StatPearls anatomy, the KiTS19/21 challenge analyses, and the classical kidney-segmentation literature (Lin 2006 spine-relative region growing; El-Baz shape+appearance level sets/RF; Freiman graph-cut). Full citations in the research briefs archived with this project.*

#### B.1.a Semantic description (the target)

- **Kidneys** are paired **retroperitoneal, paravertebral** organs spanning ~**T12–L3**, lying against psoas with an **oblique, psoas-parallel long axis** (superior pole more medial/posterior). **Right kidney sits ~1–1.5 cm caudal** to the left (liver displaces it). Adult length ~**10–12 cm**.
- Each kidney is a **single connected "reniform" (bean)** body: convex lateral border, concave medial **hilum** where vessels and the collecting system enter, a central fat-filled **sinus**.
- The kidney is wrapped in **perirenal fat inside Gerota's fascia** — a nearly-closed **low-attenuation envelope**. This fat rim is the organ's true boundary and is **phase-invariant** (fat ≈ −190…−30 HU, does not enhance).
- **Renal cell carcinoma** arises *from* the parenchyma and **replaces/expands** it: ~94% of cortical RCCs **distort the smooth reniform contour** (exophytic bulge or endophytic mass). It is characteristically **heterogeneous** (necrosis 0–30 HU, hemorrhage 50–70 HU unenhanced, calcification >100 HU) versus smooth parenchyma. It is usually **unilateral, solitary**.
- **The organ envelope = parenchyma + tumor + cyst as one spatial footprint, but separate labels.** Segment the envelope first; then split. (This is exactly the KiTS class definition.)

#### B.1.b Robust vs fragile cues (kidney-specific)

- **ROBUST boundary:** the **parenchyma→perirenal-fat gradient**. Kidney soft tissue is ≥ +20 HU in every phase; surrounding fat is deeply negative → a contrast of **~60 to >350 HU across the capsule in all phases**. Use this rim as the wall.
- **ROBUST tumor cue:** enhancement **relative to the *same scan's* cortex** (sample both tumor-candidate and adjacent cortex; the ratio cancels phase/scanner), plus **architectural disruption** and **contour distortion** (both contrast-independent, geometric). See the texture correction below.
- **FRAGILE:** absolute parenchyma HU. It swings **~30 HU (unenhanced) → ~200+ HU (corticomedullary cortex)**. A fixed HU window that works on one scan fails on the next. *(This is the exact reason a global threshold plateaued at Dice 0.42 in earlier hands-on work — see failure modes.)*

> **Calibrated on IDC KiTS ground truth (5 training cases, source of truth = the KiTS SEGs):**
> - *Absolute HU fragility, confirmed:* kidney median HU = **207 / 60 / 108 / 141 / 200** across cases (3.4×). No usable fixed window.
> - *Fat anchor, confirmed:* fat mode = **−115…−105 HU** in every case, independent of contrast phase → the normalization anchor and the wall.
> - *Fat-wall coverage is partial:* fat bounds only **50–88%** (median ~70%) of the organ surface; the rest abuts soft tissue (liver/psoas/vessels/hilum). **The reniform shape prior is mandatory, not optional** — it must close the remaining 12–50%.
> - **TEXTURE DIRECTION CORRECTED (important):** fine-scale local variance is *higher in normal kidney than in tumor* here (median 1283/641/395/1710/2215 kidney vs 496/502/473/1047/1887 mass). In corticomedullary/nephrographic phase the *normal* kidney is highly structured (bright cortex / dark medulla / bright sinus), so it is the *high-variance* tissue; a solid tumor **replaces that organized architecture with a comparatively uniform enhancing blob.** So the discriminator is **loss of the normal radial cortex→medulla organization** (a mid-scale architectural anomaly), **not** "tumor = noisy." A naive high-variance-⇒-tumor rule points the wrong way.

#### B.1.c Contrast-phase awareness (must detect before deciding)

| Phase | Cortex | Medulla | Collecting system | Whole-parenchyma uniform? |
|---|---|---|---|---|
| Unenhanced | 30–40 | 30–40 | fluid 0–20 | yes (all dim) |
| **Corticomedullary (CMP)** | **140–220** | **60–100 (dark)** | low | **no — bright cortex, dark medulla** |
| Nephrographic (NP) | 100–140 | 100–140 | low | **yes — best for whole-kidney** |
| Excretory | falling | falling | **>300 (bright)** | no |

**KiTS data is corticomedullary/late-arterial.** Therefore *expect a strong bright-cortex / dark-medulla split inside the normal kidney* — the "uniform parenchyma" assumption is false here, and **normal dark medulla must not be mistaken for a lesion** (it is central, symmetric, reticulated). Detect phase from the cortex–medulla split and pelvis opacification, then set expectations accordingly.

#### B.1.d Probe recipe (the loop, instantiated)

**Probe 0 — Context & normalization.**
- Confirm CT. Detect phase (cortex–medulla split present → CMP; uniform bright parenchyma → NP; bright pelvis → excretory).
- Anchors: **fat mode** = peak of the low-HU (<−30) histogram lobe; **cortex HU** = robust high percentile of enhancing tissue in the paravertebral zone; **aorta HU** = bright tubular structure just anterior/left of the spine (tracks the bolus). Normalize subsequent intensity cues to these.

**Probe 1 — Localize.** Find the **spine** (bright, midline, posterior). Define **two paravertebral search boxes** flanking it in the T12–L3 band, anterior to psoas. Expect **exactly two** organs, the right centroid caudal.

**Probe 2 — Confirm cores.** In each box find a compact **bright-cortex** blob → the confident seed. Cross-check bilateral symmetry and right-caudal offset. If only one side has an obvious kidney, flag OOD (nephrectomy? mass replacing the organ?) and lower confidence / request a click.

**Probe 3 — Grow the envelope (the key step).** From each cortex seed, **confidence-connected region grow**: accept a voxel if within *k·σ* of the **running mean of the already-accepted region**, then **re-estimate mean/σ and iterate**. This adapts to the organ (captures the dark medulla as the region mean drops) instead of to a fixed HU guess. **Hard barrier:** any fat voxel (below the fat band) is infinite-cost — the grow cannot cross Gerota's fat. This is what both captures the medulla *and* prevents the liver leak that a low global threshold caused.

**Probe 4 — Regularize (close the wall-gaps).** The fat envelope is **open** at known **bare areas** — the medial **hilum** (toward vessels/pelvis) and the **right-upper-pole↔liver** contact (fat thin/absent). There the grow will leak. Impose the shape prior: morphological **close + fill holes**, keep **two compact reniform components**, reject anything crossing the midline into aorta/IVC, and clip growth that violates paravertebral compactness. Shape supplies recall where the fat evidence is missing.

**Probe 5 — Resolve sub-structures (envelope → parenchyma / tumor / cyst).** Inside the envelope only:
- **Cyst gate first:** a homogeneous region of **0–20 HU, thin wall, non-enhancing (Δ<10 HU vs unenhanced, if available)** → cyst, not tumor. Suppress the **10–20 HU pseudoenhancement** band for small (<1.5 cm) lesions ringed by bright cortex (artifact, not vascularity).
- **Tumor:** a contiguous region inside the envelope that **breaks the normal cortex→medulla architecture** — i.e. a comparatively **uniform mid-scale enhancing blob** where structured parenchyma should be (per the calibration above, tumor has *lower* fine-scale variance than the organized normal kidney, not higher) — **and/or** enhancement **anomalous relative to adjacent cortex** (clear-cell ≈ cortex in CMP then washes out; papillary ≪ cortex all phases) **and/or** a **bulge distorting the reniform contour** (± pseudocapsule rim). Mask out very-high-HU **excreted contrast** (collecting system) so it isn't called tumor.
- Everything else in the envelope = **parenchyma**.

**Probe 6 — Verify.** Scroll every axial slice: the mask enters/leaves as two beans. Rotate 3D: two reniform surfaces, right lower, any bulge explained as tumor. Recheck no leak into liver/spleen/psoas/bowel, no medulla-as-tumor error, tumor is unilateral/plausible. Fix the responsible step.

#### B.1.e Decision rules & numeric anchors (relative, not gates)

- **Enhancement test (tumor vs cyst):** Δ ≥ 20 HU (post−pre) = enhancing → solid/tumor; <10 = non-enhancing → cyst; 10–19 = equivocal/pseudoenhancement.
- **Subtype relative behavior** (use as *direction*, not thresholds): clear-cell hypervascular+heterogeneous, wash-in→washout; papillary hypovascular, homogeneous when small; chromophobe intermediate, sometimes central scar.
- **Fat wall:** voxels below ≈ fat_mode + margin (robustly < −45 HU) = barrier, every phase.

#### B.1.f Failure modes (read before starting — most bad results are one of these)

1. **Global HU threshold** for the whole kidney — *impossible in CMP* (cortex 140–220 vs medulla 60–100); high → drops medulla, low → reconnects to liver. **Use confidence-connected grow + fat wall instead.** (Hands-on: fixed threshold peaked at Dice 0.425 here; hysteresis with a lower floor *reconnected* kidney→liver and did worse, 0.31.)
2. **Growcut / loose intensity flooding** from a few seeds — floods through same-HU liver/muscle/vessel/bowel (hands-on: 40× over-segmentation, Dice 0.002). Intensity connectivity alone cannot contain the kidney.
3. **Cyst called tumor** — the #1 KiTS error. Apply the cyst gate (non-enhancing fluid) before tumor.
4. **Normal dark medulla called tumor** in CMP — it's central, symmetric, reticulated, *inside* the envelope; not a focal contour-distorting mass.
5. **Leak at bare areas** (right-upper-pole↔liver, hilum↔vessels) — close with the shape prior, not a lower threshold.
6. **Small / endophytic / isoattenuating tumors** — intrinsically hard (mean KiTS19 tumor Dice across all teams was 0.58; human inter-rater 0.92). Expect low tumor recall; flag low confidence and request a click rather than guessing extent.
7. **OOD anatomy** (post-surgical, transplant in iliac fossa, horseshoe/duplex) — the location/count priors break. Detect the mismatch, drop to human-seeded mode.

#### B.1.g Realistic expectations

Whole **kidney**: a well-executed probe loop targets **Dice ~0.85–0.92** (classical ceiling on tumor-bearing data; ~0.97 numbers are cherry-picked healthy cohorts). **Tumor**: **~0.3–0.6**, highly case-dependent — *mid-pack among CNNs*, and honestly reported as such.

---

## Appendix — how this skill becomes the "weights replacement"

- The **method (Part A)** is fixed and small — it fits in a prompt for a modest LM.
- The **structure library (Part B)** is the knowledge that today lives in millions of network parameters, here written as inspectable anatomical descriptions + probe recipes + failure lists. New structures = new library entries, authored once (from literature + one expert probing session), not hundreds of labeled volumes.
- The **similarity substrate** — "does this look like cortex / like heterogeneous tumor" — is the one learned component: a **latent embedding of medical-image space** the agent queries in place of the hand-built features. That embedding is *general* (one per modality/region), not per-task, so it does not inherit nnU-Net's per-task data hunger or OOD brittleness.
- Together: a **small LM + a general image embedding + this skill** actively probe a new volume and produce a *semantically justified* segmentation whose every decision can be inspected, questioned, and corrected.

---

*Status: v1 draft (authored from two literature briefs + hands-on KiTS probing). Next: validated and refined by executing it in-the-loop on unseen cases; each probe recipe hardened against what actually works on the native arrays.*
