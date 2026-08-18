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

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed contribution guidelines.

## Acknowledgments

This work continues a line of GPU-accelerated medical imaging experiments:

- **[SlicerCL](https://github.com/pieper/SlicerCL)** — GPU-accelerated segmentation effects (OpenCL)
- **[step](https://github.com/pieper/step)** — Browser-based GPU medical image computing (WebGL 2.0)

Deep gratitude to the [3D Slicer](https://www.slicer.org/) developers and community for decades of inspiration and reference implementation.

---

**Gateway:** Eventually at **live.slicer.org**. Currently at [pieper.github.io/live](https://pieper.github.io/live).

**Questions?** Open an issue, start a discussion, or reach out on the [3D Slicer Discourse](https://discourse.slicer.org).
