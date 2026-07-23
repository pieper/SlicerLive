# Slicer ↔ SlicerLive A/B harness

Purpose: make SlicerLive reproduce traditional VTK-Slicer look/feel **and interaction** on the
step-based WebGPU backend, by driving *identical* synthetic input into native Slicer and the browser
and comparing **numbers** (camera parameters, voxel indices, matrices) — not just screenshots.

## Two drivers, run side by side

| Side | Driver | What it gives |
|---|---|---|
| **Native Slicer** | `slicer-mcp` MCP server (`http://localhost:2026/mcp`) | `execute_python` (anything: cameras, interactor events, node state), `screenshot`, `load_sample_data`, `read_file`/`write_file` |
| **SlicerLive** | Chrome DevTools Protocol → `harness/cdp.ts` | `Input.dispatchMouseEvent` (true browser-level synthetic input), `Runtime.evaluate` (exact state), `Page.captureScreenshot` |

**Chrome is always launched HEADED / on-screen** (dedicated `--user-data-dir`, never the user's
profile) so the work is watchable and interruptible. Never headless — see the
`visible-verifiable-testing` note: prefer numeric ground truth over reading pixels.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  --user-data-dir=<scratch>/chrome-harness \
  --no-first-run --no-default-browser-check \
  --window-size=1280,900 --window-position=60,80 about:blank &

cd /Users/pieper/slicer/live && python3 -m http.server 8099   # iterate without pushing
```

## Why not qSlicerWebWidget
Qt 6.10.1 / QtWebEngine (Chrome 134) reports `WebGPU: Hardware accelerated` in `chrome://gpu`, but
`requestAdapter()` returns **null** for every option (incl. `forceFallbackAdapter`), and Qt logs
`Failed to create WebGPU Context Provider`. Flags (`--enable-unsafe-webgpu --enable-features=WebGPU
--ignore-gpu-blocklist`) are applied and visible in Chromium's command line, so it is not the
blocklist. The distinguishing config is Qt's forced **`--in-process-gpu`** (+ `--use-gl=angle`);
Dawn-backed WebGPU wants the real out-of-process GPU service. External Chrome 150 works fully
(`apple` / `metal-3`, `float32-filterable`, `shader-f16`). Embedding remains desirable long-term
but is not required for the harness.

## `window.__slicerlive` (render/introspect.ts)
Installed by each browser demo so the harness can read/set exact state instead of inferring it:

- `getCamera()` → orbit params **and** vtkCamera-comparable `position` / `focalPoint` / `viewUp` / `viewAngle`
- `setCamera({azimuth,elevation,distance})`
- `getPlanes()` → per MPR cell `{orient, offset01, offsetMm}` (offset in RAS mm, comparable to a slice node)
- `setPlane(cell, offset01)`
- `getVolume()` → `{name, dims, ijkToRAS, rasLo, rasHi, window, level}`
- `viewToVoxel(cell, u, v)` → the picking path (view → RAS → voxel index)
- `log` / `logEvent()` / `clearLog()` — which binding fired, with modifiers
- `snapshot()` — everything in one round-trip

## Scripts
- `harness/cdp.ts` — CDP client (connect, eval, goto, waitFor, screenshot, mouse/drag/wheel)
- `harness/verify-harness.ts` — smoke test: WebGPU present, page initializes, input lands, capture
- `harness/check-hook.ts` — reads camera, drags, re-reads, and asserts the delta equals the binding math

## Status / next
The current 3D binding is still ad-hoc (`azimuth += dx*0.008`), verified only self-consistently.
**Next:** replace it with Slicer's real bindings from `vtkMRMLThreeDViewInteractorStyle` /
`vtkMRMLSliceViewInteractorStyle` (+ VTK camera math), and assert equality against native Slicer
camera state for the same synthetic drag.
