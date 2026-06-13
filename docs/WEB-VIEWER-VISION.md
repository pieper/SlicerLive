# Lightweight web viewer — vision + render-isolation inventory

*Design note (2026-06-12). Builds on `DISTRIBUTED-MRML-ARCHITECTURE.md` (places/closures/render-pathways)
and `MRML-COUCH-DESIGN.md` (sync substrate). This doc captures the **lightweight-viewer product direction**
and the **feature inventory** for what offloads cleanly vs. what needs special handling.*

---

## 0. One-line thesis

A **"fake" Slicer**: a native HTML/JS app that holds an MRML scene and reimplements the **viewer** controls
(not the full Qt/module surface), renders the views on the client GPU from MRML, and reaches for an
**on-demand** CPU or GPU helper **only when the data actually demands it** — so you pay for a machine, and
for GPU spin-up time, only when the scene requires it.

This is the same engine as the desktopia offload (MRML closure + JS displayable managers + client-GPU
render), repackaged as a **standalone viewer with no streamed desktop** — the natural product most people
asking for a "lightweight web Slicer viewer" actually want.

---

## 1. The viewer (what it IS, and what it deliberately is NOT)

- **IS:** an MRML scene mirror + the **view** widgets (3D + slice views via the JS displayable managers we
  already built) + reimplemented **viewer controls** in plain HTML/JS — layout, slice scroll/W-L/zoom,
  visibility toggles, opacity, color/LUT, camera presets, markups view/measure, transforms, a subject/data
  list. Loads `.mrb`/MRML scenes (or pulls a scene closure from a store).
- **IS NOT:** the Qt desktop, the module panels, the C++/Python module logic, the segment editor, the full
  editing surface. Most of that **isn't needed for viewing**, and it's exactly the imperative non-MRML
  surface that doesn't offload cleanly (§3).

## 2. Permission model — read-only / view-only / selective edit

Loading a scene is **per-node (or per-closure) authority**, not all-or-nothing:
- **read-only**: render + navigate; no writes (camera/slice nav are local-only view state, never written back).
- **view-only-with-some-edits**: a whitelist of editable node types (e.g. markups, ROI, display props,
  window/level) while the data nodes (volumes, segmentations, models) stay locked.
- This reuses the **lease + role/priority** mechanism from the architecture doc — a place is *granted* a
  closure with a capability set (render / interact / write-which-nodes), enforced at the sync boundary.

## 3. The render-isolation inventory (reviewed against Slicer source, 2026-06-12)

**Offloads cleanly — MRML state rendered by a displayable manager** (the whole 3D/slice view surface). All of
these are JS-DM-portable; the offload TODO tracks the unbuilt ones:

  Camera*, View*, Model* + ModelSlice, VolumeRendering*, Segmentations 2D*/3D*, Markups* (+interactive),
  LinearTransforms (handles) + Transforms 2D/3D (glyph/grid), OrientationMarker*, Ruler*, ScalarBar/
  ColorLegend, Crosshair 2D/3D, ThreeDReformat (handles), ThreeDSliceEdge, VolumeGlyphSlice (vector/tensor).
  (* = already implemented in the offload client.)
  → No bespoke direct-to-renderer drawing exists in the loadable-module widgets; everything routes through a
  displayable manager. So the **render-isolation/keyhole approach covers the entire standard view surface.**

**Needs special-casing — imperative feedback with NO MRML node** (the keyhole would suppress it; must be
redrawn client-side bespoke, or left server-rendered/video):
  - **Segment Editor effects** — the main case: Draw (polyline being drawn), LevelTracing (live contour),
    Threshold (preview overlay), Paint/Erase (brush cursor), Islands/scissors outlines. Each creates VTK
    actors directly in the slice/3D renderer keyed to the widget, driven by mouse events — no MRML, no DM.
    The **result** (the labelmap) offloads fine; only the **interactive preview** is bespoke.
  - **Markup placement preview** — the transient point following the cursor before commit (minor).
  - **DataProbe** — cursor RAS/IJK/value readout; mostly a Qt-panel widget (rides video) + can be computed
    locally in the viewer (it's just math on the volume the client already has).

**A DIFFERENT problem — non-GL render surfaces** (not render-isolation; they can't be keyholed/texture-sampled
like a GL view — they need their **own web widgets**, reading the MRML data nodes):
  - **Plot views** (`vtkMRMLPlotChartNode`/`vtkMRMLPlotSeriesNode` → `qMRMLPlotView`, vtkChartXY) → a JS
    charting lib (Plotly/uPlot/vega) bound to the plot+table nodes.
  - **Table views** (`vtkMRMLTableNode` → `qMRMLTableView`) → an HTML table bound to the table node.
  - Today (streamed-desktop offload) these just ride the video. In the standalone viewer they're small,
    well-scoped JS components — and being MRML-backed, the data syncs for free.

**Net:** for *viewing*, the only real gap beyond the displayable-manager port is (a) the segment-editor
preview (out of scope for a viewer anyway) and (b) two small non-GL widgets (plots, tables). The viewer
vision is therefore **very achievable** on top of what exists.

## 4. Tiers — browser-first, helpers on demand (pay only when the data demands it)

The render-pathway / place abstraction makes this a **per-view, per-task, automatic** decision by data size
& complexity — not a fixed architecture:

| Tier | When | Server cost |
|---|---|---|
| **Browser-only** | scenes the client GPU/RAM can render + nav (most viewing) | **$0** — static site / bucket, no server |
| **+ on-demand CPU helper** | an ITK filter / obscure pipeline / format-convert / large IO is requested | spin a CPU box for the job, tear down after (per-task) |
| **+ on-demand GPU helper** | a scene too big for the browser (huge volume/mesh) needs server-side rasterization | spin a GPU box, it becomes a **Remote render place** streaming that view's video, tear down when the heavy view closes |

- **Dynamic provisioning is the goal**: rent a machine, and eat GPU cold-start, **only when the scene
  requires it** — the light common case is free/static; cost scales with the data, not with the session.
- Same scene, different pathways: a light view renders locally; a giant volume in the same scene falls back
  to a GPU helper's video — automatic, per-view (the `RenderMode` Local/Remote seam, §4 of the arch doc).
- The CPU/GPU helpers are just **places** (compute place / remote-render place) subscribing to the scene
  closure — no new architecture, the distributed-MRML model already covers them.

## 5. Relationship to the current work + WebGPU

- This is **tier 2** of the migration spectrum (headless data model + web viewer, no Qt desktop / no always-on
  video) — see the chat analysis. Tier 3 (MRML + module logic in wasm, fully static) is reachable incrementally.
- The **display-node / render-pathway generalization** is the shared seam: "what to render (MRML scene)" is
  decoupled from "how/where (vtk.js-WebGL now, vtk-wasm-WebGPU next, remote-GPU video fallback, native-wasm
  later)." This single abstraction serves the desktopia offload, this viewer, the GPU-helper fallback, AND
  the separate WebGPU rendering work — each is "another render pathway for the same scene."

## 6. Near-term build order (after the offload DM parity is finished)

1. Finish the displayable-manager port (the offload TODO) — it IS the viewer's render layer.
2. Standalone viewer shell: MRML mirror + HTML/JS viewer controls, no streamed desktop (`__OFFLOAD_STANDALONE`
   already proves the no-video render path).
3. Scene load (`.mrb`/closure) + the read-only/selective-edit permission model.
4. Plots + tables web widgets.
5. On-demand helper protocol: CPU job place (ITK/pipeline), then GPU remote-render place (auto fallback by
   scene size), with spin-up/tear-down tied to demand.
