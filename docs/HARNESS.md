# Slicer ↔ SlicerLive A/B harness

Purpose: make SlicerLive reproduce traditional VTK-Slicer look/feel **and interaction** on the
step-based WebGPU backend, by driving *identical* synthetic input into native Slicer and the
browser and comparing **numbers** (camera parameters, slice offsets, voxel indices) — not
screenshots. Screenshots illustrate a conclusion; they never derive one.

## Quick start

```bash
# 1. Chrome, HEADED and on-screen (never headless — the user watches and intervenes)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  --user-data-dir=/tmp/chrome-harness \
  --no-first-run --no-default-browser-check \
  --window-size=1280,900 --window-position=60,80 about:blank &

# 2. serve the gallery locally so you can iterate without pushing
cd /Users/pieper/slicer/live && python3 -m http.server 8099

# 3. run the regression suite
cd /Users/pieper/slicer/SlicerLive
deno run -A harness/run-all.ts             # pure checks: fixtures + TS ports, no browser
deno run -A harness/run-all.ts --browser   # + live-browser checks over CDP
```

## Two drivers

| Side | Driver | Gives |
|---|---|---|
| **Native Slicer** | `slicer-mcp` MCP server (`localhost:2026/mcp`) | `execute_python` (cameras, real interactor events, node state), `screenshot`, `load_sample_data` |
| **SlicerLive** | Chrome DevTools Protocol → `harness/cdp.ts` | `Input.dispatchMouseEvent` (true browser-level input), `Runtime.evaluate` (exact state), `Page.captureScreenshot` |

## Regression suite

Pure checks need **neither Slicer nor a browser** — they replay ground truth captured from a real
Slicer session (`harness/fixtures/`) against the TS ports. These are the CI-able tests.

| Check | Script | Needs |
|---|---|---|
| `VtkCamera` port == real VTK (5 cases: single/accumulated rotate, dolly, scale, tilted view-up) | `verify-vtk-camera.ts` | fixtures |
| Camera bindings: rotate / pan / zoom / wheel | `verify-actions.ts` | fixtures |
| Slice stepping: wheel, `f`/`b`, arrows, bounds rejection | `verify-slice-step-math.ts` | fixtures |
| Startup geometry: volume, slice offsets, fitted FOV, camera | `compare-startup.ts` | browser |
| Real drag through Slicer's `vtkMRMLCameraWidget`, reproduced in TS **and** via the DOM | `verify-drag-parity.ts` | browser |
| Slice stepping through the real DOM wiring | `verify-slice-step.ts` | browser |

## Non-obvious rationale (read before "fixing" any of this)

These are all things that cost real debugging time; the values are measured from Slicer, not chosen.

- **Coordinate origin flip.** VTK display coords put the origin at the BOTTOM-left (y up); browser
  pointer coords put it at the TOP-left (y down). `CameraInteractor` converts on the way in, so all
  interaction math is in VTK convention and comparable to Slicer 1:1. Getting this wrong inverts
  elevation only — rotation still "works", which is why it must be tested numerically.
- **Slice offset sign.** Slicer's `sliceOffset` is measured along the slice NORMAL, which is `+S`
  (axial), `+A` (coronal) and **`-R` (sagittal)** per the default `sliceToRAS` presets. The hook
  reports `offsetMm` in that signed convention (and `rasMm` for the raw positive-RAS coordinate).
  A stale sign compensation in a *test* is what made `compare-startup` fail after the hook adopted
  the signed convention — the code was right and the test was double-negating.
- **Radiological display.** Screen-right is the NEGATIVE axis in every default Slicer 2D view:
  axial/coronal `-R`, sagittal `-A` (so the face points LEFT). Rendering RAS with `+R` to the right
  looks exactly like an LPS/RAS bug. See `coordinate-systems-discipline` in the agent memory.
- **Default slice position** is NOT the bounding-box centre — Slicer snaps to the voxel-centre plane
  at `floor((N-1)/2)` on the IJK axis aligned with the slice normal (`slicerDefaultOffset01`). The
  bbox centre is a half-voxel off (0.5 mm here, 0.65 mm sagittal at 1.3 mm spacing).
- **Slice fit has no margin.** `FitSliceToBackground` fits the limiting in-plane extent exactly;
  Red's FOV `[891.78, 256]` at viewport 634×182 is precisely the 256 mm A-extent with x following
  aspect. An earlier `*1.02` "border" was wrong.
- **Default 3D camera is fixed, not fitted.** `(0,500,0)` → focal point at the **RAS origin** (not
  the volume centre), `viewUp +S`, `viewAngle 30`. Slicer does not refit the camera when a volume
  loads, so neither do we.
- **Slice steps are rejected, not clamped.** `MoveSlice` applies the step only if the new offset is
  inside the slice bounds; stepping at the edge leaves the offset unchanged (verified: 116.8857 with
  a 117.2857 bound stays put). Clamping to the bound would be wrong.
- **Slice step size** is the background volume's spacing **along the slice normal** — for MRHead
  that's 1.0 axial/coronal but **1.2999954 sagittal**, because that normal follows the 1.3 mm k axis.
- **`Elevation` is subtle.** VTK rotates about `-row0` of the view transform and *temporarily*
  rotates the view-up for the internal computation before restoring the member — which is why Slicer
  always follows it with `OrthogonalizeViewUp`. A naive implementation matches for one step and
  drifts after several, hence the 6-step accumulation case in `verify-vtk-camera.ts`.
- **Pan shortcut is exact.** `panByDisplayDelta` moves in the camera basis rather than doing VTK's
  focal-depth unproject/reproject. Verified equal to `ProcessTranslate` to ~4e-7, so it is a
  simplification, not an approximation — but re-verify if a model transform is ever introduced.
- **`goto()` must detect a NEW document.** Waiting on `Page.loadEventFired` alone lets a subsequent
  `waitFor(...)` match leftover state from the OLD document; input then lands mid-reload before
  listeners attach and silently does nothing. `goto` stamps the current document and waits for the
  stamp to disappear with `readyState === "complete"`. This produced a reproducible false negative.

## `window.__slicerlive` (render/introspect.ts)

Installed by each browser demo so the harness reads/sets exact state:

- `getCamera()` → vtkCamera-comparable `position` / `focalPoint` / `viewUp` / `viewAngle`
- `setCamera({position, focalPoint, viewUp, viewAngle})`
- `getPlanes()` → per cell `{orient, offset01, offsetMm (Slicer-signed), rasMm, spanMm, spacing, bounds}`
- `setPlane(cell, offset01)`, `setSliceOffsetMm(cell, mm)`, `stepSlice(cell, forward)`, `keySlice(cell, key)`
- `getVolume()` → `{name, dims, ijkToRAS, rasLo, rasHi, window, level}`
- `viewToVoxel(cell, u, v)` → the picking path (view → RAS → voxel index)
- `log` / `logEvent()` / `clearLog()` — which binding fired, with modifiers; `snapshot()` for one round-trip

## Regenerating the fixtures

`harness/fixtures/*.json` came from a live Slicer (clear scene → load MRHead → enable volume
rendering). Refresh them when validating a new Slicer build:

1. Run the capture snippets over `slicer-mcp` `execute_python` — they are the code blocks that write
   `/tmp/slicer-startup.json`, `/tmp/vtk-camera-truth.json`, `/tmp/slicer-drag-truth.json`,
   `/tmp/slicer-actions-truth.json`, `/tmp/slicer-slicestep-truth.json` (see git history of this
   file's commit for the exact Python, or re-derive: dump camera/slice/volume state; apply
   `Azimuth/Elevation/OrthogonalizeViewUp/Dolly` to a bare `vtkCamera`; inject
   `LeftButtonPressEvent`/`MouseMoveEvent`/`MouseWheelForwardEvent`/`KeyPressEvent` into the real
   view interactors).
2. Validate against the fresh dumps without overwriting: `SLICERLIVE_FIXTURES=/tmp deno run -A harness/run-all.ts`
3. If they agree, copy them into `harness/fixtures/`.

## Why not qSlicerWebWidget
Qt 6.10.1 / QtWebEngine (Chrome 134) reports `WebGPU: Hardware accelerated` in `chrome://gpu`, but
`requestAdapter()` returns **null** for every option (incl. `forceFallbackAdapter`) and Qt logs
`Failed to create WebGPU Context Provider`. The flags are applied and visible in Chromium's command
line, so it is not the blocklist — the distinguishing config is Qt's forced **`--in-process-gpu`**
(+ `--use-gl=angle`); Dawn-backed WebGPU wants the real out-of-process GPU service. External Chrome
works fully (`apple`/`metal-3`, `float32-filterable`, `shader-f16`). Embedding stays desirable
long-term but is not needed for the harness.

## Scope not yet covered
- **Slice pan/zoom** (right-drag zoom, middle-drag pan, Ctrl+wheel zoom — note Slicer *inverts*
  Ctrl+wheel vs plain wheel). Needs slice FOV/pan state; `SliceRenderer` currently always fits.
- Slice-view crosshair / jump-to-slice, linked slice views, blend (fg/bg opacity), lightbox.
- 3D spin is implemented but not yet A/B-verified against Slicer.
