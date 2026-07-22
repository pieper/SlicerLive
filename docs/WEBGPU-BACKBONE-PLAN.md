# SlicerLive WebGPU backbone — consolidation plan & roadmap

*Status: planning note for review (2026-07-22). Implementation roadmap that sits **under** the canonical
[`ARCHITECTURE.md`](ARCHITECTURE.md) (which fixes the vocabulary — LiveScene, displayer contract, RenderMode,
participants). This doc turns that vocabulary into a concrete build plan for making SlicerLive a WebGPU-native
reactive-MRML core with an explicit **participant** framework (LiveRenderer / LiveInterface / LiveModule roles), a
ported **SlicerWGPU** LiveRenderer, and **nnLive** as the first **LiveModule** test case — with an end-to-end
example: interactive segmentation feeding a ColorizeVolume-style
RGBA 3D render, live, in a 4-up viewer. Nothing here is built yet; this is the pre-code design to nail down.*

---

## 0. North star

**SlicerLive becomes the browser-native (and Deno-native) home of the SlicerWGPU rendering ideas plus a general
module framework, all driven by a reactive MRML-like core.** The same code renders in the browser (WebGPU) or
native (Deno/Node WebGPU, same API), local or remote (pixel streaming). Every capability — rendering, segmentation,
markups, measurement — is a **participant** (a LiveRenderer, LiveInterface, and/or LiveModule role) that observes a
closure of the LiveScene and reacts, reads and/or writes, wherever its compute lives. The proof-of-life use case: **click-to-segment with nnLive →
labelmap node → ColorizeVolume RGBA bake → 3D DVR + MPR slices update live**.

This completes the philosophy in `ARCHITECTURE.md`: rendering stops being a privileged core (today vtk.js) and
becomes just another module behind the displayer contract (§3.1, §7 there). "SlicerWGPU is a fourth implementation
of the same displayer contract" becomes real — and it's the *same* implementation the browser and native both run.

---

## 1. Decision #1 (recommended, needs ratification): ONE language = TypeScript for the shared backbone

The open question: one language for browser + native, or two? Recommendation: **TypeScript for the shared
SlicerLive backbone (reactive scene, participant framework, ported WGPU renderer, nnLive engine); Python stays as a
first-class *participant*, not duplicated code.**

**Why TS and not Python+Pyodide** — the decisive fact is that **WebGPU is one API spec**:
- In TS, identical code (`navigator.gpu`, `GPUDevice`, WGSL) runs in the browser **and** natively in **Deno**
  (built-in WebGPU on Rust `wgpu`/`wgpu-native`) or Node (Dawn or wgpu-native bindings). "Same renderer code,
  browser and native" is literally true (same standard API). Caveat: the *engine* differs by runtime — Chrome uses
  Dawn, Deno/Firefox use wgpu — so "same results" is verified across engines, not assumed; pair the same engine when
  exact parity matters (Firefox ≈ Deno's wgpu; a Node+Dawn binding ≈ Chrome). Note Deno's wgpu is the *same* engine
  `wgpu-py` binds to — the split below is about API surface + host language, not the underlying GPU implementation.
- In Python, native uses **wgpu-py** (its own surface over wgpu-native), but **Pyodide cannot load wgpu-py**
  (a Rust native ext); in-browser Python would drive `navigator.gpu` through the Pyodide→JS bridge — a *different*
  API than wgpu-py. So Python-everywhere needs an abstraction over wgpu-py vs pyodide-JS-WebGPU, i.e. it shares
  *less* renderer code than TS-everywhere, precisely at the renderer. Plus Pyodide (~10 MB, bridge overhead) sits
  in the latency-critical path, and nnLive's tuned engine (`nnLive/docs/js/wgpu-net.js`) is already TS/JS.

**Interop does not require one language.** The LiveScene protocol (node-state JSON + content-addressed blobs)
already makes a Python module and a TS module interoperate transparently — that is its entire job. One language
only avoids *duplicating a component twice*; the component you least want to duplicate is the renderer, whose
shaders (WGSL) are shared verbatim regardless of host language.

**What stays Python (as participants, unchanged, over the protocol):**
- Desktop **Slicer** (the hub / source of truth).
- The real **nnInteractive** teacher, distillation/training, heavy compute → remote LiveModules.
- **`slicer_wgpu`** — remains the **reference oracle** to port from, *and* a valid `RenderMode=Remote` render
  place (it already streams pixels to the browser via `tools/modal_spike/local_render_ws.py`).

**Cost, honestly:** port `slicer_wgpu` → TS **once**; thereafter the TS renderer is SlicerLive-canonical and the
Python `SlicerWGPU` (inside Slicer) may drift on host orchestration — but shared WGSL bounds the drift, and Python
consumes the LiveScene rather than sharing renderer host code.

**Alternative if overridden (Python-everywhere):** coherent only if maximal reuse of existing Python renderer/
compute outweighs the browser-GPU story; accept an abstraction layer over wgpu-py vs pyodide-JS-WebGPU and
Pyodide's weight. Not recommended for the interactive browser path.

> Everything below is written language-neutral in shape; where the choice bites, TS is assumed per this rec.

---

## 2. The ecosystem (what exists, where, and its role)

| Repo / path | What it is | Role in the plan |
|---|---|---|
| **`SlicerLive/`** (`viewer/slicerlive.js`) | Today: one vtk.js/WebGL2 file — mirror + `*DM` displayers + 4-up + bidirectional Markups/ROI/Transform + interaction lease (`1565-1723`) | **Becomes** the WebGPU-native backbone. The vtk.js path is the reference for the reactive core + bidirectional contract. |
| **`SlicerLive/tools/modal_spike/`** | Remote/local render spikes: `local_render_ws.py` (localhost FastAPI → WS+WebCodecs H.264, renderer = `slicer_wgpu.headless`, budget controller, per-session, camera replay, superres), `live_render_nvenc.py` (Modal/EGL/NVENC/Zarr) | The **`RenderMode=Remote` test rig**. Local helper = the pragmatic offload target. Not yet wired into the viewer. |
| **`latest/slicer-wgpu/`** (`slicer_wgpu/`) | Clean **Field / Displayer / SceneRenderer** ray-march architecture (pygfx-backed), `headless.py`, progressive refinement, `add_colorize_volume` referenced | **Primary port source** for the TS renderer (design abstraction + step loop + progressive). |
| **`latest/SlicerWGPU/`** (`SceneRendering/SceneRenderingLib/wgpu_vtk_inject.py`) | Production raw-wgpu bridge: explicit bindings, `_build_wgsl`/`_pack_material`, **`RGBAVolumeField`**, **`add_colorize_volume`** + GPU bake compute shaders, `Camera` UBO | **Port source for the explicit WebGPU binding/struct layout + the ColorizeVolume bake.** |
| **`nnLive/`** (`docs/js/{wgpu-net,faithful-enc,pathA-faithful-worker}.js`) | Custom WGSL inference runtime + faithful nnInteractive encoding + worker | **First LiveModule test case** (already TS/JS; wraps into the participant contract). |
| **`latest/SlicerNNInteractive/`, `lnq-segmenter/`** | Modal inference REST patterns | Patterns for remote compute LiveModules. |
| **`desktopia/`** | GStreamer→H.264→QUIC/WS streaming stack | Streaming transport reference (vast.ai/QUIC path). |

Two distinct wgpu systems, both port sources: `slicer_wgpu` (the *abstraction* — Field/Displayer/SceneRenderer,
per-sample summation then one OVER) and `wgpu_vtk_inject.py` (the *concrete WebGPU contract* — `@binding(N)`, the
`Mat` struct byte layout, `RGBAVolumeField`, the bake). The TS port takes the decomposition from the first and the
explicit GPU layout + bake from the second.

---

## 3. The participant contract (unifies render + bidirectional interaction + compute)

`ARCHITECTURE.md` open questions #1–#3 (make the displayer contract explicit; separate render vs interaction;
define the LiveModule protocol) collapse into **one interface**: the participant. It generalizes three existing,
proven precedents:

- **Render half** — SlicerLive's `*DM` `handles/update/remove` (`slicerlive.js`), and `slicer_wgpu`'s Displayer
  `node_class` + `_make_field`/`_update_field` (structural vs uniform-only) + `on_structure_changed`/
  `on_field_modified`.
- **Bidirectional capture half** — SlicerLive's shared drag handler (`slicerlive.js:1586-1724`): pick handle →
  mutate mirror node attrs → update **lease** (`leasedId`/`leasedLocal`) → local re-render → `sendGated`
  drop-to-latest on `ack`. Python precedent: `slicer_wgpu` `FiducialField.pick/drag_update` + `FiducialDisplayer.
  commit_drag` (detaches its own observer to avoid feedback).
- **Compute half** — nnLive: subscribe to volume + interaction nodes, produce a labelmap node.

**Proposed participant interface (TS, language-neutral shape):**

```ts
interface Participant {   // one object; a role is present iff its half is implemented
  // identity + what it observes
  readonly id: string;
  observes(scene: LiveScene): Closure;                 // which node classes/refs form its input closure

  // RENDER half (optional — a pure compute module omits it)
  onNodeUpdate?(node: Node, ctx: RenderCtx): void;     // node -> fields/actors (idempotent, structural vs uniform)
  onNodeRemove?(id: NodeId, ctx: RenderCtx): void;
  handles?(node: Node): boolean;

  // INTERACTION half (optional — makes it bidirectional / a LiveInterface)
  pickables?(): Pickable[];                            // handles entering the global pick registry
  onDrag?(hit: Pickable, ray: Ray): NodeWrite | null;  // mutate closure node + return serializable write
  leaseKey?(hit: Pickable): NodeId;                    // node whose lease this drag holds

  // COMPUTE half (optional — a pure renderer omits it)
  onInputsChanged?(closure: Closure): Promise<NodeWrite[]>;  // recompute when declared inputs change
}
```

Key properties, all grounded in the precedents:
- **Reactivity is by declared closure**, not a global sweep — a module recomputes only when *its* inputs change
  (content-hash dedup), so a remote/Python module doesn't re-run on unrelated edits. (Replaces `syncDMs()`'s
  full re-apply.)
- **Writes are typed + leased**: `onDrag`/`onInputsChanged` return `NodeWrite`s that the core applies locally at
  full rate and syncs out drop-to-latest under the single-writer lease (the `1565-1723` controller, generalized).
- **Location/language transparent**: a module may run in-tab (TS), in a Worker, in Deno, in Pyodide, or remote
  (Python over WS/HTTP) — identical from the scene's view.
- **Render is a participant**: the WGPU LiveRenderer is a participant (LiveRenderer role) whose `onNodeUpdate`
  builds Fields; a `RenderMode=Remote` view is a participant that emits a placeholder and displays streamed pixels.

---

## 4. The reactive LiveScene core (evolution of MRML scene + displayers)

Today: `mirror` (Map<id,node>) + `blobCache` (hash→bytes) + `syncDMs()` deterministic full re-apply. Evolve to a
**reactive** core that keeps the good parts (content-addressed blobs, closures = displayer reachability) and adds
per-node change events so participants react precisely.

Pieces to build (TS, browser + Deno):
1. **Node-state store** — `{class, attrs, refs, blobs:{role:{hash,dtype,…}}}` per node (already the protocol,
   `ARCHITECTURE.md` §2). Mutations produce change events `{added|modified|removed, id, changedKeys}`.
2. **Content-addressed blob store** — `hash→TypedArray`, immutable by hash (edit → new hash → new blob); the
   labelmap, LUTs, meshes, RGBA bakes all live here. Enables cheap "unchanged node never recomputes."
3. **Closure engine** — from an anchor (view/ROI/subject) compute the reachable sub-graph (reuses displayer
   reachability). A module's `observes()` returns a closure; the core notifies it on changes within it.
4. **Interaction lease** — generalize `leasedId`/`leasedLocal`/`sendGated`/`onAck` into a reusable single-writer-
   per-node lease with optimistic local overlay + drop-to-latest sync (works the same for local hub and remote).
5. **Transports** — start with in-process (browser) + Worker; the WS hot-channel + HTTP/bucket already exist for
   remote; shared-memory/p2p remain future bindings (`ARCHITECTURE.md` §8, unchanged/deferred).

This is `ARCHITECTURE.md` open Q#1/#2 realized: the displayer contract becomes explicit (the participant render half),
and render-vs-interaction is a capability of one module object, not two files.

---

## 5. The WebGPU renderer (TS port of slicer_wgpu + the bake)

Port target, in dependency order. Shared WGSL where possible; the host orchestration is the new TS.

- **5a. GPU core** — device, buffer/texture helpers, pipeline cache. (nnLive's `wgpu-net.js` already has a mature
  version to borrow patterns from; the renderer needs render pipelines + 3D textures + samplers.)
- **5b. Field system** (port `slicer_wgpu/fields/`): the `Field` contract — `uniformType(slot)`, `bindings(slot)`,
  `samplingWGSL(slot)` (`sample_field_<kind><slot>`), `tfWGSL(slot)`, `fillUniforms`, `aabb`, optional
  `skipWGSL` + `pick`/`dragUpdate`. `ImageField` (numpy→3D `r32float` texture + 256×4 LUT + gradient LUT + Phong +
  space-skip); `TransformField` (grid warp, non-compositing); `FiducialField` (glyph spheres + pick/drag). Slot
  namespacing (`img0`,`fid1`,…) is the codegen mechanism.
- **5c. SceneRenderer** (port `scene_renderer.py`): `buildForFields(fields)` → slot assignment, WGSL codegen from a
  template with 4 substitution blocks (`__FIELD_FUNCTIONS__`/`__FIELD_DISPATCH__`/`__SKIP_CHECKS__`/
  `__SAMPLE_SHADOW_FN__`), the material UBO, the fullscreen-triangle ray-march (per-sample **sum contributions →
  one front-to-back OVER**, AABB clip, dither seed). Plus `needsRebuildFor`, `refreshUniforms`, `recomputeBounds`,
  `pickAt`, `dragContinue`. Material layout: follow `wgpu_vtk_inject.py`'s explicit `Mat` struct for a stable
  WebGPU byte layout (scene block + per-image/seg/rgba blocks + grid/clip tail). **Do not use `__`-prefixed pad
  names** (pygfx strips them; in raw WebGPU pack offsets explicitly).
- **5d. ColorizeVolume RGBA bake** (port `add_colorize_volume` + `_run_bake`/`_run_bake_surface` + `RGBAVolumeField`):
  labelmap (`r8uint` 3D) + palette (256×RGBA, label→color/opacity) → GPU **compute** bake to an `rgba16float` 3D
  texture. Density: palette-init → 3× separable Gaussian on alpha → optional modulate-by-CT. Surface: JFA SDF →
  palette RGB + signed-distance alpha. Then `RGBAVolumeField` ray-marches it. (The carve-dilate uses `scipy.ndimage`
  today → replace with a small GPU dilation or JS pass.) **This is nnLive's output target.**
- **5e. MPR slices (NET-NEW — not in either wgpu source; both are pure 3D DVR):** the 4-up's three orthogonal
  planes. Simplest: a WGSL pass sampling the same volume 3D texture (+ the RGBA/labelmap overlay texture) on an
  ortho plane at the slice offset — reusing the *same* uploaded textures as the 3D view (shared device = zero extra
  upload). Alternatively thin-slab DVR via clip planes. Small addition; unlocks the familiar Slicer 4-up.
- **5f. Camera / progressive** — explicit `Camera` UBO (proj/view + inverses; TAA jitter optional). Port
  `headless.py`'s progressive refinement (reduced-res during motion via a pixel budget; interleaved sub-lattice
  convergence to full-res when settled) — matters for interactivity on weaker GPUs.

**Displayers** (render-half participants) wrap the fields: `VolumeRenderingDisplayer` (volume node + TF → ImageField,
fast LUT refresh path), a `ColorizeDisplayer` (segmentation node → RGBAVolumeField via the bake), `MarkupsDisplayer`
(bidirectional, port the fiducial pick/drag/commit + the SlicerLive handle machinery).

---

## 6. nnLive as the first LiveModule + the end-to-end example

The demonstrator that ties it together (single shared `GPUDevice` for render + compute — the payoff over vtk.js/
WebGL2):

1. Volume node in the scene (idc_tools spin or loaded). The WGPU renderer shows the 4-up.
2. **nnLive compute participant** observes {volume, interaction points}. On a pick in a view → an interaction-point
   node write → nnLive `onInputsChanged` runs (its existing encode-once/decode-per-click engine, wrapped from the
   inline orchestration in `nnLive/docs/index.html:172-197`) → produces a **labelmap** (kept on nnLive's 1.5 mm grid;
   labelmapIjkToRAS set accordingly, no regrid).
3. The labelmap lands in the scene as a segmentation node (labelmap blob, content-addressed).
4. **ColorizeDisplayer** reacts → `add_colorize_volume`-style GPU bake → `RGBAVolumeField` → the 3D DVR shows the
   **ColorizeVolume RGBA render**, and the MPR planes show the overlay. Because compute and render share the device,
   the labelmap can be a GPU texture the bake consumes directly — **the whole 4-up updates ~per-frame with no CPU
   round-trip** as the user keeps clicking.

This is the "results of nnLive interactions go straight into the ColorizeVolume-style RGBA rendering" goal.

---

## 7. Milestones (revised; M4 remote deferred to the local-helper path)

- **M0 — Reactive LiveScene core (TS):** node-state store + content-addressed blob store + change events + closure
  engine + the participant registry/attach + the generalized interaction lease. Backbone everything plugs into.
- **M1 — WGPU renderer, 3D DVR + MPR of a scene volume:** ports 5a–5c + 5e + basic camera; a live 4-up (3 MPR +
  3D DVR) from a volume node, driven only by scene state. Proves renderer-as-participant + zero-build (no vtk.js).
- **M2 — nnLive as a compute participant on the shared device:** pick→interaction node→labelmap node→overlay in all
  four views, no readback. Proves the module contract + reactivity + shared-device handoff.
- **M3 — ColorizeVolume RGBA (5d):** the segmentation node bakes to an RGBA field; nnLive edits drive the live
  cinematic 3D render. **This is the end-to-end use-case shot.** (3D is essential here, not deferred.)
- **M3.5 — bidirectional Markups participant:** port the two-way handle machinery as the reference bidirectional
  module (validates the interaction half beyond compute).
- **Deferred — `RenderMode=Remote` via the LOCAL helper:** wire a view to display streamed pixels from
  `tools/modal_spike/local_render_ws.py` (or a Deno-native peer running the *same TS renderer*). Not now — revisit
  once M0–M3 land and the local helper integration is worth it. The local helper (regular Slicer or a Deno peer) is
  the preferred test rig over cloud/Modal.

---

## 8. Essential-vs-extension boundary (intentional, will evolve)

Like historic Slicer's built-in vs extension split, but deliberate. **Essential (in SlicerLive core):** reactive
LiveScene, participant framework + registry + lease, the WGPU renderer (Fields/SceneRenderer/ColorizeVolume/MPR),
core Markups (bidirectional reference), volume + segmentation display. **Modules (loaded, possibly from a URL at
runtime):** nnLive segmentation, specific measurement/registration/simulation, remote compute services, alternate
renderers. The boundary is a judgment call revisited per use case — captured here so it's explicit, not accidental.

---

## 9. Decisions

**Resolved (2026-07-22):**
1. **Language** — **TypeScript** for the shared backbone; Python stays a first-class participant (not duplicated).
2. **Native runtime** — **Deno** (built-in WebGPU on Rust `wgpu`; identical standard API to the browser — engine
   differs from Chrome's Dawn, so verify result parity across engines).
3. **Repo layout** — the reactive core + participant framework + TS **LiveRenderer** and other components land
   **inside `SlicerLive/`** (its real backbone); the vtk.js path stays until the WebGPU path reaches parity, then
   retires. The TS renderer is a portable package usable by both the browser and a Deno helper.
4. **Vocabulary** — use `ARCHITECTURE.md`'s canonical roles **LiveRenderer / LiveInterface / LiveModule** over the
   umbrella **participant** contract. ("nnModule" was a typo; **nnLive is a LiveModule test case**.)
5. **Docs** — architecture notes evolve as **versioned, dated files** (latest = `ARCHITECTURE-2026-07-22.md`, each
   with a "what changed since the prior version" summary); older iterations kept, superseded-by pointer added.

**Still open (before/while coding M0–M1):**
6. **MPR approach:** dedicated ortho-plane sampling pass vs thin-slab DVR via clip planes for the slice views?
7. **Labelmap geometry in-scene:** stays on nnLive's 1.5 mm grid (recommended, no regrid) vs resampled to the
   display volume grid — confirm the segmentation node geometry convention.
8. **Bake residency:** keep the ColorizeVolume RGBA bake fully on-GPU (replace the `scipy` carve-dilate with a GPU/
   JS dilation) to avoid any CPU round-trip in the interactive loop — confirm.
9. **Standalone authority:** for the browser-only case (no Slicer hub), the browser tab is its own hub? (Ties to
   `ARCHITECTURE.md` §8 hub-authoritative default.)
