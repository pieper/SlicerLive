# Remote wgpu Render + Stream — Plan and Research Notes

Status: **prior spike RECOVERED on this machine — resuming as "swap VTK → wgpu", not green-field.**
Last updated: 2026-07-01.

> **Note on machines.** This plan doc was written on a *different* computer, where the
> spike code wasn't present — hence the "not found" open item below. The actual
> slicerlive modal experiments were done on **this** machine and are committed here. The
> open item is resolved; see "Recovery result" immediately below it.

Goal (verbatim from [`wgpu-remote.md`](wgpu-remote.md)): render the SlicerLive gallery
and scenes remotely on a **modal.com** GPU and stream them to a local browser page
using the **nvenc + QUIC/WebSocket + WebCodecs** path developed for **desktopia**. The
backend server should use **wgpu-py** (Rust WebGPU on Vulkan) driving the **SlicerWGPU**
volume-rendering infrastructure, in a **very thin** container.

This doc exists so the work can be resumed on another machine. It captures what was
researched, the decided approach, and the open item (finding a prior deployment).

---

## ✅ Recovery result — the prior spike is HERE (was on this machine all along)

The plan above (written on another computer) assumed the render container was built "on a
different machine" and unrecoverable. In fact the slicerlive modal experiments were done
**on this machine** and are committed to this repo. Recovered artifacts:

- **Modal app:** `slicerlive` (`ap-Sqvf1XqHKSEtkGwkXSimA1`), deployed 2026-06-21 11:13 EDT.
  This is the third `modal app list` entry beyond `lnq-segmenter` /
  `nninteractive-slicer-server` that the checklist below said to look for.
- **Source:** [`tools/modal_spike/`](../tools/modal_spike/) — 22 files. The main harness is
  [`live_render_nvenc.py`](../tools/modal_spike/live_render_nvenc.py) (render-first
  multiscale Zarr pyramid /8→/1 with progressive swap, **VTK GPU volume render via EGL on
  an L4**, NVENC-native ABGR, Modal `@concurrent`, H.264 → browser WebCodecs), plus
  `live_render.py` and the probe/benchmark suite (`vulkan_probe`, `nvenc_*_probe`,
  `vtk_egl_probe`, `zarr_bench`, `chunk_bench`, `pyramid_build`, `idc_probe`, JS2 tooling).
- **Commit:** `b116c80` — *"LiveRenderer: Modal GPU remote-render spikes + progressive
  NVENC/WebCodecs"* (one commit after this plan doc's own commit `3d5257e`). Also added
  [`docs/LIVE-ARCHITECTURE.md`](LIVE-ARCHITECTURE.md).
- **Building session:** Claude chat
  `~/.claude/projects/-Users-pieper-slicer-slicer-skill/c6ab9fa4-6add-4816-86a7-0dc48bedd639.jsonl`
  (2026-06-20 → 06-21).

**Measured findings from that spike:** cold boot ~5 s (slim image), time-to-first-frame
~4.5 s (coarse-first), NVENC ~1 ms/frame, Modal Volume vs JS2 read a wash (~50–71 MB/s).
The bumblebee μCT is the 11.4 GB "too big for the browser" motivating case
([`MORPHODEPOT-JETSTREAM2.md`](MORPHODEPOT-JETSTREAM2.md)).

**So the milestones below re-anchor** from green-field (build a renderer) to integration:
the harness already renders, encodes, transports, and displays end-to-end with **VTK**.
The remaining work is to **swap the VTK render call for the `slicer-wgpu` package** and
tidy the module boundary (web/encode/transport in SlicerLive, rendering in slicer-wgpu).
See "Revised milestone plan (VTK → wgpu swap)" below.

<details><summary>Original open-item checklist (kept for the record — now satisfied)</summary>

- Run `modal app list` — anything other than `lnq-segmenter` /
  `nninteractive-slicer-server` is a candidate → **`slicerlive`**.
- Look for a harness importing wgpu/nvenc that fetches the volume from a URL at startup →
  `tools/modal_spike/live_render_nvenc.py` (VTK today, not wgpu yet; fetches a Zarr
  pyramid, not a single GitHub blob).
</details>

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

## Decided approach (revised after recovery)

The spike already renders→encodes→streams→displays end-to-end with **VTK GPU raycast (EGL
on L4)**. The remaining work is a **renderer swap plus a clean module boundary**, not a
green-field build. Two repos are involved, and the split is deliberate:

| Concern | Home | Notes |
|---|---|---|
| **Rendering** (volume → RGBA numpy) | **`slicer-wgpu`** (pip package, `github.com/pieper/slicer-wgpu`) | Already pip-installable (`pip install git+https://github.com/pieper/slicer-wgpu.git`, deps numpy/wgpu/pygfx/rendercanvas). Gains a **headless offscreen renderer** with a numpy+camera-matrix API and no `vtk`/`slicer`/Qt at call time. The pygfx volume renderer already exists in [`slicer_wgpu/demos/single_volume.py`](../../latest/slicer-wgpu/slicer_wgpu/demos/single_volume.py) (`SlicerVolumeRenderer`/`SlicerVolumeMaterial` + WGSL); MRML/VTK coupling is isolated to `build_renderer_for_volume`/`patient_to_texture_matrix`. |
| **Web / transport / encode / data** | **`SlicerLive`** | Modal app, FastAPI + WebSocket server, NVENC (PyNvVideoCodec, ABGR), camera-input coalescing, progressive Zarr pyramid loader, browser client (viewer + WebCodecs decode + `<video>` wiring). Promoted from `tools/modal_spike/` into a real module. |

| Decision | Choice | Why |
|---|---|---|
| Renderer | **`slicer-wgpu` headless renderer** (pip-installed on modal from GitHub) | Puts rendering in the rendering repo; deletes the ~300 MB VTK image floor → faster cold boot. |
| Container GPU API | **wgpu-py → Vulkan** (offscreen, no surface) | Same core the browser will use; already Vulkan-forced on Linux. `tools/modal_spike/vulkan_probe.py` already tested Vulkan on modal. |
| First scene | **Small test volume first** | Prove wgpu render→encode→stream on the existing harness before the 11.4 GB case. |
| Transport on modal | **WebSocket / TCP (WSS)** | Modal exposes HTTPS/TCP only, no raw UDP → no QUIC/WebTransport on modal. The spike's WS + WebCodecs path already works; QUIC stays for vast.ai. |
| Data | **Progressive Zarr pyramid** (Modal Volume today; JS2/GitHub-URL option) | Keep the recovered `_load_finer_bg` coarse→fine loader as-is; renderer choice doesn't affect it. |

---

## Revised milestone plan (VTK → wgpu swap)

**R1 — Headless renderer in `slicer-wgpu`.** Add a Slicer-free offscreen renderer (e.g.
`slicer_wgpu/headless.py`) exposing: `HeadlessVolumeRenderer(width, height)`;
`set_volume(array, spacing, origin=...)`; `set_transfer_function(color_pts, opacity_pts,
scalar_range)`; `set_camera(...)` or `render(camera) -> np.ndarray[H,W,4] uint8`. Reuse
`SlicerVolumeRenderer`/`SlicerVolumeMaterial` from `demos/single_volume.py`; compute
`patient_to_texture` from spacing/origin (no `vtk`). Validate locally against a small
volume (parity vs. the VTK frame). Confirm offscreen works **without Qt** (wgpu offscreen
canvas, not the rendercanvas-Qt fork).

**R2 — Swap the render seam in the harness (local).** In `live_render_nvenc.py`, replace
the VTK setup (~210–238) and `render_h264`'s VTK render+readback (~252–277) with calls to
the `slicer-wgpu` renderer, keeping NVENC/ABGR/WebSocket/progressive-swap untouched. The
renderer returns RGBA→ we keep the existing flip + RGBA→ABGR → NVENC. Run locally
end-to-end (browser ↔ local GPU) if a local GPU is available, else straight to R3.

**R3 — Promote into SlicerLive + thin modal image.** Move the server out of
`tools/modal_spike/` into a real module (e.g. `server/` or `LiveRenderer/`). Modal image =
`pip install git+https://github.com/pieper/slicer-wgpu.git` + Vulkan loader/ICD +
PyNvVideoCodec + zarr/fastapi — **no VTK, no Slicer**. Deploy; stream the small scene, then
bumblebee, via the recovered progressive path. Compare cold-boot/TTFF/fps to the VTK
baseline (cold ~5 s, TTFF ~4.5 s, NVENC ~1 ms).

**R4 — Browser wiring in the SlicerLive viewer.** Add the `RenderMode=Remote` path to
[`viewer/slicerlive.js`](../viewer/slicerlive.js): a `<video>`/canvas element beside the
vtk.js host (compositing seam at `offload3d`/`offload3d-out`, ~lines 56–66), a WebCodecs
`VideoDecoder` (`avc1.640028`, adapt desktopia `client/index.html` ~534–692), and the
modal WSS connect. Wire the gallery to route big scenes to remote render. Then tackle the
11.4 GB bumblebee out-of-core sub-problem.

<details><summary>Original green-field M1–M4 (superseded by R1–R4 above)</summary>

M1 standalone wgpu renderer · M2 frame source into desktopia's GStreamer encoder · M3 thin
modal container · M4 SlicerLive wiring. Superseded because the spike already provides the
encoder (PyNvVideoCodec, not GStreamer), transport (FastAPI WS), data loader, and a working
deploy — only the renderer swap and browser wiring remain.
</details>

---

## Risks / unknowns

- **wgpu-py offscreen on Vulkan inside modal** — needs the Vulkan loader + NVIDIA ICD and a
  no-surface adapter. `tools/modal_spike/vulkan_probe.py` already exercised this; re-run in
  the new image. Watch for the `rendercanvas` Qt dependency — use the plain wgpu offscreen
  canvas so no Qt/PythonQt is pulled into the container.
- **wgpu vs. VTK visual parity** — the pygfx renderer's TF/gradient-opacity/lighting must
  match the VTK preset the spike used, or the demo looks different. R1 includes a parity check.
- **NVENC on modal GPUs** — already working in the spike via PyNvVideoCodec (ABGR, ~1 ms);
  unchanged by the swap.
- **Big-volume handling (bumblebee)** — 11.4 GB won't fit a naive GPU upload; the progressive
  pyramid covers coarse levels, full-res out-of-core is the R4 sub-problem.

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
