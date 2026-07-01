# Remote wgpu Render + Stream — Plan and Research Notes

Status: **planning / research complete, no code written yet.**
Last updated: 2026-07-01.

Goal (verbatim from [`wgpu-remote.md`](wgpu-remote.md)): render the SlicerLive gallery
and scenes remotely on a **modal.com** GPU and stream them to a local browser page
using the **nvenc + QUIC/WebSocket + WebCodecs** path developed for **desktopia**. The
backend server should use **wgpu-py** (Rust WebGPU on Vulkan) driving the **SlicerWGPU**
volume-rendering infrastructure, in a **very thin** container.

This doc exists so the work can be resumed on another machine. It captures what was
researched, the decided approach, and the open item (finding a prior deployment).

---

## ⚠️ Open item — locate the prior modal deployment (resume here)

The task assumed a container "already built and debugged … currently up on modal.com
rendering the bumblebee microCT scan." **On this machine that code was not found** — not
on disk, not in any `modal_app.py`, not in the Claude chat histories. The user believes
it was built with Claude on a **different machine**. Before building green-field, recover
it from that machine:

- Run `modal app list` — the authoritative list of deployed apps. Anything **other than**
  `lnq-segmenter` and `nninteractive-slicer-server` is a candidate.
- Look for a `modal_app.py` whose image imports **wgpu-py + GStreamer/nvenc** and which
  **fetches the bumblebee volume from a GitHub URL** at startup (the data is pulled from
  GitHub by the server, MorphoDepot-style — not baked into the image). That import
  signature is the fingerprint of the render server (the two known modal apps are
  inference REST services and import neither wgpu nor gstreamer).
- If found: copy its directory/URL here and we adapt it instead of rebuilding.
- If not found: proceed green-field with the milestone plan below.

The only on-disk trace of "bumblebee" is a dataset-size example (11.4 GB μCT) in
[`MORPHODEPOT-JETSTREAM2.md`](MORPHODEPOT-JETSTREAM2.md) — cited as a scan *too big for the
browser*, which is the motivating case for remote rendering.

---

## The three building blocks (all exist; never before combined here)

Sibling repos assumed checked out next to this one (paths on the research machine shown
for reference; structure is what matters):

### 1. desktopia — the streaming stack (`../desktopia`)
`server.py` (~520 lines) is a GStreamer capture → H.264(nvenc) → transport loop with a
browser client and an input path.

- **Frame source is the integration seam.** Frames come from `waylanddisplaysrc`/
  `ximagesrc` today. The `Broadcaster` pulls encoded H.264 access units in
  `_on_sample` and fans them out to viewers (`server.py` ~196–250). Swap the capture
  element for a GStreamer **`appsrc` fed by Python frames** and a different renderer can
  push frames in with the encoder/transport/client untouched.
- **Transports:** WebTransport/**QUIC over UDP** (primary, `aioquic`) *and* a
  **WebSocket/TCP (WSS)** fallback (the NRP path). The browser WebCodecs decode
  (`client/index.html`, `VideoDecoder` codec `avc1.640028`) is identical for both.
- **Encoder:** `nvh264enc` (NVENC) with `x264enc` software fallback; H.264 High, Annex-B,
  SPS/PPS on every keyframe for late-joiners.
- **Input:** browser sends fixed-length binary mouse/keyboard messages over a reliable
  stream; server injects them via XTEST (`Injector`).
- **Deploy today:** vast.ai (Dockerfile is a thin FROM-scratch artifact; deps installed
  at runtime by `entrypoint-wayland.sh`). Not currently modal.

### 2. SlicerWGPU — the volume renderer (`../latest/SlicerWGPU`)
Field-compositing **ray-march** volume renderer via wgpu-py.

- **Portable core (reuse this):** WGSL shader generation, material-UBO packing, and
  GPU→numpy readback in `SceneRendering/SceneRenderingLib/wgpu_vtk_inject.py`
  (`_build_wgsl` ~601–1356; `_wgpu_render` ~5889–6124, readback via
  `device.queue.read_buffer`). Already **forces Vulkan-only on Linux**
  (`_force_vulkan_only_wgpu_instance` ~413–448) — exactly what headless-in-container needs.
- **MRML-free transfer function:** `wgpu_volume_render.py` uses JSON control points +
  presets (Grayscale, CT bone/soft-tissue, MR) — no `vtkMRMLVolumePropertyNode`.
- **Coupling to remove for standalone:** the pygfx `Shared` device singleton, the
  `slicer_wgpu.fields.ImageField` volume upload, and MRML scene observation.
- **Standalone proof:** `Experiments/slicer-render.py` renders offscreen with wgpu-py and
  reads back to numpy **without** the Slicer app.

### 3. modal deployment patterns (`../latest/SlicerNNInteractive/server/modal_app.py`, `../latest/lnq-segmenter/modal_app.py`)
Two working GPU modal apps to pattern the container on (image build, GPU function,
persistent Volume, web endpoint). Both are inference REST — neither renders or streams —
but the modal scaffolding is directly reusable.

### SlicerLive already specifies this feature
[`ARCHITECTURE.md`](ARCHITECTURE.md) §4 and [`SLICERLIVE.md`](SLICERLIVE.md) §4 define a
"Remote render place (Modal / JS2 / vast)" with a per-view `RenderMode`
(Local / Remote / Placeholder / Off): the *same* scene state, rendered headless on a
remote GPU, streamed back as video for scenes too big for the browser. This work
implements that seam. The viewer renders client-side (vtk.js) today; the remote path adds
a `<video>`/canvas display beside it.

---

## Decided approach

| Decision | Choice | Why |
|---|---|---|
| Renderer | **Standalone wgpu driver** (Slicer-free) | Thinnest container; lift SlicerWGPU's WGSL + material packing out of pygfx `Shared` / `ImageField`. |
| First scene | **Small test volume first** | Prove render→encode→stream→browser before out-of-core work. |
| Transport on modal | **WebSocket / TCP (WSS)** | Modal web endpoints expose only HTTPS/TCP, **not raw UDP** → QUIC/WebTransport can't run on modal. desktopia's WSS fallback already works; identical WebCodecs client. QUIC stays for vast.ai. |
| Bumblebee data | **Fetched from GitHub by the server** at startup | Keeps the image thin; matches SlicerLive's data-by-URL model. Deferred to M4 (11.4 GB needs bricking/downsampling). |

---

## Milestone plan (green-field; skip/adapt M1–M3 if prior deployment is recovered)

**M1 — Standalone headless wgpu renderer.** New dir (e.g. `SlicerWGPU/StandaloneRenderer/`
or a new repo). Extract ray-march WGSL + material packing into a driver that: creates a
wgpu-py **Vulkan** device directly (no pygfx `Shared`), uploads a numpy volume as a 3D
texture (minimal `ImageField` replacement), applies the JSON transfer function, and
renders a frame to a numpy RGBA array given camera matrices. Validate locally on a small
volume.

**M2 — Frame source into desktopia's encoder.** Add an `appsrc` frame-producer path to
`server.py` (`Broadcaster` accepts a Python frame callback instead of a capture element).
Reinterpret the existing browser mouse/keyboard messages as **camera orbit/zoom/pan**
updating the renderer's view matrices for the next frame (replaces the XTEST `Injector`).
Run M1+M2 locally end-to-end: browser ↔ local GPU.

**M3 — Thin modal container.** A `modal_app.py` (patterned on the two existing ones) with a
GPU function exposing desktopia's **WebSocket** server via `@modal.web_server`. Image =
wgpu-py + Vulkan loader + NVIDIA ICD + GStreamer/nvenc + aioquic/websockets — **no Slicer,
no desktop**. Volume fetched from GitHub URL (or a modal Volume). Deploy; stream a small
scene to the browser.

**M4 — SlicerLive wiring + scale up.** Add the remote `RenderMode` path to the viewer
(video element + connect to the modal WSS URL); wire the gallery/scene catalog to launch
remote render for big scenes; then tackle the 11.4 GB bumblebee (out-of-core / bricking /
downsample — its own sub-problem).

---

## Risks / unknowns

- **wgpu-py on Vulkan inside a modal GPU container** — needs the Vulkan loader + NVIDIA ICD
  present and a headless (no-surface) adapter. Verify adapter enumeration succeeds on
  modal's GPU image.
- **NVENC access on modal GPUs** — desktopia relies on `libnvidia-encode.so`. Confirm it's
  available on modal, else fall back to `x264enc` (CPU) for M3.
- **Standalone extraction cost** — decoupling from pygfx `Shared` and `ImageField` is the
  main engineering effort in M1.
- **Big-volume handling (bumblebee)** — 11.4 GB won't fit naive GPU upload; M4 problem.

---

## Reference: exact seams (research machine paths)

- desktopia frame fan-out / encoder: `../desktopia/server.py` ~142–154 (encoder),
  ~196–250 (`Broadcaster`), WSS path ~362–407.
- desktopia client decode: `../desktopia/client/index.html` ~329–340 (VideoDecoder),
  WS connect ~428–479.
- SlicerWGPU render + readback: `../latest/SlicerWGPU/SceneRendering/SceneRenderingLib/wgpu_vtk_inject.py`
  ~413–448 (Vulkan-only), ~601–1356 (WGSL), ~5889–6124 (render/readback).
- SlicerWGPU MRML-free transfer function:
  `../latest/SlicerWGPU/SceneRendering/SceneRenderingLib/wgpu_volume_render.py`.
- Standalone wgpu proof: `../latest/SlicerWGPU/Experiments/slicer-render.py`.
- modal patterns: `../latest/SlicerNNInteractive/server/modal_app.py`,
  `../latest/lnq-segmenter/modal_app.py`.
</content>
</invoke>
