# SlicerLive architecture — iteration 2026-07-24

*Status: latest canonical iteration. **Supersedes [`ARCHITECTURE-2026-07-22.md`](ARCHITECTURE-2026-07-22.md)**,
which remains on disk as the prior version. The enduring model is **unchanged** — two-axis places×transports,
the participant contract (LiveRenderer / LiveInterface / LiveModule), the single-writer lease + rate-gated
drop-to-latest write-back, content-addressing, and per-view RenderMode all carry forward exactly. This iteration
does not overturn anything; it **names and unifies two dimensions that were implicit** — the interaction/event
model and multi-rate impedance matching — and records one implementation decision (LiveScene variable → GPU
uniform) that is now being built. Build plan / milestones / port detail remain in
[`WEBGPU-BACKBONE-PLAN.md`](WEBGPU-BACKBONE-PLAN.md); render-perf method + results in
[`RENDER-PERFORMANCE.md`](RENDER-PERFORMANCE.md).*

---

## 0. What changed since 2026-07-22

Nothing in the foundation. Three things became **explicit** as interaction work began (draggable TPS landmarks, a
clipping ROI box):

1. **The event model is specified** (§3). Interaction dispatch follows the **web-browser model**: an event is
   offered to widgets, which either **grab** it (own it until pointer-up) or **let it bubble**; the camera is the
   root handler that grabs anything otherwise ungrabbed. The dispatch is **pluggable** (window/level, widget
   placement, and future tools register the same way) and carries **hover** (highlight grabbable handles, set
   cursor). A **snap-suggestion** layer is on the wishlist (offer to snap a drag to logical candidates, e.g. the
   nearest segment surface within tolerance) and the model reserves room for it.

2. **Impedance matching across the interaction loop is named as a first-class concern** (§4). Different parts of a
   single interaction run at **different rates set by their slowest satisfied dependency**: render-local operations
   (a clip-plane or TPS drag) stay at display rate; sync-to-scene runs at whatever the transport supports;
   interactions whose *correct* frame needs external computation throttle the module-facing rate to what the module
   can keep up with — while the human keeps seeing a responsive predicted frame. This is the generalization of the
   existing lease/rate-gate (prior §5) from "one write-back rate" to "a tier of decoupled loops." It is the balancing
   act that lets one architecture span the whole deployment range (§5, §6) without the human ever waiting on a slow
   downstream stage.

3. **One implementation decision is committed** (§7): map LiveScene node-state variables to **GPU uniforms updated
   per frame without a pipeline rebuild** (`SceneRenderer.syncUniforms`). This is what makes the render-local tier
   real, and it retroactively justifies keeping field geometry (AABBs) out of generated WGSL — see the box-skip
   negative result in [`RENDER-PERFORMANCE.md`](RENDER-PERFORMANCE.md).

Everything below is elaboration of these three, plus the success criteria (§2) and the consistency check (§8).

---

## 1. Enduring model (unchanged, for context)

Two axes: **places** (human / agent / module / renderer) × **transports** (HTTP bucket, WS hot-channel, shared
memory, p2p). One **LiveScene** protocol: a node-state channel + a content-addressed blob channel; each place
mirrors a **closure**. One **participant contract** with three optional halves (LiveRenderer / LiveInterface /
LiveModule). One **authority model**: role priority `human > agent > module > automated`, single-writer-per-node
interaction lease, sync **rate-gated drop-to-latest**, Lamport-LWW fallback, echo suppression, per-closure
capabilities. Per-view **RenderMode** (Local / Remote / Placeholder / Off). Substrate is **hub-authoritative now**,
Couch/CRDT only if peerless p2p proves necessary. See [`ARCHITECTURE.md`](ARCHITECTURE.md) §§1–8 and
[`ARCHITECTURE-2026-07-22.md`](ARCHITECTURE-2026-07-22.md) for the full treatment.

**Why nothing here overturns that:** the lease + rate-gated drop-to-latest write-back *is already* a two-rate loop
(local full-rate mutation vs. transport-limited sync-out). This iteration recognizes that the same pattern recurses
into more tiers, and that the interaction *dispatch* on top of it deserves the same care the *authority* underneath
it already got.

---

## 2. Success criteria — the north star

SlicerLive is not a work-alike; it is meant to be an **evolution of 3D Slicer across every engineering dimension,
leaving no computing optimization on the table**. Concretely, the architecture must simultaneously satisfy:

- **The full deployment range**, from a **$0 static bucket viewer** to **image-guided robotic surgery** with
  streaming data, dynamic simulation, and human haptic guidance — *the same LiveScene protocol and participant
  contract*, not special-cased stacks (§5, §6).
- **High interactive rates for render-local operations regardless of scene complexity or where compute lives** —
  a clip-plane or landmark drag must feel native even when a module or renderer is remote and slow (§4).
- **Graceful degradation, never a stalled human** — when a dependency is slow (transport, module, remote GPU), the
  human-facing loop shows a predicted/best-available frame and reconciles when truth arrives; it does not block.
- **The gallery demos are the proving ground** for the LiveScene ideas, not throwaways. Each demo should exercise a
  real slice of the contract (a draggable landmark = LiveInterface + render-local tier; an ROI crop = the
  event→state→render tight loop; nnLive = a LiveModule) so the protocol is validated in practice before the
  distributed transports are built. Standalone today, LiveScene-shaped by construction (§8).

These are **requirements on the architecture**, tracked so we stay on course as complexity grows; §6 walks four real
Slicer use cases against them.

---

## 3. The interaction & event model

Extends the participant contract's **LiveInterface half** (07-22 §3: `pickables()`, `onDrag(hit,ray)→NodeWrite`,
`leaseKey(hit)`) with the *dispatch* that feeds it. Precedent: the vtk.js viewer already does the grab-or-bubble
trick by hand — a capture-phase `pointerdown` that `stopPropagation()`s when it grabs a handle so the camera
interactor never sees it (`viewer/slicerlive.js:1586`). This formalizes and generalizes that.

**Grab-or-bubble (the web-browser model).** A pointer event is offered down a **stack of interactors**; each may:
- **grab** it — take ownership of the gesture until pointer-up (the widget "captures the pointer", exactly like DOM
  `setPointerCapture`); no lower interactor sees the rest of the gesture; or
- **pass** — decline and let the event bubble to the next interactor.

The **camera is the root interactor**: it grabs anything nobody else grabbed (drag = orbit, wheel = dolly). This is
why a handle drag must never also move the camera — the handle grabs first, the camera never sees it. Grab acquires
the node's **interaction lease** (§1 authority model); pointer-up releases it.

**Pluggable interactor stack.** Interactors register into the stack; order = priority. The set is open-ended:
handle-drag widgets (ROI, markups, transform), **window/level** (drag on a slice), **widget placement** (click to
drop a new control point / seed), measurement, future tools. Each is a small object — `hitTest(event) → hit | null`,
`onGrabStart/onGrabMove/onGrabEnd(hit) → NodeWrite`, plus a `cursor(hit)` — so adding a tool is adding an interactor,
not editing a dispatcher. This is the same "capability of one object, not a special case" discipline as the
participant contract.

**Hover.** A cheap, non-authoritative pass on pointer-move-without-buttons: the top interactor that `hitTest`s the
cursor gets to **highlight** its grabbable handle and set the **cursor** (resize / move / crosshair / W-L). Hover
takes no lease and writes no node state; it is pure local render feedback (a uniform flag on the hovered handle),
so it runs entirely in the render-local tier (§4).

**Snap suggestions (wishlist — reserve room, do not build yet).** During a grab, a **suggestion provider** may
annotate the live drag with candidate targets and offer to snap — e.g. a control point offering to snap to the
surface of the nearest segment within a tolerance. Architecturally this is: (a) a provider that, given the in-flight
drag value, returns ranked candidate writes; (b) render-local highlight of the candidates; (c) commit-to-candidate on
release if within tolerance. Cheap providers (snap-to-handle, snap-to-grid) are render-local; expensive ones
(snap-to-segment-surface, snap-to-centerline) are **module-dependency-tier** (§4) and must throttle — which is
exactly why the tiering below must exist before snapping is built. Kept on the wishlist; the event model leaves the
seam open.

---

## 4. Multi-rate impedance matching (the core new framing)

A single interaction is not one loop; it is **several loops coupled only by shared LiveScene state, each running at
the rate its slowest satisfied dependency allows.** The engineering goal is to **decouple them so the human-facing
render loop never inherits a slow downstream rate**, and to **reconcile** when slower truth arrives (predict-then-
correct). Three tiers, by dependency latency class:

- **Tier A — render-local (display rate, GPU-local).** The frame is *correct* using only state already on the
  render device. Clip-plane drags, ROI box geometry, TPS displacement-grid re-solve, fiducial position, hover
  highlight. Implemented by writing LiveScene variables straight into GPU **uniforms** and re-rendering — no
  pipeline rebuild, no CPU round-trip, no transport (§7). Runs at monitor refresh regardless of everything else.

- **Tier B — transport-sync (transport-limited).** Persisting the interaction to the shared LiveScene for other
  places. This is the **existing** single-writer-lease + **rate-gated drop-to-latest** write-back (prior §5,
  `slicerlive.js:1565-1723`): mutate locally at Tier-A rate, sync out at ≤ one write in flight, coalescing to the
  latest. Its rate is set by the transport (SHM ≫ WS ≫ HTTP ≫ p2p) and is **independent of the render rate**.

- **Tier C — module-dependency (module-limited).** The *correct* frame depends on external computation:
  fiducial-seeded segmentation, DMRI streamline selection through an ROI, a simulation step. The interaction
  throttles its **module-facing** rate (again drop-to-latest) to what the module can absorb — local Worker, Deno,
  or a remote GPU over HTTP/p2p — while Tier A keeps showing the **best available** frame: a local prediction
  (straight-line curve before the spline; last-committed selection while dragging) that **snaps to truth on
  arrival**. The markup viewer already does exactly this — "follow local control points while dragging, snap to the
  server spline on settle" (`slicerlive.js` `linePoints` vs `controlPoints`). Tier C generalizes that discipline to
  any module dependency.

**The governing principle:** *an interaction's achievable interactive rate is a function of which dependencies must
be satisfied for the frame to be correct.* Classify each dependency (render-local / transport / module), run each
tier at its native rate, keep Tier A at display rate by rendering predicted frames, and reconcile. **Several
constraints routinely apply at once** (a remote render *and* a remote module *and* a rate-limited transport); the
tiers compose — the achievable rate of each is independent, and the human always sees Tier A.

**Adaptive rendering as a transport-driven control.** When a view is `RenderMode=Remote` (remote GPU streaming video
back), **resolution/quality adapt to transport headroom** — degrade under congestion, recover with slack — so the
interaction stays fluid on a constrained link. This is the same impedance-matching idea applied to the *pixel*
stream rather than the *state* stream, and it lives on the RenderMode seam (prior §7). Local `RenderMode=Local`
views need none of it; the two coexist per-view in one layout.

**What this is not:** it is not a global frame-rate governor. Each loop clocks itself off its own dependency; there
is no shared tick. This is what lets a hard-realtime control loop (§6, robotics) run on its own clock next to a
best-effort render loop without either dragging the other.

---

## 5. The deployment × computation matrix

The two axes (§1) already say deployments "mix and match." Interaction makes the **compute placement** explicit as a
third dimension whose cells the tiering (§4) must cover:

```
render     ∈ { local, remote(GPU video) }
compute    ∈ { none, local-module, remote-module }         (per dependency)
transport  ∈ { SHM, WS, HTTP, p2p }
```

The interaction rate in any cell = the tier profile present:

| interaction | render | compute | dominant tier(s) | human sees |
|---|---|---|---|---|
| clip-plane / TPS drag | local | none | A | display-rate truth |
| clip-plane drag | remote | none | A(remote render) + adaptive res | display-rate, quality adapts |
| fiducial seed → segment | local | local/remote module | A(widget) + C(seed) | responsive widget, seeded result catches up |
| DMRI streamline ROI select | local | module | A(box) + C(selection) | responsive box, last selection until module updates |
| IGT: stream→sim→robot | any | remote module + hard-RT loop | A + C + separate RT clock | live view; control loop on its own clock |

The invariant across every cell: **Tier A is always display-rate**, and everything slower is decoupled behind
predict-then-reconcile. That invariant is the success criterion (§2) made testable.

---

## 6. Scenario success criteria (worked against the tiers)

Four real 3D Slicer use cases, each a checkpoint the architecture must meet:

1. **TPS landmark drag (building now).** Entirely **Tier A**: drag a source/target landmark → re-solve the TPS →
   regenerate the 24³ displacement grid → `writeTexture` → re-render, all GPU-local (`deform-scene.ts` `setTarget`
   already does the math; only the per-frame uniform/texture update without pipeline rebuild is new, §7). **Tier B**
   persists the landmark. No module. This is the proof that the render-local loop is genuinely display-rate.

2. **Fiducial seeding.** Drop a seed (widget-placement interactor, Tier A responsive) → a **LiveModule** (Tier C,
   local or remote) grows a region/segmentation → new nodes → a ColorizeDisplayer renders them. The seed placement
   never waits on the module; the seeded result throttles to module rate and appears when ready. Exercises the
   Interface→Module→Renderer round-trip on the shared device (the nnLive reference use case is this shape).

3. **SlicerDMRI streamline ROI selection.** An ROI drag crops/selects which tracts pass through it. The **box** is
   Tier A (geometry + clip planes update at display rate); the **selection** (which of N streamlines intersect the
   ROI) is **Tier C** — a module recomputes the passing set at its own rate. While dragging, the view shows the
   last-computed selection and updates when the module catches up. This is the canonical "widget state must go back
   to a module that updates other nodes before the final scene is correct" case.

4. **Image-guided robotic surgery (the stress test).** Realtime image data streams in (Tier-C *input*) → forms
   **boundary conditions for a dynamic simulation** (Tier-C compute, plausibly a remote GPU) → feeds a **robot
   control pathway with human haptic feedback and guidance** (a **hard-realtime loop on its own clock and latency
   budget**). The architecture must let each of these run **at its own rate**, coupled only through LiveScene state,
   and must **not** bind the haptic/control loop to the render loop (§4 "no shared tick"). This is the case that
   forces the multi-rate design to be real rather than cosmetic, and it is a genuine Slicer application target — so
   it is in scope for planning even though far off in implementation.

---

## 7. Enabling decision (committed): LiveScene variable → GPU uniform

To make Tier A real, `SceneRenderer` gains a **`syncUniforms()`** path: re-run each field's `fillUniforms` into the
resident material buffer and let the existing per-frame `flush()` upload it — **no pipeline rebuild**. Today
`fillUniforms` runs only inside `build()`, which recompiles the shader; that is fine for nnLive's per-*click* rebuild
but impossible for a per-*frame* drag. After `syncUniforms`, everything Tier-A (clip planes, ROI box geometry, sphere
positions, displacement grid) updates at drag rate with no recompile.

This is the render-side expression of the whole impedance-matching thesis: **lightweight interactive drags are
GPU-local uniform updates.** It also closes the loop with the box-skip negative result
([`RENDER-PERFORMANCE.md`](RENDER-PERFORMANCE.md)): baking field AABBs into generated WGSL would force a recompile on
any geometry move, so **moving state must be uniform-resident, never codegen-resident.** The `FiducialField` skip
already respects this (its spheres live in uniforms); the rule is now explicit.

Interaction discipline that keeps this LiveScene-shaped even while standalone: **interactors write node state;
displayers rebuild fields from node state; nothing mutates a field directly.** A local node-state layer
(`{class:'vtkMRMLMarkupsROINode', attrs:{center,axes,halfSizes}}`) + `RoiDisplayer`/`MarkupsDisplayer` mapping state
→ fields means that when a real LiveScene transport arrives, only the *source* of node state changes — displayers,
fields, and the event stack are untouched, and Tier B/C slot in at the sync boundary that already exists.

---

## 8. Consistency check vs. existing docs

This iteration overturns nothing. Explicit mapping:

- **Event model (§3)** is the dispatch feeding the participant contract's **LiveInterface half** (07-22 §3); the
  grab-or-bubble + lease-on-grab is the existing capture-phase controller (`slicerlive.js:1586`) made general and
  pluggable. Consistent; additive.
- **Tier B (§4)** *is* the single-writer lease + rate-gated drop-to-latest of the authority model (06-21 §5) —
  unchanged, just placed in a tier stack.
- **Adaptive remote render (§4)** lives on the **RenderMode** seam (06-21 §7) — unchanged; the resolution-adaptation
  is a policy on the existing `Remote` mode.
- **Deployment × compute matrix (§5)** is the deployment combos (06-21 §4) with compute-placement named; the cells
  are the same places×transports.
- **Uniform decision (§7)** is a render-backbone implementation detail under the LiveRenderer half; it changes no
  protocol.

No existing statement needs correction. The 06-21 and 07-22 docs remain accurate; this doc adds the interaction and
multi-rate layer on top and is now the canonical iteration.

---

## 9. Open questions added to the tracked list

Appended to [`ARCHITECTURE.md`](ARCHITECTURE.md) §9:

9. **Event-dispatch API** — the interactor-stack interface (`hitTest` / `onGrab*` / `cursor`), pointer-capture
   semantics, and how the camera-root and per-view stacks compose across a multi-view layout (§3).
10. **Suggestion/snap provider interface** — ranked candidate writes during a drag, render-local vs. module-tier
    providers, commit-on-release tolerance (§3 wishlist).
11. **Per-tier rate-control policy** — how each loop measures its dependency's headroom and picks its rate
    (transport RTT, module queue depth, GPU frame time); the predict-then-reconcile contract per interaction (§4).
12. **Hard-realtime / haptic loop as a distinct clock** — how a control loop with a fixed latency budget coexists
    with best-effort render/sync loops sharing LiveScene state without coupling (§4, §6.4). Likely a separate
    transport binding (deterministic, bounded) rather than the WS hot-channel.
13. **Adaptive-resolution controller** — the transport-headroom → render-resolution/quality control law on
    `RenderMode=Remote` (§4).

---

## 10. Status & pointers

- **Now building:** `SceneRenderer.syncUniforms` (§7) → draggable TPS landmarks (§6.1) → clip planes + ROI box
  (§6, the event→state→render tight loop). Sequencing per the plan reviewed 2026-07-23.
- **Enduring model / authority / content-addressing / substrate:** [`ARCHITECTURE.md`](ARCHITECTURE.md) (2026-06-21).
- **Rendering decision / participant contract / reference use case:** [`ARCHITECTURE-2026-07-22.md`](ARCHITECTURE-2026-07-22.md).
- **Build plan / milestones / port detail:** [`WEBGPU-BACKBONE-PLAN.md`](WEBGPU-BACKBONE-PLAN.md).
- **Render-perf method + skip results + box-skip negative result:** [`RENDER-PERFORMANCE.md`](RENDER-PERFORMANCE.md).
- **A/B harness (Slicer ↔ SlicerLive numeric parity):** [`HARNESS.md`](HARNESS.md).
