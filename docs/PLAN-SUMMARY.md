# SlicerLive — one-page plan & next steps (2026-07-22)

## The goal
Make **SlicerLive** the WebGPU-native home of the SlicerWGPU rendering ideas plus a general **participant**
framework, all driven by a **reactive MRML-like core**. Rendering stops being a privileged core (vtk.js) and becomes
just another participant. **Proof-of-life:** nnLive click-to-segment → labelmap → **ColorizeVolume RGBA** render,
live, in a 4-up (3 MPR + 3D DVR), with render + compute on **one shared WebGPU device** (no CPU round-trip).

## The model (three roles, one contract)
A **LiveScene** (node-state + content-addressed blobs) is observed/written by **participants**, each implementing
only the halves it needs:
- **LiveRenderer** — node → pixels (the TS-ported SlicerWGPU ray-march + ColorizeVolume bake).
- **LiveInterface** — interaction → node writes (bidirectional Markups; single-writer lease, drop-to-latest).
- **LiveModule** — compute → node writes (**nnLive is the first test case**).

## Decisions locked (2026-07-22)
1. **TypeScript** for the shared backbone — WebGPU is one API spec, so the same renderer runs in browser **and**
   native. Python stays a first-class *participant* (Slicer, nnInteractive, training, local helper), not duplicated.
2. **Deno** for the native/headless path (built-in WebGPU via Rust `wgpu` — same standard `navigator.gpu` API as
   the browser; note the engine differs from Chrome's Dawn, so verify result parity across engines).
3. Core + participant framework + TS **LiveRenderer** live **inside `SlicerLive/`**; vtk.js kept until parity, then
   retired; TS renderer is a portable package (browser + Deno).
4. Canonical vocabulary (LiveRenderer / LiveInterface / LiveModule); "nnModule" was a typo.
5. Architecture notes = **versioned, dated files** with change summaries. Latest: `ARCHITECTURE-2026-07-22.md`.

## Milestones
- **M0** — Reactive LiveScene core: node-state store + change events + content-addressed blobs + closure engine +
  participant registry + generalized interaction lease.
- **M1** — TS WebGPU LiveRenderer: live 4-up (3 MPR + 3D DVR) from a scene volume node (ports Field / SceneRenderer;
  MPR is small net-new WGSL). Proves renderer-as-participant + zero-build.
- **M2** — nnLive as a LiveModule on the shared device: pick → interaction node → labelmap node → overlay in all
  four views, no readback.
- **M3** — **ColorizeVolume RGBA**: segmentation node bakes to `RGBAVolumeField`; nnLive edits drive the live 3D
  render. *The end-to-end shot.*
- **M3.5** — bidirectional Markups participant (reference LiveInterface).
- **Deferred** — `RenderMode=Remote` via the **local helper** (`local_render_ws.py` / a Deno peer / regular Slicer),
  not cloud-first.

## Still open (before/while M0–M1)
MPR approach (ortho-plane pass vs thin-slab DVR) · labelmap grid convention (keep 1.5 mm, no regrid) · keep the RGBA
bake fully on-GPU (replace the `scipy` carve-dilate) · standalone-tab authority (tab as its own hub).

## Next steps
1. **You:** review `ARCHITECTURE-2026-07-22.md` + `WEBGPU-BACKBONE-PLAN.md`; confirm the four still-open items (or
   defer them to when they bite).
2. **Then M0:** stand up the reactive LiveScene core in TS inside `SlicerLive/` (the backbone everything plugs into)
   — the first code, gated on your review.

**Full detail:** [`WEBGPU-BACKBONE-PLAN.md`](WEBGPU-BACKBONE-PLAN.md) · [`ARCHITECTURE-2026-07-22.md`](ARCHITECTURE-2026-07-22.md)
