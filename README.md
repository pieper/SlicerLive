# slicerlive 🧬

⚠️ **EXPERIMENTAL & AI-ASSISTED** — This is an early-stage research project deliberately written with AI-assisted coding. Expect rapid change, incomplete features, and rough edges. Use at your own risk in production.

**Live 3D Slicer scenes on the web** — open a URL and a Slicer scene renders interactively in your browser on your own GPU, with no Slicer install and no server for the common case. The same TypeScript/WebGPU renderer also runs headless under Deno, so scenes too big for the browser can render on a remote GPU and stream to thin clients. Gateway eventually at **live.slicer.org**.

> **Status:** Early development. Experimental platform under active development with rapidly evolving architecture. Much of this codebase is written by AI agents working under human direction and review.

## What is slicerlive?

**slicerlive** is a **modular, open ecosystem** for bringing medical imaging scenes to life in the browser and beyond. Rather than a monolithic application, it's a collection of independently-useful components that work together:

- **Rendering** — WebGPU-powered 3D/MPR visualization with no scene-graph overhead
- **Sync** — Real-time bidirectional sync (MRML ↔ browser ↔ remote GPU)
- **mrson** — A vendor-neutral medical scene format (DICOM-aware, Git-friendly, content-addressed)
- **Algorithms** — GPU-accelerated interactive segmentation with live preview
- **Headless rendering** — The same TypeScript/WebGPU renderer runs in Deno for remote GPU compute

## Future Organization

The codebase will eventually be split across multiple focused repositories:

| Component | Purpose | Future location |
|-----------|---------|-----------------|
| **rendering** | WebGPU 3D/MPR renderer (browser + Deno headless) | `slicerlive/rendering` |
| **mrson** | Medical scene format (schema, codecs, validators) | `slicerlive/mrson` |
| **sync** | Real-time scene replication + CouchDB-style sync | `slicerlive/sync` |
| **algorithms** | GPU-accelerated segment editing engine | `slicerlive/algorithms` |
| **core** | LiveScene model + observer dispatch | `slicerlive/core` |
| **slicer** | 3D Slicer integration (LiveStory module + examples) | `slicerlive/slicer` |
| **examples** | Demo applications (cardiac, spine review, SEGRoulette) | `slicerlive/examples` |
| **harness** | Slicer ↔ Browser parity testing framework | `slicerlive/harness` |

Currently everything is in this monorepo. See [docs/REFACTORING.md](docs/REFACTORING.md) for the planned separation strategy.

## Quick Start

### Try it live
- **[SEGRoulette](https://pieper.github.io/live/webgpu/segroulette.html)** — Spin random AI segmentations from the NCI Imaging Data Commons
- **[Gallery](https://pieper.github.io/live/)** — Volume rendering, 4-up MPR, segment editing, nnLive AI, LiveCodec

### For developers

**Render a volume in the browser:**
```typescript
import { SceneRenderer } from '@slicerlive/rendering';
import { fetchZarrVolume } from '@slicerlive/rendering/zarr';

const volume = await fetchZarrVolume('https://my-data-bucket/', zarSpec);
const renderer = new SceneRenderer(canvas, device);
renderer.addImageField(volume);
renderer.render();
```

**Sync a scene bidirectionally:**
```typescript
import { LiveScene } from '@slicerlive/core';
import { LiveSync } from '@slicerlive/sync';
import { WebSocketTransport } from '@slicerlive/sync/transport';

const scene = new LiveScene();
const sync = new LiveSync(scene, new WebSocketTransport('ws://localhost:8000'));
// Changes on either side propagate automatically
```

## Architecture

### The core idea: LiveScene

A **LiveScene** is a live, partially-replicated medical scene — metadata (node state) plus bulk data (content-addressed blobs) — that any number of **participants** observe and write back to over any of several **transports**.

**Everything else is either a participant or a transport:**

- **Participants:** 3D Slicer (LiveStory), web browser, headless renderer, AI agent
- **Transports:** WebSocket, shared memory (planned), file system
- **Observers:** Renderer, UI controls, analysis pipelines

The invariant: controllers never touch render objects or the network, views never write, and sync never renders — all coordinate only through LiveScene node state.

### Layers

```
┌─────────────────────────────────────────────┐
│  Applications (cardiac, spine review, etc)  │
├─────────────────────────────────────────────┤
│  Slicer integration (LiveStory) + UI        │
├─────────────────────────────────────────────┤
│  Sync (replication, transport)              │
├─────────────────────────────────────────────┤
│  Core (LiveScene, observer dispatch)        │
├─────────────────────────────────────────────┤
│  mrson (document format + ops)              │
├─────────────────────────────────────────────┤
│  Rendering (3D/MPR fields + GPU plumbing)   │
│  Algorithms (segment editing compute)       │
└─────────────────────────────────────────────┘
```

## Code Review & Quality

**This is an AI-assisted codebase.** When reviewing code:

- Verify numerical correctness, especially in ray-marching shaders and coordinate transforms
- Check for off-by-one errors in medical coordinate systems (RAS/LPS, IJK/voxel semantics)
- Ensure WebGPU device lifecycle and resource cleanup are correct
- Validate DICOM/mrson round-trip fidelity for real datasets
- Test edge cases (empty volumes, single-slice images, extreme aspect ratios)

AI-generated code is often creative and performant but can hide subtle bugs. **Comprehensive testing and human review are essential** before any clinical use.

## Key Documentation

- **[ARCHITECTURE-2026-08-02.md](docs/ARCHITECTURE-2026-08-02.md)** — System design and invariants
- **[MRSON-LIVESCENE.md](docs/MRSON-LIVESCENE.md)** — Scene format and protocol
- **[RENDER-PERFORMANCE.md](docs/RENDER-PERFORMANCE.md)** — GPU profiling and optimization
- **[ALGORITHMS.md](docs/ALGORITHMS.md)** — Segment editing engine design
- **[UNIFIED-RENDERING-PLAN.md](docs/UNIFIED-RENDERING-PLAN.md)** — Progressive refinement and remote GPU rendering
- **[SLICERLIVE.md](docs/SLICERLIVE.md)** — Roadmap and future plans

## Development Setup

### Prerequisites
- Deno 1.x
- Node 20+ (for VTK.js bundling)
- (Optional) 3D Slicer for LiveStory integration

### Local Development

**Render library:**
```bash
cd render
deno lint
deno check
deno test --allow-write test/
```

**Live demos:**
```bash
deno run -A examples/cardiac/serve.ts  # http://localhost:8777
```

**Full build and test:**
See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed setup.

## Design Philosophy

1. **Modular, not monolithic** — Use what you need. A renderer can work standalone; sync can work with any scene model.

2. **Performance is measurable** — GPU profiling, ablation harness, regression testing. Guessing is not allowed.

3. **Vendor-neutral format** — mrson is DICOM-aware but doesn't require DICOM. It's a medical scene format, not a DICOM reader.

4. **One codebase, many contexts** — Browser TypeScript/WebGPU, headless Deno, Slicer Python. Same algorithms, different runtimes.

5. **Designed for AI** — Discrete ops, deterministic replay, API-first (no GUI required). Natural fit for AI-assisted segmentation and workflow.

## Funding

This work is supported by the NIH grant **[R01 CA310962](https://reporter.nih.gov/search/NqGZkegLQkaxQEbLxCXMdw/project-details/11343589#description)** — *3D Slicer: A unified open-source platform for advanced cancer imaging research*.

## License

Apache 2.0 — same as 3D Slicer.

## Contributing

**slicerlive** is an experimental platform under active development. We welcome:

- Bug reports and feature requests
- Performance profiling and optimization
- New field types and rendering modes
- Integration with other medical imaging workflows
- Educational use and teaching materials
- **Code reviews with attention to numerical correctness and medical imaging semantics**

**Please open issues, not pull requests.** This is an AI-generated codebase that changes fast, and
incoming patches are difficult to review fairly against it. A detailed issue — especially one showing
a wrong number — is the contribution that helps most; accepted ones get implemented by a coding agent
under review. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Acknowledgments

SlicerLive continues a line of experiments in GPU-accelerated medical imaging:

- <a href="https://github.com/pieper/SlicerCL" target="_blank" rel="noopener"><b>SlicerCL</b></a> —
  3D Slicer extensions written in OpenCL through pyopencl, including a GPU-accelerated GrowCut effect for
  Slicer's segmentation editor. It contributed the core idea behind `algorithms/`: interactive segmentation
  editing expressed as GPU compute kernels, driven live from an editor UI. It also introduced the
  compositing renderer that `render/` follows — multiple pieces of content composited in a single
  ray-cast pass — along with analytic signed-distance-field compositing and ray marching through
  nonlinear transforms, the direct ancestors of today's Fields, SDF shells, and `TransformField`.  This led to a proposal for [CommonGL](https://docs.google.com/document/d/1-4Up_Shq6oFTGhwXIF5DuiXUYsdIMlAC1oK7eNHWP_o/edit?usp=sharing) and experiments adding functionality to VTK's GLSL.

  <a href="https://www.youtube.com/watch?v=hFxTyLPjQd0" target="_blank" rel="noopener"><img src="https://img.youtube.com/vi/hFxTyLPjQd0/mqdefault.jpg" alt="Nonlinear Transforms and Volume Rendering" width="200"></a>
  <br><sub><a href="https://www.youtube.com/watch?v=hFxTyLPjQd0" target="_blank" rel="noopener">Nonlinear Transforms and Volume Rendering</a></sub>

- <a href="https://github.com/pieper/step" target="_blank" rel="noopener"><b>step</b></a> — GPU medical
  image computing in the browser with JavaScript and WebGL 2.0, working directly from DICOM-native data
  structures. It contributed the everything-in-the-browser premise, the patient/pixel/texture coordinate
  discipline and `aToB` naming conventions the renderer still uses, and the transform-composition pattern
  that `TransformField` follows today.

  <a href="https://youtu.be/ML9_JWAz1kY" target="_blank" rel="noopener"><img src="https://img.youtube.com/vi/ML9_JWAz1kY/mqdefault.jpg" alt="STEP nonlinear transform volumes" width="200"></a>
  <a href="https://youtu.be/8dputUoKBTA" target="_blank" rel="noopener"><img src="https://img.youtube.com/vi/8dputUoKBTA/mqdefault.jpg" alt="MR/US registration in step" width="200"></a>
  <br><sub><a href="https://youtu.be/ML9_JWAz1kY" target="_blank" rel="noopener">STEP nonlinear transform volumes</a> &nbsp;·&nbsp; <a href="https://youtu.be/8dputUoKBTA" target="_blank" rel="noopener">MR/US, step p3</a></sub>

Beyond these direct ancestors, SlicerLive owes its deepest debt to the
<a href="https://www.slicer.org/" target="_blank" rel="noopener">3D Slicer</a> developers and users —
decades of their designs, code, and clinical-research workflows are the inspiration for, and the reference
implementation behind, essentially everything here — and to the many software developers and researchers
who published the algorithms and open implementations this project draws on, from ray-marched volume
rendering and jump-flooding distance transforms to the ecosystem of open DICOM tooling.

---

**Gateway:** Eventually at **live.slicer.org**. Currently at [pieper.github.io/live](https://pieper.github.io/live).

**Questions?** Open an issue, start a discussion, or reach out on the [3D Slicer Discourse](https://discourse.slicer.org).
