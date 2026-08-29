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
Open: DICOM (local series via the dcmjs worker, DICOMweb, the minimal project/study browser behind
`Project/StudyIndex/SeriesSource`), NRRD keeps its native dtype (the reader expands to f32 today), `.nrrd.gz`.

Next: W1 DICOM — minimal DICOM module behind `Project/StudyIndex/SeriesSource` interfaces
(Steve's SlicerRad folder browser to be reconciled when that code is available).
