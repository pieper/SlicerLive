# Field survey: volumetric segmentation & quantification tools

> **Read as inventory, not as a plan.** The direction taken from this survey is in
> **[SEMANTIC-EDITOR.md](SEMANTIC-EDITOR.md)** — a knowledge-first editor where boundaries are derived
> from questions — *not* a port of the tools catalogued here. §7's "what users call critical" list is
> still the sharpest thing in this doc, and §8's "worth taking" list is superseded.

Status: **research only (2026-08-14). Nothing implemented.** Companion to
[SEGMENTATION-TOOLS-PLAN.md](SEGMENTATION-TOOLS-PLAN.md), which compares ITK-SNAP against the Slicer
Segment Editor in depth and owns the SlicerLive roadmap. That doc's base is narrow: two free research
applications of the same academic lineage. This one widens it to what people actually use — research
and industrial 3D suites, interactive-ML tools, clinical reading and radiotherapy systems,
browser-native viewers, and the current interactive-AI models — and asks a different question:
**which features do users report as critical or remarkably useful?**

## 1. Scope and method

Surveyed from vendor documentation, product manuals, peer-reviewed evaluations, and user-community
threads (sources at the end; every product claim below is linked there). Covered: tools whose job is
to turn a 3D/4D image into labeled regions and numbers. Not covered: pure viewers, pure
reconstruction, pathology/WSI-specific tooling, and the surgical-navigation stack except where it
carries a segmentation primitive worth borrowing.

Two caveats. First, "users report" for clinical systems means published evaluations, vendor case
material and forum discussion — not a survey we ran; treat the ranking in §7 as a considered reading
of that literature, not a measurement. Second, feature sets for commercial products move fast and
some details are version-specific.

---

## 2. Research and industrial 3D suites

**Materialise Mimics** (Innovation Suite; Mimics Medical is FDA-cleared for diagnostic use) — the
default in orthopedics, CMF, and patient-specific device/3D-print work. Segmentation tools worth
noting: **Region Growing** and **Dynamic Region Growing** (connectivity on gray value with a
deviation range plus a sensitivity control, aimed at vessels, nerves, airways); **Split Mask**
(separate two touching structures — the bone-in-a-joint case region growing cannot do); **Smart
Fill** (close gaps and cavities in a thin or perforated mask); **Smart Expand**. Above the tools sit
**anatomy-specific one-click modules** (CT Heart, Segment Airway, Segment Lung & Lobes). Downstream,
3-matic does remeshing for FEA and printing. Slicer forum users have specifically asked for the
anatomy-module concept.

**Amira / Avizo** (Thermo Fisher) — the Segmentation+ Workroom mixes interactive tools (brush, lasso,
**magic wand**, **blow tool**), semi-automatic ones (threshold, watershed, top-hat), **interpolation
between labeled slices**, and a **deep-learning module** (create/save/reuse models on VGG/ResNet
backbones) with **AI-assisted seed-based one-click selection**. Strengths that matter at scale:
large/out-of-core data and **Recipes** for batch replay of a segmentation procedure.

**Dragonfly** (ORS, now Comet; free for academic use) — its **Segmentation Wizard** is the most
interesting single feature in this group: paint features of interest on a limited subset of frames,
train *several* classical-ML and deep models, compare them, fine-tune the best, then export it for
repeat use. It is praised precisely because it demands no ML expertise and produces results that
don't drift with the operator.

**Simpleware ScanIP** (Synopsys) — segmentation whose purpose is meshing: remove disconnected
regions, holes and noise; split regions; close cavities; ML landmark-based anatomy tools; then
multi-part conforming volume meshes with contacts, boundary conditions and materials for FE/CFD.

**VGSTUDIO MAX** (Volume Graphics / Hexagon) — industrial CT rather than medical, but one idea
transfers directly: **subvoxel-precise surface determination**, tuned for multi-material,
high-dynamic-range data, treated as the headline product rather than a post-process — plus
porosity/inclusion/fiber quantification built on it.

Also in this family, less central to our purposes: **Imaris** and **arivis** (object wizards,
statistics tables, batch pipelines, for microscopy), **Analyze**, **MITK Workbench**, **Seg3D**.

---

## 3. Interactive-ML tools — "train while you annotate"

**ilastik** is the canonical implementation of the loop: scribble a few labels → features are
computed for the labeled pixels and a **random forest is trained** → the classifier predicts over the
current field of view and the result is **overlaid live**; feature caching makes every update after
the first fast. You then correct where it's wrong. It also shows an **uncertainty measure that steers
you to ambiguous regions**, and the recommended practice is explicitly "start with few annotations,
turn on live update, correct the classifier." Its **Carving** workflow (seeded) is interactive-only —
it is the one workflow that cannot be batched, which is itself a statement about where its value is.

**Trainable Weka Segmentation** and **Labkit** (Fiji) are the same idea, lighter.

**MONAI Label** is the deep-learning generation of it: a server offering click-guided models
(**DeepGrow**, **DeepEdit**), a **scribble/energy-based** method, and **active learning** that
fine-tunes online as labels arrive, with 3D Slicer, OHIF, QuPath and CVAT as clients. Reported
annotation-time reductions are 50–80 %.

---

## 4. Clinical systems

**syngo.via** (Siemens) — disease-specific guided workflows rather than a toolbox. **MM Oncology**
does automated lesion segmentation in lung, liver and lymph nodes with RECIST 1.0/1.1, WHO, Choi and
volume, and its follow-up path is the notable engineering: it automatically detects **44 stable
anatomical landmarks** in each thoraco-abdominal-pelvic CT, builds a patient-specific coordinate
system, cross-links baseline and follow-up (~19 s), and then navigates lesion-to-lesion in real time.
**syngo.CT Bone Reading** adds automatic rib and vertebra labeling with **rib unfolding** — the whole
rib cage presented as one curved 2D plane, generated unattended in about a minute per case, and
repeatedly reported as a real time-saver for trauma and metastasis reads.

**MIM Software** (now GE HealthCare) — **PET Edge** is the feature nuclear-medicine users name: a
gradient/edge-based lesion segmenter that follows the curvature of a lesion instead of producing the
voxel-stepped, jagged boundary of a fixed-SUV threshold, and is independent of the contrast setting.
Alongside it: the **VoxAlign** deformable registration engine for propagating contours across time
and modality, **Contour ProtégéAI+** auto-contouring that lands *inside* the editing workflow rather
than beside it, workflow automation, and contour QA / peer review.

**Radiotherapy planning systems** (RayStation, Eclipse, Monaco, Pinnacle, plus Velocity, Limbus,
MVision, Radformation) — the recurring primitives are a **smart brush that snaps to image features**,
**smart interpolation from a few contours**, and **between-slice interpolation**, which has been
studied directly: seeding a structure with the interpolation tool changes how clinicians contour and
raises agreement between the resulting contours. Note the data model — RT works in per-slice
**contours** (RTSTRUCT), not labelmaps, which is what makes push/pull contour editing natural there.

**Brainlab Elements SmartBrush** — outline the lesion on **two planes** and get a 3D object, across
modalities. Marketed and reported on reduced intra- and inter-observer variability, and extended from
cranial to spine planning. It is the highest-leverage sparse-input primitive in this survey.

**Philips IntelliSpace Portal / Canon Vitrea / TeraRecon** — automatic **bone removal**, vessel
**centerline extraction with lumen and wall contours and stenosis quantification**, multi-modality
tumor tracking. The valued capability is often one-click removal of the structure that is *in the
way*, not segmentation of the target.

**Quantification products** — **NeuroQuant** reports brain structure volumes as age- and sex-matched
**percentiles** against a 16 400-scan normative database, flagging below the 5th and above the 95th;
**icobrain** is comparable; service products like HeartFlow and Cleerly hide segmentation entirely.
The mask is invisible; the number against a reference is the product.

**OsiriX / Horos** — the **Repulsor**: drag a circle and the existing contour is pushed ahead of it.
A distinct editing primitive that neither Slicer nor ITK-SNAP has, used in published work
specifically to correct automatically generated contours.

---

## 5. Browser-native — SlicerLive's actual peer group

**Cornerstone3D / OHIF** is the serious competitor. It carries **labelmap *and* contour
representations** behind one panel, brush, circle/rectangle/**sphere scissors**, a **livewire**
contour tool that snaps to borders, a **dynamic-threshold ROI**, and — most relevant — a
**"sculptor" brush whose radius automatically adapts to the region border**: place it inside the
region to expand, outside to erase. That is the repulsor idea rebuilt for the web.

**NiiVue** (WebGL2) has a pen with outline and flood-filled modes, a **magic wand**, and **GPU Grow
Cut ported from 3D Slicer**, with WebGL used to accelerate the drawing operations and reslicing. It
is the closest existing thing to SlicerLive's GPU-editing claim.

**Annotation platforms** (RedBrick AI, Encord, V7) converge on the same feature set: **SAM/SAM2-
assisted masks**, **mask propagation across a slice range**, interpolation that lets an annotator
label roughly 30 of 100 slices, **consensus scoring and multi-stage review**, versioning, and DICOM
SEG export. Their differentiator is not the tools but the *process* around them.

---

## 6. Interactive AI models

nnInteractive (fast, point/scribble/lasso prompts; now shipped inside ITK-SNAP 4.4 over a remote
GPU), SAM-Med3D, VISTA3D, SegVol, MedSAM/MedSAM2, ENSAM — plus TotalSegmentator and nnU-Net on the
unattended side. Recent comparisons put nnInteractive at a favourable accuracy/latency point, with
VISTA3D and SAM-Med3D stronger on 3D CT but noticeably heavier in compute and memory. Every one of
these is deployed server-side in every product surveyed here. SlicerLive's nnLive is the exception.

---

## 7. What users call critical — the cross-cutting list

Ranked by how consistently it shows up as the thing people say they cannot work without:

1. **Fixing an existing contour beats drawing one.** The repulsor (OsiriX), the sculptor brush
   (Cornerstone3D), Split Mask and Smart Fill (Mimics), the feature-snapping smart brush (RayStation),
   auto-contouring delivered *into* the edit loop (MIM). Once auto-segmentation is decent, the edit
   loop is the product.
2. **Sparse input → dense result.** Two-plane SmartBrush, between-slice interpolation, mask
   propagation over a slice range, ITK-SNAP's Interpolate Labels. Consistently the largest measured
   time saving in manual work.
3. **A live-retraining loop with visible uncertainty.** ilastik, the Dragonfly Segmentation Wizard,
   Amira's AI-assisted selection. What makes ilastik beloved is not the random forest — it is that
   you see the prediction change as you scribble, and it tells you where it is unsure.
4. **Anatomy-specific one-click starts.** Mimics' CT Heart / Airway / Lung & Lobes, syngo.via's
   disease workflows, TotalSegmentator. Users want a *named structure*, not a general algorithm.
5. **Longitudinal propagation.** syngo.via's landmark cross-linking, MIM's VoxAlign, Velocity. A
   segmentation is rarely an artifact of one scan.
6. **Domain-tuned boundary definition.** PET Edge for PET, subvoxel surface determination for CT
   metrology, auto bone removal and centerlines for CTA. A generic segmenter loses to one that knows
   the modality's failure mode.
7. **The number, not the mask.** RECIST/PERCIST criteria, normative percentiles.
8. **Presentation transforms.** Rib unfolding, curved MPR, vessel straightening — segmentation used
   to make anatomy *readable*, which is often where its clinical value is realized.
9. **Batch, reproducibility, QA.** Recipes, Workflows, macros, contour evaluation, consensus review.
10. **Trust.** FDA clearance for clinical use; free-for-academic licensing for research adoption.

Worth stating plainly: **items 5–8 are not segmentation effects.** The thing clinical users most
often call critical is rarely a new brush.

---

## 8. Implications for SlicerLive

**Already ours.** GPU grow-cut (NiiVue is the only other browser implementation, and it is a port of
Slicer's); a live SDF surface that updates per edit; an op-stream that yields provenance and replay
for free; client-side interactive AI via nnLive; an agent that can drive the same op stream.

**Worth taking (editing engine).** Four primitives, added to the roadmap in
[SEGMENTATION-TOOLS-PLAN.md](SEGMENTATION-TOOLS-PLAN.md) §4.4 — repulsor/push editing, the
border-adaptive sculptor brush, two-plane outline → 3D plus range propagation, and a live-retraining
scribble classifier. Each is unusually cheap for us because the JFA distance field is already
resident: the repulsor is level-set advection, the sculptor brush reads its radius straight out of
the SDF, and two-plane interpolation is the same shape-based interpolation as fill-between-slices.
Also worth taking into the flood/CCL group: magic-wand / dynamic region growing with a live
sensitivity control, Split Mask, Smart Fill.

**Deliberately not ours, for now** (decision recorded here so it stays visible): quantification
against a normative reference, longitudinal registration and lesion tracking, structured reporting,
presentation transforms like rib unfolding, and regulatory clearance. Items 5–8 above are real, and
they are where clinical value concentrates — but SlicerLive is scoped to the editing engine, and each
of them is a program of work in its own right.

---

## Sources

Research/industrial: [Mimics Core](https://www.materialise.com/en/healthcare/mimics/mimics-core) ·
[Dynamic Region Growing](https://www.materialise.com/en/academy/healthcare/mimics-innovation-suite/video-tutorials/dynamic-region-growing) ·
[Split Mask](https://www.materialise.com/en/academy/healthcare/mimics-innovation-suite/video-tutorials/split-mask) ·
[Mimics segmentation tips](https://www.materialise.com/en/inspiration/articles/5-tips-medical-image-segmentation) ·
[Amira/Avizo Segmentation Workroom](https://www.thermofisher.com/us/en/home/electron-microscopy/products/software-em-3d-vis/3d-visualization-analysis-software/segmentation-workroom.html) ·
[Amira segmentation + deep learning](https://documents.thermofisher.com/TFS-Assets/MSD/Flyers/amira-software-segmentation-editor-deep-learning-en-fl0189.pdf) ·
[Dragonfly Segmentation Wizard](https://theobjects.com/dragonfly/dfhelp/Content/Artificial%20Intelligence/Segmentation%20Wizard/Segmentation%20Wizard.htm) ·
[Dragonfly review](https://rigaku.com/products/imaging-ndt/x-ray-ct/learning/blog/ct-analysis-software-review-dragonfly) ·
[Simpleware image processing](https://www.synopsys.com/simpleware/software/image-processing.html) ·
[VGSTUDIO MAX](https://volumegraphics.hexagon.com/en/products/vgstudio-max.html).

Interactive ML: [ilastik pixel classification](https://www.ilastik.org/documentation/pixelclassification/pixelclassification) ·
[ilastik paper](https://ilastik.github.io/documentation/sommer_11_ilastik.pdf) ·
[MONAI Label](https://monai.io/label.html) · [MONAI Label paper](https://arxiv.org/pdf/2203.12362).

Clinical: [syngo.via](https://www.siemens-healthineers.com/en-us/molecular-imaging/pet-ct/syngo-via) ·
[landmark-based lesion tracking evaluation](https://pmc.ncbi.nlm.nih.gov/articles/PMC4212533/) ·
[CT Bone Reading / rib unfolding](https://academy.siemens-healthineers.com/en-us/syngovia-vb10-ct-bone-reading-e-clip/) ·
[Bone Reading reader study](https://pmc.ncbi.nlm.nih.gov/articles/PMC5605069/) ·
[MIM Maestro](https://www.mimsoftware.com/radiation-oncology/mim-maestro) ·
[Contour ProtégéAI+](https://www.mimsoftware.com/radiation-oncology/contour-protegeai-plus) ·
[PET segmentation algorithm evaluation](https://jnm.snmjournals.org/content/62/supplement_1/1402) ·
[RayStation contouring](https://www.raysearchlabs.com/contouring-organs-at-risk_raystation/) ·
[automated contouring review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9955359/) ·
[Brainlab Elements cranial planning](https://www.brainlab.com/surgery-products/overview-neurosurgery-products/cranial-planning/) ·
[IntelliSpace Portal 12 datasheet](https://cms.v-liveexperience.com/production/wp-content/uploads/2021/04/2020-11-Portal-12-clinical-datasheet.pdf) ·
[TeraRecon](https://www.terarecon.com/terarecon-advanced-visualization) ·
[NeuroQuant normative database](https://www.cortechs.ai/whitepaper-normative-database/) ·
[OsiriX ROI functions / repulsor](https://osirixpluginbasics.wordpress.com/2011/07/25/common-roi-functions/) ·
[BEAS + repulsor correction](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0274491).

Browser: [Cornerstone3D segmentation tools](https://www.cornerstonejs.org/docs/concepts/cornerstone-tools/segmentation/) ·
[Cornerstone3D new segmentation tools](https://radicalimaging.com/post/cornerstone3d-and-cornerstone3dtools-5-new-segmentation-tools) ·
[OHIF 3.9 release notes](https://ohif.org/release-notes/3p9/) ·
[NiiVue drawing & segmentation](https://niivue.com/docs/drawing/) ·
[Encord DICOM](https://encord.com/dicom/) ·
[V7 medical imaging](https://www.v7darwin.com/medical-imaging-annotation).

AI models: [VISTA3D (CVPR 2025)](https://openaccess.thecvf.com/content/CVPR2025/papers/He_VISTA3D_A_Unified_Segmentation_Foundation_Model_For_3D_Medical_Imaging_CVPR_2025_paper.pdf) ·
[ENSAM + interactive-model comparison](https://arxiv.org/html/2509.15874v1) ·
[SAM2-3dMed](https://arxiv.org/pdf/2510.08967).

Community: [Slicer forum — Mimics-style pipelines](https://discourse.slicer.org/t/can-we-build-some-advanced-tools-for-automatic-pipline-like-mimics/16589) ·
[Slicer forum — Amira-like segmentation](https://discourse.slicer.org/t/amira-like-segmentation-add-to-segment-functionality/26032) ·
[Slicer forum — magic wand equivalent](https://discourse.slicer.org/t/how-can-i-approximate-the-magic-wand-tool-in-avizo-amira/29611).
