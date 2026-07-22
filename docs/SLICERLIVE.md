# SlicerLive — live 3D Slicer scenes on the web

> **Superseded for vocabulary + overall shape by [`ARCHITECTURE.md`](ARCHITECTURE.md) (2026-06-21).** This note
> remains the reference for the product framing, scene formats, the launcher/router, IDC input, and the build
> roadmap. Where its terms differ from the canonical model (places × transports; LiveScene / LiveRenderer /
> LiveModule / LiveInterface), `ARCHITECTURE.md` wins.

*Founding design note (2026-06-13). The unifying product for the offload work: a Slicer **save** that is
**alive** on the web — rendered live on the client, always current (every save republishes), one click from
the full native app or a cloud GPU. Builds on `WEB-VIEWER-VISION.md`, `MORPHODEPOT-JETSTREAM2.md`,
`DISTRIBUTED-MRML-ARCHITECTURE.md`. Gateway eventually at **live.slicer.org**.*

---

## 0. One-liner
Open a URL → a Slicer scene (MRML/MRB) renders interactively in your browser on your own GPU, with no Slicer
install and no server for the common case. If the data is too big for the browser, one click opens the native
app or spins up a cloud GPU — the viewer tells you which you need.

## 1. Repository split (decided 2026-06-13)
- **`desktopia`** = the **desktop-sharing package** — video capture (GStreamer ximagesrc/waylanddisplaysrc),
  H.264/NVENC encode, QUIC/WebTransport + WebSocket transport, the chroma-key keyhole compositor, input
  injection, the single-port proxy, the cloud/vast/NRP launchers. Genuinely useful on its own (a "stream any
  Linux desktop to the browser" toolkit). SlicerLive *uses* it as the underpinning for the remote-GPU fallback.
- **`SlicerLive`** (new repo) = the **Slicer/MRML layer** — the JS displayable managers, the vtk.js render
  stack, the MRML/MRB **loader** + format readers, the **viewer app**, the **launcher/router**, the manifest
  spec, and the Slicer **save/publish** extension. This is where everything currently in `desktopia/offload/`
  (the DM client `offload-overlay.js`, the standalone mode, the design notes) migrates.
- **`live.slicer.org`** = the hosted gateway (the parameterized viewer + the launcher), pointing at any scene URL.

Rationale: the desktop-sharing infra and the client-GPU MRML rendering are independent concerns with different
audiences; splitting lets each be adopted/contributed to on its own, and keeps SlicerLive lightweight (no
GStreamer/CUDA) for the static-viewer common case.

## 2. Architecture — layered, host-pluggable
| Layer | What | Where (PLUGGABLE — viewer only needs CORS URLs) |
|---|---|---|
| **Scene** | a MRML scene + a small `manifest.json` (data URLs, sizes, dims, multiscale levels) | git repo / bucket / any static host |
| **Viewer** | the SlicerLive client (DMs + vtk.js + loader + router), hosted **once**, `?scene=<url>` | live.slicer.org / Pages / bucket / CDN |
| **Bulk data** | NRRD/VTP/labelmaps/markups at **CORS** URLs (whole or multiscale chunks) | **public Ceph bucket on JS2** (big) · raw.githubusercontent/jsDelivr (small) |
| **Save = publish** | a Slicer extension writes the MRML + manifest + uploads changed data | generalizes MorphoDepot's git-backed save |
| **Launcher / router** | reads scene size vs the client's WebGL caps → recommends the best render path | in the viewer |

The viewer never knows or cares where data lives — it consumes **CORS-enabled URLs**. So GitHub, a Ceph/S3
bucket, or any web server all work; pick per use case.

## 3. Scene formats — MRB and MRML+URLs (one loader)
- **MRB** (self-contained Slicer ZIP): unzip client-side (fflate) → `scene.mrml` + `Data/*.{nrrd,vtp,…}`.
  Simplest to share ("one URL = the whole scene"); downloads everything upfront.
- **MRML + URLs**: the scene's storage-node file refs resolve to URLs (a `manifest.json` maps them) → lazy /
  partial loading, deduped/CDN data, multiscale. Better for big or cohort data.
- Same MRML parser; MRB is "MRML with files bundled," MRML+URLs is "MRML with files remote."
- **Loader pieces** (the new code): (a) **MRML XML → node state** (`{class, attrs, refs}`) — port the
  attr mapping that already exists server-side in `mrml_sync.py` from VTK-getters to XML-attributes; (b)
  **format readers → typed arrays the DMs consume**: polydata via vtk.js (VTP/VTK/STL/OBJ/PLY, native);
  volumes/labelmaps via a lean JS **NRRD** parser (NRRD = header + gzipped raw; the common MRB format) or
  **itk-wasm** for arbitrary medical formats (NIfTI/DICOM/MHA); markups/transforms = JSON/matrix.

## 3b. DICOM input — SlicerLive as an IDC 3D viewer
The same loader makes SlicerLive a **3D viewer for the Imaging Data Commons (IDC)** — a complement to OHIF's
2D web viewer. IDC hosts DICOM in public, CORS-enabled GCS/AWS buckets; SlicerLive can read it directly into
MRML and render in 3D. The work is **porting the Slicer DICOM module's `DICOMPlugins` logic** (the
examine→load mapping from DICOM objects to MRML nodes) so we reliably read the hard objects:
- `DICOMScalarVolumePlugin` — image series → scalar volume (geometry, multi-frame, orientation).
- `DICOMSegmentationPlugin` — **DICOM SEG** → `vtkMRMLSegmentationNode` (labelmap/closed-surface + terminology).
- `DICOMParametricMapPlugin` — **PM** → scalar volume + display/units.
- `MultiVolumeImporterPlugin` / `DICOMVolumeSequencePlugin` — **sequences / 4D** → `vtkMRMLSequenceNode`.
- (+ RT structures, spatial registration as needed.)

Format *parsing* is partly available in JS/wasm (**dcmjs** reads SEG/SR/PM — it's what OHIF uses; **itk-wasm**
reads DICOM image volumes); what gets ported from the Python plugins is the **Slicer-specific MRML mapping +
multi-object assembly + terminology**. Result: open an IDC study (a manifest of DICOM instance URLs) → assemble
volumes + SEGs + PMs + sequences → render in 3D, no install, on free public data. (IDC's per-study scale is the
same size question as MorphoDepot — the router decides browser vs remote-GPU.)

## 4. The launcher / adaptive routing (the clever bit, and it's computable)
From the manifest's sizes/dims + the running browser's `MAX_3D_TEXTURE_SIZE` + a VRAM estimate, recommend:
- **fits the browser** → render here (free, instant, client GPU).
- **too big for the browser, fits a remote GPU** → **open in native Slicer** (`slicer://open?scene=<url>`
  protocol handler, or a `.mrb` download Slicer is file-associated with) **or launch a cloud GPU** running
  desktopia (the remote-render fallback) and reroute — matched to a GPU whose VRAM fits the data (e.g. JS2
  A100 40/80 GB, L40S 48 GB).
- **too big for any single GPU** → say so plainly (needs multiscale/out-of-core).
The recommendation is **personalized** to the actual client (a phone vs a workstation get different advice).

## 5. Hosting on Jetstream2 (OpenStack + public Ceph)
- JS2 gives **OpenStack** access + **Ceph object storage** — expose datasets as **public, CORS-configured
  S3/Swift buckets**. This is the natural bulk-data home: no 2 GB-per-file cap, no CORS proxy, multiscale-chunk
  friendly, and **free for research**. (CORS finding 2026-06-13: GitHub *release assets* are NOT
  browser-fetchable cross-origin — they 302 to a signed `release-assets.githubusercontent.com` URL with no
  `access-control-allow-origin`; `raw.githubusercontent.com`/jsDelivr send `ACAO:*` but are for small committed
  files. So big data → a CORS bucket; GitHub stays great for the scene + collab + Pages.)
- The **remote-GPU fallback** also runs on JS2 (free research GPUs) — desktopia on a launched instance, the
  "Remote render place" from the architecture doc.

## 6. Save = publish (generalize MorphoDepot)
A Slicer extension (fork/generalize `SlicerMorphoDepot`): on save, write the MRML + `manifest.json`, upload
changed data to the chosen host (bucket put / git push + bucket), and (optionally) publish/refresh the viewer
"site". So **every save updates the live web scene**. Inherits MorphoDepot's collaboration when GitHub-hosted
(issues/PRs/versioning); works against a plain bucket otherwise.

## 7. Reused vs new + migration
- **Reused (≈all rendering):** the offload DMs (Model/VolumeRendering/Segmentation/Markups/ROI/TransformWidget/
  View), vtk.js setup, camera/interaction, decorations, the `__OFFLOAD_STANDALONE` no-server path. → **migrate
  to SlicerLive**.
- **New:** the MRML/MRB **loader** + readers, the **manifest** spec, the **router**, the launch hooks
  (`slicer://` + cloud-launch via MorphoCloud's GitHub-Issue pattern), the **save/publish** extension, and the
  `live.slicer.org` gateway.
- **Migration plan:** create the `SlicerLive` repo; move `offload/spike/client/` (DM client + standalone) and
  the design notes; keep `slicer_scene_export.py` (the live-server feed) in BOTH worlds (it's the
  desktopia-offload server AND a useful "publish from a running Slicer" path); desktopia keeps server.py /
  transport / compositor / launchers.

## 8. Dev & test loop (all local, now)
The full thing is debuggable today with the existing harness — no cloud needed:
- The **local MCP Slicer** is the editing app + ground-truth renderer (and saves the test `.mrb`/`.mrml`).
- The **qSlicerWebWidget** hosts the SlicerLive viewer; drive/inspect its JS via `evalJS` (Qt6 has WebGL2 +
  WebCodecs).
- Serve a saved scene from a **local static dir** (or `file://`) → the viewer loads it → debug the loader +
  DMs, comparing against the live Slicer render via the **dual-Slicer compare** already built. Once solid, point
  the same viewer at a **public JS2 Ceph bucket**.
- (CRITICAL: never `slicer.app.processEvents()` inside MCP execute_python — issue-evalJS-and-poll across calls.)

## 9. Caveats
- **Public/non-PHI only** for bucket/Pages-hosted scenes (scene delivery ships the data). PHI → private auth'd host.
- **CORS** must be set on the data host (Ceph bucket CORS policy); avoid GitHub release assets for fetched data.
- **`slicer://`** needs Slicer to register the protocol (small core feature); `.mrb` download is the fallback today.
- **Cloud control plane** for the GPU launch — reuse MorphoCloud's authenticated GitHub-Issue launcher / the JS2 API.
- **Size** — same WebGL ceiling as the MorphoDepot analysis; multiscale + the remote-GPU fallback cover it.

## 10. Build roadmap
- **v0** — `viewer.html?scene=<mrml-url>` renders **models** from URLs (vtk.js VTP), via the standalone DMs.
  Debug locally in the webwidget against a Slicer-saved scene.
- **v1** — + **NRRD volumes** (JS parser / itk-wasm) → volume rendering + slices.
- **v2** — + **MRB** (unzip) and the **manifest** spec.
- **v3** — + segmentations, markups, transforms (DMs already written) → full scene fidelity.
- **v3b (IDC)** — **DICOM input**: port the `DICOMPlugins` logic (SEG/PM/sequences) via dcmjs/itk-wasm →
  render IDC studies from their public buckets (the 3D complement to OHIF).
- **v4** — the **router** (size vs WebGL caps) + the launch buttons (native Slicer, cloud GPU).
- **v5** — the **save/publish** extension; host data on a **JS2 Ceph bucket**; stand up **live.slicer.org**.
- **(repo)** — create `SlicerLive`, migrate the DM client + notes; desktopia keeps the desktop-sharing infra.
