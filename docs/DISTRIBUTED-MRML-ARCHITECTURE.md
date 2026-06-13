# Distributed MRML: scene closures, places, and render pathways

*Status: living design note. Captures the architecture that fell out of the desktopia 3D/2D offload
work (2026-06). Companion to `MRML-COUCH-DESIGN.md` (which covers the sync substrate: hot/cold,
conflict ordering, backend-vs-protocol). This doc is about the **shape**: what the units of
distribution are, where rendering and computation live, and how today's Slicer concepts generalize.*

---

## 0. One-line thesis

**The MRML reference-closure is the unit of distribution.** A "place" subscribes to a closure, holds a
local mirror, and renders or computes against it locally — synchronizing changes back asynchronously
under explicit authority rules. The server becomes a hollow shell that owns the authoritative data
model and event graph and delegates rendering (and, eventually, computation) to places.

Everything below is a consequence of taking that seriously.

---

## 1. What we actually built, and what it revealed

The desktopia offload renders Slicer's views on a *client* GPU from a *GPU-less* server. To make that
work we had to:

- Compute, on the server, the set of MRML nodes a view needs — its **reference closure** (view/camera
  anchor → data nodes with a display node in that view → their display/transform/property/color refs).
- Ship those node states + content-addressed binary blobs to the browser.
- Run JS "displayable managers" that turn node state into vtk.js actors — the same MRML→DM→VTK model
  Slicer uses internally, just in a third language.
- Let the browser interact locally (camera, ROI handles, markups) and **gate** writes back to the
  server's MRML nodes through a priority **lease** + a rate-adaptive controller (one write in flight,
  drop-to-latest, ack-paced).
- Replace the server's own rendering of an offloaded view with a cheap magenta **keyhole** placeholder
  (`vtkRenderer::SetDraw(0)` on the scene renderers) so the server stops doing wasted software-GL work.

Three things became clear in the process:

1. **The closure is general.** A 3D view's closure, a 2D slice view's closure, and (prospectively) a
   simulator's region-of-interest are the *same kind of object* — a sub-graph of MRML reachable from
   an anchor. "Mirror a view to a place" and "give a worker its working set" are one operation over
   different anchors.

2. **The server's pixels are waste once a place renders the view.** `SetDraw(0)` measured a 92×
   drop (17.5 ms → 0.19 ms) per 3D render, and it's the single biggest lever for interaction latency
   on a GPU-less server. Generalized across all views, the server's render cost goes to zero.

3. **The write-back path is a module logic in disguise.** A browser dragging an ROI handle *observes*
   part of the scene, *reacts*, and *writes back* — exactly what a module logic does, but across a
   boundary with explicit conflict rules. That equivalence is the door to the bigger architecture.

---

## 2. Places

A **place** is anything that holds a mirror of a closure and does something with it:

- the browser rendering a 3D or slice view (vtk.js / WebGL);
- a remote-GPU node rendering the same view headlessly and streaming video back;
- a simulation (gravity, FEM, fluid) advancing state inside its ROI;
- an AI/analysis pipeline (segmentation, registration, tracking);
- a robot or device publishing/consuming geometry;
- the server's own Qt UI (a place that happens to be co-located with the source of truth).

A place is defined by:

| Property | Meaning |
|---|---|
| **anchor** | the node(s) the closure is computed from (a view node, a layout, an ROI, a node set) |
| **closure** | the reachable sub-graph it subscribes to (recomputed as the graph changes) |
| **role / priority** | its authority class for conflict resolution (UI = "hand of god" > automated) |
| **rate profile** | how fast it produces/consumes, used for impedance matching |
| **capabilities** | render? compute? interact? read-only? |

Places are symmetric in the protocol: the substrate doesn't privilege "the renderer" over "the
simulator." They differ only in role/priority and what they publish.

---

## 3. The closure as a dynamic, reachability-based filter

A closure is **not** a static document selector — it's graph reachability from an anchor, recomputed
as references change. This is precisely what a displayable manager already computes to decide what to
draw and observe (`IsDisplayableInView` + node reference roles). Reusing it means:

- the membership of a place's mirror tracks the scene automatically (add a volume to a view → it
  enters that view's places' closures);
- a per-doc database selector **cannot** express this (no graph reachability), so a DB-backed
  substrate must materialize per-place membership tags on the hub — see `MRML-COUCH-DESIGN.md` §1a.

Content (volumes, meshes, labelmaps) is **content-addressed**: the closure ships node states by value
and big binary by hash, so dedup and caching are independent of which place asked.

---

## 4. Render pathways (the near-term seam, and the PR)

Today a Slicer view always renders itself. The keyhole hack fakes "don't render this, someone else
will" by suppressing draw and painting a chroma key. The clean version is a first-class concept:

**A view node carries a `RenderMode` / render-pathway:**

- `Local` — render normally (today's behavior, the default).
- `Remote` — a place renders this view; the core **short-circuits its own scene render** and emits a
  placeholder (or nothing). Displayable-manager `scheduleRender()` calls become cheap automatically.
- `Placeholder` — render a cheap configurable fill (the keyhole color) — for compositing.
- `Off` — don't render at all (headless data-only).

Honored in the view widget's render path (`ctkVTKAbstractView` / `qMRMLThreeDView` / `qMRMLSliceView`),
plus a **register-external-renderer** hook + event so a place can declare itself the renderer and so
the placeholder is configurable. This replaces the `SetDraw(0)`+magenta-cover Python shim with a
supported API, and it's useful beyond desktopia (embedded/headless views, mirrored sessions,
collaborative editing). **First PR scope:** the enum on `vtkMRMLAbstractViewNode` + the short-circuit
+ placeholder. Slice and 3D views both benefit.

For 5.10 today we keep the Python shim (`set_keyhole`: `SetDraw(0)` on scene renderers + a self-
clearing magenta cover renderer); the offload reads MRML (not pixels), so suppressing GL is free.

---

## 5. Module logic → external synchronizing connection

This is the load-bearing generalization.

A Slicer **module logic** today: observe MRML nodes → react → write MRML nodes, all in-process. A
**place** does the same thing across a boundary with explicit conflict rules. Therefore:

> A module logic generalizes to **an external participant that subscribes to a scene closure and
> publishes changes asynchronously**, wherever its compute lives.

Consequences:

- Compute is **relocatable**: a segmentation/registration/simulation runs on the GPU box (or a
  cluster) and syncs results into the scene; it doesn't have to be linked into the app's address
  space. "Module" shifts from *code linked into Slicer* to *a node in a distributed compute graph
  holding a lease on part of the scene.*
- **Authority is explicit and per-closure.** The lease/priority model we built for the ROI is the
  general mechanism: a place can claim part of the scene; lower-priority producers defer and re-seed
  from consensus on release (the "gravity sim vs. the user's hand" case). LWW is the fallback, not the
  design.
- **Impedance matching is first-class.** High-rate producers (60 Hz interaction, a 1 kHz sim) and
  low-rate consumers (a slow link, a downsampled renderer) decouple via rate adaptation — the renderer
  can degrade quality as a function of update frequency, RTT, bandwidth, and the video encoder's own
  resolution/latency budget.
- **Async parallelism is the default**, not bolted on: places advance independently and reconcile;
  there is no global render/compute lock.

---

## 5b. The offloadability test: is it MRML state rendered by a displayable manager?

A practical predictor of how cleanly something offloads:

> **If it is MRML node state rendered by a displayable manager, it offloads cleanly** (closure +
> JS-DM). **If it is imperative UI feedback with no MRML representation, it needs bespoke serialization
> + imperative client redraw — brittle by nature.**

| Offloads cleanly (MRML + DM) | Needs special-casing (no MRML node) |
|---|---|
| volumes, models, segmentations-as-data | segment-editor effect feedback (brush cursor, level-tracing preview, draw polyline) |
| markups, ROI, transforms | data probe / cursor readout (pure UI) |
| slice/view/camera nodes | some widget-internal interaction state |

**Worked example — the segment editor.** Each effect is an imperative Qt/Python object that creates and
positions VTK actors *directly in the slice widget's renderer* (`addActor2D(sliceWidget, actor)`,
`paintAddPoint(qMRMLWidget*, …)`), keyed by the widget and driven by mouse events. There is no MRML node
for the brush and no displayable manager. So:

- The **result** offloads (Paint writes the segmentation labelmap → MRML → syncs + re-renders cleanly).
- The **feedback** (brush cursor) does not — it has to be reverse-engineered out-of-band (serialize the
  effect parameters, redraw the circle client-side). It works, but it's the brittle exception that
  proves the rule.

**Design consequence.** The clean long-term answer is not more client hacks for each effect — it is to
*reduce the surface that lives outside the scene model*: bring transient interaction feedback into MRML
(even as ephemeral nodes), and/or extend the render-pathway concept (§4) to cover interaction feedback,
so it rides the same closure-sync as everything else. This is the same pull as §5 (module logic →
external connection): the more of Slicer's behavior that is *scene state + observers* rather than
*imperative widget code*, the more of it is distributable for free.

## 6. Where UI elements live becomes a per-element decision

Once view rendering is a place and module logic is an external connection, "browser or server?" stops
being a global architecture choice and becomes a per-element tag: *which place owns this interaction,
and where does its feedback render?*

- A slice window/level slider → owned by the browser place, instant local feedback, gated write-back.
- The segment list / module panel → server-side Qt (cheap raster, no GL).
- A markup control point → browser place during a drag (lease held), authoritative on release.

The keyhole/compositor is the mechanism that lets server-rendered and place-rendered pixels coexist
**per-pixel** (chroma-key on the GPU, with a low-rate mask for event routing). So the desktop is no
longer "a video of Slicer" — it's a composite of many places' outputs, of which the server's Qt is
one.

---

## 7. The real architecture is the data model (the honest tension)

None of the above pays off unless the shared data model is genuinely the **source of truth** and
**fast**. That's where the hard questions live (detailed in `MRML-COUCH-DESIGN.md`):

- substrate as **swappable backend vs. protocol** (CouchDB/PouchDB replication vs. a custom WS — the
  hot interaction path needs real-time, which changes-feeds don't give);
- **logical ordering** (Lamport, not wall-clock) + origin + role for conflict resolution;
- **state-replication-first vs. event-sourcing** (append-only command log → materialized read model;
  pulls toward event-sourcing for undo/redo + migration);
- **blob deltas** (sub-region volume/labelmap updates; whole-attachment replication is too coarse);
- closure membership materialized **on the hub vs. computed per consumer**.

The 2D slice-offload is the **forcing function** for these: high-rate interaction (scroll, window/
level) + large blobs (volumes) + multiple consumers is the stress case. If MRML-as-distributed-
substrate survives slice interaction at interactive rates across two places, it survives most things.

---

## 8. Slice-offload: incremental feature roadmap

The slice view is where we exercise all of the above. Build order (each increment is independently
shippable; the rendering keystone — WebGL2 3D-texture reslice — and the server serialization are
done):

0. **Infra** — client `SliceDM` (R32F 3D texture per volume; reslice each slice node via the shader),
   GPU compositor generalized to **N keyhole layers** (slice pass vs. chroma-key 3D pass), per-slice
   screen-rect tracking, `SetDraw(0)` suppression extended to slice views. *(in progress)*
1. **Background volume, grayscale W/L** — scrub (slice offset), window/level, pan/zoom local + gated.
2. **bg/fg compositing** — foreground volume + opacity; color LUTs (procedural + table color nodes).
3. **Thick slab** — slab thickness + mode (max/mean/sum) as multi-tap sampling in the reslice shader.
4. **Label / segmentation overlays** — labelmap as an indexed texture + segment colors; closed-surface
   intersection contours come later.
5. **Data probe** — RAS↔IJK + voxel value readout at the cursor, computed locally (no round-trip).
6. **Markups in slice** — control points / lines / curves projected onto the slice plane (reuse the 3D
   markups closure + the lease/handle machinery, projected to 2D).
7. **Transform visualization** — glyphs/grids for transform nodes affecting in-slice geometry.
8. **Slice intersections + reformat handles** — the interaction-DM cases (write-back to slice nodes).

Each new overlay is a **layer** the slice compositor stacks (image layers blended by opacity, vector
layers drawn over). The data each needs is already a closure-serialization problem we know how to
solve; the rendering is a shader/▒2D-draw problem on the proven WebGL base.

---

## 8a. A scene is itself a closure in a database

Take the thesis one step further: **a MRML "scene" is not a file — it's a closure within a database,
anchored by some node(s).** An entire cohort (every study, every derived segmentation, every analysis
result) lives as MRML nodes + content-addressed blobs in one store. "Opening a scene" stops being
"parse a `.mrb`" and becomes **pulling the right node closures into the right places**:

- the anchor (a subject node, a study node, a saved-layout node) defines what a session sees;
- different places get different *projections* of the same closure — a **rendering place** pulls the
  bulk data (volume scalars, meshes), while a **UI place** (a cohort browser, a worklist) pulls only
  **metadata** (names, dimensions, modality, QC status) and never touches the bytes;
- the same blob is shared by every place that needs it (content-addressed), so a cohort of thousands
  of studies is one deduplicated store, not thousands of files.

This collapses several Slicer concepts into one:

| Today | In the distributed model |
|---|---|
| Save/Load scene (`.mrb`) | commit/checkout a closure to/from the store |
| Sample data / DICOM import | nodes already in the store; pull the closure |
| Subject hierarchy | the anchor graph that closures hang from |
| "the scene" (one in-memory set) | a working set = one place's projection of a closure |

Consequences worth designing for: **lazy/partial loading** is the default (pull metadata first, bulk
on demand by hash — exactly what the UI-vs-render split needs); **scope/security** is per-closure
(a place is granted a closure, not "the database"); and **provenance** is natural if the store is
event-sourced (the closure carries its command history). This is the same machinery as the offload —
a render place pulling a view's closure is the special case where the anchor is a view node and the
projection is "everything needed to draw it."

## 9. Glossary

- **place** — a consumer/producer holding a mirror of a closure (browser, sim, AI, robot, server Qt).
- **closure** — the MRML sub-graph reachable from an anchor; the unit of subscription/distribution.
- **render pathway / RenderMode** — per-view declaration of who renders it (Local/Remote/Placeholder/Off).
- **keyhole** — the chroma-key region where a place's render replaces the server's (today's shim for
  `RenderMode=Remote`).
- **lease** — a priority claim on part of the scene for conflict resolution during interaction.
- **impedance matching** — rate adaptation between high-frequency producers and low-frequency consumers.
