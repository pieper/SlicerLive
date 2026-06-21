# The Live\* architecture — un-bundling Slicer into web-native services

*Design note (2026-06-20). The umbrella architecture the offload/SlicerLive work has converged on:
take the monolithic Slicer desktop app and break it into independent, scale-to-zero services, with the
**SlicerLive** browser viewer as the GUI + orchestrator and the **MRML scene** as the wire format that
ties them together. Supersedes the "desktopia" framing; builds on `SLICERLIVE.md` (viewer + roadmap),
`DISTRIBUTED-MRML-ARCHITECTURE.md`, and `MORPHODEPOT-JETSTREAM2.md`.*

---

## 0. One-liner

Stop shipping one heavyweight Slicer to do everything. Ship a thin browser viewer that renders on the
client GPU for the common case, and call out to small stateless services — a **renderer** and per-algorithm
**modules** — only when the work exceeds the browser. Each service spins up on demand and scales to zero.

## 1. The brand family

| Name | What it is | Where it runs | Status |
|---|---|---|---|
| **SlicerLive** | the browser viewer — JS displayable-manager layer + vtk.js + MRML/MRB/IDC loader; the GUI **and** the orchestrator | client browser; hosted once at `live.slicer.org` | shipping (v0: models + IDC SEG) |
| **LiveDesktop** | the full interactive Slicer desktop streamed as video (was *desktopia*): GStreamer/NVENC, QUIC/WebTransport + WebSocket, XTEST input, chroma-key hole-punch compositor, vast/NRP/Cloud-Run launchers | cloud GPU box | mature (Build-phase 1 done) |
| **LiveRenderer** | a stripped server-side **render-only** service — headless `slicerlive.js` on a GPU, pixels out | Modal.ai / RunPod (scale-to-zero GPU) | new — Phase 1 spike |
| **LiveModules** | individual Slicer algorithms as serverless functions (segmentation, registration, …): `data in → data out` | Modal.ai / RunPod | new — Phase 3 |

"desktopia" is no longer a brand — it is the **LiveDesktop** backend, one of SlicerLive's render fallbacks.

## 2. The shape — orchestrator + stateless services, MRML as the bus

```
                         ┌────────────────────────────┐
                         │  SlicerLive viewer (browser)│  GUI + orchestrator
                         │  DMs + vtk.js + MRML mirror │  client-GPU render (default)
                         └──────────────┬─────────────┘
                MRML scene / NRRD / VTP  │  (CORS URLs — the wire format / message bus)
        ┌────────────────┬──────────────┼───────────────┬────────────────────┐
        ▼                ▼                              ▼                    ▼
  scene-export      LiveRenderer                   LiveModules           LiveDesktop
  feed (GPU-less)   (server-GPU pixels)            TotalSegmentator      full desktop
  mrml_sync.py      headless slicerlive.js         Elastix / BRAINS      (heavy / "I need
  client renders    big scenes → video             lnq-segmenter …       the whole app")
```

Every box consumes and produces MRML scenes + CORS-addressable data (NRRD/VTP/labelmaps/markups). No box
holds session state it doesn't have to; each can scale to zero between calls.

## 3. Rendering is a three-path tier (not one server)

A correction to the tempting "put the renderer on Modal for lowest latency" framing: **the lowest *frame*
latency is the client-side path SlicerLive already has** — render in the browser, zero server round-trip,
free. A server renderer *adds* a network hop. What a server renderer actually buys is **lowest cold-start /
cost for the remote-GPU fallback** (scenes too big for the browser's WebGL ceiling) and **thin-client
reach** (render a heavy study, stream pixels to a phone). So rendering is a tier, chosen per-view by the
router already specced in `SLICERLIVE.md` (manifest size + dims vs the client's `MAX_3D_TEXTURE_SIZE` /
VRAM estimate):

1. **Client render** — browser GPU. Default, fastest, free. *Built.*
2. **Scene-export feed** — GPU-less server (`mrml_sync.py` / `slicer_scene_export.py`) holds the data, the
   client still renders. For big-but-shippable scenes. *Built (spike).*
3. **LiveRenderer** — server GPU rasterizes and streams pixels. Only when the scene won't fit the client.
   *New.* The today-fallback for path 3 is "boot a whole LiveDesktop" (multi-GB image, slow start);
   LiveRenderer replaces that with a scale-to-zero render-only container.

### 3a. Why "move the render to the data" — measured (2026-06-20)

The bytes live in AWS one hop from a Modal worker; the user's last-mile link is the wall. Largest IDC
series = **NLM Visible Human** cryosection set, **~190 GB** in one series (the largest *renderable 3D
volume* is a ~9 GB CT) — both far past the browser ceiling (WebGL2 `MAX_3D_TEXTURE_SIZE` ~2048, ~few-GB
tab memory). Download throughput on the **same** IDC objects: a residential link saturated at **~26 MB/s**
(parallel×16 barely beat single-stream → link-capped), while **Modal hit 202 MB/s (1.69 Gbps) parallel×16**
(69 MB/s single), scaling higher with s5cmd. So Visible Human takes **~2.1 h to a home machine vs ~3–16 min
to Modal**; a 9 GB CT **~6 min vs seconds**. LiveRenderer streams back only ~2–3 Mbps of H.264. → router
rule: small scenes render in the browser; big studies keep the data put, render on Modal, stream pixels.

## 4. LiveRenderer — same render code, headless, on a GPU

**Decision: the engine is `slicerlive.js` running headless on a server GPU, not a stripped C++ Slicer.**
The displayable-manager layer is now JavaScript, so the same code renders on the client and the server —
automatic fidelity parity (no "does the server match the client" problem; this is the
*offload-follows-MRML* rule for free), a tiny image, and fast cold starts, which is exactly what Modal /
RunPod reward.

- **Output:** frame-grab → H.264, reusing LiveDesktop's QUIC/WebCodecs transport (don't reinvent it).
- **The one risk to de-risk first (Phase 1 go/no-go):** headless WebGL2 **volume rendering** on a server
  GPU — the known vtk.js/WebGL2 weak spot.
- **Fastest spike route:** run the *real* `viewer.html` in **headless Chromium with the GPU enabled**
  (`--use-gl=egl`, e.g. puppeteer) on a Modal box and screenshot a volume scene; if it matches the desktop
  render, LiveRenderer is essentially a frame-grab + encode wrapper around the page we already ship.
  - Note: `headless-gl` (npm `gl`) is **WebGL 1.x only** and will not run the WebGL2 volume mapper — use a
    real EGL/GBM context (headless Chromium) or vtk.js's WebGPU backend.
- **C++/EGL headless Slicer** stays the fallback only if headless WebGL can't render volumes acceptably —
  maximal fidelity, but a multi-GB image and slow cold start, which fights the scale-to-zero goal.

## 5. LiveModules — Slicer algorithms as serverless functions

The strongest part of the plan, and it's **~80% true structurally already**: Slicer CLI modules are
SlicerExecutionModel (SEM) executables — standalone binaries with an XML I/O descriptor that take files in
and write files out. BRAINSFit/BRAINSDemonWarp, Elastix, TotalSegmentator, nnU-Net, lnq-segmenter are all
already containerizable, stateless functions. So this is **packaging + a registry**, not a rewrite:

- Each module = a Modal/RunPod function: `inputs (CORS URLs or upload) → run → outputs (URLs)`, stateless,
  scale-to-zero.
- **MRML / NRRD / VTP is the wire format** — the same data plane the renderer uses.
- The **SEM XML descriptor auto-generates the module's input form** in the SlicerLive UI — the GUI comes
  for free, exactly as it does in the desktop app today.

**First module (decided): TotalSegmentator / lnq-segmenter** — `volume URL → SEG URL`, rendered by the
existing SegmentationDM on IDC / SEGRoulette non-PHI data. It closes the full loop —
browser orchestrates → serverless GPU computes → browser renders — with no auth work.

## 6. Why this wins

- **Cost:** rent compute and rendering only when needed; everything scales to zero. No always-on GPU.
- **Latency:** the common case renders locally with zero round-trip; heavy work escalates path-by-path.
- **Modularity:** a new algorithm is a new function + a registry entry, not a new Slicer build. Contributors
  ship a service, not a 2 GB app.
- **One data model:** MRML everywhere means a result from any module drops straight back into the scene and
  renders with an existing DM.

## 7. Implementation plan

- **P0 — branding + doc truth.** Rebrand the desktopia repo as **LiveDesktop** (one SlicerLive backend).
  Refresh `desktopia/FEATURES.md`: mark clipboard / live-HUD / Ctrl-Alt-Del **done**, add the three-path
  render tier, note the genuinely-missing items (file upload/download, FUSE↔FS-Access, auth token, dynamic
  resolution). Land this doc.
- **P1 — de-risk LiveRenderer (go/no-go).** Start with the **minimal Vulkan floor** probe
  (`tools/modal_spike/vulkan_probe.py`: does a tiny container get a Vulkan stack on the GPU + true minimal
  cold start) — if Modal won't inject graphics caps, stop here. Then the Chromium/WebGL2 fidelity +
  S3→Modal throughput probe (`liverenderer_probe.py`), then load `viewer.html` with the test scene + one
  IDC volume; confirm models, slices, **and volume rendering** render headless; measure cold-start and
  per-frame time. Output PNGs first (no transport). **Platform notes:** GPU memory snapshots do *not* help —
  Modal docs say they're "incompatible with non-CUDA GPU code (graphics operations)" — so the few-seconds
  story rests on ~1 s container boot + a warm pool (`min_containers`/`buffer_containers`), not snapshots.
  Region pinning is `region=["us-east"]` (near IDC's `us-east-1` AWS bucket); there is no public `cloud="aws"`
  knob, so same-AWS-region co-location isn't guaranteed, but IDC open-data is AWS Open Data → free egress
  regardless. De-risk on Modal's free tier; keep vast/JS2 for cheap iteration if headless GL needs flag work.

  **P1 status — PROVEN on Modal (2026-06-20, L4, driver 580.95.05; spikes in `tools/modal_spike/`):**
  the GPU graphics + encode stack works end-to-end.
    - **wgpu on Vulkan binds the discrete L4** (`backend=Vulkan, adapter=DiscreteGPU, device=NVIDIA L4`) —
      the WebGPU endgame, not just the EGL/WebGL2 stopgap. EGL also works (NVIDIA vendor +
      `EGL_EXT_platform_device`, surfaceless headless GL — the Chromium WebGL2 path).
    - **wgpu render → GPU NVENC, end-to-end @1080p (measured):** **119 fps**, pipeline latency **p50
      8.5 ms** (p95 9.7). Stages: render+readback 3.1 ms, RGBA→NV12 convert (cupy, incl. H↔D copies) 4.7 ms,
      **NVENC encode 0.64 ms** (NVENC-only ceiling ~473 fps). So NVENC is a non-issue and the path clears
      real-time 1080p with latency to spare. Remaining budget is the convert + readback, which collapse when
      the NV12 convert moves into the render pass (wgpu compute shader) or unified memory removes the copies.
      NOTE: wgpu-py can't export Vulkan memory for true zero-copy and PyNvVideoCodec device-input was finicky,
      so this uses GPU color-convert + CPU-input NVENC — not the bottleneck, and unified memory erases the gap.
    - **Cold start ~5–6 s, warm ~1.6 s** for a small image — the "few-seconds LiveRenderer" holds; a warm
      pool makes it sub-second.
    - **Packaging gotcha (write it down):** Modal honors `NVIDIA_DRIVER_CAPABILITIES=all` and mounts the
      driver libs, but does **not** inject the Vulkan ICD / EGL vendor JSONs, and `debian_slim` lacks the GL
      userspace → default fallback is Mesa **llvmpipe (software)**. Fix = install the GL userspace
      (`mesa-utils-extra` pulls it) + `libglvnd0`/`libx11-6`/`libxext6`, and write
      `/usr/share/vulkan/icd.d/nvidia_icd.json` → `libGLX_nvidia.so.0` and
      `/usr/share/glvnd/egl_vendor.d/10_nvidia.json` → `libEGL_nvidia.so.0`. Then the real L4 enumerates.
- **P2 — LiveRenderer service.** Wrap as a Modal/RunPod endpoint (`scene URL + camera → frames`), stream via
  LiveDesktop's H.264/QUIC. Wire in as render-path 3 behind the router; it replaces "boot a LiveDesktop" for
  oversized scenes.
- **P3 — first LiveModule.** TotalSegmentator/lnq as a Modal function (`volume URL → SEG URL`); SlicerLive
  calls it and renders the result with SegmentationDM, on IDC data. Defer auth/PHI (non-PHI substrate).
- **P4 — LiveModules registry.** Template + manifest so any SEM module → a service, with the XML descriptor
  auto-generating the SlicerLive input UI. This is where "Slicer un-bundled" becomes general.

**Repo shape:** SlicerLive is the umbrella; `LiveDesktop` (renamed desktopia) and `LiveRenderer` are
siblings (or a `live-*` org); LiveModules live behind a registry, not in the viewer repo.

## 8. Caveats (carried from SLICERLIVE.md)

- **PHI:** scene delivery and LiveModules ship the actual data to the browser / to a service. Public /
  non-PHI (IDC, education) is the launch substrate; PHI needs a private, authed host. Auth is deliberately
  deferred for the MVP.
- **CORS** must be set on every data host (Ceph/S3 bucket policy); GitHub *release assets* are not
  cross-origin fetchable — use a CORS bucket for bulk data.
