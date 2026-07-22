# MRML sync over CouchDB / PouchDB — design & phased investigation

> **Superseded for vocabulary + overall shape by [`ARCHITECTURE.md`](ARCHITECTURE.md) (2026-06-21), and gated by
> its §8 substrate decision.** The Couch/Pouch substrate is *deferred, not adopted*: the built system is
> hub-authoritative (WebServer + content-addressed buckets + WS hot-channel). This note becomes live again only if
> SlicerLive needs authority-free multi-master p2p — see `ARCHITECTURE.md` §8. Its conflict/lease/rate-adaptation
> and displayable-manager-survey detail remain the reference regardless of substrate.

Status: design proposal (2026-06). Successor to the VTK-render-window-level sync spike
(`offload/spike/`), which proved client-GPU rendering + compositing but is the wrong sync layer
(see `MEMORY`/project notes: "as wrong as doing it at the OpenGL level").

## 1. Goal

Make **MRML the source of truth** and sync it to many consumers, each of which reconstructs the
part of the scene it needs:

- **Browser render clients** — one per `viewID`; run JS "displayable managers" that translate MRML
  → vtk.js actors, render on the client GPU, and composite over the streamed Qt desktop.
- **Remote GPU render servers** — the legacy Qt UI runs on a cheap CPU box; the *render-relevant*
  subset of the scene syncs to a GPU box that renders the 3D view(s) and streams video back into the
  desktopia compositor. The GPU box can be a full Slicer, a trame app, or **a Node app running the
  exact same JS render code we write for the browser**.
- **Other processes** — analysis, simulation, UI/IO devices, robots — that subscribe to and write
  back into the "main" scene.

The unifying idea: **one logical MRML scene, partially replicated** into per-consumer "miniscenes",
each reconstructed locally. The substrate (CouchDB/PouchDB or a custom log) provides durable storage
and replication; we provide the MRML-native semantics: a reference-closure filter, interaction-aware
sync rates, and a deliberate conflict policy.

## 1a. Framing in MRML's own mechanisms (supersedes the hot/cold framing in §4)

MRML already gives every view/module a way to know *exactly* which data is relevant to its
configuration: examine nodes by type, follow **node references**, and add/remove observers to stay
current. The distributed renderer should follow the same model:

- **The replication filter IS the node-reference closure.** A consumer anchors on the node(s) it owns
  (a view node / layout region). Its working set = the transitive closure over references from that
  anchor (view ← display nodes targeting it → data nodes → transforms, color, storage/blob). This is
  exactly what a displayable manager computes to decide what to render and observe — so "what to
  replicate" reuses existing logic. The closure is **dynamic** (visibility/reference changes grow or
  shrink it), mirroring MRML's add/remove-observer behavior. (Couch's per-document selectors can't
  express graph reachability → the hub materializes per-consumer membership tags, or we push the
  closure over our own channel. The graph logic lives where it already exists: the Slicer hub.)

- **One data model (MRML nodes), interaction-adaptive sync RATE — not a fixed hot/cold partition.**
  Camera = vtkMRMLCameraNode, slice offset = vtkMRMLSliceNode, the handle drives a
  vtkMRMLTransformNode. "Hot" data is just MRML nodes. The real rule: *a node under active local
  interaction is mutated at full rate locally and synced outward at a connection-adapted, downsampled
  rate, converging when interaction settles.* That single rule covers the camera, the transform
  handle, and the slice-plane-in-3D examples. The custom low-latency transport (WS/WebTransport) still
  exists, but it carries the **same** node updates on a tighter pipe while interacting; settled state
  flows over durable replication. Authority for an interacted node is **localized to the viewer that
  owns that layout region** (the transform handle and its view are delegated there).

## 2. Why Couch/Pouch fits — and the two places it doesn't

Fits well:
- Bidirectional, multi-master replication (many processes read/write the same scene).
- **Filtered replication** (Mango selectors, per-document, no JS process) → each client/viewID pulls
  only its subset efficiently. This is the mechanism for "render what's needed for this viewID."
- Conflict model that *keeps* divergent revisions (deterministic winner + surfaced conflicts) rather
  than silently losing writes — important when UI + analysis + robot all touch the scene.
- Live changes feed to drive incremental local updates.
- Offline / intermittent consumers (a robot or an analysis job) reconcile when they reconnect.

Does **not** fit (custom implementation required — call these out early):
- **High-frequency ephemeral state** (camera pose, interaction, viewport rect during a window drag,
  cursor). Routing these through documents bloats the revision tree and the changes-feed latency is
  not tight enough. → keep these on a **custom low-latency channel** (today's WS on `:2028`;
  WebTransport later), keyed by `viewID`. NOT in the DB.
- **Large binary payloads** (volume voxels, polydata points/cells, segmentation labelmaps). Couch
  attachments are whole-document-revision granularity; a segmentation paint that touches a sub-region
  would re-ship the blob. → a **content-addressed blob store** (hash-keyed, immutable, dedup'd — the
  same trick as the spike's `/array?hash=`), referenced by the node doc, with **delta encoding** for
  incremental edits.

This **hot/cold split** is the central design decision and the thing to validate first.

## 3. Data model: MRML → documents

- One **document per MRML node** (`_id` = node ID). Body = node class, attributes, and **references
  to other nodes by id** (the MRML scene graph becomes a document graph).
- **Binary data** lives in the content-addressed blob store, not in the node doc; the doc carries the
  blob hash(es). Cold scene structure stays small and cheap to replicate; big data is fetched by hash
  and cached.
- **View/layout/window state**: a view-node doc per 3D view carrying camera (HOT — see §4), plus the
  **on-screen geometry** (screen x/y/w/h of the view widget) needed for compositing. *Investigate:*
  Slicer's view geometry currently lives Qt-side / in the layout manager, not in MRML — we likely
  need to surface per-view screen rect + DPI into MRML (or a parallel "presentation" doc) so any
  client can composite correctly without Qt.
- **Per-consumer assignment**: which `viewID`s / node subsets a given consumer renders → drives the
  Mango selector for its filtered replication.

## 4. Hot/cold split (the crux)

| | COLD (durable, Pouch-replicated) | HOT (ephemeral, custom channel) |
|---|---|---|
| Examples | model/volume/segmentation nodes, display props, transfer functions, transforms, layout, view assignments, screen geometry | camera pose, mouse/interaction, viewport rect mid-drag, cursor |
| Transport | CouchDB ⇄ PouchDB filtered replication | WS/WebTransport keyed by viewID |
| Consistency | eventual, conflict-managed | best-effort, last-writer, low-latency |
| Why | needs durability + multi-writer + offline | revision churn + feed latency make Pouch wrong here |

A TF drag is the interesting boundary case: it's a *cold* edit (changes the scene) fired at high
frequency. → coalesce at the **MRML/semantic** source (one doc write per settle, or throttled), so we
don't churn revisions. Measure whether even the coalesced cold path is fast enough or whether TF needs
a hot-path fast-lane.

## 5. Topology

```
  Slicer (Qt UI; CPU box, local or rental)
     │  writes MRML changes -> node docs + blob store
     ▼
  CouchDB (server-local)  ──filtered replication──►  PouchDB (browser, viewID=A)  ─► JS DMs ─► vtk.js ─► composite over video
     │                    ──filtered replication──►  PouchDB (browser, viewID=B)
     │                    ──filtered replication──►  Node GPU render server ─► JS DMs ─► vtk.js (headless GL) ─► video ─► desktopia compositor
     │                    ──filtered replication──►  analysis / sim / robot (read subset, write results back)
     ▼
  (hot state: camera/interaction over WS per viewID, bypassing the DB)
```

- Server-local CouchDB (or a PouchDB sidecar) is the hub. Slicer is one writer among several.
- The **remote GPU render server is just another consumer** running the same JS render code — the
  browser path and the Node-GPU path share the DM + vtk.js implementation.
- Analysis/sim/robot processes are first-class participants: subscribe to their subset, write results
  back as MRML nodes, which propagate to every renderer.

## 6. JS displayable managers

A registry keyed by MRML node class; each manager owns the vtk.js objects for its nodes and reacts to
Pouch `changes`:
- `ModelDM`: model node (+ display node) → polydata actor (geometry from blob store).
- `VolumeRenderingDM`: volume node + VR display/property → vtk.js volume + transfer functions.
- `SegmentationDM`: closed-surface representation → actors (delta-friendly blob updates).
- `MarkupsDM`, `TransformDM`, … as needed.
- A `ViewDM` applies camera (from the hot channel) + screen geometry (from MRML) for compositing.

This is a C++→JS port of Slicer's existing, debugged displayable-manager logic — the same kind of
translation as the project's prior C++→Python work.

## 6a. Conflict, authority, and loop control (deliberate — to avoid runaway chaos)

Two policy principles:
1. **UI events get priority** over automated writers (single-user → the interacting component is clear
   from app state).
2. **Most-recent-wins** on a true conflict.

Mechanism (more than Couch gives by default):
- Every change carries `(logicalTime, origin, role)` — a Lamport-style counter, NOT a wall clock
  (clocks drift across machines). Resolution: higher `role` (UI > automated) wins; tie → higher
  `logicalTime`; → deterministic `origin` tiebreak. (Couch's own revision-tree winner is overridden by
  applying this in-app.)
- **Priority-based interaction lease** (proposed, stronger than raw LWW): a lease on node X carries a
  **priority**, and a higher-priority claim **preempts** the current holder. When a viewer begins
  interacting with X it broadcasts ownership (`X owned by me, priority P, gen N`); other writers (e.g. a
  60 Hz physics sim, lower priority) observe the lease and stop *publishing* to X (they keep computing
  internally) until release; on release they read the consensus value and resume from there. **Explicit
  user intent sits at the top of the priority order** — UI actions are the "hand of god" that override
  things which would otherwise have priority (manually moving the falling body preempts the gravity
  sim's lease, the sim yields, then resumes from the new pose). This unifies "UI priority" (principle 1)
  and the lease: `role`/intent IS the lease priority. Raw LWW is the fallback when no lease is held.
  (OPEN: explicit lease vs optimistic LWW — see §10.)
- **Echo / loop suppression (mandatory):** a participant must never republish a change it just applied
  from someone else (tag by origin+version, suppress). Without this, derived-update chains A→B→A run
  away — the named "runaway chaos."
- **Conflict feedback is just MRML observation:** the losing/yielding writer observes the node and
  adapts (the sim re-seeds from the new pose) — the existing event model carries it; no special path.

## 6b. Motivations beyond desktopia (each stresses the design differently)

- **Simulation isolation** — a sim is a process holding its closure, observing inputs, writing outputs,
  off the UI loop. Strongest argument for the interaction lease (§6a).
- **Scene migration** machine→machine without data loss — wants durable content-addressed blobs + a
  replayable change log.
- **Progressive state / undo-redo** (currently missing in Slicer) — pulls toward **event sourcing**: an
  append-only log of MRML changes/commands as the source of truth, with current node-state as a
  materialized read model (CQRS). Couch's pruned, conflict-oriented revision history is NOT that log.
  This is a real architectural fork (state-replication-first vs log-first) — see §10.

## 6c. Rate adaptation / impedance matching (a pillar of the MRML redesign)

A high-frequency PRODUCER (a local interaction loop) and a low-frequency CONSUMER (the server, other
views) must **adapt to each other** so the perceptual experience maps well. The local mini-scene runs the
interaction loop at full rate; outbound updates are GATED to what the transport + consumer can absorb,
**dropping intermediate values (coalesce-to-latest, never queue)** so there's no backlog and the consumer
is always eventually-consistent on the most-recent value.

Mechanism:
- The producer (the viewer holding the interaction lease, §6a) renders locally at full rate and emits node
  updates outbound at a rate **R** that adapts to measured capacity.
- **Drop-to-latest:** between emissions the producer coalesces to the latest value (only the most recent
  ROI box / camera pose is ever sent) — no stale queue, so lag can't accumulate.
- **Signals that set R** (we control the whole chain, so all are available): round-trip time, network
  bandwidth, the consumer's *observed consume rate* (how fast its version advances / acks), and the
  **video encode resolution/bitrate** of the desktop stream — the 3D-state channel and the video channel
  share one budget.
- On lease release, a final authoritative value is sent → global convergence.

**Transparent + queryable.** The effective rate / sync budget per channel (per miniscene or node-group) is
an INSPECTABLE signal any component can read, and a renderer **downgrades quality as a function of it**:
lower volume sample rate / a low-res proxy while updates are frequent or the budget is tight, full quality
when settled — and the same controller co-adapts the desktop video encode resolution. Because the whole
chain is ours, this is automatic and unified.

**Reliable async:** drop-to-latest + logical-clock LWW (§6a) + the lease make it robust to out-of-order,
dropped, and delayed updates — apply only the latest, never regress, no queue to back up.

**Canonical first case — the volume-cropping ROI (also the first interaction DM):**
- The user drags the ROI in the browser; the browser holds the ROI lease and re-crops the LOCAL volume at
  interactive rates (tight mini-scene loop).
- Outbound ROI updates to the server are gated + dropped-to-latest at the rate the server's slice-view
  update can absorb; the slice view lags slightly (acceptable) but never backs up.
- The controller drops updates the moment it detects the server can't keep up (server version advances
  slower than the producer emits) → caps R, coalesces.
- On release, the final ROI is sent → server + all views converge.

## 7. Phased investigation plan

Each phase answers a question, ships a small spike, and **surfaces the risks that may force custom
implementations**.

- **Phase 0 — MRML⇄doc round-trip.** Represent a tiny scene (1 model, 1 volume, 1 view node) as Couch
  docs + blob store; Slicer→docs→Slicer round-trips faithfully.
  *Risks:* faithful (de)serialization of node attributes + references; reference integrity; choosing
  attachment vs external blob store; node-id stability across processes.

- **Phase 1 — one-way cold replication → browser render.** CouchDB→PouchDB (filtered to one viewID);
  `ModelDM` reconstructs and renders it on the client GPU.
  *Risks:* selector correctness; cold-update latency end-to-end; blob fetch/caching performance;
  out-of-order doc arrival (a node before its blob) → need an MRML-level reconcile pass.

- **Phase 2 — hot/cold split + latency budget.** Camera/interaction over WS; scene over Pouch.
  Measure: TF edit (cold) vs camera move (hot) end-to-end latency; revision growth under a TF drag.
  *Risks:* where Pouch is too slow; whether TF needs a fast-lane; coalescing strategy at the MRML
  source.

- **Phase 3 — bidirectional, multi-writer, conflicts.** Browser/process writes back MRML (a markup, a
  segmentation edit, an analysis result); two writers touch the same node.
  *Risks:* conflict frequency; resolution strategy; **doc-level conflict vs field-level MRML
  semantics** — may need to split a node across multiple docs (per-attribute) or add merge hooks.

- **Phase 4 — per-viewID views + MRML-driven compositing.** Multiple views/clients; each composites
  from screen geometry carried in MRML.
  *Risks:* surfacing Qt/screen geometry into MRML; selector design per consumer; multi-view overlay
  bookkeeping.

- **Phase 5 — remote GPU render server.** Node app running the same JS DMs + vtk.js on headless GL,
  consuming the same replication, streaming video back to the desktopia compositor.
  *Risks:* headless WebGL/GL in Node (or vtk-wasm); parity of DMs across browser vs server; wiring the
  returned video into the existing hole-punch compositing.

- **Phase 6 — scale & perf.** Many nodes, large volumes, many consumers; revision pruning; blob-store
  GC; segmentation-paint deltas.
  *Risks:* replication throughput; revision-tree growth; large-attachment handling; whether a **custom
  delta protocol** is needed for big incremental binary updates; changes-feed latency under load (may
  need the WS to signal "pull now" instead of relying on the live feed).

## 8. Likely custom-implementation points (consolidated)

1. **Hot path** — camera/interaction over a custom low-latency channel, not the DB.
2. **Blob store + deltas** — content-addressed binary, with sub-region deltas for segmentation/labelmap
   edits (attachments are too coarse).
3. **MRML-source event compression** — coalesce high-frequency edits (TF drags) into throttled doc
   writes to avoid revision churn.
4. **Conflict semantics** — doc-level Couch conflicts vs field-level MRML; possible per-attribute doc
   splitting or merge hooks.
5. **Out-of-order reconcile** — Pouch gives no cross-doc ordering; need an MRML-level apply pass robust
   to a node arriving before its data/reference (analogous to vtk.js `synchronize`, but semantic).
6. **Change notification** — if the live changes feed lags under load, use the WS to nudge "pull now."
7. **Screen/window geometry in MRML** — surface per-view rect + DPI so compositing needs no Qt.

## 9. Prior art to review

- CouchDB/PouchDB replication + conflict docs; Mango selector-based filtered replication.
- RxDB (Couch-style replication protocol over other backends) — if Couch attachments/revisions prove
  limiting, the *protocol* may still be reusable on a different store.
- trame-slicer (MRML/libSlicer-level but **server-side** render) — contrast for the render split.
- Slicer's existing displayable managers (the C++ to port) and any prior Slicer+Couch/Kanso efforts.

## 9a. Displayable-manager survey & generalization (Slicer core, 2026-06)

Enumerated the core DMs (`find slicer-source -iname '*DisplayableManager*.h'` → 33 files). The point: the
JS-DM port isn't ad-hoc — it mirrors an interface that **already exists and is already implemented in more
than one language**.

**The contract every DM implements** (`vtkMRMLAbstractDisplayableManager`):
`Create()`, `UpdateFromMRML()` / `UpdateFromMRMLScene()`, `OnMRMLDisplayableNodeModifiedEvent(caller)`,
`ProcessMRMLNodesEvents(caller,event,callData)`, plus (for interactive ones)
`CanProcessInteractionEvent` / `ProcessInteractionEvent`. A renderer DM keeps a **node→actor map**
(`GetActorByID`/`GetIDByActor`) and `UpdateActorProperties`/`UpdateMapperProperties`. **Our JS DM registry
is the same contract** — `onNodeUpdate/onNodeRemove` over the MRML mirror, owning vtk.js actors.

**Precedent that this is language-agnostic:** `vtkMRMLScriptedDisplayableManager` already lets DMs be
written in **Python**; extensions register them. JS DMs are the same idea in a third language — so the
abstraction is proven, and extension authors could ship JS DMs alongside their C++/Python ones.

**Two categories (this is the whole taxonomy):**

1. **Renderer DMs — MRML → vtk actors, one-way. Port cleanly to JS (exactly our approach):**
   `Model`, `VolumeRendering`, `Segmentations3D`, `View` (box/axes/bg), `Camera`, `OrientationMarker`,
   `Ruler`, `ScalarBar`, `ColorLegend`, `ThreeDSliceEdge`. *Desktopia needs the first three now; the rest
   are additive and mechanical.*

2. **Widget / interaction DMs — render a widget AND write BACK to MRML (`*InteractionEvent`). These are
   the bidirectional ones and map onto the interaction-lease model (§6a):** `Markups` (place/edit, one DM
   delegating to per-type `vtkSlicerMarkupsWidget`/representation — fiducials, lines, curves, ROI, planes,
   angles), `LinearTransforms` (transform handles), `Transforms3D` (glyphs + interaction), `Crosshair3D`,
   `ThreeDReformat` (slice-plane handles in 3D). The *widget rendering* ports like a renderer DM; the
   *interaction logic* is what gets delegated to the viewer that owns the layout region, mutating the node
   locally at full rate and syncing out at adapted rate. vtk.js has widget infrastructure
   (`vtkWidgetManager`, handle widgets) to build on.

**A third axis (defer): slice/2D-view DMs** — `VolumeGlyphSlice`, `ModelSlice` (intersections),
`Crosshair`(2D), `Segmentations2D`, `Transforms2D`. These need reformatted-image rendering and are a
separate sub-effort from the 3D path.

**Infrastructure (not DMs to port, but their JS analogues):** `DisplayableManagerFactory` + `…Group` →
our per-view JS DM **registry**; `Abstract{ThreeD,Slice}ViewDisplayableManager` → JS base classes; the
helpers (`Annotation/MarkupsDisplayableManagerHelper`) → shared JS widget bookkeeping.

**Generalization assessment:**
- The renderer category (≈10 DMs) is **mechanical** — a node→actor map + property application; the work is
  breadth, not depth, and each is independently shippable. Desktopia's three prove the pattern.
- The interaction category (≈5 DMs) is **the real design work**, and it's the same work as the
  interaction-lease (§6a/§10): who owns the widget, full-rate-local + adapted-out, write-back, conflict.
  Doing one (transform handle, per your example) exercises the whole distributed-interaction story.
- Markups being a single DM with a per-type widget sub-registry means JS gets **one** `MarkupsDM` + a
  representation registry, not N managers.
- Extensions: same contract; the scripted-DM precedent means third-party JS DMs are viable later.

Implication for the build order: finish the **renderer DMs for desktopia** (Model → VolumeRendering →
Segmentation) to lock the registry + MRML-mirror plumbing, then take **one interaction DM** (transform
handle) to drive the lease/authority design end-to-end.

## 10. Open design decisions (to assess before committing)

1. **Substrate role** — CouchDB/PouchDB as a *swappable persistence/migration backend* behind
   MRML-native sync semantics (recommended), vs adopting its replication protocol as the transport
   (which imports its non-LWW conflict model). Don't let Couch's defaults dictate semantics.
2. **Conflict handling** — explicit **interaction lease** (UI yields/leases, sim defers) vs optimistic
   **LWW** with role priority and accepting transient fights. The sim example argues for the lease.
3. **Change representation** — **event/command log first** (event sourcing → undo/redo + migration
   replay, ordering explicit) vs **current-state replication first**, log added later. Undo/migration
   goals argue for log-first; desktopia alone doesn't need it.
4. **Where the closure is computed** — the Slicer **hub** materializes per-consumer membership from the
   reference graph (reuse displayable-manager reachability; recommended) vs each consumer recomputing.
5. **Logical clock** — Lamport counter vs per-node (version+origin) vector; how `role` priority and
   tiebreaks compose.
6. **Doc granularity** — one doc per MRML node (start here; conflicts are whole-node) vs per-attribute
   docs (only if two writers routinely touch different fields of the same node concurrently).

The **short-term desktopia fix** (§7 Phase 0/1) does NOT depend on 1–3: stream the 3D view's
reference-closure node states over the WS + JS displayable managers, camera local. It fixes the
VTK-level reliability problems (show/hide becomes a semantic visibility attribute) and validates the
closure-filter + DM-port approach before the bigger forks are decided.

## References

- PouchDB conflicts: https://pouchdb.com/guides/conflicts.html
- CouchDB replication & conflict model: https://docs.couchdb.org/en/stable/replication/conflicts.html
- Mango queries / selector replication: https://docs.couchdb.org/en/stable/ddocs/mango.html
- PouchDB changes feed (near-real-time caveats): https://pouchdb.com/guides/changes.html
