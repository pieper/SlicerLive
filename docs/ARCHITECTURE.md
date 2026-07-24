# SlicerLive architecture (2026-06-21)

> **Superseded by [`ARCHITECTURE-2026-07-22.md`](ARCHITECTURE-2026-07-22.md)** — the latest iteration (WebGPU-native
> renderer decision, TS/Deno one-language, explicit participant contract, ColorizeVolume reference use case). This
> file is retained as the prior version; its thesis, two-axis model, authority/lease model, content-addressing, and
> substrate decision remain in force and are referenced (not duplicated) by the newer note.

*Status: canonical architecture note (2026-06-21). This is the source of truth for SlicerLive's vocabulary and
shape. It supersedes the framing (not the research) in the four exploratory notes — `SLICERLIVE.md`,
`WEB-VIEWER-VISION.md`, `DISTRIBUTED-MRML-ARCHITECTURE.md`, `MRML-COUCH-DESIGN.md` — each of which now carries a
pointer header back here. Those remain valuable for their detail (renderability analysis, the DM survey, the
Couch tradeoff, the render-isolation inventory); this note fixes the words and the overall plan they describe
inconsistently. `MORPHODEPOT-JETSTREAM2.md` is a target-use-case/hosting note and stands on its own.*

---

## 0. One-line thesis

A **LiveScene** is a live, partially-replicated MRML scene — metadata (node state) + bulk data (content-addressed
blobs) — that any number of **participants** observe and write back to over any of several **transports**. Everything
else in SlicerLive is either a participant or a transport.

That single sentence is the whole architecture. The rest of this doc is its consequences.

---

## 1. The two axes

The system used to be described as a four-layer stack (LiveScene / LiveRenderer / LiveModules / LiveInterface).
It is cleaner as **two orthogonal axes**: *who participates* and *how the scene is transported*. The four "layers"
are really four **roles of one participant abstraction** (a "place," in the older docs' word — kept here as the
umbrella term), and they are independent of the transport carrying the scene.

### Axis 1 — participants (places)

A **place** is anything holding a mirror of (a closure of) a LiveScene and doing something with it. Places differ
only by three things: do they write, what drives the writes, and their authority role.

| Participant | Reads | Writes driven by | Authority role | Name |
|---|---|---|---|---|
| read-only display | ✓ | nothing | — | **LiveRenderer** |
| human view + edit | ✓ | a person (HTML widgets) | `human` (top) | **LiveInterface** (human) |
| agent view + edit | ✓ | an LLM (tool calls) | `agent` | **LiveInterface** (agent) |
| autonomous compute | ✓ | an algorithm (seg / reg / sim) | `module` | **LiveModule** |
| Slicer itself | ✓ | the desktop app / source of truth | `human` (co-located) | (the hub) |

All five are **observe-LiveScene → act-on-LiveScene**. The renderer is the read-only corner; the human and the
agent are the same corner with a different driver; a module is the same with an algorithm driving. This is why
"**the LiveRenderer is a special case of the LiveInterface**" is literally true — it is the LiveInterface with the
write half removed.

### Axis 2 — transports

The LiveScene **protocol** (§2) binds to several transports. A place picks whichever fits where it runs; the
protocol is identical across all of them.

| Transport | node-state channel | blob channel | For | Built? |
|---|---|---|---|---|
| **HTTP + bucket** | `GET /mrml?view=` | `GET /blob?hash=` | browsers, static publish | ✅ |
| **WS hot-channel** | interaction deltas (camera, drag) | — | low-latency interaction | ✅ (offload) |
| **shared memory** | versioned scene region (seqlock) | mapped hash arena | same-machine processes | ❌ new |
| **p2p mesh** | closure replication | hash advertise / fetch | cross-machine sync | ❌ new |

Shared-memory and peer-to-peer are **not new architecture** — they are two new *bindings* of the protocol that
already exists. That is the whole trick to adding them.

---

## 2. The LiveScene (protocol)

A LiveScene is one logical MRML scene, of which each place mirrors a **closure** — the sub-graph reachable from an
anchor (a view node, a layout region, an ROI, a subject/study node), recomputed as references change. This is
exactly what a displayable manager already computes to decide what to draw; "what to replicate" reuses that logic.

The protocol has **two channels**:

1. **Node-state channel** — JSON, one record per MRML node: `{class, attrs, refs, blobs:{role:{hash,dtype,...}}}`.
   The scene graph becomes a document graph; bulk data is referenced by hash, never inlined.
2. **Content-addressed blob channel** — `hash → bytes` (gzipped raw typed arrays, polydata points/cells, labelmaps).
   Immutable by hash: an edit produces a *new* hash → a *new* blob; the old one stays valid for anyone still
   pointing at it.

Today, in code: the node-state channel is `${SCENE}/mrml?view=` and the blob channel is `${SCENE}/blob?hash=`,
with the client holding a `mirror` map + a `blobCache` keyed by hash (`viewer/slicerlive.js`). Writes go back over
the WS hot-channel (`sendGated`) and camera over `POST ${SCENE}/camera`.

> **Content-addressing is the load-bearing decision.** It is what makes shared memory lock-free (readers of an old
> hash never tear against a writer producing a new one), what makes the p2p mesh dedup for free (peers advertise
> hashes; a cohort of thousands of studies is one deduplicated store), and what makes caching trivial (an unchanged
> mesh — even a hidden node toggled back on — never refetches). See §6.

---

## 3. Participants in detail

### 3.1 LiveRenderer — the displayers

The LiveRenderer turns LiveScene node state into rendered pixels via **displayers** (the simpler name for what
Slicer calls displayable managers, and what the older docs call DMs). Today these are TypeScript/vtk.js classes in
`viewer/slicerlive.js`: `ModelDM`, `VolumeRenderingDM`, `SegmentationDM`, `ViewDM`, `OrientationMarkerDM`,
`SliceDM`, plus the interaction displayers `ROIDM`, `MarkupsDM`, `TransformWidgetDM`.

**The displayer contract** (to be made explicit — see §8 gap): every displayer is keyed by MRML node class and
implements `onNodeUpdate(node)` / `onNodeRemove(id)` over the mirror, owning its render objects. This is the same
contract Slicer's `vtkMRMLAbstractDisplayableManager` implements in C++ and `vtkMRMLScriptedDisplayableManager`
implements in Python — so SlicerLive's TS displayers are "the same contract in a third language," and **SlicerWGPU
is a fourth implementation of the same contract** (§7), not a rewrite.

**Pure-render vs. interaction.** A displayer that only reads (`ModelDM`, `VolumeRenderingDM`) is LiveRenderer. A
displayer that writes back (`ROIDM`, `MarkupsDM`, `TransformWidgetDM` — handle drags mutate the node) is, under the
two-axis model, really **LiveInterface**: it is how a human manipulates the scene. They share rendering code but
differ on the write half. (See §8 — today both live in one file; the boundary is conceptual, not yet structural.)

### 3.2 LiveInterface — human and agent

The LiveInterface is the replacement for the Qt GUI: the layer where a goal-directed actor observes the LiveScene
and writes back. It has two drivers over one substrate:

- **Human** — HTML/JS controls (layout, W/L, visibility, opacity, color/LUT, camera presets, markups, transforms,
  a data list). Today these are ~60 listeners embedded *inside* `viewer/slicerlive.js`; `viewer.html` is just a shell.
- **Agent** — the same LiveScene writes exposed as a **tool schema** (`setVisibility`, `setWindowLevel`, `addMarkup`,
  `setView`, `runModule(...)`). "The agent's widgets are tool calls." The agent observes via (a) a **semantic
  projection** of the node-state channel — a scene summary (modalities loaded, segment terminology, measurements,
  current view) rather than raw vtk node dumps — and optionally (b) the **rendered frame** from a LiveRenderer as a
  visual observation for a multimodal model.

The agent is not a special case: it is a place with `role=agent`, below `role=human`, holding leases like anything
else. Wiring it up is the forcing function that makes the authority model (§5) finally get unified.

### 3.3 LiveModule — classic modules as services

A LiveModule is a classic Slicer module (segmentation, registration, a simulation) **recast as a service that speaks
the LiveScene protocol**: it subscribes to a closure (its inputs), computes, and writes results back as MRML nodes —
wherever its compute lives (in-process, a local process over shared memory, or a remote box / Modal / Jetstream2 GPU
over HTTP or p2p). This is the older docs' "module logic → external synchronizing connection" made concrete: a module
shifts from *code linked into Slicer* to *a place holding a lease on part of the scene*. **Nothing implements this
yet** (§8) — the packaging + invocation protocol is the biggest concept-to-code gap.

---

## 4. Deployment combinations (these compose freely)

The two axes are why the deployments "mix and match." Each is a choice of participants + transports against the same
LiveScene:

1. **Browser-only bucket viewer** — publish the LiveScene to a bucket; a browser LiveRenderer reads it over HTTP. $0,
   static. *(Built — `viewer.html?scene=` / `?segroulette` / `?ct=&seg=`.)*
2. **Remote-desktop chromakey overlay** — a GPU-less Slicer streams its desktop as video; the browser LiveRenderer
   renders the 3D/slice views on the client GPU and composites them over the video via a magenta keyhole, syncing over
   HTTP + the WS hot-channel. *(Built — the "offload" mode in `slicerlive.js`, `KEY=[255,0,255]`, ports :2027/:2028.)*
3. **Remote render place (Modal / JS2 / vast)** — the *same* displayers run headless on a remote GPU, rendering a view
   too big for the browser and streaming video back; the LiveScene coordinates which view renders where (the
   render-pathway seam, §7). *(Conceptual — the "Node app running the same JS DMs headless" case.)*

A single LiveScene can use all three at once, per view (`RenderMode` Local / Remote / Placeholder / Off).

---

## 5. Authority model (unified)

Three older docs describe authority at three altitudes (per-node capability leases in `WEB-VIEWER-VISION.md` §2;
the priority interaction-lease in `MRML-COUCH-DESIGN.md` §6a; role/priority in `DISTRIBUTED-MRML-ARCHITECTURE.md`
§5). They are one mechanism. The canonical model:

- **Role priority order:** `human` > `agent` > `module` > automated. Explicit human intent is the "hand of god" that
  preempts anything. (Adding `agent` between human and module is the new piece.)
- **Single-writer-per-node interaction lease.** While a place interacts with node X it holds X's lease: it mutates X
  locally at full rate and syncs out **rate-gated, drop-to-latest** (at most one write in flight, releasing on the
  final ack). A higher-priority claim preempts; the yielding place re-seeds from consensus on release. *This is built
  today for the hub case* — `viewer/slicerlive.js:1565-1723` is exactly this controller for ROI / markup / transform /
  camera drags.
- **Lamport-LWW fallback** for uncontended races: `(logicalTime, origin, role)`, never wall-clock.
- **Echo suppression** is mandatory: never republish a change you just applied (tag by origin+version).
- **Capabilities** are per-closure: a place is *granted* a closure with a capability set (render / interact /
  write-which-nodes), enforced at the sync boundary — this is the read-only / view-only-with-edits permission model.

What's built is the lease/rate-adaptation for one client ↔ one hub. What's missing for multi-place and for agents is
the role/priority ordering and preemption across more than two parties (§8).

---

## 6. Content-addressing — the enabler

One decision pays off in four places:

- **Lock-free shared memory.** Bulk data goes in a shared `hash → buffer` arena, mapped read-only by every local
  process. Because blobs are write-once-by-hash, a reader holding `abc` keeps reading that buffer while a writer
  produces `def` — no locks on the 14 GB volume, ever. Only the small mutable scene graph needs a versioned/seqlock
  region (read-version → read-state → re-read-version, retry on change). The arena owner (the WebServer process)
  runs blob GC (ref-count or keep-last-N-versions). Browsers can't map SHM, so **the WebServer is the SHM → HTTP/WS
  bridge**: local processes map directly; remote/browser clients go through the server.
- **Free p2p dedup.** Peers advertise the hashes they hold and fetch missing ones from whoever has them
  (BitTorrent-style); per-machine SHM is the local cache of the mesh's blobs.
- **Trivial caching.** Unchanged geometry never refetches (already true in `blobCache`).
- **Cohort scale.** Thousands of studies = one deduplicated store, not thousands of files (the "scene is a closure in
  a database" idea from `DISTRIBUTED-MRML-ARCHITECTURE.md` §8a).

---

## 7. SlicerWGPU and the render-pathway seam

"What to render (the LiveScene)" is decoupled from "how/where (vtk.js-WebGL now, SlicerWGPU/WebGPU next, remote-GPU
video fallback)." Each is **another implementation of the displayer contract (§3.1) for the same scene**. A view node
carries a `RenderMode` — `Local` (render here), `Remote` (a place renders it; the core short-circuits its own render
and emits a placeholder/keyhole), `Placeholder` (cheap fill for compositing), `Off` (headless). The keyhole/offload
path is today's hand-rolled `RenderMode=Remote`. SlicerWGPU is therefore a *second renderer backend behind one
contract*, not a fork — the contract is the thing to define first (§8).

---

## 8. The substrate decision (deferred, gated on one question)

Should the LiveScene be **hub-authoritative** (Slicer/WebServer is the source of truth; everyone else subscribes) or
**symmetric multi-master** (any peer writes, no central authority, offline reconcile)? This is the single fork that
decides whether the CouchDB/PouchDB substrate (`MRML-COUCH-DESIGN.md`, 24 KB of design) is needed or dead weight.

- **Hub-authoritative** → the simple WebServer + content-addressed buckets + WS hot-channel + shared memory is
  *complete*. Couch is unnecessary. **This is what the code is.** It covers all three deployment combos (§4) and both
  new transports — *except* true peerless p2p.
- **Symmetric multi-master p2p** → you need durable replicated logs with real conflict resolution, and PouchDB-style
  multi-master replication is a proven substrate for exactly that. The p2p ambition (§1, axis 2) is the *single
  strongest argument* for keeping Couch on the table.

**Recommendation:** ship hub-authoritative now (it is built and covers the near-term combos); design the lease/closure
model (§5) so a Couch-or-CRDT replication leg can slot in *later* if peerless p2p proves necessary. Don't pay for
multi-master before a use case demands it. **Gating question to revisit:** *does any real workflow need authority-free
multi-master, or is hub-authoritative + leases enough?* Conflict strategy if/when p2p lands: single-writer-per-node
lease (default) → Lamport-LWW (uncontended fallback) → CRDT (only if concurrent *same-node* editing becomes a real
requirement, which is rare here — peers usually own different nodes/views).

---

## 9. Open design questions (tracked)

1. **Displayer contract** — make the implicit `onNodeUpdate/onNodeRemove` contract an explicit interface so vtk.js and
   SlicerWGPU are interchangeable backends (§3.1, §7).
2. **LiveRenderer ↔ LiveInterface boundary** — interaction displayers are conceptually LiveInterface; today they live
   in the renderer file. Decide whether to separate structurally (§3.1).
3. **LiveModule protocol** — packaging + invocation + result-write-back for a classic module recast as a service (§3.3).
   The largest concept-to-code gap.
4. **Agent interface** — the semantic scene projection + the tool schema + agent role in the authority order (§3.2, §5).
5. **Shared-memory transport** — arena ownership, seqlock layout for the scene graph, GC policy, the WebServer bridge (§6).
6. **p2p transport + the substrate decision** — gated per §8.
7. **Where the WebServer lives** — it is currently *not in either repo* (see gap analysis); decide whether it is the
   Slicer built-in WebServer module extended, or a new versioned component.
8. **Unified authority across >2 places + preemption** — built for one client↔hub; generalize (§5).

*Added 2026-07-24 (see [`ARCHITECTURE-2026-07-24.md`](ARCHITECTURE-2026-07-24.md) §§3–4, 9):*

9. **Event-dispatch API** — the pluggable interactor stack (`hitTest`/`onGrab*`/`cursor`), pointer-capture (grab-or-bubble) semantics, camera-root composition across a multi-view layout.
10. **Suggestion/snap provider interface** — ranked candidate writes during a drag; render-local vs. module-tier providers; commit-on-release tolerance (wishlist).
11. **Per-tier rate-control policy** — how each interaction loop (render-local / transport-sync / module-dependency) measures dependency headroom and picks its rate; the predict-then-reconcile contract.
12. **Hard-realtime / haptic loop as a distinct clock** — a bounded-latency control loop coexisting with best-effort render/sync loops over shared LiveScene state without coupling; likely its own deterministic transport binding.
13. **Adaptive-resolution controller** — transport-headroom → render-resolution/quality control law on `RenderMode=Remote`.

---

## Appendix — vocabulary map (vision ↔ older docs ↔ code)

| Canonical (this doc) | Older-doc terms | In `viewer/slicerlive.js` |
|---|---|---|
| **LiveScene** | scene closure / miniscene / "scene as a closure in a database" | `SCENE` base + `mirror` + `blobCache` |
| **place / participant** | place | (the modes: standalone / offload) |
| **LiveRenderer / displayer** | (JS) displayable manager / DM; render place | `*DM` classes |
| **LiveInterface** (human) | "reimplemented viewer controls"; UI place | the ~60 listeners in `slicerlive.js` |
| **LiveInterface** (agent) | — (new) | — |
| **LiveModule** | "module logic → external synchronizing connection"; compute place | — |
| **node-state channel** | "one doc per MRML node" | `/mrml?view=` |
| **blob channel / content-addressed** | content-addressed blob store, hash-keyed | `/blob?hash=`, `blobCache` |
| **transport: WS hot-channel** | hot/cold split (hot leg) | `sendGated`, ws `:2028` |
| **transport: shared memory** | — (new) | — |
| **transport: p2p mesh** | Couch multi-master replication | — |
| **interaction lease** | priority interaction-lease / impedance matching | `leasedId` / `sendGated` (1565-1723) |
| **render-pathway / `RenderMode`** | render pathway (Local/Remote/Placeholder/Off) | keyhole `KEY`, offload mode |
| **SlicerWGPU** | "vtk-wasm-WebGPU next" render pathway | — |
