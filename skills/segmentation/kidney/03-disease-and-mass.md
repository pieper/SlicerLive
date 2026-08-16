# Kidney — Layer 3: Disease & renal-mass characterization (Bosniak 2019 + mimics)

Run **inside the confirmed kidney envelope** for any focal region that disrupts the normal cortex→medulla architecture, or globally for diffuse disease. Ordered so the cheapest/most-decisive discriminators run first. Every threshold below is load-bearing — cited to primary sources.

## The mass characterization decision tree

### NODE 0 — Lesion or pseudotumor?  → (Layer 0 §0.4)
Iso-to-cortex in **all** phases + cortical continuity + no sinus mass effect → normal variant, STOP. Else continue.

### NODE 1 — Macroscopic fat? (most specific probe; run early)
- PROBE: min-attenuation ROI on **unenhanced** CT.
- **< −10 HU macroscopic fat AND no calcification → angiomyolipoma (AML)** — benign, essentially diagnostic (most AMLs ~ −100 HU). Between −20 and −10 HU → MR/US to exclude a cyst.
- **BRANCH:** fat **+ calcification** → suspect **fat-containing RCC** → route to solid path. **Fat-poor AML** has no measurable fat, is homogeneously hyperdense on unenhanced CT, enhances avidly → falls through to solid path and cannot be separated from RCC on CT alone.
- ACTION note: macroscopic fat is negative-HU — a soft-tissue window will *drop* it; include it. Sporadic AML ≥4 cm or aneurysm >0.5 cm → treatment referral.
- CITE: [ACR white paper](https://www.jacr.org/article/S1546-1440(17)30497-0/fulltext); [PMC6159326 (fat-poor AML)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6159326/).

### NODE 2 — Enhancing? (the solid-vs-cyst pivot)
- PROBE: **ΔHU = nephrographic − unenhanced, same ROI/location.**
- **ΔHU ≥ 20 → true enhancement → SOLID** (→ NODE 3; if cystic-appearing, Bosniak).
- **ΔHU ≤ 10 → no enhancement → cyst** (→ Bosniak I/II).
- **ΔHU >10 & <20 → INDETERMINATE = pseudoenhancement trap** (beam-hardening overcorrection, worst for small <1.5 cm intrarenal cysts at high background). If small/homogeneous/fluid → favor cyst, confirm with MRI (≥15% SI rise) or CEUS. Use a stricter **15 HU** cut for exophytic/larger lesions.
- Shortcuts (no math): unenhanced **−10 to +20 HU homogeneous** → simple cyst (Bosniak I); unenhanced **≥70 HU homogeneous** → hyperdense **Bosniak II**, no workup (NOT reassuring on contrast-only CT). "Too small to characterize" = size < 2× slice thickness → usually benign, surveil.
- Size→malignancy (solid): <1 cm ~40% benign; 1–4 cm ~20%; >4 cm <10%. Growth: ≤3 mm/yr for ≥5 yr = stable; ≥4 mm/yr = growth.
- CITE: [ACR white paper Table 3](https://geiselmed.dartmouth.edu/radiology/wp-content/uploads/sites/47/2019/04/ACR_Renal2017.pdf); [AJR enhancement threshold](https://ajronline.org/doi/full/10.2214/AJR.15.14806); [Radiology pseudoenhancement](https://pubs.rsna.org/doi/abs/10.1148/radiology.213.2.r99nv33468).

## Bosniak 2019 (cystic mass = <25% enhancing tissue) — evaluate top-down, highest feature met sets the class
Measurement dictionary: enhancement = **≥20 HU** (CT) / ≥15% SI (MRI); wall/septum **thin ≤2 mm**, **minimally thickened = 3 mm**, **thick ≥4 mm or irregular**; **protrusion ≤3 mm obtuse = "irregularity" (class III)**; **nodule = ≥4 mm obtuse-margin protrusion, OR any size with acute margins (class IV)**. Calcification is **not** a determinant in v2019.

- **B0 — enhancing nodule?** → **Class IV** (cystic RCC), ~90% malignant → surgery.
- **B1 — thick (≥4 mm) OR irregular walls/septa, enhancing?** → **Class III**, ~50% malignant → surgery vs surveillance.
- **B2 — minimally thickened (3 mm) enhancing wall/septa, OR ≥4 smooth thin enhancing septa?** → **Class IIF**, ~11% malignant → surveillance.
- **B3 — thin (≤2 mm) wall with 1–3 thin smooth septa (may enhance), and/or hyperdense (≥70 HU unenhanced) fluid?** → **Class II**, <1% → no follow-up.
- **B4 — thin smooth wall, no septa, homogeneous simple fluid (−9 to 20 HU), no enhancement?** → **Class I**, ~0% → no follow-up.
- CITE: [Silverman, Radiology 2019](https://pubs.rsna.org/doi/full/10.1148/radiol.2019182646); [RadioGraphics pictorial](https://pubs.rsna.org/doi/full/10.1148/rg.2021200160).

## NODE 3 — Solid enhancing mass: subtype, growth, staging (report fields)
- **Subtype by enhancement (RCC):** **clear cell** — hypervascular, heterogeneous, peaks **corticomedullary** ~125 HU, washout (CM threshold ~55 HU separates from papillary at ~94% sensitivity); **papillary** — hypovascular, homogeneous, ~54 HU, peaks nephrographic; **chromophobe** — intermediate, sometimes spoke-wheel (overlaps oncocytoma). CITE: [PMC4882405](https://pmc.ncbi.nlm.nih.gov/articles/PMC4882405/).
- **Oncocytoma:** central scar (39–43%, not specific) + spoke-wheel + segmental enhancement inversion — **overlaps chromophobe RCC so heavily that imaging cannot call it benign**; suggest, don't conclude. CITE: [PMC9881251](https://pmc.ncbi.nlm.nih.gov/articles/PMC9881251/).
- **Growth pattern:** exophytic / mesophytic / **endophytic** (contour looks normal — the dangerous one) / **infiltrative** (preserves reniform shape while replacing cortex — "big ugly kidney"). Read the **nephrographic phase for regions that fail to enhance normally.** CITE: [RadioGraphics infiltrative masses](https://doi.org/10.1148/rg.352140015).
- **Tumor thrombus:** follow the **renal vein into the IVC** for *enhancing, expansile* soft tissue (vs bland thrombus = non-enhancing). Staging-critical (T3a renal vein / T3b IVC below diaphragm / T3c above).
- **Nephrometry (R.E.N.A.L.):** R radius (≤4/>4–<7/≥7 cm = 1/2/3), E exophytic (≥50%/<50%/entirely endophytic), N nearness to sinus (≥7/>4–<7/≤4 mm), A anterior/posterior (descriptor), L polar-line location; total 4–6 low / 7–9 intermediate / 10–12 high; suffix `h` = hilar. **T-size cuts 4 / 7 / 10 cm.** CITE: [PMC7733781 (RENAL)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7733781/); [AJR AJCC-8 staging](https://ajronline.org/doi/full/10.2214/AJR.21.25493).
- Report fields (RadReport 50857): location, 3-D size, composition (solid/…/cystic %nonenhancing), Bosniak class, margins, per-phase HU, enhancement, RENAL, local extent (perirenal/sinus fat, collecting system, adrenal, Gerota), renal vein/IVC thrombus, nodes, TNM.

## Diffuse / mimic disease recognizers (each has a distinguishing probe)

### Focal pyelonephritis / abscess
- CT: **striated nephrogram** (linear alternating bands) + **wedge-shaped NON-mass hypo-enhancement**, perinephric stranding; abscess = **rim-enhancing fluid collection ± gas** (emphysematous PN = ~−1000 HU gas foci).
- DISTINGUISH: geographic, non-mass-forming, infectious/clinical context; resolves on follow-up. CITE: [PMC12374602](https://pmc.ncbi.nlm.nih.gov/articles/PMC12374602/).

### Renal infarct
- CT: **sharply demarcated wedge, non-enhancing**, base at capsule; **cortical rim sign** (~50%, thin preserved subcapsular enhancement, appears over hours–days).
- DISTINGUISH: wedge + sharp margins + rim sign, no mass effect (vs pyelonephritis's striations). Don't drop it from the kidney label. CITE: [NBK582139](https://www.ncbi.nlm.nih.gov/books/NBK582139/); [PMC11366376](https://pmc.ncbi.nlm.nih.gov/articles/PMC11366376/).

### Hydronephrosis / obstruction
- CT: **dilated water-attenuation collecting system** (calyces/pelvis), parenchymal thinning chronic; opacifies only on **excretory** phase.
- DISTINGUISH: the fluid **communicates and follows the ureter** (vs a central cystic mass); find the obstruction level. CITE: [NBK563217](https://www.ncbi.nlm.nih.gov/books/NBK563217/).

### ADPKD
- CT: **bilateral, innumerable cysts obliterating parenchyma**; TKV is the biomarker; hemorrhagic cysts **40–100 HU** (~90% have ≥1 hyperdense cyst).
- DISTINGUISH: bilateral symmetric cyst burden, no normal bean; the hard problem is finding a **superimposed enhancing solid nodule** (not just a hyperdense hemorrhagic cyst) → needs multiphase HU. CITE: [PMC7657046](https://pmc.ncbi.nlm.nih.gov/articles/PMC7657046/).

### Xanthogranulomatous pyelonephritis (XGP)
- CT: **enlarged non-functioning kidney + central staghorn calculus + "bear-paw" low-density calyceal replacement** (lipid-laden macrophages, not simple fluid), perinephric extension.
- DISTINGUISH: staghorn + bear-paw + non-function + infectious context = XGP, not necrotic tumor. CITE: [PMC6524550](https://pmc.ncbi.nlm.nih.gov/articles/PMC6524550/).

### Renal lymphoma / metastases
- CT: **multiple, often bilateral, homogeneous hypovascular masses**; or infiltration/nephromegaly; ± retroperitoneal adenopathy engulfing vessels.
- DISTINGUISH: **multiplicity + bilaterality + adenopathy + vessel encasement WITHOUT luminal narrowing** (patent vessel through tumor = lymphoma, unlike RCC invasion) + known primary. CITE: [PMC9375790](https://pmc.ncbi.nlm.nih.gov/articles/PMC9375790/).
