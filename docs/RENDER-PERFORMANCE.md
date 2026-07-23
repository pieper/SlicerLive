# SlicerLive render performance: profiling and empty-space skipping

How to measure the WebGPU ray-marcher honestly, and the rationale behind the
empty-space-skipping design in `render/scene-renderer.ts`.

## Measuring: never trust `performance.now()`

`renderToView()` returns as soon as the work is *submitted*; WebGPU executes
asynchronously. The `ms/frame` shown in the demo status bars is therefore JS +
submit time, **not** GPU cost. It cannot find a shader bottleneck.

Use `SceneRenderer.timePass(w, h, iters)` instead — it wraps the render pass in a
`timestamp-query` and returns the **median GPU pass duration in ms**. `device.ts`
requests the feature when the adapter has it, so this is free when unavailable
(`timePass` returns `NaN`).

Two caveats learned the hard way:

- **Profile headless (Deno).** Chrome quantizes timestamps unless the page is
  cross-origin isolated; Deno gives full resolution.
- **Keep passes well under the GPU watchdog.** Passes in the hundreds of ms
  (macOS/Metal) corrupt *subsequent* timestamp reads — we saw negative deltas
  appear only after a 633 ms pass. `timePass` discards non-positive samples, and
  `profile-fiducials.ts` profiles at 448² so no pass gets near the danger zone.
  Relative scaling is resolution-independent; only absolutes shrink.

## Diagnosing: ablation, not intuition

`render/test/profile-fiducials.ts` diffs GPU time across configurations so each
delta attributes cost to exactly one variable:

- volume only → baseline
- \+ N **empty** fields (n=0) → isolates per-step call/dispatch overhead
- \+ N **full** fields → adds the loop body
- sweep field count / spheres-per-field / step size → which one does cost track?

This is what identified the Volume+Fiducials bottleneck. Adding fields was *free*;
the cost tracked **total sphere count × march steps**: ~100 `length()` tests at every
one of ~570 sub-millimetre steps, virtually all rejected.

Note this beats a GPU capture tool for our purposes: the fragment shader is
*generated*, so we control every variable. (RenderDoc has no Metal backend and
cannot capture Chrome on macOS at all; Nsight/RenderDoc on a Windows/Linux
NVIDIA/AMD box are worth reaching for only for *instruction-level* detail —
occupancy, divergence — after the algorithmic cost is gone.)

## The skip API

A field opts in via `providesSkip` + `skipWGSL(slot)`, emitting
`skip_<kind><slot>(wp) -> f32`: a **conservative lower bound** on the distance from
`wp` within which that field contributes nothing. `0` means "no information" and
forces the normal fine step, so **the default is safe by construction** — a field
that says nothing can never cause geometry to be skipped.

Non-obvious decisions, and why:

- **The horizon is cached and coasted — that *is* the optimization.** Computing the
  fiducial bound costs the same O(N) loop as sampling it. A design that recomputes a
  global `min(skip_i)` every step would pay the full O(N) per step and save nothing.
  The renderer stores a `resume_<field>` per field and re-evaluates the bound only
  when the ray reaches it.
- **A global leap needs *every* field to defer.** A dense `ImageField` never yields a
  bound, so inside the volume only per-field coasting fires; the global jump is what
  makes sparse-only scenes (markups) fast. Both paths are exercised in the profiler
  (sections A–D and E respectively).
- **No variable-step opacity correction is needed.** Leaps only cross space every
  field proved empty, so no *sampled* segment ever changes length and the fixed-step
  `pow(1-a, step/unit)` integration stays exact. (This is why leaping through
  participating media would be wrong — don't "optimize" that later.)
- **One step of slack.** `wp` is the jittered sample position (±0.5 step off `t`), so
  the bound has a full step subtracted before becoming a horizon.
- **Transforms disable skipping.** A nonlinear `TransformField` warp invalidates a
  distance measured in un-warped space (you would need the warp's Lipschitz bound).
  The renderer excludes any field carrying a `transform`.

### FiducialField's bound

Spheres are an exact SDF. The conservative form used is **nearest-centre distance
minus the field's largest radius**: since `min_j(d_j) <= d_k` and `max_r >= r_k` for
every k, it never exceeds the true `min_k(d_k - r_k)`, so it cannot skip a sphere —
and it needs only dot products in the loop plus **one** `sqrt`.

## Results (448², CTACardio + 100 pins)

| | before | after |
|---|---|---|
| scene | 236 ms | **26.9 ms** |
| fiducial cost | 214 ms | **11.2 ms** |
| fiducials only | *(broken)* | 10.0 ms |

Output is **byte-identical** to the pre-optimization render — the correctness bar for
a conservative bound. Any change here must keep that property (or explain precisely
why sample *phase* changed, as the global leap does in sparse-only scenes).

The scene is now **volume-bound** (~16 ms `ImageField`). Lowering that floor needs a
per-field **occupancy grid** implementing the same `skip_i` interface — which also
generalizes to `SegmentField` and fiber strands, where an analytic distance bound is
impractical. Each field owning a grid over its own extent/resolution gives the
"small high-res structure inside a big sparse volume" case for free, without a true
nested hierarchy.

## Gotcha: `layout: "auto"` and the shared sampler

`layout: "auto"` derives the bind group layout from what the shader **actually
references**. In a scene of purely procedural fields (fiducials/markups only) nothing
samples a texture, so binding 2 is absent from the derived layout while the bind
group still supplied it → invalid pipeline → the view silently renders **nothing**.
The sampler declaration and its bind entry are now emitted under the same
`usesSampler()` condition so they cannot drift. Watch for this whenever adding a
field kind with `bindingCount = 0`.
