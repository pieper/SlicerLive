<p align="center">
  <img src="docs/slicerlive-logo.png" alt="SlicerLive" width="320">
</p>

# SlicerLive

**Live 3D Slicer scenes on the web** — open a URL and a Slicer scene renders interactively in your browser
on your own GPU, with no Slicer install and no server for the common case. The same TypeScript/WebGPU
renderer also runs headless under Deno, so scenes too big for the browser can render on a remote GPU and
stream to thin clients. Gateway eventually at **live.slicer.org**.

## Try it

- **SEGRoulette** — spin a random AI / expert segmentation from the NCI <a href="https://imaging.datacommons.cancer.gov/" target="_blank" rel="noopener">Imaging Data Commons</a>
  (with its source CT, MR, or PET) into a live 3D + MPR viewer, DICOM streamed straight from IDC's public buckets:
  <a href="https://pieper.github.io/live/webgpu/segroulette.html" target="_blank" rel="noopener"><b>pieper.github.io/live/webgpu/segroulette.html</b></a>
- **Gallery** of live demos (volume rendering, 4-up MPR, segment editing, nnLive AI segmentation, LiveCodec, spine review):
  <a href="https://pieper.github.io/live/" target="_blank" rel="noopener">pieper.github.io/live</a>
- **Colab notebook** — find an IDC segmentation with `idc-index` and view it in an embedded SlicerLive output cell:
  <a href="https://colab.research.google.com/github/pieper/SlicerLive/blob/main/notebooks/SlicerLive_IDC_demo.ipynb" target="_blank" rel="noopener"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"></a>

## Architecture

The one-line thesis: a **LiveScene** is a live, partially-replicated MRML scene — metadata (node state) plus
bulk data (content-addressed blobs) — that any number of **participants** observe and write back to over any
of several **transports**. Everything else in SlicerLive is either a participant or a transport. The current
canonical architecture note is [`docs/ARCHITECTURE-2026-08-02.md`](docs/ARCHITECTURE-2026-08-02.md); it links
back through the earlier iterations it supersedes.

### The scene model: observer-MVC, in Slicer's own terms

SlicerLive deliberately mirrors Slicer's MVC/observer shape, using Slicer's vocabulary:

- **LiveScene (the Model)** — the local authoritative copy of the scene, held as mrson nodes plus
  content-addressed blobs. It exposes `applyOp()`: apply a mutation and notify observers. Every write is
  tagged `{origin, version}`. This is the analogue of `vtkMRMLScene` and its node `ModifiedEvent`s.
- **DisplayableManagers (the View)** — keyed by node type, they observe the scene, rebuild GPU render
  objects from node state, and request renders. Read-only, exactly like Slicer's
  `vtkMRMLAbstractDisplayableManager`.
- **Interactors and Controls (the Controller)** — the write half. An **Interactor** handles pointer input
  through a grab-or-bubble stack (camera at the root) and writes node state while holding an interaction
  lease; a **Control** is a data-bound DOM widget, the 1:1 DOM dual of a Slicer `qMRML` widget — it observes
  a node property and writes changes back. The event and multi-rate interaction model is specified in
  [`docs/ARCHITECTURE-2026-07-24.md`](docs/ARCHITECTURE-2026-07-24.md).

The invariant that keeps this honest: controllers never touch render objects or the network,
views never write, and sync never renders — all three coordinate only through LiveScene node state. That
means the same code runs standalone or connected: "connected" just adds a sync peer.

### LiveSync: replication, decoupled from everything else

The mental model is CouchDB-shaped — LiveScene is a local database, its observer dispatch is the changes
feed, and **LiveSync** is replication between two such databases (a browser LiveScene and a running Slicer,
or two LiveScenes). LiveSync is the only component that knows about the wire, so all the impedance matching
lives in one tunable place: latest-wins coalescing per key, debounce to the transport's sustainable rate,
echo suppression, update-on-complete for interactions that must not stream, and per-peer sequence
checkpoints so a reconnect catches up rather than re-snapshotting the scene. Bulk data rides a separate
content-addressed channel — the changes feed carries blob hashes, the bytes move lazily. After any burst,
both sides converge on the same state. Divergence resolves by authority: a user-initiated change beats any
automated or echoed value ([`docs/ARCHITECTURE-2026-08-02.md`](docs/ARCHITECTURE-2026-08-02.md) §2–2a).

In practice this syncs bidirectionally with a running 3D Slicer over a WebSocket at ~1 ms per op — drag a
markup in the browser and it moves in Slicer, toggle visibility in Slicer's Qt GUI and the browser follows.

### mrson: the scene format

**mrson** is the document and operation format that LiveSync (and files, and recordings) carry —
LiveScene is the protocol, mrson is the payload, deliberately split so mrson can stand alone as a
vendor-neutral format. It is a schema'd JSON representation of a medical scene with two faces: a
materialized **document** (snapshot) and a stream of **ops** (incremental patches, Lamport-versioned,
drop-to-latest safe). Types are neutral nouns (`image`, `segmentation`, `markup`, `transform`, `mesh`,
`camera`…), not VTK class names; world space is RAS with explicit frames of reference; DICOM is treated as
a boundary — imported attributes are carried losslessly for round-trip, but never drive the runtime. The
full design, including how it subsumes OpenIGTLink-style realtime streams, is
[`docs/MRSON-LIVESCENE.md`](docs/MRSON-LIVESCENE.md); scenes also support content-addressed commits and
forks for Git-like history and sharing ([`docs/MRSON-COMMITS-FORKS.md`](docs/MRSON-COMMITS-FORKS.md)).

### The renderer

`render/` is a from-scratch TypeScript/WebGPU renderer with no scene-graph framework underneath: a
**Field** is a WGSL-composable piece of renderable content (image volumes, SDF segmentation shells,
fiducials, ROI widgets, transform gizmos), and `SceneRenderer` / `SliceRenderer` ray-march the composed
fields for 3D and 4-up MPR views. Segmentations render as smooth distance-field shells baked by compute
shaders; volumes stream from Zarr or DICOM. Slice math follows Slicer's `sliceToRAS` conventions —
radiological display, RAS throughout. Performance work is measured, not guessed: GPU timestamp-query
profiling and an ablation harness drive optimizations like cached empty-space horizons (a representative
scene went 236 ms → 27 ms with byte-identical output); see
[`docs/RENDER-PERFORMANCE.md`](docs/RENDER-PERFORMANCE.md).

One codebase runs in the browser and headless under Deno — the remote path treats rendering as a
**Producer → sample stream → Reconstructor** pipeline steered by a frame-time **Budget**, so progressive
refinement locally and streamed rendering from a big remote GPU are the same mechanism
([`docs/UNIFIED-RENDERING-PLAN.md`](docs/UNIFIED-RENDERING-PLAN.md)).

### Segment editing

`algorithms/` is a WebGPU-compute segment-editing engine — a sibling of `render/` with a strictly one-way
dependency (it imports the renderer's device and field plumbing; the renderer never imports it). An
`EditableSegmentation` keeps the labelmap in a GPU buffer that effects (paint, draw, islands, margin…)
mutate incrementally in compute shaders, with a live smooth-surface render mode so edits appear under the
brush in real time. It is driven entirely by mrson ops — no UI of its own — so the same edits can come from
a browser interactor, a replayed recording, or an AI agent; `logic/` glues the engines together. Design and
milestones: [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md).

### The Slicer side: LiveStory

`LiveStory/` is the 3D Slicer module that makes Slicer a LiveScene peer. It exports a loaded scene to
mrson (a self-contained serializer, no Slicer core changes), hosts the Slicer-side LiveSync endpoint
(`mrson_live.py`: MRML observers out, `applyOps` in, with its own outbound coalescing), and records whole
sessions as keyframe + delta streams with real 4-up screenshots — a recorded session can be scrubbed and
replayed in the browser viewer. Narrated scene stories are served through Slicer's built-in WebServer.

### Testing: numbers, not screenshots

`harness/` drives identical synthetic input into native Slicer (via an MCP server) and the browser (via
Chrome DevTools Protocol) and compares **numbers** — camera parameters, slice offsets, voxel indices —
so look-and-feel parity with Slicer is a regression suite, not an eyeball judgment. Fixture-replay checks
run CI-style with neither Slicer nor a browser; see [`docs/HARNESS.md`](docs/HARNESS.md).

## Layout

- `render/` — the WebGPU renderer core, plus `render/demos/` (the pages published to the gallery) and
  `render/test/`.
- `algorithms/`, `logic/` — the segment-editing compute engine and the app-layer glue.
- `LiveStory/` — the 3D Slicer extension (export, live sync, session recording).
- `examples/` — larger scenario apps (spine review, LiveCodec).
- `harness/` — the Slicer ↔ SlicerLive A/B parity harness.
- `notebooks/` — the Colab IDC demo.
- `docs/` — design notes; start with [`docs/ARCHITECTURE-2026-08-02.md`](docs/ARCHITECTURE-2026-08-02.md),
  roadmap in [`docs/SLICERLIVE.md`](docs/SLICERLIVE.md).

## Acknowledgments
Thanks to **Andrey Fedorov** for his valuable testing and feedback, which shaped the SEGRoulette viewer
and its IDC integration.
