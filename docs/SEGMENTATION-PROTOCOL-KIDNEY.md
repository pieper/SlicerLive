# Kidney + Tumor — a hypothesis-driven, body-plan-reconstruction protocol (CT / KiTS)

**Status: v0 scaffold (2026-08-12).** My synthesis of the approach applied to KiTS, written to be *enriched* by three in-flight literature investigations (knowledge-based/hypothesis-driven interpretation architectures; the radiologist renal reading protocol + Bosniak; the kidney variant/surgical/disease taxonomy). This is the "apply it to KiTS" companion to `SEGMENTATION-SKILL.md`.

## The core idea

Don't segment the kidney by matching a fixed template. **Reconstruct how this individual's body plan developed, then recognize where development, surgery/trauma, or disease deformed it.** The scan is a specific realization of the human body plan; segmentation is *explaining* that realization structure by structure. Two levels run together:

- **Pixel level** — cheap GPU probes score local evidence (enhancement relative to in-scan anchors, fat, gradient, texture, tubularity).
- **Scan level (holistic)** — a running anatomical model checks global consistency (two kidneys straddling the spine? right lower? collecting system draining to a ureter? symmetry? one kidney missing → is there a fossa scar, a transplant in the iliac fossa, an ectopic kidney?).

The pixel evidence proposes; the scan-level model disposes. Neither alone is enough — that's the lesson of the isolation failures.

## Protocol-execution model (structure-agnostic)

A protocol is an **ordered set of hypotheses**, each with: a *generator* (what to expect and where), one or more *probes* (GPU measurements), a *score*, *competitors*, and a *commit / refute / defer* rule.

```
ESTABLISH FRAME      spine → midline, SI axis, posterior, body width, L/R sense
BUILD BODY PLAN      the individual's expected normal anatomy, instantiated from the frame:
                     "two kidneys, paravertebral, right ~1–1.5 cm caudal, fat-wrapped,
                      hila medial, draining to ureters toward the bladder"
FOR EACH EXPECTED STRUCTURE (easy → hard, rule-out order):
    generate hypothesis at its expected location/appearance
    run probes → score
    CONFIRM  (evidence matches expectation)        → commit label, subtract from field
    REFUTE   (evidence contradicts)                 → branch to VARIANT / SURGICAL / DISEASE
    DEFER    (ambiguous, low confidence)            → flag for human/second-model
HOLISTIC CHECK       does the committed scene satisfy the body-plan constraints?
                     unexplained region → "other"; violated constraint → re-open a hypothesis
```

The **branch on refutation** is the heart of it: when "normal left kidney here" fails, the protocol doesn't give up — it asks the *next* hypotheses in a ranked differential (absent+fossa-scar → prior nephrectomy; absent+iliac-mass → transplant; displaced-inferior → ectopic/pelvic; midline-bridge → horseshoe; two collecting systems → duplex; replaced-by-cysts → ADPKD; fat-containing mass → AML; …). Each is a recognizer with its own probes. *(The full differential + probes come from research thread #3.)*

## Kidney/tumor protocol — v0 ordered steps

**0. Frame & anchors.** Spine → coordinate frame; sample fat mode, cortex, and the **aorta (detected as a midline tube)** as the per-case enhancement reference. *(Built.)*

**1. Rule-out partition (subtract the knowns).** Air/body, fat, bone/spine, great vessels (aorta/IVC), psoas/paraspinal muscle, liver, spleen, bowel — each a semantic detector; label and subtract. The kidney lives in what remains in the retroperitoneal fossa. *(Spine + vessels built; rest is the next build.)*

**2. Instantiate the two-kidney hypothesis.** From the body plan, predict a left and a right paravertebral organ region (right caudal). This is the *positive* expectation the residual must satisfy.

**3. Confirm each kidney by its signature, per side, bounded.** In each predicted fossa: the fat-wrapped, structured-enhancing (cortex bright / medulla darker) organ, lateral to psoas, below the liver/spleen dome, hilum medial. Grow within the per-side region bounded by the fat wall + the detected confusers (so it cannot absorb liver/aorta — the fix for the isolation failure). Verify shape (reniform, compact) and laterality.

**4. Branch on refutation (variants / surgery / disease).** If a side fails the two-kidney hypothesis, walk the ranked differential (above). Each recognizer, when confirmed, *rewrites the body-plan expectation* for the rest of the protocol (e.g. horseshoe → expect a midline isthmus crossing anterior to the aorta; solitary → expect compensatory hypertrophy contralaterally). *(Differential + signatures from research #3.)*

**5. Within the kidney envelope, characterize masses (Bosniak-style decision tree).** For each focal region that disrupts the normal cortex→medulla architecture: enhancing (Δ vs cortex, pseudoenhancement guard) → solid **tumor**; non-enhancing fluid, thin wall → **cyst** (Bosniak I–II) vs complex (III–IV); macroscopic fat → **AML** (not RCC); central and continuous with cortex → **column of Bertin** (a pseudotumor, *not* a mass). *(Exact decision tree + thresholds from research #2.)*

**6. Holistic verification.** Two reniform surfaces (or the confirmed variant), right lower, masses plausible/unilateral, collecting system accounted for, nothing unexplained left un-"other"-ed. Scroll all slices, rotate 3D. Low-confidence regions → defer for review; the review becomes new training material.

## Why this is the right shape for KiTS

- The KiTS failures that break CNNs and my naive detector are exactly steps 4–5 material: OOD anatomy (post-surgical, variants) and the tumor/cyst/pseudotumor differential. Encoding them as an explicit *differential the protocol walks* is what a CNN can't expose and can't reason about.
- It degrades gracefully: it *knows* when it's off the normal body plan and can defer, instead of confidently mislabeling.
- Every recognizer is a cheap probe + a written rule, so the whole thing stays fast (the FLOP argument) and inspectable.

## Filled by the research (2026-08-12) → now in the skill hierarchy
The three research threads landed and are distilled into [`../skills/segmentation/`](../skills/segmentation/):
- **Executor architecture** → [`skills/segmentation/README.md`](../skills/segmentation/README.md): a *fuzzy-CSP blackboard with learned probes and an NS-VQA-style symbolic protocol, coarse-to-fine over an FMA/RadLex graph* (Bloch constraint-propagation, Udupa AAR, VISIONS/Manchester blackboard, NS-VQA, MMedAgent). **Two rules:** never commit early (carry fuzzy bounds + backtracking to kill error-propagation); score hypotheses jointly on pixel evidence AND whole-scan constraint consistency, deferring on disagreement.
- **Step 4 variant/surgical/disease differential** → [`01-variants.md`](../skills/segmentation/kidney/01-variants.md), [`02-surgical-trauma.md`](../skills/segmentation/kidney/02-surgical-trauma.md), [`03-disease-and-mass.md`](../skills/segmentation/kidney/03-disease-and-mass.md).
- **Step 5 mass/Bosniak-2019 decision tree** with exact thresholds → [`03-disease-and-mass.md`](../skills/segmentation/kidney/03-disease-and-mass.md).
- **Layer 0 frame + patient-normal + pseudotumor gate + anti-SOS search** → [`00-normal-anatomy-and-frame.md`](../skills/segmentation/kidney/00-normal-anatomy-and-frame.md).

Remaining engineering (not research): implement the blackboard/CSP executor over the GPU feature-cortex; build the partition detector suite; wire the Layer-0→3 gates; score on KiTS; fold in expert Slicer reviews.
