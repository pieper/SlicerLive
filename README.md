<p align="center">
  <img src="docs/slicerlive-logo.png" alt="SlicerLive" width="320">
</p>

# SlicerLive

**Live 3D Slicer scenes on the web** — open a URL and a Slicer scene renders interactively in your browser
on your own GPU, with no Slicer install and no server for the common case. The same TypeScript/WebGPU
renderer also runs headless under Deno, so big scenes can render on a remote GPU and stream to thin clients.
Gateway eventually at **live.slicer.org**.

## Try it

- **SEGRoulette** — spin a random AI / expert segmentation from the NCI <a href="https://imaging.datacommons.cancer.gov/" target="_blank" rel="noopener">Imaging Data Commons</a>
  (with its source CT, MR, or PET) into a live 3D + MPR viewer, DICOM streamed straight from IDC's public buckets:
  <a href="https://pieper.github.io/live/webgpu/segroulette.html" target="_blank" rel="noopener"><b>pieper.github.io/live/webgpu/segroulette.html</b></a>
- **Gallery** of live demos (volume rendering, 4-up MPR, segment editing, nnLive AI segmentation, LiveCodec, spine review):
  <a href="https://pieper.github.io/live/" target="_blank" rel="noopener">pieper.github.io/live</a>
- **Colab notebook** — find an IDC segmentation with `idc-index` and view it in an embedded SlicerLive output cell:
  <a href="https://colab.research.google.com/github/pieper/SlicerLive/blob/main/notebooks/SlicerLive_IDC_demo.ipynb" target="_blank" rel="noopener"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"></a>

## Status

SlicerLive is now a **WebGPU-native** implementation (the original vtk.js proof of concept is retired to
`viewer/`, still deployed under the gallery's `legacy/` path for the notebook and older links):

- **`render/`** — the TypeScript/WebGPU renderer: direct volume rendering, 4-up MPR slices, SDF-based
  segmentation shells, markups, transforms, and Zarr/DICOM loading. One codebase runs in the browser and in
  Deno for remote rendering. See [`docs/ARCHITECTURE-2026-08-02.md`](docs/ARCHITECTURE-2026-08-02.md)
  (canonical architecture: LiveScene local-authority MVC + decoupled LiveSync) and
  [`docs/RENDER-PERFORMANCE.md`](docs/RENDER-PERFORMANCE.md).
- **Live sync with 3D Slicer** — scenes flow between a running Slicer and the browser as **mrson**
  (schema'd MRML→JSON documents + incremental ops) over a WebSocket, bidirectionally (~ms round trip), and
  whole sessions can be recorded and replayed. See [`docs/MRSON-LIVESCENE.md`](docs/MRSON-LIVESCENE.md).
- **`algorithms/`** — a WebGPU-compute segment-editing engine (editable segmentations with live paint /
  draw effects, driven by mrson ops). See [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md).
- **`LiveStory/`** — the Slicer-side module: exports scenes to SlicerLive JSON, records sessions, and
  serves them via Slicer's WebServer.

## Layout

- `render/` — renderer core + `render/demos/` (the pages published to the gallery) + `render/test/`.
- `algorithms/`, `logic/` — segment-editing compute engine and app logic.
- `LiveStory/` — the 3D Slicer extension (export, sync, recording).
- `examples/` — larger scenario apps (spine review, LiveCodec).
- `viewer/` — the legacy vtk.js v0 viewer.
- `docs/` — design notes; start with [`docs/ARCHITECTURE-2026-08-02.md`](docs/ARCHITECTURE-2026-08-02.md),
  roadmap in [`docs/SLICERLIVE.md`](docs/SLICERLIVE.md).

## Acknowledgments
Thanks to **Andrey Fedorov** for his valuable testing and feedback, which shaped the SEGRoulette viewer
and its IDC integration.
