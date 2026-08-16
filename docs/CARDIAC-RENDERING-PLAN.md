# Cardiac rendering in SlicerLive — replicating the CHOP/SlicerHeart papers

Plan for reproducing the rendering options described in two Jolley-lab papers, in the
SlicerLive WebGPU renderer, and standing up a new live-gallery example on comparable
public data.

Source papers:

1. **Cianciulli AR, Sulentic A, Wang Y, Daemer M, Amin S, Joyce J, Lasso A, Otero HJ,
   Cohen MS, Fuller S, Nuri MAK, Tang J, O'Byrne ML, Jolley MA.**
   *Volume Rendering of CT Images to Inform Closure of Complex Ventricular Septal Defects.*
   JACC: Case Reports 2025. doi:10.1016/j.jaccas.2024.102827 — open access, PMC12011141.
2. **Iacovella J, Vaiyani D, Pressley S, Lasso A, Jolley MA, et al.**
   *Rapid Visualization of Valves and Myocardium Using Volume Rendering of 3D Cardiac MRI,
   4D Cine, and 4D Flow Images.* Radiology: Cardiothoracic Imaging, 12 Feb 2026.
   doi:10.1148/ryct.250129 — paywalled; technical content below reconstructed from the
   abstract, the RSNA and CHOP press releases, and the SlicerHeart source.

Both are VTK-via-3D-Slicer work (Slicer core `VolumeRendering` + SlicerHeart), so the
rendering model — piecewise-linear scalar transfer functions, gradient-shaded front-to-back
GPU raycasting — is the same model SlicerLive's `ImageField` already implements. Most of
this transfers directly.

---

## 1. What the papers actually render

### Paper 1 (CT / VSD closure)

The central trick is **transfer-function inversion**: rather than the usual angiographic
preset that makes the contrast-filled blood pool opaque, they use a transfer function that
"visualized the myocardial tissue rather than contrast-containing blood." The camera then
sits *inside* the blood pool and looks at the endocardial surface — you see RV
trabeculations, the septal defect orifices, and the tissue rims directly, with no
segmentation step. Reported: usable render in under 1 second, tuned render in under a
minute, versus ~2 hours for manual segmentation of the same anatomy.

This preset already exists in SlicerHeart as **`CT-EndoVascular`**
(`ValveAnnulusAnalysis/Resources/VrPresets/US-VrPresets.mrml`). Its scalar opacity is the
tell:

```
-3024 → 0      (air)
-140  → 0
  95  → 0.286  ┐
 179  → 0.554  ├ myocardium ramps up
 260  → 0.848  │
 290  → 0.871  ┘
 338  → 0      ← contrast-opacified blood becomes INVISIBLE above ~340 HU
2784  → 0
2930  → 0.9    (bone/metal returns)
```

That drop to zero at 338 HU is what lets you fly through the blood pool. Everything else
in the paper's workflow is on top of that render:

| Feature | Slicer/SlicerHeart source |
|---|---|
| Myocardium-selective CTA transfer function | `CT-EndoVascular` VR preset |
| Interior ("endovascular") camera | Slicer 3D view with camera inside the volume |
| Interactive clipping / cropping to isolate a chamber | VolumeRendering ROI crop |
| Virtual patch, sized for intraoperative cutting | SlicerHeart `BafflePlanner` |
| Virtual occluder device placement/sizing | SlicerHeart `CardiacDeviceSimulator` / `AsdVsdDeviceSimulator` |
| Multidisciplinary immersive review | SlicerVR |

Three cases, all muscular VSDs obscured by RV trabeculation: 2-month-old (6 mm apical),
14-month-old (12 mm posterior + two 3 mm apical), 27-month-old (7.4 mm apical, closed
transcatheter with an Amplatzer Muscular VSD occluder).

### Paper 2 (MRI / valves, myocardium, flow)

Same inversion idea carried to MR, plus time and flow. Per Jolley in the RSNA release:
*"We developed specific settings that make heart muscle and heart valves visible while
making blood and surrounding tissues transparent."*

Three input types, four pediatric patients (April 2023 – January 2025), including a
4-year-old with aortic insufficiency and a 5-year-old with neoaortic insufficiency:

- **3D cardiac MRI** (whole-heart, ferumoxytol-enhanced) — static DVR of myocardium and
  valve leaflets.
- **4D cine** — the same DVR played back over the cardiac cycle, showing leaflet motion,
  coaptation, and prolapse.
- **4D flow** — three new flow depictions: dense **streamlines** for direction,
  **Doppler-like color coding** (toward/away, i.e. a diverging red/blue map on the
  velocity component), and **velocity encoded relative to the annular plane** — which is
  what makes a regurgitant jet through a specific valve legible.

The headline claim is speed: 3D/4D visualization in under 1 second, refinement under 3
minutes. Tissue rendering and flow rendering are composited in the *same* view so valve
dynamics and the resulting jet are seen together.

---

## 2. Mapping onto the SlicerLive renderer

SlicerLive has no rasterization at all. Every 3D pipeline is a fullscreen triangle whose
fragment shader ray-marches, and all content is a **Field** — a WGSL-composable object
emitting `sample_field_<kind><slot>(wp, rd) -> vec4` in premultiplied color. The renderer
sums all fields per sample and does one front-to-back OVER
([render/scene-renderer.ts:647](render/scene-renderer.ts#L647)). Adding a visual means
writing a Field, not adding to a scene graph.

### Already present — reuse unchanged

| Need | Where |
|---|---|
| Piecewise-linear color + scalar opacity TF → 256×1 rgba8 LUT | [render/scene-volume.ts:25-55](render/scene-volume.ts#L25-L55) (`interpTF`, `lutFromTransferFunctions`) |
| Live TF edit without bind-group churn | [render/fields.ts:114](render/fields.ts#L114) (`setLUT` rewrites in place) |
| Step-size opacity correction (`1-pow(1-a, step/unit)`) | [render/fields.ts:175](render/fields.ts#L175) |
| Gradient-based Blinn/Phong headlight, per-field ka/kd/ks/shininess | [render/fields.ts:177-198](render/fields.ts#L177-L198) |
| Front-to-back composite, per-sample jitter, early termination at α≥0.99 | [render/scene-renderer.ts:599-664](render/scene-renderer.ts#L599-L664) |
| Up to 8 arbitrary clip planes + axis-aligned crop box, per-field opt-out | [render/scene-renderer.ts:719-733](render/scene-renderer.ts#L719-L733) |
| Interactive ROI crop widget | [render/roi-box-field.ts](render/roi-box-field.ts), [render/demos/roi-widget.ts:40](render/demos/roi-widget.ts#L40) |
| Multiple volumes with independent TFs in one pass | [render/demos/selftest-scenes.ts:89](render/demos/selftest-scenes.ts#L89) |
| Pre-colored RGBA volume rendering | `RGBAVolumeField`, [render/fields.ts:547-644](render/fields.ts#L547-L644) |
| Line/tube primitives (256 capsules per field) | [render/capsule-field.ts:28](render/capsule-field.ts#L28) |
| Temporal-AA accumulation + adaptive low-res while moving | [render/scene-renderer.ts:356](render/scene-renderer.ts#L356), [render/demos/accum-loop.ts](render/demos/accum-loop.ts) |
| Slicer-faithful camera, MPR planes, crosshairs, radiological convention | [render/vtk-camera.ts](render/vtk-camera.ts), [render/slice-renderer.ts:82-95](render/slice-renderer.ts#L82-L95), [render/demos/crosshair.ts](render/demos/crosshair.ts) |
| Empty-space skipping framework | [docs/RENDER-PERFORMANCE.md](docs/RENDER-PERFORMANCE.md) |

### Important negative finding: gradient opacity is not needed

A first read of the gap list flags "gradient-magnitude opacity is parsed but never used"
as a fidelity risk. It is not, for this work. Checking every preset in Slicer's
`presets.xml`, **every** cardiac-relevant preset — `CT-Cardiac`, `CT-Cardiac2`,
`CT-Cardiac3`, `CT-Coronary-Arteries-1/2/3`, `CT-Chest-Contrast-Enhanced`, `MR-Default`,
`MR-Angio` — plus SlicerHeart's `CT-EndoVascular` and all eight US presets, carries a
**flat** `gradientOpacity="4 0 1 255 1"`, i.e. a constant 1.0 no-op. Only `CT-Bones`,
`CT-Fat`, `CT-Lung`, `MR-T2-Brain`, `DTI-FA-Brain`, `US-Fetal`, and the µCT presets use a
real gradient curve, and none of those are in play here.

So the cardiac presets port to the existing scalar-only LUT machinery **byte-for-byte**.
Gradient opacity is a later nicety, not a blocker. This is the single biggest de-risking
fact in this plan.

### Must be built

| Gap | Effort | Notes |
|---|---|---|
| **VR preset table in TS** | Small | Transcribe `CT-EndoVascular`, `CT-Cardiac3`, `CT-Coronary-Arteries-3`, `CT-Chest-Contrast-Enhanced`, `MR-Default`, `MR-Angio` into a TS table feeding `lutFromTransferFunctions`. Home: `render/scene-volume.ts`. Today presets only arrive via a Slicer-exported scene. |
| **Camera inside the volume** | Small, must verify | `fs_trace` computes scene-AABB entry/exit; needs `tmin` clamped to 0 when the eye is inside, and the camera controller must allow dollying past the surface. Verify before assuming. |
| **4D cine** | Medium | Greenfield — no 4th dimension exists anywhere (`ZarrDesc.shape` is fixed `[nz,ny,nx]`). **Designed in full in [docs/SEQUENCES-CINE.md](docs/SEQUENCES-CINE.md)**: mirror Slicer's Sequences model (sequence node + browser + proxy), keep all frames resident as separate r16float 3D textures with pre-built per-frame bind groups (measured zero per-frame cost), and drive playback through the existing `kick()`/moving tier. Verified to work unmodified through `SceneRenderer.refreshBindings()`. |
| **Doppler-style flow color** | Small — free, actually | Bake velocity to an rgba16float volume with a diverging map and render it as an existing `RGBAVolumeField` alongside the tissue `ImageField`. The sum-then-OVER compositor gives tissue+flow in one view for nothing. |
| **Dense streamlines** | Medium | Integrate seeds on CPU/compute, then draw as chained `CapsuleField`s (256 segments/field, multiple fields allowed) — or write a dedicated field if seed counts get large. |
| **Velocity relative to annular plane** | Small once flow exists | Project velocity onto a user-placed plane normal; the plane can be authored with the existing markups/gizmo. |
| **Slice planes inside the 3D view** | Medium | Not supported; the most obviously missing piece for cardiac scenes ("2-chamber view + DVR"). New Field sampling a thin slab. |
| **Virtual patch / device geometry** | Large | No mesh rendering exists anywhere. Defer past the first gallery example; an SDF or capsule-outline stand-in is the cheap version. |
| **MIP / MinIP modes** | Medium | Not needed for these papers. |
| **Occupancy grid for dense volumes** | Medium | The documented next perf step; matters at 512³ cardiac CT. |
| **AO / shadows / cinematic** | Large | No infrastructure. `renderAccum` is the natural place to hang stochastic secondary rays. Neither paper needs it. |

---

## 3. Data

All links below were verified reachable. SlicerLive's browser has **no NRRD or NIfTI
reader** — everything streams as OME-Zarr, so each dataset needs a conversion pass
modeled on [examples/spine/worker/zarr_worker.py](examples/spine/worker/zarr_worker.py).

### Tier 1 — immediate, no registration, tiny

**`CTACardio`** — adult cardiac CTA, 64 MB NRRD, already the repo's standard test volume.
`https://github.com/Slicer/SlicerTestingData/releases/download/SHA256/3b0d4eb1a7d8ebb0c5a89cc0504640f76a030b4e869e33ff34c564c3d3b88ad2`
Right data for bringing up the `CT-EndoVascular` preset and the interior camera on day one.

**`CTCardioSeq`** — **a real 4D cardiac CT cine**, 13 MB.
`https://github.com/Slicer/SlicerDataStore/releases/download/SHA256/d1a1119969acead6c39c7c3ec69223fa2957edc561bc5bf384a203e2284dbc93`
Header confirmed by download: NRRD0005, `dimension: 4`, `sizes: 10 128 104 72`
(10 cardiac phases × 128×104×72), `kinds: list domain domain domain`, RAS space,
1.15 × 1.15 × 2.0 mm. This is the cheapest possible way to build and test the cine path —
10 frames at 128³-ish fits comfortably in one texture array. Also `CTPCardioSeq` (CT
perfusion cardiac sequence) from the same store.

### Tier 2 — the gallery centerpiece

**HVSMR-2.0** — 60 cardiovascular MR scans in **congenital heart disease**, from Boston
Children's. This is the closest public match to paper 2's 3D cardiac MRI.

- figshare: `10.6084/m9.figshare.c.7074755.v2` — collection article 25226360 ("orig"),
  `orig.zip`, 1.78 GB, direct download, **no registration**
- **CC BY 4.0**, IRB-approved for open release
- NIfTI `.nii.gz`, near-isotropic 0.73 × 0.73 × 0.81 mm (range 0.52–1.15 in plane)
- SSFP with prospective ECG gating; gadolinium (Ablavar or Gadovist) in many subjects —
  the paper used ferumoxytol, but the resulting contrast behavior is close enough that
  the same TF shape applies
- Ground-truth labels for 8 structures (LV, RV, LA, RA, AO, PA, SVC, IVC), which gives the
  example an optional `SegmentField` overlay and a way to validate that the DVR preset is
  showing the myocardium it claims to
- Paper: Pace et al., Sci Data 2024, doi:10.1038/s41597-024-03469-9, PMC11219801

### Tier 3 — closer anatomy match, requires a request form

- **ImageCHD** — 110 3D CTs spanning 16 CHD types **including VSD**, with 7-substructure
  segmentation. The closest public analogue to paper 1.
  `github.com/XiaoweiXu/ImageCHD-A-3D-Computed-Tomography-Image-Dataset-for-Classification-of-Congenital-Heart-Disease`
- **MM-WHS** — 20 CT + 20 MR training whole-heart, `zmiclab.github.io/zxh/0/mmwhs`.
  Signed form, mostly normal-variant adult anatomy.

### 4D flow — the real gap

There is no good open **cardiac** 4D flow dataset. What exists:

- Zenodo 4882572 — 4D flow at 0.5/1/1.5 mm isotropic, CC BY 4.0, 2.2 GB, directly
  downloadable, with explicit x/y/z velocity components in cm/s. But it is **phantom**
  data (silicone tubes and a carotid aneurysm model), not a heart.
- CMRxRecon2026 challenge — 200+ cases with stenosis, regurgitation, aneurysm,
  coarctation, dissection. Requires challenge registration; the Zenodo record
  (15087777) is only the announcement PDF.
- Note IDC is not an option — it is a cancer archive and has zero cardiac collections
  (checked all 176).

Recommendation: build and demonstrate the flow rendering on the Zenodo phantom (whose
geometry is at least vascular and whose velocities are honestly encoded), or on a
synthetic analytic swirl field, and treat real cardiac 4D flow as a follow-on once a
dataset is obtainable. Do not block the gallery example on it.

---

## 4. Milestones

**M0 — preset table.** Transcribe the six Slicer/SlicerHeart presets above into TS beside
`lutFromTransferFunctions`. Validate against `CTACardio` with a headless
`renderToRGBA` → PNG regression in `render/test/`, comparing to a Slicer screenshot of the
same preset and camera. Cheap, and it is the foundation for everything else.

**M1 — the endovascular look.** `CT-EndoVascular` on `CTACardio`; confirm the raymarcher
behaves with the eye inside the AABB; add camera dollying into a chamber. Deliverable: a
fly-through of the blood pool showing endocardial surface. This alone reproduces the core
of paper 1.

**M2 — cine, modeled on Slicer Sequences.** Mirror `vtkMRMLSequenceNode` /
`vtkMRMLSequenceBrowserNode` (as `sequence` / `sequenceBrowser` mrson node types), add a
`CineImageField` holding all frames resident as r16float 3D textures with pre-built
per-frame bind groups, and drive playback through the existing `kick()`/moving tier with a
scrub timeline lifted from the recorder UI. Test on `CTCardioSeq` (10 frames, 13 MB, and
note it needs the legacy interleaved-frame loader path). Full design, measurements, and
work items: **[docs/SEQUENCES-CINE.md](docs/SEQUENCES-CINE.md)**.

**M3 — MR whole-heart gallery example.** HVSMR-2.0 → zarr via a worker modeled on the
spine pipeline → public bucket. Build `examples/cardiac/` on the established three-file
pattern (`cardiac-scene.ts` / `cardiac-browser.ts` / `cardiac.html`), 4-up with linked
crosshair, a preset picker, ROI crop, and an optional 8-structure `SegmentField` overlay.
Add to `/Users/pieper/slicer/live/scenes/index.json` with a thumbnail. **This is the
shippable gallery deliverable** and it does not depend on M4/M5.

**M4 — flow, color first.** Velocity → rgba16float → `RGBAVolumeField` composited with the
tissue `ImageField` in the same pass. Diverging Doppler map; plane-relative velocity once a
plane can be placed. On phantom or synthetic data.

**M5 — streamlines.** Seed and integrate, render as chained capsules. Then, only if the
paper-1 workflow is wanted end to end, virtual patch/device geometry — which needs a mesh
or SDF story that does not exist yet, and should be scoped separately.

Sequence rationale: M0–M2 are all on 77 MB of data that downloads in seconds and need no
new data pipeline, so they can be done and regression-tested before any bucket work. M3 is
where the effort goes. M4–M5 are genuinely new rendering and should not gate the example.
