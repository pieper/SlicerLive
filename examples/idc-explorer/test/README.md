# test/ — one driver for any profile (design)

**Nothing here is implemented.** This is how a single CDP driver could verify any IDC Explorer
profile, replacing the per-demo drivers that `examples/spine` and `examples/remind` each
hand-roll today.

## The principle worth keeping

Both existing drivers assert **numbers, not screenshots** — decoded geometry, segmentation
voxel counts and centroids, slice offsets resolving to the same RAS point. That is what made
them safe to refactor against: a screenshot suite would have gone red on every cosmetic change
and taught everyone to ignore it. It also caught real things — the ReMINDer driver's first run
failed on an ultrasound bound and on a camera-distance assumption, and **both failures were the
test being wrong, not the code**, which is exactly the conversation a good driver starts.

Chrome runs **headed, on screen** (`docs/HARNESS.md`), so a human can watch and intervene.

## What is already there to build on

`harness/cdp.ts` — `CDP.targets` / `waitForChrome` / `attachToPage`, and per-instance
`eval` / `waitFor` / `goto` / `screenshot` / `mouse` / `drag` / `wheel`.

**Neither existing driver uses it.** `examples/spine/test/spine-compare-run.ts` and
`examples/remind/test/*.ts` each re-implement an inline WebSocket client, a `pending` map, a
`Deno.serve` on a hardcoded port, and a local `check(name, ok, detail)` accumulator. The
generic driver should use `harness/cdp.ts` and factor the rest — serve, check, report,
screenshot — into one place.

Register the result in `harness/run-all.ts` `BROWSER`; a check passes on exit 0 with no
`FAIL_MARKERS` (`XX`, `MISMATCH`, `DIFFER`) in the output.

## The introspection contract

Both viewers already expose a debug hook (`__cmpDbg`, `__remindDbg`) with nearly the same
shape. Generalising that hook is what lets one driver test every profile:

```ts
globalThis.__idcx = {
  profile: () => string,
  case: () => string,
  rows: () => { id, frame, state, dims, vox, win, lev, ijkToRAS, rasLo, rasHi, layers }[],
  parts: () => { id, label, metric, located }[],
  focus: () => Vec3,          fov: () => number,
  camera: () => { position, focalPoint, dist, viewAngle, fovAtFocus },
  offsets: () => { id, off: Record<Orientation, number> }[],
  jumpTo: (ras) => void,      jumpPart: (id) => void,
  toggleRow: (id) => void,    setColumn: (c, on) => void,
  compare: () => { mode, a, b, blend, live },
  tf: (id) => { ramp, points, win, lev },
}
```

## Assertions that should hold for every profile

The collection-independent invariants — a driver that only checks these still catches most
regressions:

1. **Opens cold.** After several seconds with no interaction, every row is `idle`. A case can
   be 780 MB; the page must fetch the index and nothing else.
2. **Geometry is real.** Each loaded row's dims, isotropic voxel and RAS extent are finite and
   physically plausible. Watch the trap the ReMINDer driver fell into: an *oblique* volume's
   axis-aligned bounding box is legitimately much larger than its side lengths — bound
   `dims × vox`, not the AABB.
3. **Layers land on their frame's grid.** Non-empty, with centroids inside the frame's bbox. A
   silently empty labelmap is the most likely decode failure and the easiest to miss visually.
4. **Patient-space linking.** After one `jumpTo`, every loaded row's slice offset resolves back
   to the *same* RAS point — to well under a millimetre — no matter how different the grids.
   This is the single assertion that proves the whole design.
5. **Linked zoom.** Zooming one slice changes the shared field of view, every row follows, and
   the 3D camera spans the same millimetres. Note the invariant is *"the 3D view spans the same
   mm as the slices"*, not *"the distance halves"* — the camera snaps into agreement on the
   first coupled gesture, so a naive halving check fails on the first zoom and passes on the
   second.
6. **Residency.** Toggling a row off releases it; toggling it back reloads it.
7. **Dashboard ⇄ index agreement.** Recompute the dashboard's counts from the index in the
   driver rather than trusting the page's own arithmetic — otherwise a bug in the page's
   grouping is invisible to a test that asks the page what the grouping is.
8. **Drilldown wiring.** A row click opens the viewer for that case; `jumpPart` / `stepPart` /
   `closeDrill` cross the iframe boundary.

## Live deployment check

Worth keeping as a separate, tiny driver: point it at the *deployed* URL and load one series.
Worker-URL resolution and cross-origin reads from IDC's public bucket are exactly the things
that only break in production, and a 30-line smoke test catches them the moment they do.
