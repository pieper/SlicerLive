# SlicerLive architecture — iteration 2026-08-02: the scene-sync foundation

*Status: latest canonical iteration. **Supersedes the framing of [`ARCHITECTURE-2026-07-24.md`](ARCHITECTURE-2026-07-24.md)**
(which stands as the prior version and whose event-model §3 and multi-rate §4 carry forward unchanged). The enduring
model — two-axis places×transports, LiveScene protocol, participant contract, authority + lease, content-addressing,
RenderMode — is unchanged. This iteration commits the decisions needed to build the **core architecture** rather than
the proof-of-concept: local authority per place, a sync layer decoupled from rendering/UI, and the by-construction
observer-MVC contract that mirrors Slicer's own. It also records the terminology harmonization and the divergence/
authority rules for later multi-master work.*

---

## 0. Framing: proof-of-concept → foundation

Everything built to date (`render/*`, `LiveStory/LiveStoryLib/mrson_*`, the gallery demos) is the **proof of
concept**. It established two things we no longer need to prove:

- **Sync works** (Slicer↔SlicerLive over mrson, locally, at interactive rates), and
- **Rendering parity** (the TS/WebGPU renderer can reproduce Slicer's rendering features).

What it did **not** build is the **core architecture**: places that are locally authoritative, with state sync as a
first-class, decoupled concern. That is the job now. The three-fold goal:

1. **Get the scene sync working cleanly** — `LiveScene` as a locally-authoritative observable model + a sync layer
   (debounce / coalesce / drop / echo-suppress / eventual-consistency / impedance-match) **decoupled** from everything
   that renders or writes.
2. **Adapt the rendering infrastructure onto that model** — DisplayableManagers observe LiveScene and rebuild render
   objects from node state; nothing mutates a render object directly (07-24 §7 discipline, now enforced by construction).
3. **Continue porting core Slicer functionality** onto the new foundation.

---

## 1. The by-construction observer-MVC contract

SlicerLive mirrors Slicer's own MVC/observer shape, in Slicer's own terms. Three participants, and **they touch only
the LiveScene** — never each other, never the transport:

```
   DisplayableManagers            Interactors + Controls
      (the View: read)            (the Controller: write)
              \                        /
               \   observe    write   /
                v                     v
        ┌───────────────────────────────────┐
        │   LiveScene  (the Model)           │   local authoritative node-state (mrson nodes) + blobs
        │   applyOp() → mutate → notify      │   every write tagged {origin, version}
        └───────────────────────────────────┘
                ^                     |
      apply     |   observe writes    | 
     remote ops |                     v
        ┌───────────────────────────────────┐
        │   LiveSync  (per peer/transport)   │   debounce · coalesce · drop · echo-suppress ·
        │                                     │   update-on-complete · impedance-match · LWW
        └───────────────────────────────────┘
                          ^  transport (WS / HTTP / SHM / p2p)
                          v
        remote peer: Slicer (mrson_live) — itself a locally-authoritative place — or another LiveScene
```

- **LiveScene = the Model** — the local authoritative mirror of an MRML scene as mrson nodes (+ content-addressed
  blobs). It exposes `applyOp(op)`: apply a mutation (from a local Control/Interactor **or** an inbound remote op) to
  the node state and **notify observers**. Every write carries `{origin, version}`. This is the analogue of
  `vtkMRMLScene` + its node `ModifiedEvent`s.
- **DisplayableManager = the View** (unchanged contract) — keyed by node type; `onNodeAdded/onEvent/onNodeRemoved`;
  rebuilds render objects (Fields) from node state and requests a render. Read-only w.r.t. the model. Analogue of
  `vtkMRMLAbstractDisplayableManager`.
- **Interactor / Control = the Controller** — the write half.
  - **Interactor**: pointer-driven (grab-or-bubble stack, camera as root — 07-24 §3). A grab produces node-state
    writes (`applyOp`), takes the node's interaction lease, releases on pointer-up. Analogue of
    `vtkMRMLViewInteractorStyle` + the 3D widgets.
  - **Control**: a data-bound DOM widget (checkbox, slider, color) — the DOM dual of Slicer's **qMRML widgets**,
    **1:1**: every Slicer `qMRML*` widget corresponds to a SlicerLive `Control` (Qt-bound-to-MRML ⟷ DOM-bound-to-
    LiveScene, same observe-node + write-node contract, different toolkit). It **observes** a node property (reflects
    current state, updates when it changes from anywhere) **and writes** a node-state change on user action. Symmetric
    to a DisplayableManager: one observes-to-render, the other observes-to-reflect + writes. **Porting recipe:** a
    Slicer module's Qt GUI = its `.ui`'s qMRML widgets → a set of Controls over the same node properties.

**The invariant that makes it by-construction:** Interactors and Controls **never** touch render objects or the
transport; DisplayableManagers **never** write; LiveSync **never** renders. All three coordinate *only* through
`LiveScene` node state. Adding a node type, a displayer, a control, or a tool is a uniform recipe, and the same code
runs standalone or connected — because "connected" only adds a LiveSync peer, it changes nothing above the model.

---

## 2. LiveSync — the decoupled sync layer (the hard part, done once)

**Mental model: LiveScene is a local database; LiveSync is replication (CouchDB-shaped).** The LiveScene's observer
dispatch **is its `_changes` feed**; DisplayableManagers and Controls are pure **changes-feed consumers** (that is
exactly the observer-MVC — they react to the local change stream and nothing else). `LiveSync` is **replication
between two databases** (this LiveScene ↔ Slicer's MRML via `mrson_live`, or ↔ another LiveScene): it reads the local
changes feed to push out, and writes inbound changes to the local DB. It is the **only** component that knows about
the wire — deliberately isolated so all coalescing/throttling/downsampling lives in one place, tunable without
touching rendering or UI.

**Per-entity, transport-adaptive policy.** Each data entity carries its own sync policy — coalesce / throttle /
downsample / stream-proxy-then-truth / update-on-complete — and the policy **adapts to the measured transport
characteristics**: shared memory → send nearly everything; a slow/lossy pipe or remote-VR stream → aggressive
coalesce + low-res proxy first, truth on settle. A camera pose, a fiducial, a labelmap blob, and a transfer function
each get a different policy; the app layers above the model are unchanged — only the replication config differs.

**Sequence + checkpoint = resumable sync (CouchDB shape).** Every change carries a monotonic sequence (the
`{origin, version}` tag); LiveSync **checkpoints the last-synced seq per peer**, so on reconnect it **catches up from
the checkpoint** rather than re-snapshotting the whole scene — which is the durable fix for the reconnect re-snapshot/
re-bake leak. Bulk data is just an entity with an aggressive policy: the changes feed carries the blob **hash**; the
content-addressed channel moves the bytes lazily (proxy hash first).

**Guardrail — Couch *shape*, not full multi-master yet.** We adopt the changes-feed / replication / checkpoint /
eventual-consistency shape, but **not** revision-tree multi-master conflict resolution. Conflicts resolve by §2a
(user-initiated write wins; ownership later). The seam stays open for a CRDT/revision leg only if peerless multi-user
ever demands it (06-21 §8) — don't pay for it now.

Its contract:

- **Outbound**: observe local writes → translate to mrson ops → **coalesce latest-wins per key** (`cp:<id>:<idx>`,
  `cam:<id>`, `vis:<id>`, …) → **debounce / rate-gate drop-to-latest** to the transport's sustainable rate → send.
  This is the existing `Coalescer` (client) and the `_OutCoalescer` + camera-pose-dedup (Slicer side, this session),
  generalized into the sync layer. **≤ one write in flight per key**; a burst collapses to the latest.
- **Update-on-complete**: some interactions must **not** stream — only the final value crosses the wire (or a cheap
  proxy streams during, truth on release). Policy is per interaction/key (Tier A/B/C, 07-24 §4): a fiducial position
  may stream at ~30Hz; a heavy recompute-triggering edit may sync only on pointer-up.
- **Inbound**: receive remote ops/events → `LiveScene.applyOp` with `origin=remote` → observers fire → View updates.
- **Echo suppression (mandatory)**: never re-emit a write that arrived from the peer. Tag by `{origin, version}`;
  the outbound side drops anything whose origin is the peer it would send to.
- **Eventual consistency**: after a burst settles, both sides converge to the same latest value (the trailing flush
  guarantees the final write lands). No global tick; each key/loop clocks off its own dependency (07-24 §4).
- **Bulk data on its own channel**: node-state ops reference blobs by content hash; blobs move on the content-
  addressed channel and are themselves droppable/deferrable (stream a low-res proxy hash during interaction, swap to
  the full hash on settle). The sync layer coalesces the *reference*, not the bytes.

`mrson_live.py` is the **Slicer-side LiveSync endpoint** — MRML observers = "observe local writes", `applyOps` =
"apply remote ops", the `_OutCoalescer` + camera dedup = outbound impedance matching. Slicer is not special: it is a
locally-authoritative place whose model happens to be the C++ MRML scene, reached through mrson transactions.

### 2a. Divergence & authority (rules recorded; multi-user deferred)

Two locally-authoritative copies can diverge (a slow/lossy link, an offline edit, two writers). Resolution rules:

- **Single copy, two drivers (the common case):** the **user-initiated change is the deciding version.** An
  automated/echoed/predicted value never overrides an explicit human write. This is the `human > agent > module >
  automated` priority (06-21 §5) applied to divergence, and it is enough for the single-user Slicer↔SlicerLive case
  we build now.
- **Uncontended races:** Lamport-LWW on `{logicalTime, origin, role}` — never wall-clock.
- **Multi-user (future, note only — do NOT build yet):** a **data-authority / ownership** model — a user *owns* part
  of the scene (a closure: nodes, a view, a study), and divergences defer to the owner with greater authority over
  *that part*. Ownership is per-closure and travels with the capability grant (06-21 §5 capabilities). Concurrent
  same-node editing (rare here — places usually own different nodes/views) is the only case that would ever need a
  CRDT leg (06-21 §8); leave the seam, don't pay for it. **Action: this paragraph is the note; implementation gated
  on a real multi-user workflow.**

---

## 3. Terminology harmonization (Slicer terms; fewer words)

| Concept | Use | Retire |
|---|---|---|
| the model | **LiveScene** | — |
| the view/displayer | **DisplayableManager** (match Slicer C++/Python exactly) | ~~MirrorView~~, "displayer" |
| the per-view coordinator + render target | **DisplayableManagerGroup** owning a `SceneRenderer`/`SliceRenderer` (Slicer's group→renderer shape) | ~~MirrorView~~ |
| pointer interaction | **Interactor** (grab-or-bubble stack, camera root) | — |
| data-bound DOM control | **Control** — the DOM dual of a Slicer **qMRML** widget, 1:1 (confirmed 2026-08-02) | — |
| the sync layer | **LiveSync** (no Slicer equivalent — Slicer is single-process; new term is warranted) | — |

`MirrorView` is retired: its methods (`setField`/`removeField`/`redraw`/`setCamera`/`setClipBox`/`setSlicePlane`/…)
become the `DisplayableManagerGroup` + renderer surface, matching how Slicer DMs add/remove props to a renderer and
`RequestRender()`.

---

## 4. Build plan (the three-fold goal, sequenced)

**Phase 1 — clean scene sync (the foundation).**
1. **Shared mrson op-applier in TS** — `applyOp(scene, op)` for `put/patch/del/cmd`, the exact dual of
   `mrson_server._apply_op`. Pure, unit-testable, runs in Deno and the browser.
2. **LiveScene becomes locally authoritative** — `write(op)` applies locally (optimistic), tags `{origin, version}`,
   notifies observers; `applyOp(remoteOp)` does the same with `origin=remote`. The node map is no longer a
   passive mirror.
3. **Extract LiveSync** — move all wire/coalesce/echo-suppress logic out of the demos and `LiveScene` into a
   `LiveSync(scene, transport)` object. Generalize the `Coalescer`; add per-key policy (stream vs update-on-complete)
   and origin-based echo suppression. `LiveScene` no longer knows about the WebSocket.
4. **Conformance harness** — one scenario runner asserting the round-trips, executed **identically in Deno and in the
   browser over CDP** (test-driven replicability). Scenarios: inbound op → model → View update; local Control write →
   model → View update + correct outbound op; coalescing (N writes → ≤ rate sent, latest lands); echo suppression (no
   re-emit); divergence (user write wins).

**Phase 2 — adapt rendering onto the model.**
5. Retire `MirrorView` → `DisplayableManagerGroup`; DisplayableManagers rebuild Fields from node state only (enforce
   "nothing mutates a Field directly"). Fold the existing managers (Camera/VolumeRendering/Slice/Segmentation/Markups/
   RoiCrop/Layout) onto the finalized contract.

**Phase 3 — port core Slicer functionality** onto the foundation, each as the uniform recipe (a node type + a
DisplayableManager + optional Interactor/Control), validated by a conformance scenario. First reference slice: node
**visibility** (segmentation + volume) as a **Control** (checkbox), both directions, standalone + connected — the
template every subsequent port follows.

---

## 5. Success criteria (unchanged, restated for this phase)

- **Standalone == connected, by construction** — a SlicerLive page is a self-consistent MVC with no Slicer; adding a
  Slicer peer is adding a LiveSync, and nothing above the model changes.
- **The human loop never blocks** — Tier A (render-local) stays at display rate regardless of transport/module latency
  (07-24 §4); slow sync coalesces/drops behind predict-then-reconcile.
- **Replicable across runtimes** — the same LiveScene / DisplayableManager / Control / LiveSync code runs and is
  tested in Deno and the browser; the conformance suite is the proof.
- **Slicer-developer legible** — the contract reads like Slicer's own (Scene → nodes → DisplayableManagers →
  RequestRender; Interactors/widgets write nodes), so a Slicer dev recognizes it on sight.
