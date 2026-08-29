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

Next: W1 (load data / DICOM) — minimal DICOM module behind `Project/StudyIndex/SeriesSource` interfaces
(Steve's SlicerRad folder browser to be reconciled when that code is available).
