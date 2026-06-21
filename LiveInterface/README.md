# LiveInterface

The **LiveInterface** layer of [SlicerLive](https://github.com/pieper/SlicerLive) — UI primitives that
read and edit a [LiveScene](../docs/SLICERLIVE.md) (SlicerLive's runtime semantic graph, the
MRML-replacement) and run in a browser or in Slicer's `qSlicerWebWidget`. Successor to a traditional
widget toolkit: the primitives here are intended both as direct-use components today and as building
blocks an agent can compose against a LiveScene tomorrow (see SlicerLive's "every user is differently-abled"
design principle).

First primitives: a `ColorPicker`, `Histogram`, `TransferFunctionEditor`, `CombinedTransferFunctionEditor`,
`WindowLevelEditor`, `PhongShadingPanel`, `LightingPanel`, and `PresetPicker`. The set grows from there.

## Why WebGPU

- Headroom for live previews of render effects, large histograms, smooth animations, future 3D thumbnails inside primitives.
- Works in modern browsers and in recent Slicer builds (Qt 6.7+ with `--enable-unsafe-webgpu`).

## Build

```sh
npm install
npm run build       # emits dist/liveinterface.{esm,iife}.js
npm run typecheck
npm run watch       # incremental
```

## Hosts

- **SlicerLive viewer** — `import { TransferFunctionEditor } from '@slicerlive/liveinterface'`.
- **Slicer desktop (qSlicerWebWidget)** — load `dist/liveinterface.iife.js`, use `window.LiveInterface.*`.

## Layout

- `src/core/` — base `Widget` class, typed event bus, theme tokens.
- `src/gpu/` — `GPUDevice` singleton, pipeline + buffer helpers, WGSL shaders.
- `src/widgets/` — per-primitive code, one folder each. (Subdirectory name kept as `widgets/` — "widget"
  is the right CS term for a self-contained UI primitive; the brand-level rename is at the package layer.)
- `src/mrml/` — Slicer MRML round-trip helpers (volume property serialization, presets). The directory
  stays `mrml/` because it implements compatibility with the actual MRML file format that SlicerLive
  ingests, distinct from the LiveScene runtime concept.
- `demo/index.html` — standalone demo page (file:// or qSlicerWebWidget).
