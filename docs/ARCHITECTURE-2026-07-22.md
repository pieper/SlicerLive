# SlicerLive architecture — iteration 2026-07-22

*Status: latest canonical iteration. **Supersedes [`ARCHITECTURE.md`](ARCHITECTURE.md) (2026-06-21)**, which
remains on disk as the prior version. From now on the architecture note is kept as **versioned, dated files**; each
new iteration opens with a "what changed since the prior version" summary (§0) so the project's evolution across
machines and experiments stays legible. The enduring thesis, two-axis model, authority/lease model, content-
addressing rationale, and the substrate (hub-vs-p2p) decision are **unchanged** — see the 2026-06-21 doc for their
full treatment; they are summarized here only where needed. The **build plan / milestones / port detail** live in
[`WEBGPU-BACKBONE-PLAN.md`](WEBGPU-BACKBONE-PLAN.md).*

---

## 0. What changed since 2026-06-21

The 2026-06-21 doc fixed the *vocabulary* (LiveScene, participants, displayer contract, RenderMode) and left the
biggest items as open questions (#1 explicit displayer contract, #2 render-vs-interaction split, #3 LiveModule
protocol, #7 where the WebServer lives). This iteration makes **five decisions** that turn those from questions into
a concrete direction:

1. **The renderer is going WebGPU-native, and it is a *ported SlicerWGPU*, not vtk.js.** vtk.js/WebGL2 was always
   the "now" backend; the "next" backend (RenderMode seam, §7 of the prior doc) is now committed: a TS port of the
   `slicer_wgpu` Field/Displayer/SceneRenderer ray-march + the `SlicerWGPU` ColorizeVolume RGBA bake. Rendering
   thereby stops being a privileged core and becomes a **LiveRenderer participant** — the "fourth implementation of
   the same displayer contract" made real.
2. **One language for the shared backbone: TypeScript.** Because WebGPU is one API spec, the *same* TS renderer runs
   in the browser and natively in **Deno** (Dawn) — "same rendering code, browser or native" becomes literally true.
   Python cannot match this (Pyodide can't load wgpu-py), so Python-everywhere would share *less* renderer code.
3. **Python is retained as a first-class *participant*, not as duplicated code.** Desktop Slicer (hub), the
   nnInteractive teacher, training, and the working `tools/modal_spike/local_render_ws.py` helper all join over the
   LiveScene protocol. `slicer_wgpu` stays the reference oracle to port from and a valid `RenderMode=Remote` place.
4. **The displayer contract, the render/interaction split, and the LiveModule protocol (prior open Qs #1–#3) unify
   into one explicit *participant* interface** with three optional halves = the canonical roles LiveRenderer /
   LiveInterface / LiveModule. The bidirectional Markups DM + `slicer_wgpu`'s `FiducialDisplayer.commit_drag` are the
   precedents it generalizes.
5. **Reference use case chosen:** nnLive click-to-segment → labelmap node → **ColorizeVolume-style RGBA render** in a
   live 4-up (3 MPR + 3D DVR), render+compute on **one shared WebGPU device**. nnLive is the **first LiveModule test
   case**. ("nnModule" appearing in interim notes was a typo for LiveModule.)

Deferred, unchanged from prior: `RenderMode=Remote` streaming (now pointed at a **local helper** — a Deno peer or
regular Slicer — rather than cloud-first), shared-memory / p2p transports, and the hub-vs-multimaster substrate
decision (prior §8; still "hub-authoritative now").

---

## 1. Enduring thesis (unchanged, for context)

A **LiveScene** is a live, partially-replicated MRML scene — **node-state channel** (JSON, one record per node) +
**content-addressed blob channel** (`hash→bytes`) — that any number of **participants** ("places") observe and
write back to over interchangeable **transports** (HTTP+bucket ✅, WS hot-channel ✅, shared-memory ❌, p2p ❌).
Participants differ only by *role*: **LiveRenderer** (read-only), **LiveInterface** (human/agent writes),
**LiveModule** (compute writes), and the desktop-Slicer **hub** (source of truth). Content-addressing is the
load-bearing decision (lock-free SHM, free p2p dedup, trivial caching). See the 2026-06-21 doc §1–§6 in full.

---

## 2. The rendering decision — WebGPU-native, TS, one renderer everywhere

- **Backend:** a hand-written WebGPU ray-march ported from `slicer_wgpu` (abstraction: Field / Displayer /
  SceneRenderer; per-sample contribution sum → one front-to-back OVER) + `SlicerWGPU/wgpu_vtk_inject.py`'s explicit
  binding/`Mat`-struct layout, `RGBAVolumeField`, and the `add_colorize_volume` GPU **compute** bake. WGSL is shared
  verbatim across browser and native; only host orchestration is re-authored in TS.
- **Language:** **TypeScript**. Browser via `navigator.gpu`; native/headless via **Deno**'s built-in WebGPU (same
  API). No Pyodide in the hot path. nnLive's tuned WGSL runtime (`wgpu-net.js`) is already TS.
- **Home:** the reactive core + participant framework + TS LiveRenderer land **inside `SlicerLive/`**; the vtk.js
  path stays until the WebGPU path reaches parity, then retires. The TS renderer is a portable package the browser
  and a Deno helper both import.
- **MPR is net-new:** both wgpu sources are pure 3D DVR; the 4-up's three orthogonal slice planes are a small added
  WGSL pass sampling the *same* uploaded 3D textures (shared device → no extra upload).

This realizes prior-doc §7 ("SlicerWGPU is a second renderer backend behind one contract, not a fork"): the contract
is the participant interface (§3), and the two backends (vtk.js now, TS-WebGPU next) are implementations of it.

---

## 3. The participant contract (prior open Qs #1–#3, resolved into one interface)

Every participant is one object implementing the halves for the roles it plays; the reactive core calls only the
implemented halves. Grounded in three precedents: the `*DM` `handles/update/remove` + `slicer_wgpu` Displayer
`_make_field`/`_update_field` (render), the SlicerLive shared drag handler `slicerlive.js:1586-1724` +
`FiducialDisplayer.commit_drag` (bidirectional capture), and nnLive (compute).

- **LiveRenderer half** — `handles(node)`, `onNodeUpdate(node)`, `onNodeRemove(id)`: node state → Fields/actors,
  idempotent, structural-vs-uniform distinction for cheap refresh.
- **LiveInterface half** — `pickables()`, `onDrag(hit, ray) → NodeWrite`, `leaseKey(hit)`: interaction → a
  serializable node write, applied locally at full rate and synced **drop-to-latest under a single-writer lease**
  (the `1565-1723` controller, generalized). This is the render/interaction split of prior open Q#2 — now a
  *capability of one object*, not two files.
- **LiveModule half** — `observes() → Closure`, `onInputsChanged(closure) → NodeWrite[]`: recompute **only when the
  declared input closure changes** (content-hash dedup), replacing `syncDMs()`'s global re-apply. Location/language
  transparent: in-tab TS, Worker, Deno, Pyodide, or remote Python — identical to the scene.

**Reactive LiveScene core** (the substrate all halves plug into): node-state store emitting per-node change events;
content-addressed blob store (immutable by hash); a closure engine (reuses displayer reachability); the generalized
interaction lease with optimistic local overlay. This is the concrete form of prior open Q#1 (make the displayer
contract explicit).

---

## 4. Reference use case — nnLive → ColorizeVolume RGBA, live 4-up

The proof-of-life that exercises every seam on one shared `GPUDevice`:

1. Volume node in the scene → the TS LiveRenderer shows the 4-up (3 MPR + 3D DVR).
2. **nnLive (LiveModule)** observes {volume, interaction points}. A pick writes an interaction-point node →
   `onInputsChanged` runs nnLive's encode-once/decode-per-click engine → emits a **labelmap** (on nnLive's 1.5 mm
   grid; `labelmapIjkToRAS` set, no regrid).
3. Labelmap → a segmentation node (content-addressed blob).
4. A **ColorizeDisplayer (LiveRenderer)** reacts → `add_colorize_volume` GPU bake → `RGBAVolumeField` → the 3D DVR
   shows the ColorizeVolume RGBA render and the MPR planes show the overlay. Compute and render sharing the device
   means the labelmap is a GPU texture the bake consumes directly — **the 4-up updates ~per-frame, no CPU round-trip**
   as the user keeps clicking. (Payoff impossible under vtk.js/WebGL2.)

---

## 5. RenderMode and the offload path (deferred, now local-first)

Per-view `RenderMode` (Local / Remote / Placeholder / Off) is unchanged from prior §7. The **Remote** path is
deferred until the reference use case lands, and is re-aimed at a **local helper** first: `local_render_ws.py`
(localhost FastAPI → WS + WebCodecs H.264, renderer = `slicer_wgpu.headless`) already exists and is transport-
symmetric with the Modal cloud harness — the browser can't tell a local helper from a cloud GPU. A Deno peer running
the *same TS renderer* is the other local option. Regular Slicer as the local helper is the pragmatic test rig.

---

## 6. Unchanged / still-deferred (see 2026-06-21 doc)

Authority model (role priority human > agent > module; single-writer lease; Lamport-LWW fallback; echo suppression;
per-closure capabilities) — unchanged. Content-addressing enabler (SHM, p2p dedup, caching, cohort scale) —
unchanged. Substrate decision (hub-authoritative now; Couch/CRDT only if peerless p2p proves necessary) — unchanged,
still gated on the same question. Shared-memory and p2p transports — still new *bindings* of the existing protocol,
not built.

---

## 7. Status & pointers

- **Build plan, milestones (M0 reactive core → M1 WGPU 4-up → M2 nnLive LiveModule → M3 ColorizeVolume RGBA → M3.5
  bidirectional Markups), port detail, remaining open questions:** [`WEBGPU-BACKBONE-PLAN.md`](WEBGPU-BACKBONE-PLAN.md).
- **Prior architecture iteration:** [`ARCHITECTURE.md`](ARCHITECTURE.md) (2026-06-21) — full thesis, two-axis model,
  authority, content-addressing, substrate.
- **Remote/local render spikes:** `tools/modal_spike/` + [`wgpu-remote-plan.md`](wgpu-remote-plan.md).
- **Status:** decisions recorded; **no code written yet.** Remaining open items before/while coding M0–M1: MPR
  approach, labelmap grid convention, keeping the bake fully on-GPU, standalone-tab authority.
