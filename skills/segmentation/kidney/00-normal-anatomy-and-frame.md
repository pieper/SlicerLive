# Kidney — Layer 0: Normal anatomy, coordinate frame, and the patient-normal reference

The base layer. It **establishes this individual's normal anatomy before judging anything abnormal**, and — crucially — it does not silently "win": it emits a **prior-violation signal** for each departure that *routes* to a deeper layer. Abnormality is defined relative to the patient's own baseline, not a population template.

## 0.1 Coordinate frame (run first — cheapest strong-prior probe)
- PROBES: spine detector (bone, high HU) → **midline x, SI axis, posterior direction, body half-width**; R/L sense from the volume's index→RAS. Then the in-scan intensity anchors: **fat mode** (~−110 HU, phase-invariant), **cortex** (bright enhancing parenchyma), **aorta** (detected as a midline tube = the per-case enhancement reference).
- ACTION: seat the frame; every other recognizer's location is expressed against it. *(Built: `algorithms/features/` + the spine/aorta detectors.)*

## 0.2 Acquisition-phase probe (gates what every later probe can measure)
- PROBES: cortex−medulla split + collecting-system opacification → classify **unenhanced / corticomedullary (CMP) / nephrographic (NP) / excretory**.
- EXPECTATION: **NP (~80–120 s) is the primary detection + characterization phase** (uniform parenchyma, hypo-enhancing masses stand out); CMP is worst for lesion detection; **excretory (~7–10 min)** for the collecting system; **unenhanced** is the baseline for all enhancement math, fat, and calcification.
- ACTION: choose which probes are valid; require the *same ROI* across unenhanced+NP for enhancement (ΔHU). KiTS is largely CMP → expect bright cortex / dark medulla and do **not** read normal medulla as lesion.
- CITE: [AJR renal enhancement phases](https://www.ajronline.org/doi/10.2214/ajr.173.3.10470916); [Radiology CMP vs NP](https://pubs.rsna.org/doi/abs/10.1148/radiology.200.3.8756927).

## 0.3 Patient-normal reference (establish BEFORE lesion search)
Per-kidney probes → the individual's baseline; each row's BRANCH opens Layer 1/2:

| PROBE | EXPECTATION | violation → ROUTE |
|---|---|---|
| **Number** | 2 | ≠2 → Layer 1 (agenesis/ectopia/horseshoe/supernumerary) or Layer 2 (nephrectomy) |
| **Position** | retroperitoneal, ~T12–L3, right slightly lower | out-of-fossa → Layer 1 ectopic/pelvic or Layer 2 transplant |
| **Length** | ~9–13 cm; the two within ~1.5 cm | asymmetry/atrophy → Layer 2/3 (obstruction, vascular, infiltrative) |
| **Axis** | upper poles medial/posterior, long axis ∥ psoas | malrotation / horseshoe → Layer 1 |
| **Contour** | smooth reniform (fetal lobulation / dromedary hump allowed) | focal bulge → **0.4 pseudotumor gate** |
| **Corticomedullary differentiation** | present CMP, uniform NP | loss/asymmetry → Layer 3 (infiltration, medical renal disease) |
- CITE: normal anatomy [Radiopaedia kidney](https://radiopaedia.org/articles/kidney); size norms standard.

## 0.4 The pseudotumor gate (resolves the most common false positive)
- TRIGGER: any **focal parenchymal bulge** flagged by 0.3 (the naive "endophytic tumor" trap).
- PROBE: enhancement of the bulge vs adjacent cortex across **all** phases + cortical continuity + collecting-system mass effect.
- DISTINGUISH: **a pseudotumor stays iso-attenuating and iso-enhancing to cortex in EVERY phase, is continuous with cortex, and exerts no mass effect on the sinus.** A true mass deviates from cortex in ≥1 phase.
- ACTION: iso-in-all-phases → label **normal parenchyma** (→ Layer 1 names it: column of Bertin / fetal lobulation / dromedary hump), STOP. Otherwise → Layer 3 mass recognizer.
- CITE: [PMC5747680 (pseudotumor rule)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5747680/); [PMC12410592 (column of Bertin)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12410592/).

## 0.5 Structured search (anti–satisfaction-of-search)
Expert reading = a fast **gestalt** pass + a **structured search** that *completes every station even after a positive finding*. Once one lesion is found, a second is disproportionately missed (≈90% of misses are actually fixated) — so **finding one renal mass is a trigger to search for a second and for metastatic spread, not closure.**
- ACTION: the protocol must force-complete the checklist — parenchyma → collecting system → ureters → perinephric space → sinus/hilum → **renal vein/IVC (tumor thrombus)** → adrenals → rest of abdomen (liver, nodes, bones, lung bases) — before finalizing.
- CITE: [Radiology SOS](https://pubs.rsna.org/doi/10.1148/radiol.11110987); [RadioGraphics error reduction](https://pubs.rsna.org/doi/10.1148/rg.2015150023).

## 0.6 Positive kidney signature (what Layer 0 confirms when no violation fires)
The fat-wrapped, structured-enhancing organ (cortex bright / medulla darker in CMP), paravertebral, lateral to psoas, below the liver/spleen dome, hilum medial, bilateral (right lower). Grow within the per-side fossa **bounded by the fat wall and the detected confusers** (so it cannot absorb liver/aorta) → the isolation fix. Then run the Layer 3 mass-screen inside the confirmed envelope. Anything in the fossa no recognizer claims → **"other."**
