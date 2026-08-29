# Native port — status log

The plan: `~/.claude/plans/consider-the-corpus-of-glistening-teacup.md` (2026-08-29) — the ModuleServer is
backwards compatibility only; traditional Slicer behaviors are ported natively into SlicerLive, workflow by
workflow (W1 load data/DICOM → W2 layouts + view controllers → W3 volumes & W/L → W4 markups → W5 segment
editor → W6 transforms + models → W7 save/export), each landing with unit/gpu/browser/parity/self tests
(`docs/HARNESS.md`). Core policy from the VTK/ITK/Python census: TS + WGSL only; wasm confined to DICOM pixel
codecs; ITK-heavy CLIs, pytorch, VMTK stay behind the ModuleServer seam.

## M0 — test spine + app shell (2026-08-29) — DONE

- `deno run -A test/run.ts [--gpu|--browser|--parity|--all]` is the single entry point (tiers by file name;
  hermetic default; `.github/workflows/test.yml` runs the unit tier + scoped lint/check on every push).
- `harness/slicer.ts` (MCP), `harness/cdp.ts` (the one CDP client; cache-proof `openTab`), `harness/ready.ts`
  (settle detection), `render/selftest.ts` + `window.__slicerlive.{frameCount,idle,selfTest}`.
- Parity oracle `test/oracle.ts` with the 20 baseline rows as JSON (`harness/fixtures/parity/baseline.json`,
  class-based node aliases), scene builder `harness/parity/setup.ts` — **21/21 rows pass** against the Qt6
  headless Slicer. Golden helper `test/golden.ts`; first `*.gpu.test.ts`; browser smoke test.
- `harness/capture-fixtures.ts` checked in (the fixture capture HARNESS.md used to point at git history for);
  it needs a GL-capable Slicer — the offscreen ModuleServer crashes when its 3D interactor renders.
- **Native app shell** `render/demos/app-shell.ts` + `render/demos/theme.css`: dark theme, Slicer's
  Red/Yellow/Green view colours, logo-palette accents, module selector + panel registry, toolbar, status,
  resizable sidebar; `slicer-app.html` defaults to it (FourUp over the view area until W2's layout engine);
  `?legacy` keeps the streamed stock-Slicer chrome. Theme self-tests (WCAG AA contrast, view colours).
- Fixed on the way: the segmentation serializer leaked temp labelmap nodes on failure; 12 lint findings.

## W1 — load data / DICOM — IN PROGRESS (2026-08-29)

Done: `logic/readers/nifti.ts` (NIfTI-1/2: sform > qform > pixdim, gz, big-endian; no LPS flip — NIfTI is RAS),
`logic/readers/registry.ts` (sniff + `readVolume` for NRRD/NIfTI), `logic/ingest.ts` (volume → content-addressed
zarr chunks with Slicer's exact chunk rule and `sha256-` names, an in-memory blob store chained into
`setBlobFetch`, `loadVolumeIntoScene` = `image` + display + slice composites), `logic/sample-data.ts` (Slicer's
catalog + SHA-256 verification; mirrored in the CORS-enabled bucket at `slicerlive/sampledata/` because GitHub
release assets carry no CORS headers), the **Data panel** (open file(s), drag-and-drop on the views, Sample
Data with progress). Tests: unit (NIfTI geometry/order, sniffing, chunk rule + round trip through the production
zarr loader, checksum), browser (bytes → image node + composites), self-test (synthetic NIfTI in-page), **parity:
native MRHead == Slicer MRHead — dims, ijkToRAS ≤1e-4, voxel sum exact**.
DICOM (local): `logic/readers/dicom-series.ts` — a PURE reconstructor (subseries split by orientation, sort
by IPP·normal, ijkToRAS from IOP/IPP/PixelSpacing with LPS→RAS, per-slice rescale; ported from the IDC worker so
a local and an IDC series reconstruct identically) + a dcmjs parse step (lazy-loaded from a CDN in the browser);
`logic/readers/dicom-local.ts` indexes a granted folder or dropped files into series and loads a chosen one.
Data panel gained Open DICOM folder/files + a series list. Tests: 6 unit (geometry, sorting, per-slice rescale,
single-slice thickness, subseries split) with NO dcmjs, and a browser test that synthesizes a 5-slice CT with
dcmjs in the page and verifies dims + ijkToRAS. Verified visually: a synthetic CT sphere loads and renders in 3D.

Open: DICOMweb (QIDO/WADO-RS), the minimal FSA-project study browser behind `Project/StudyIndex/SeriesSource`
(reconcile with SlicerRad later), DICOM SEG read (with W7), fitting a newly loaded volume to the views (W2),
NRRD keeps its native dtype (the reader expands to f32 today), `.nrrd.gz`.

## W2 — layouts + view controllers — STARTED (2026-08-29)

Foundation (pure logic, tested): `logic/slice-logic.ts` — `fitFovToVolume` (vtkMRMLSliceLogic::FitSliceToVolumes:
fit to the smaller window dimension) **validated to ≤0.5 mm against the live-Slicer MRHead fixture in all three
orientations**, and `offsetRangeResolution` (slider range + step). `logic/layouts.ts` — Slicer's layout catalog by
`vtkMRMLLayoutNode` id (Conventional 2, FourUp 3, OneUp3D 4, OneUpRed/Yellow/Green 6/7/8, Dual3D 15,
ThreeOverThree 21, TwoOverTwo 29) as fractional cells; unit test proves every arrangement tiles the area with no
overlaps. `mountLiveViews` gained `fitVolume(rasLo,rasHi,ijkToRAS)` (used on a native load; the mirrored-plane
path still wins when a Slicer peer streams a frame).

Open: native `sliceView` nodes so locally loaded volumes own their slice frames (the local-vs-peer frame
ownership), slice/3D controller bars (offset slider, orientation combo, link/hot-link, fg opacity, fit, reset),
the layout picker in the shell, slice intersection lines, `setLayout` cmd + `cellsFor` wired into `setCells`.

View interactions **reuse the existing DRY primitives** (checked, not reinvented): `mountLiveViews` already
reused `attachSliceControls` (wheel/drag/pan/zoom) and `CameraInteractor` (3D orbit); added double-click
**maximize/restore** via the demos' `attachDoubleClick`, and made SHIFT+move **jump the other slice cells
natively** (the crosshair jump that previously only reached the Slicer peer). CDP client gained `key`/`withKey`
so modifier-gated interactions are testable. Browser tests: maximize 4→1→4, and SHIFT+move jumps the other views.

**Layout picker** (toolbar): Slicer's catalog (`logic/layouts.ts`) drives the view cells via `setCells` —
verified switching OneUpRed→Conventional→FourUp. Double-click maximize and SHIFT+move crosshair are wired and
tested. `mountLiveViews` exposes `__cellPlanes`/`__jumpTo` for tests; a `jumpLocal` native crosshair-jump is in
place but only sticks once slice planes are node-owned (see below).

**Native sliceView nodes (done)**: standalone (peerless) scenes now create `view`/slice nodes (Red=Axial,
Yellow=Sagittal, Green=Coronal) with a `sliceToRAS` + fitted `fieldOfView` when a volume loads, so the same
`SliceDisplayableManager.setSlicePlane` path a peer uses now drives locally loaded volumes — **standalone
renders**, and the crosshair jump / offset **persist** because the node owns the plane (`jumpLocal` patches the
node's `sliceToRAS` translation). Verified: a synthetic volume renders in all three slice views, and a jump lands
each cell's offset exactly (axial→S, coronal→A, sagittal→R). When a Slicer peer is connected its `view` nodes own
the planes (native ones are not created).

**Slice controller bars (done)**: `render/demos/slice-controller.ts` — the coloured bar Slicer shows above each
slice view (orientation, offset slider with mm range/step, fit button), plain DOM in the theme, driven by a pure
adapter so it works over native sliceView nodes and a peer's slice nodes alike. `mountLiveViews` exposes
`getSliceOffset`/`setSliceOffset`/`sliceOffsetRange`/`fitCell`; the bar re-reads after any slice render.
Verified: bars per cell (Red=Axial, Yellow=Sagittal, Green=Coronal), and the slider drives the plane to its
value. The redundant corner cell-name label is hidden (the bar shows orientation).

**Slice intersection lines (done)**: each slice view draws the other slice planes as coloured localizer lines
(two-plane intersection projected into the view), matching Slicer's crosshair localizers — yellow/green in the
axial view, etc. `mountLiveViews.sliceIntersectionLines(cell)` returns the line endpoints for tests;
`setSliceIntersections(on)` toggles. Browser test asserts the sagittal localizer is vertical and the coronal
horizontal in the axial view.

**3D controller bar (done)**: look-from buttons (R/A/S/L/P/I) reset the camera to standard anatomical views
(camera on the axis toward the volume centre, correct viewUp) + an orthographic toggle. `mountLiveViews`
exposes `resetCamera3D`/`setOrthographic`/`isOrthographic`. Browser test (standalone) asserts A→anterior camera,
S→superior, and orthographic on/off.

W2 slice + 3D view controllers are now substantially complete and native (layout picker, slice controller bars,
maximize, crosshair jump, intersection localizers, 3D standard views + orthographic), all tested.

Next: W2 tail — orientation combo (reformat), link/hot-link across slice views; then **W3 volumes & window/level**
(auto W/L histogram, W/L drag, presets, threshold, colour tables, TF editor — reusing the plan's histogram/W-L
kernels) — minimal DICOM module behind `Project/StudyIndex/SeriesSource` interfaces
(Steve's SlicerRad folder browser to be reconciled when that code is available).

## W3 — Volumes & window/level (in progress)

**Auto window/level (done)**: `logic/window-level.ts` `histogramPercentiles` reproduces
`vtkImageHistogramStatistics` (0.1/99.9 percentiles: unit bins for integer data capped at 2^16, 1000 bins for
float, subsample above 4M voxels) and `autoWindowLevel` maps them to window=hi−lo, level=(lo+hi)/2 — the same
rule as `vtkMRMLScalarVolumeDisplayNode::CalculateAutoLevels`. `logic/ingest.ts` now computes the load-time W/L
through this exact histogram (the old subsample-sort `percentileWindowLevel` delegates to it). **Parity**:
`harness/parity/window-level.parity.test.ts` — native MRHead auto W/L 152.0/76.0 vs Slicer 151.0/75.5 (window
tol 2, level tol 1).

**W/L drag (done, reuses `attachSliceControls`)**: Slicer's AdjustWindowLevel mouse mode is the default 2D
left-drag in the native shell — gain = (rangeHi−rangeLo)/min(viewW,viewH), window += gain·Δx, level += gain·Δy
(display coords), already implemented faithfully in `render/demos/slice-control.ts`. `live-views.ts` now enables
it standalone (no peer interaction node ⇒ on when the cell has a background volume) and targets the cell's
**background** volume display via `bgDisplayId(c)` (composite→image→display), clearing `autoWindowLevel`. Right-drag
stays zoom, wheel stays scroll. `logic/window-level.ts:adjustWindowLevel` is the unit-tested reference for the gain.

**Presets (done)**: `CT_WL_PRESETS` (CT Soft Tissue/Lung/Bone/Brain/Abdomen/Angio/Mediastinum, PET) matching the
BIR reader values.

**Color tables (done)**: `logic/color-tables.ts` — Slicer's continuous ramps (Grey, InvertedGrey, Rainbow, Ocean,
Iron, Fire, Cool, Warm) as 256-entry `colorTable` nodes (the shape `livescene.ts:lutFor` consumes), plus
`sampleColor(table, scalar, w, l, threshold?)` — a CPU reference of the slice shader's scalar→W/L→LUT→RGBA map
(threshold is alpha-only). Grey stays the identity ramp so the plain grayscale path is used.

**Volumes panel (done)**: `render/demos/volumes-panel.ts` — active-volume selector, W/L sliders + numeric + Auto
(recomputes the exact histogram from the volume's chunks) + preset dropdown, threshold (apply + lo/hi), interpolate
toggle, color-table picker. Every control patches the `scalarVolumeDisplay` node through the LiveScene
(local-authoritative) so slice + VR update immediately. Programmatic API (`__volumeList`, `__volumeDisplay`,
`__setWindowLevel`, `__autoWL`, `__wlPreset`, `__setThreshold`, `__setInterpolate`, `__setColorTable`) for tests.

**Tests**: unit `logic/window-level.test.ts` (5) + `logic/color-tables.test.ts` (7); parity above; browser
`harness/volumes-panel.browser.test.ts` (2: panel API auto/preset/threshold/color-table, and left-drag W/L
integration — grows window, more for longer drag, level stable, auto cleared, vertical drag moves level); self-test
"volumes: auto W/L … presets + threshold + color table apply" on `slicer-app.html` (selfTest 6 pass / 0 fail).

**VR transfer-function editor (done)**: `render/demos/tf-editor.ts` — a "Volume Rendering" panel that enables VR
on the active scalar volume (`volumeRenderingDisplay {visible, refs.volume, refs.property}`), applies a Slicer CT
VR preset (`CT_VR_PRESETS` -> a `transferFunction` node's `colorStops` + `scalarOpacity`), and edits the
scalar-opacity curve on a canvas (drag a handle, click to add, double-click to remove), patching the
`transferFunction` node so `VolumeRenderingDisplayableManager.reLUT()` rebuilds the LUT and the 3D view updates.
One transferFunction/VR-display node per scene (the VR DM tracks one image), matching the native single-volume VR
path. Programmatic API `__setVolumeRendering`, `__setVrPreset`, `__setOpacityStops`, `__vrState`. Browser test
`harness/tf-editor.browser.test.ts` (enable VR, CT-Bone preset writes sorted color/opacity stops, opacity edit
persists, frames advance, VR off).

**histogram kernel (done)**: `algorithms/kernels/histogram.ts` — the reusable reduction the plan schedules
(replaces `vtkImageAccumulate`/`vtkImageHistogramStatistics`): `histogram(data,{bins,range})`, `imageStats`
(min/max/mean/stdev one pass), `dataRange`, `percentileFromCounts`, plus a WGSL compute path `histogramGPU`
(atomic<u32> bins) that returns **byte-identical integer counts** to the CPU reference. Feeds auto W/L now and
SegmentStatistics later. Tests: `histogram.test.ts` (6, CPU) + `histogram.gpu.test.ts` (GPU==CPU on ramp,
clamped edges, 100k-sample deterministic noise). (`logic/window-level.ts:histogramPercentiles` keeps its
Slicer-tuned int/float binning for the parity-verified auto W/L; the kernel is the general-purpose path.)

**resample3d kernel (done)**: `algorithms/kernels/resample3d.ts` — the data path of `vtkImageReslice` /
`vtkOrientedImageDataResample`: resample an input volume (its own ijkToRAS) onto an output geometry
(dims + ijkToRAS) with nearest or trilinear interpolation, direction-aware (goes through world RAS, so arbitrary
rotation/anisotropy works), out-of-extent -> background; integer input keeps integer output. Plus `isotropicGrid`
(build a cubic-voxel output covering the same RAS box). **Parity**: `harness/parity/resample3d.parity.test.ts` —
vs Slicer's `vtkImageReslice` on a 10^3 ramp resliced onto an interior anisotropic-scaled grid: nearest exact,
linear max|Δ| 6.71e-4 (< 1e-3) over 216 voxels. Unit: `resample3d.test.ts` (7: identity, translation, background,
trilinear midpoint, 90-degree permutation, integer rounding, isotropicGrid). The WGSL path lands with its first
heavy consumer (W5 masking / W6 harden). Needed by W5 masking, W6 harden, W1 crop.

Next: W2 tail (orientation combo for reformat, link/hot-link across slice views); the resample3d WGSL path when
W5/W6 need the throughput.

## W2 tail — slice linking + reformat (done)

**Slice linking (done)**: `logic/link.ts` is a faithful port of `vtkMRMLSliceLinkLogic::BroadcastSliceNodeEvent`
— when a slice view's `sliceComposite.linkedControl` is on, an offset/orientation/zoom change broadcasts to the
other slice views in the same view group: SliceToRAS (offset+plane) only to **orientation-matching** views,
FieldOfView to all (aspect-corrected per target), an orientation change realigns all. Wired into
`live-views.ts:patchNativeOffset` via `propagateLink` (gated by `compositeLinked(cell)`); `__setLinked(on)`
toggles every composite's `linkedControl` (Slicer's link button). Test: `logic/link.test.ts` (5) + browser
`harness/slice-link.browser.test.ts` (reformat Green→Axial, link on ⇒ Green follows Red, Yellow doesn't; link
off ⇒ Green stays).

**Orientation combo / reformat (done)**: `logic/slice-logic.ts:reformatSliceToRAS` builds the canonical
SliceToRAS for an orientation through the current centre (Slicer's `SetOrientation`); `live-views.ts:reformatCell`
applies it (updates the node + the cell's orientation so fit/offset math follow), and `patchNativeOffset` is now
general — it moves the plane along its **current** normal, so a reformatted cell scrolls correctly. The slice
controller bar's orientation is now a `<select>` (reformat combo) instead of a static label. Test: browser
"reformat combo" (drive Green's combo to Sagittal ⇒ node orientation + plane normal update).

## W4 — Markups (in progress)

**Measurements (done)**: `logic/markups/measurements.ts` — distance, polylineLength (open/closed), angleDeg,
polygonArea (Newell, planar-in-3D), boxVolume, `measurementsFor(type,...)`. Parity: line length 5 + angle 90
match `vtkMRMLMeasurement` exactly; ClosedCurve is a spline in Slicer (area 18.225/length 15.387 over interpolated
points), so the area/length FORMULAS are validated on Slicer's own curve points to 0.5% (spline interpolation is a
later `curve.ts` port). Unit `measurements.test.ts` (6).

**Placement (done)**: `logic/markups/placer.ts` — a pure state machine (`placeClick`, `POINTS_NEEDED`,
`removeControlPointOp`): a click creates a new `markup` node or appends a control point; completes at the type's
point count (fiducial 1, line 2, angle 3, plane 3, roi 2; curves user-ended). Wired natively in `live-views.ts`
(`interaction` node + `placeAtNative` + `startPlace/endPlace`), so the native `MarkupsDisplayableManager` renders
placed points/lines and stored measurements update on placement and on control-point drag. `render/demos/markups-panel.ts`
— place toolbar (Point/Line/Angle/Curve/Closed Curve/ROI), place-multiple toggle, node list with per-node
measurement + delete; Esc stops placing. Unit `placer.test.ts` (6); browser `harness/markups.browser.test.ts`
(place line+angle by clicking → measurements; fiducial 1-click; delete).

**Curve interpolation (done)**: `logic/markups/curve.ts` is a faithful port of Slicer's default curve
(`vtkMRMLMarkupsCurveNode` = Cardinal spline via `vtkCurveGenerator`/`vtkParametricSpline`/`vtkCardinalSpline`,
10 points per interpolating segment, clamped zero end-slopes, closed wrap). `interpolateCurve(controlPoints,
closed)` produces the world `linePoints` the display + measurements use. **Parity**
(`harness/parity/curve.parity.test.ts`): matches Slicer's `GetCurvePointsWorld` to **2e-6 mm** (open + closed,
41 points), and ClosedCurve area matches exactly (1974.388). Wired into `live-views.ts:storeMeasurements` — placing
a curve/closedCurve stores `linePoints` (the `MarkupsDisplayableManager` renders the smooth spline) and measures
length/area over them. Unit `curve.test.ts` (5); browser markups.browser.test.ts (closed curve → 41-point spline +
area). This closes the ClosedCurve-area parity gap from step 1.

**Display props + lock/visibility (done)**: the Markups panel has per-node show/hide (👁) and lock/unlock (🔒)
toggles and a global glyph-size slider; hooks `__setMarkupProp(id, "visible"|"locked", on)`, `__setGlyphScale`.
Locked markups are skipped by `pickMarkup` (not grabbable). Browser markups.browser.test.ts (visibility/lock/glyph).

Next W4 (optional polish): ROI place-by-click + box handles (deferred — needs center/size + out-of-plane depth).
Then W5 segment editor (effects + kernels: ccl/morph/voxelize/autoThreshold; resample3d WGSL path lands here,
routed through the unified field-op backend — see the unified-field-op-backend direction).


## W5 — Segment editor (in progress)

**Kernels (done, exact parity)**: `algorithms/kernels/auto-threshold.ts` (Otsu/Huang/Triangle/IsoData — the ITK
ImageThresholdCalculators; Otsu 45.63 vs itk::OtsuThreshold 45.00), `algorithms/kernels/ccl.ts` (connected
components 6/18/26-conn + islands; count + sizes match scipy.ndimage.label exactly, 25/25 & 19/19),
`algorithms/kernels/morph.ts` (erode/dilate/open/close/median over a Euclidean ball; match scipy.ndimage
voxel-for-voxel, 0/5832).

**Effects layer (done)**: `logic/segment-effects.ts` — pure labelmap effects composing the kernels
(applyThreshold/applyAutoThreshold, applyIslands, applySmoothing, applyMargin) with a minimal OverwriteMode
masking model (All/Visible/None) and mm→voxel from spacing; immutable (new labelmap for undo).

**Native editor + panel (done)**: `logic/segmentation-editor.ts` creates a `segmentation` node (empty labelmap
matching the source geometry + segments) and applies effects by materializing the new labelmap (fetch zarr → run
effect → re-upload content-addressed → patch `#/zarr`, the SegmentationDisplayableManager re-bakes).
`render/demos/seg-editor-panel.ts` — create segmentation, segment list (add/select/visibility), and
Threshold/Auto-Otsu/Islands/Smoothing/Margin buttons. This is where W5 materializes voxels — to be routed through
the unified field-op backend (GPU + out-of-core) later; interactive paint stays on the GPU EditableSegmentation.

**Tests**: unit auto-threshold(6)/ccl(6)/morph(6)/segment-effects(6); parity auto-threshold(ITK)/ccl(scipy)/
morph(scipy); browser seg-editor.browser.test.ts (create → Otsu 3.3M vox → keep-largest → margin +2mm 4.2M →
median, labelmap zarr changes + re-bakes).

**Native paint/erase (done)**: `logic/segmentation-editor.ts:paintStroke`/`commitPaint` paint a resident CPU
labelmap in-place during a drag (physical-sphere or 2D-disk rasterization in voxel space) and re-upload on a
120 ms throttle + at stroke end; `invalidatePaintCache` drops it after a discrete effect. `live-views.ts:sendStroke`
branches to `cfg.onNativePaint`/`onNativePaintCommit` when the segmentation is local (peer path unchanged). The
Segment Editor panel gains Paint/Erase + a diameter slider + Sphere toggle. Browser `harness/paint.browser.test.ts`
(drag paints 5182 voxels; erase -> 207). Reuses the existing brush interaction plumbing (cursor overlay, stroke
capture) — no reinvention. Next W5 (optional): masking-intensity-range, Fill Between Slices
(contour interpolation), Logical operators, segment statistics (shape-stats kernel). Then W6 transforms + models,
W7 save/export.

## W6 — Transforms + models (in progress)

**Transform hierarchy (done)**: `logic/transforms.ts` — the pure math of `vtkMRMLTransformNode`: `worldMatrix`
composes a transform's parent chain to world (`GetMatrixTransformToWorld`), `worldForNode` for a transformable's
`refs.transform`, `rowMul`/`invertRowMajor`, cycle detection (`wouldCycle`, guarded `worldMatrix`), and harden
(`hardenImageIjkToRAS` = world · ijkToRAS; `hardenPoints` for markups). **Parity**
(`harness/parity/transforms.parity.test.ts`): worldMatrix matches Slicer's GetMatrixTransformToWorld **exactly**
(max|Δ| 0) on an A→B→C chain, and harden matches `vtkSlicerTransformLogic.hardenTransform` on a volume (1e-4).
Unit `transforms.test.ts` (7).

**Native display + panel (done)**: the image DM (`VolumeLayersDisplayableManager`) now composes the transform
chain — the field is placed with `world(refs.transform) · base ijkToRAS`, re-placed when the transform or its
matrix changes (backward-compatible: no transform ref → identity → unchanged). `render/demos/transforms-panel.ts`
— apply a linear transform to the active volume, R/A/S translation sliders, Identity, and Harden. Browser
`harness/transforms.browser.test.ts` (apply → translate: world carries [10,20,30], base untouched → harden:
ijkToRAS origin shifts, ref cleared). Hooks `__createTransform`/`__applyTransformTo`/`__translateTransform`/
`__hardenTransform`/`__nodeWorldMatrix`.

Next W6: apply the chain to the VR 3D field + markups/segmentation DMs, grid (nonlinear) transforms, model display
props (colour/opacity/representation/2D intersections). Then W7 save/export.

## W7 — Save / export (in progress)

**Volume writers (done, round-trip parity)**: `logic/writers/nrrd.ts` (NRRD, raw + gzip, RAS space so no LPS flip
— `space directions` = ijkToRAS columns, `space origin` = translation; optional segment keys for .seg.nrrd) and
`logic/writers/nifti.ts` (NIfTI-1 .nii, sform = ijkToRAS RAS, sform_code 1). Both round-trip through the readers
(unit) and — the real test — **Slicer loads our files** with matching dims, ijkToRAS, and voxel sum
(`harness/parity/{nrrd,nifti}-writer.parity.test.ts`: NRRD sum 6825, NIfTI sum 2040, ijkToRAS ≤1e-3).

**Export + Save panel (done)**: `logic/export.ts` fetches a node's content-addressed voxels and serializes
(exportVolume NRRD/NIfTI, exportSegmentation → .seg.nrrd with Slicer segment keys). `render/demos/save-panel.ts`
lists savable images/segmentations, format picker, Save → browser download. Browser `harness/save.browser.test.ts`
(MRHead → NRRD 34 MB + NIfTI, segmentation → .seg.nrrd). Hooks `__savableNodes`/`__exportNode`.

Next W7: STL/PLY mesh export (needs surface-nets from a labelmap), markups .mrk.json, scene bundle (.slb), DICOM-SEG.
W6 remainder: transform chain on VR/markups, grid transforms, model display.