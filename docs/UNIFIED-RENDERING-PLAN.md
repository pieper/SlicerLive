# Unified Local/Remote Rendering — DRY Plan

Status: **approved 2026-07-28; M1 starting.** Supersedes the renderer half of
[`wgpu-remote-plan.md`](wgpu-remote.md) (which predates the TypeScript `render/` renderer
running headless under Deno).

> **Big picture.** Replicate 3D Slicer's level of capability in a more performant and
> flexible implementation, *leaving no architectural option untapped*, so that a user gets
> the most application-level benefit from whatever compute they have — their laptop GPU, a
> local Deno helper, or a remote GPU — through **one** rendering codebase. The performance
> budget of the available resource (local GPU headroom, or remote bandwidth+latency) governs
> the ray-sampling methodology and interpolation, exactly as the bandwidth/latency budget
> governed the desktopia/bumblebee remote-render experiments.

---

## 1. Two facts that set the shape

**(a) The TS renderer already runs identically in the browser and under Deno.**
`render/` (SceneRenderer + Fields + device.ts) is 100% shared between browser WebGPU and
Deno (Rust wgpu); only the *output sink* differs (`renderToView` → canvas vs `renderToRGBA`
→ readback). It has `sample_step` as a **live uniform** (`setSampleStep`, no rebuild), the
empty-space-skip machinery (cached per-field horizons + global leap, byte-identical output —
see [`RENDER-PERFORMANCE.md`](RENDER-PERFORMANCE.md)), `timePass` (honest median GPU-ms), and
`pick` — which is already a *"trace one ray → structured data, no color assembly"* pass off
the same generated shader module. But it is **single-pass and stateless between frames: no
temporal AA today** — only deterministic anti-band jitter, with a dead `seed`/`ign` hook
sitting exactly where a frame index would plug in.

**(b) The adaptive remote pipeline already exists — in Python, around a *different*
renderer.** `tools/modal_spike/local_render_ws.py` (Gen 3, ~1935 lines) has: a closed-loop
budget controller (`tune_budget` steers `budget_px` so measured motion render-time tracks a
~12 ms target; `motion_scale = sqrt(budget_px/(w·h))`), coarse-while-moving / fine-when-
settled ray step, **progressive stride-lattice convergence on settle** (provably converges to
a native render — "traced pixels spread over time"), **client-side WebGL2 Catmull-Rom superres
upsample**, a 3-loop decoupled receiver/producer/consumer transport (drop-to-latest + input
preemption), a finger→photon latency instrument, warm-spare per-session processes, and camera
state-replay. It drives `slicer_wgpu.headless.HeadlessVolumeRenderer` (Python wgpu) — **not**
the TS renderer.

**Therefore the DRY move is not "build remote rendering."** It is: **retire the Python remote
renderer, run the TS renderer under Deno, and lift the Python harness's adaptivity/
reconstruction logic into shared TS modules the browser-local path also uses.**

---

## 2. Core abstraction: Producer → (sample stream) → Reconstructor, steered by a Budget

Two rendering components with a typed contract between them:

- **`SampleProducer`** — the ray-march through the fields. Given a **`SamplePlan`** (which
  pixels/lattice to trace this tick, ray step, jitter phase, camera pose), it emits **traced
  samples** (RGBA + the pose they were traced from) into a target. This is `fs_main` refactored
  to write a sample target instead of fusing straight to final color — the `pick` multi-
  entrypoint-off-one-module pattern already in the shader. Empty-space skipping makes each
  traced sample cheap; the budget decides *how many* to trace.

- **`Reconstructor`** — takes traced samples (sparse in space, and/or **spread over time**) and
  assembles the displayed image: **spatial** reconstruction (Catmull-Rom upsample of a sparse/
  low-res trace — this *is* the Gen-3 client superres) + **temporal** accumulation into a
  history buffer (`history = lerp(history, new, 1/n)` across idle frames → supersampled,
  time-averaged AA; reset/reproject on motion). One shader, run client-side in both paths.

- **`BudgetController`** — emits the `SamplePlan` from a **measured constraint**, as a closed
  loop tuning to a target frame time (the generalized `tune_budget`):
  - **Local (RenderMode=Local):** constraint = local GPU headroom, measured per-frame
    (`timePass`/rolling render-ms). Governs resolution scale, ray step, idle-convergence rate.
  - **Remote (RenderMode=Remote):** constraint = bandwidth + latency (+ server render-ms),
    from the ack/timestamp instrument. Same controller, different inputs; governs the same
    knobs plus transport pacing.

**Local and remote differ only in the transport between Producer and Reconstructor** — an
in-process GPU buffer vs the network. `SamplePlan`, `BudgetController`, `Reconstructor`, and
the ray-march WGSL are one codebase.

| | Producer on | Sample transport | Reconstructor on | Budget input |
|---|---|---|---|---|
| **Local** | browser WebGPU | in-process GPU texture | browser WebGPU | measured GPU ms |
| **Remote** | Deno wgpu (localhost → later vast/JS2/Modal) | WS: compressed sample frames | browser WebGPU | bandwidth + latency + server ms |

## 3. Time-averaged AA and remote "progressive" are the *same* mechanism

The unification that makes this DRY rather than two features: **a progressive sample
accumulator** that doesn't care whether the next batch of samples comes from the local GPU
(next frame) or the network (next packet). Camera still → both paths keep feeding fresh
jittered/strided samples into the history buffer until it converges to a native, supersampled
image. Camera moving → both fall back to the best cheap frame (upsampled sparse trace) and
reset (later: reproject by pose delta). Local calls it TAA; remote calls it progressive
convergence; it is **one accumulator + one reconstructor**.

## 4. Confirmed decisions (2026-07-28)

1. **One codebase; Deno runs the TS renderer for remote.** Retire the Python
   `slicer_wgpu.headless` remote renderer and the VTK Modal harnesses for this path — no more
   keeping two renderers in visual parity.
2. **Primary remote transport = stream traced samples, reconstruct client-side.** No encoder
   needed in Deno; matches the "traced pixels" model; reuses the *same* Reconstructor as local.
   **ffmpeg-sidecar H.264 is the first-choice fallback** for the dense-fills-the-frame case
   where encoded video beats raw samples on bandwidth (the budget controller picks the mode,
   like Gen-3's video/image split). **Sample-stream compression is an explicit later
   optimization** — explore delta-encoding across the stride lattice / across time then entropy
   coding, or a small vision network / autoencoder tuned to this sparse-sample pattern. Not now.
3. **Localhost Deno first** for fast debugging. Stand up vast.ai / JS2 later; expose a Modal
   port for demos once it all works well (the `vulkan_probe.py` ICD recipe still applies to a
   Deno+Vulkan image).

## 5. DRY module inventory (all TS, shared browser + Deno)

- `render/sample-plan.ts` — `SamplePlan` / `SampleFrame` types: the Producer↔Reconstructor
  contract (lattice stride/offset or full-res, RGBA payload, phase/frame id, source pose).
- `render/budget-controller.ts` — the closed-loop tuner; pluggable constraint source
  (GPU-ms | bandwidth+latency). Ported from `tune_budget`/`motion_scale`.
- `render/scene-renderer.ts` — Producer: add a sample-target entrypoint beside
  `fs_main`/`fs_pick`; feed a frame index into the existing dead `seed` hook for temporal
  jitter. `sample_step` is already a live uniform.
- `render/reconstructor.ts` — spatial (Catmull-Rom) + temporal (history accumulate) resolve
  pass; ported from the Gen-3 WebGL2 superres, now WebGPU.
- **Environment-specific, thin:** `render/present-canvas.ts` (browser sink);
  `server/live-renderer.ts` (Deno WS server: receiver/producer/consumer loops, wire format,
  latency split, state-replay, warm-spare session model — a TS port of `local_render_ws.py`'s
  *harness*, calling the shared TS renderer instead of Python wgpu).

## 6. Reuse vs retire

- **Port to TS (proven in Python — `local_render_ws.py` is the spec):** budget controller,
  progressive convergence, superres, 3-loop transport, wire format + latency split,
  warm-spare/session/state-replay.
- **Retire for this path:** Python `HeadlessVolumeRenderer` + the VTK Modal harnesses.
- **Keep as fallback (M5):** ffmpeg-sidecar H.264 + WebCodecs decode for dense scenes; budget
  controller selects transport mode.

## 7. Phasing (localhost-first)

- **M1 — Split the seam locally (byte-identical).** Refactor `fs_main` into
  Producer(sample-target) + Reconstructor(resolve) in the browser; full-density output must be
  byte-identical to today (verified via `renderToRGBA` diff). Pure refactor, no behavior change.
- **M2 — Local budget + temporal AA.** Frame index → jitter; history accumulator (idle
  convergence = time-averaged AA); local GPU-ms budget controller driving resolution/step.
  *This alone fixes the "lagging as the scene gets complex" symptom — the local view degrades
  gracefully under load and converges when still.*
- **M3 — Deno server = TS renderer.** `server/live-renderer.ts`: Deno + TS renderer + WS,
  streaming sample frames; the browser Reconstructor consumes them. Localhost only.
- **M4 — Remote budget.** Wire the bandwidth+latency constraint into the same
  BudgetController; per-view `RenderMode` in the gallery so big scenes route remote. Still
  localhost Deno; then a GPU box when available.
- **M5 — Fallbacks & polish.** ffmpeg-sidecar H.264 mode; sample-stream compression research;
  temporal reprojection (next superres rung); Modal demo port.

## 8. Budget controller detail (ported)

The Python closed loop, generalized: `adj = clamp(TARGET_MS / measured_ms, 0.8, 1.25);
budget_px = clamp(budget_px · adj, 0.3 MP, 16 MP)`; `scale = clamp(sqrt(budget_px/(w·h)),
0.25, 1.0)`; settled frames render `scale = 1.0` (native). Ray step: `fine = voxel·OVERSAMPLE`
(≈3 samples/voxel, catches ~1-voxel structures) when settled, `coarse ≈ extent/N` while moving;
opacity stays step-invariant (`1-(1-a)^(step/unit)`), so step changes aliasing, not brightness.
Remote adds a second governor on the *transport* (self-pace to ~0.75× the client's frame
cadence; only ever encode/send the freshest slot; input preempts in-flight work).

The empty-space-skip optimization is the substrate the controller exploits: cheaper traces →
larger budget → more samples / higher scale. The named next step (per RENDER-PERFORMANCE.md) —
a per-field **occupancy grid** over air *inside* the volume box — lowers the `ImageField` floor
and feeds the same budget.

## 9. Risks / open items

- **Refactor must stay byte-identical at full density (M1)** — the correctness bar; guard with
  a `renderToRGBA` A/B in `render/test/`.
- **Temporal accumulation correctness under the empty-space leap** — the leap changes sample
  *phase* in sparse scenes; the history accumulator must key off a stable per-pixel identity,
  not sample index.
- **Sample-frame bandwidth before compression** — raw sparse RGBA may be large for dense
  frames; M2/M3 measure it, M5's compression + the H.264 fallback address it.
- **Deno + Vulkan on a headless GPU box / Modal** — reuse `vulkan_probe.py`'s ICD recipe; Deno
  wgpu offscreen has no surface (fine — we readback).

## 10. References

- `render/scene-renderer.ts` — `fs_main`/`fs_pick`/`renderToView`/`renderToRGBA`/`timePass`/
  `setSampleStep`; the dead `seed = ign(...)` hook.
- `render/fields.ts`, `render/fiducial-field.ts` — Field contract; the one field with a skip bound.
- `docs/RENDER-PERFORMANCE.md` — skip machinery + occupancy-grid next step + box-skip negative result.
- `tools/modal_spike/local_render_ws.py` — the Gen-3 adaptive harness (transport/budget/
  progressive/superres reference spec).
- `docs/LIVE-ARCHITECTURE.md` — the Live* service split and the three per-view render tiers.
- `docs/ARCHITECTURE-2026-07-24.md` §4–5 — interaction tiers + RenderMode seam + "adaptive
  rendering as a transport-driven control."
