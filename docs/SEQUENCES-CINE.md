# Sequences and cine in SlicerLive

Design for 4D (and beyond) in the WebGPU renderer, modeled on 3D Slicer's Sequences
infrastructure so SlicerHeart workflows transfer without translation.

Companion to [docs/CARDIAC-RENDERING-PLAN.md](docs/CARDIAC-RENDERING-PLAN.md); this doc is
milestone **M2** of that plan, plus the mrson parity work it implies.

All performance numbers below were measured on this machine (Apple M4, 10 cores, 16 GB
unified memory, Deno 2.9.3 WebGPU). Scripts are in the session scratchpad and should be
promoted to `render/test/` when M2 lands.

---

## 1. Why mirror Sequences rather than invent a cine format

Slicer's sequence model is not just a container for frames — it is a general
"index → any node type" mechanism, and everything in SlicerHeart that touches time is
built on it: the 4D echo renderer, `Reconstruct4DCineMRI`, valve analysis per cardiac
phase, the ultrasound and TomTec readers. If SlicerLive mirrors the model faithfully,
those workflows arrive for free and the LiveSync/mrson round-trip to a running Slicer
keeps working. If we invent a bespoke cine format, every one of them needs an adapter.

The model is also more general than "a volume over time," which is what makes it the right
substrate for the 4D flow work later in the cardiac plan: a browser can advance an image
sequence, a transform sequence, and a segmentation sequence together on one shared index.

---

## 2. The Slicer model, and which parts we mirror

Sources: `Libs/MRML/Core/vtkMRMLSequenceNode.{h,cxx}` (note: MRML **Core**, not the
Sequences module), `Modules/Loadable/Sequences/MRML/vtkMRMLSequenceBrowserNode.{h,cxx}`,
`Modules/Loadable/Sequences/Logic/vtkSlicerSequencesLogic.cxx`.

### 2.1 `vtkMRMLSequenceNode` — the container

Items are `(indexValue, dataNode)` pairs in a `std::deque`, where the data nodes are real
MRML nodes living in a **private nested `vtkMRMLScene`** (`GetSequenceScene()`), not bare
clones. Three properties define the axis:

- `IndexName` (default `"time"`), `IndexUnit` (default `"s"`)
- `IndexType`: `NumericIndex` or `TextIndex`
- `NumericIndexValueTolerance` (default `0.001`)

**Index values are always strings**, even for a numeric index — comparison goes through
`atof` plus the tolerance. Numeric indices are kept sorted on insert and looked up by
binary search; text indices preserve insertion order and compare linearly.
`GetItemNumberFromIndexValue(value, exactMatchRequired=false)` returns the item *just
before* the value, which is what makes "seek to the nearest earlier frame" work.

**Mirror this exactly**, including the string-ness. A number-keyed map would silently lose
text indices and the tolerance semantics.

One consequence worth knowing: `SetDataNodeAtValue` deep-copies via `CopyContent`, not
`Copy`, so **node references are stripped when data enters a sequence**. That is the
origin of the familiar "my display settings disappeared" behavior.

### 2.2 `vtkMRMLSequenceBrowserNode` — the controller

There is **no structural master/slave distinction**. The browser holds a vector of
synchronization postfixes with two node references each (`sequenceNodeRef<postfix>`,
`dataNodeRef<postfix>`), and **postfix[0] is simply the master**;
`SetAndObserveMasterSequenceNodeID` just swaps it to the front and re-resolves the current
position by index *value*, so the timepoint survives a master change.

Per-sequence flags: `Playback`, `Recording`, `OverwriteProxyName`, `SaveChanges`, and
`MissingItemMode` (`CreateFromPrevious` (default) / `CreateFromDefault` / `SetToDefault` /
`Ignore` / `DisplayHidden`) — which defines behavior when a synchronized sequence has no
item at the master's index. Worth mirroring; ragged sequences are normal in practice.

Playback state: `PlaybackActive`, `PlaybackRateFps` (default 10), `PlaybackLooped`,
`PlaybackItemSkippingEnabled`, and `SelectedItemNumber` — an **integer ordinal, not an
index value** (`SetSelectedItemByIndexValue` converts).

The compatibility contract for joining one browser is exactly: **index name, unit, and
type must be equal**. Nothing requires index values to line up; `MissingItemMode` handles
the ragged case at playback time.

### 2.3 The sync engine

`vtkSlicerSequencesLogic::UpdateAllProxyNodes` runs on a **50 Hz Qt poll**
(`UPDATE_VIRTUAL_OUTPUT_NODES_PERIOD_SEC = 0.020`), not a per-frame timer, and advances by

```cpp
int selectionIncrement = floor(elapsedTimeSec * PlaybackRateFps + 0.5);
```

i.e. wall-clock-driven with frame dropping. Mirror the *shape* (wall clock, drop frames) but
**not this arithmetic — it runs about 2x too fast.**

`floor(x + 0.5)` is round-to-nearest, and `LastSequenceBrowserUpdateTimeSec` is reset to now
whenever the increment is non-zero. So the increment first reaches 1 at
`elapsed = 0.5 / fps` — half the nominal period — and the steady-state rate is double what was
asked for. Rounding would only be correct if elapsed were measured from a fixed origin.

Measured in Slicer 5.12.0 (median inter-phase gap over 8-12 s of playback):

| requested | measured | ratio |
|---|---|---|
| 0.5 fps | 0.92 | 1.83x |
| 1 fps | 1.92 | 1.92x |
| 2 fps | 3.75 | 1.88x |
| 5 fps | 9.38 | 1.88x |
| 10 fps | 16.88 | 1.69x |

(The smaller error at 10 fps is the 50 Hz poll quantising the half-period.)

SlicerLive uses a plain phase accumulator instead — `acc += dt * fps; inc = floor(acc);
acc -= inc` — which measured **exactly 1.000 fps** when 1 fps was requested (individual gaps
0.998-1.001 s). Keep it.

`UpdateProxyNodesFromSequences` then fans out to every synchronized sequence with
`targetProxyNode->CopyContent(sourceDataNode, deep)`, batching all `StartModify`/
`EndModify` and bracketing the whole loop in `PauseRender()`/`ResumeRender()`.

### 2.4 The invariant that matters most

**`CopyContent` vs `Copy` is the whole architecture.** Content flows sequence → proxy every
frame; references (display nodes, transforms, storage, subject hierarchy) never do. That is
what lets SlicerHeart's `EchoVolumeRender` install a custom fragment shader **once** on the
proxy node and never touch it again — there is not a single browser-node observer anywhere
in SlicerHeart. Our renderer must preserve the same invariant: **the field is a stable
identity whose payload is swapped.** Transfer function, shading coefficients, clip planes,
and camera all persist across frame changes by construction.

### 2.5 A trap not to inherit

`deepCopy = !GetSaveChanges()`, so Slicer's *default* (`SaveChanges=false`) is the **slow**
path — a full CPU deep copy of every frame on every advance. There is no reason to inherit
this polarity. Make shallow/zero-copy the default and model write-back as an explicit
opt-in capability.

---

## 3. mrson mapping

Two new neutral node types, added to `TYPE_TO_CLASS` in
[render/mrson.ts:30-44](render/mrson.ts#L30-L44) and mirrored by `_sequence_node()` /
`_sequence_browser_node()` in
[LiveStory/LiveStoryLib/serialize_mrson.py](LiveStory/LiveStoryLib/serialize_mrson.py)
(which already has one `_<type>_node` function per node type):

```
sequence        -> vtkMRMLSequenceNode
sequenceBrowser -> vtkMRMLSequenceBrowserNode
```

Sequence node payload: `indexName`, `indexUnit`, `indexType` (`"numeric"|"text"`),
`numericIndexValueTolerance`, and `items: [{ index: string, node: <nodeId> }]` — item nodes
referencing blobs on the existing content-addressed blob channel, so the K frames of a cine
are K blobs and an incremental update touches one.

Browser payload: ordered `sequences: [{ sequence, proxy, playback, recording, saveChanges,
missingItemMode }]` (index 0 = master), plus `selectedItemNumber`, `playbackActive`,
`playbackRateFps`, `playbackLooped`, `playbackItemSkippingEnabled`.

This keeps the existing scene-op machinery intact: scrubbing is a single
`#/selectedItemNumber` op, which is exactly the kind of tiny bidirectional op the LiveSync
path already coalesces.

---

## 4. The renderer side

### 4.1 It does slot straight in

No new compositing concept is required. A cine volume is an `ImageField` whose scalar
texture changes; the ray-march, transfer function, shading, clipping, and picking are all
untouched. `SceneRenderer` already has the exact hook, documented for this case:

> `refreshBindings()` — "Rebuild the bind group from the fields' current resources (e.g.
> after a field swapped a texture) without recompiling the pipeline."
> — [render/scene-renderer.ts:766-772](render/scene-renderer.ts#L766-L772)

**Verified end to end.** A spike subclassing `ImageField` with N resident frame textures,
swapping the bound view and calling `scene.refreshBindings()`, renders two phases of a
contracting sphere correctly: background-corrected mean radiance 26.9 vs 6.4, a ratio of
4.2 against the 4.0 expected from a 2× radius change in projected area. No shader edit, no
pipeline rebuild.

### 4.2 Playback must converge each frame BEFORE showing it

The obvious wiring — treat a frame advance as a `kick()` into the existing moving/settled
loop in [render/demos/accum-loop.ts](render/demos/accum-loop.ts) — **is wrong, and we
shipped it before catching it.** Both of its states fail:

- Let the accumulator keep running across a frame change and it averages phase N with phase
  N+1. The heart **smears**; the 1/n weight then can't clear the ghost.
- Reset accumulation on every frame change and each displayed frame is a single jittered
  sample. On a small volume that is visibly **speckled** — the n=1 DVR look.

Neither is acceptable in an animation, and no choice of `idleGapMs` fixes it: the frame rate
you want (10 fps) is far faster than convergence (24 samples).

**SUPERSEDED (2026-08-17) — see §4.2b. The filmstrip below was built on a wrong premise and
cost interactivity; it is no longer used by the cardiac example.**

The fix *was* [render/cine-filmstrip.ts](render/cine-filmstrip.ts): converge every phase once
offscreen, cache the finished image, and play back from the cache. Each displayed frame is
a fully converged still, and playback costs one `copyTextureToTexture`. Because presenting
is a raw copy rather than a blit pass, the canvas must be configured with `COPY_DST`:

```ts
ctx.configure({ device, format, viewFormats: [srgb], alphaMode: "opaque",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
```

The strip is built a few samples per animation frame so the page stays responsive, and each
phase is presented as it completes, so the user watches it fill in. Anything that changes
what a frame looks like — camera, transfer function, crop box, canvas size, mode — must call
`invalidate()`. Camera drags therefore fall back to the live adaptive loop and the strip
re-converges when the drag ends, which is the right feel: immediate while interacting,
clean when still.

Cost is bounded and one-time: 10 phases × 24 samples = 240 traces, a few seconds for a
128³ volume. Playback then runs at whatever rate you ask for, because a frame is a copy.

### 4.2b What actually works: accumulate the held phase live

The filmstrip assumed we could not render fast enough to converge during playback. **Measured,
that is false.** Single pass, no accumulation, cine volume at 1184x820:

| ray step | ms/frame | fps | single-pass noise |
|---|---|---|---|
| 0.805 mm (0.7x spacing, old default) | 14.7 | 68 | 4.30 |
| **0.575 mm (0.5x — what Slicer uses)** | **7.1** | **140** | 2.99 |
| 0.402 mm (0.35x) | 9.7 | 103 | 2.27 |
| 0.287 mm (0.25x) | 13.0 | 77 | 1.91 |

And Slicer, read out of a running instance, renders **single-pass with no accumulation at
all**: `vtkOpenGLGPUVolumeRayCastMapper` with `UseJittering = 0`,
`AutoAdjustSampleDistances = 0`, `SampleDistance` locked to half the input spacing,
`ImageSampleDistance = 1`. One clean pass — that is where its speed comes from, and its
banding is the price.

So at 10 fps playback there is ~100 ms per displayed phase and a pass costs ~7 ms. Hold the
phase and keep accumulating into it until it is due to advance; reset on any phase or camera
change. No precomputation, nothing to invalidate, and **you can rotate while it plays** —
which the filmstrip could not do, because a camera move invalidated every cached phase and
playback stalled until they rebuilt.

Verified: dragging through ~2 s of playback gave 32 phase advances across all 10 phases with
playback still active; paused, the held phase reaches 48 accumulated passes in ~530 ms.
Accumulation depth during playback is 2-6 passes per phase (one per animation frame), so
playback is noisier than a still — but it is jitter noise in a moving image rather than
banding, and it never stalls.

The moving/settled loop is still exactly right for the *static* volume and for interaction.

### 4.3 The caching question, measured

Four strategies, on this M4:

| | 128×104×72 (1.8 MB/fr) | 192×192×128 (9.0 MB/fr) | 320×320×224 (43.8 MB/fr) |
|---|---|---|---|
| **All frames resident, swap bind group** | **0** | **0** | **0** |
| Resident GPU buffer → `copyBufferToTexture` | 1.00 ms (1.8 GB/s) | 0.72 ms (12.2 GB/s) | 1.54 ms (27.8 GB/s) |
| Host `writeTexture` per frame | 0.94 ms (1.9 GB/s) | 2.44 ms (3.6 GB/s) | 9.26 ms (4.6 GB/s) |

(Measured copying into *distinct* destination textures so nothing can be elided. Small
frames are dominated by ~1 ms fixed overhead, so only the large column is informative about
bandwidth.)

**Decision: all frames resident as separate 3D textures, with one pre-built bind group per
frame.** Per-frame data movement is exactly zero, and it is what Slicer structurally cannot
do. Fall back to a resident GPU buffer plus `copyBufferToTexture` (still cheap — 1.5 ms for
a 44 MB frame) only when the full set does not fit; never re-upload from the host per frame,
which costs 9.3 ms for a 44 MB frame and eats a third of a 30 fps budget before any
raymarching.

For calibration, this is the one place we beat Slicer outright rather than merely port it.
Slicer's per-frame cost is *worse* than a plain re-upload: `SetAndObserveImageData`
early-outs only on pointer identity, so every frame produces a new `vtkImageData`, which
makes both reload conditions in `vtkOpenGLGPUVolumeRayCastMapper` true, which calls
`LoadVolume` → `ClearBlocks()` — **texture teardown and recreation, not a subimage update**.
No frame cache exists anywhere in the VolumeRendering module; the string "Sequence" does not
appear in it. Every Discourse thread on 4D playback lag works around this (shallow copy,
item skipping, manual window/level, "remove volume rendering") and none proposes caching.

### 4.4 Two hard WebGPU constraints

**There is no `texture_3d_array` in WGSL.** Verified: the shader module fails to compile
with "no definition in scope for identifier: `texture_3d_array`". Only 2D textures can be
arrayed. So the frame set must be N separate 3D textures selected by bind group, not one
arrayed texture.

**Z-stacking frames into a single 3D texture (an atlas) is not viable.**
`maxTextureDimension3D` is 2048 on this M4 (the spec default; Apple does not exceed it), so
an atlas needs `nFrames × nz ≤ 2048`. That holds only for toy data:

| case | vox/frame | r16 MB/fr | r16 total | r32 total | atlas z |
|---|---|---|---|---|---|
| CTCardioSeq, 10 frames | 958,464 | 1.8 | 18 MB | 37 MB | 720 — OK |
| cardiac MR cine, 20 frames | 4,718,592 | 9.0 | 180 MB | 360 MB | **2560 — over** |
| HVSMR-2.0 static | 13,631,488 | 26.0 | 26 MB | 52 MB | OK |
| cardiac CT 4D moderate, 20 | 22,937,600 | 43.8 | 875 MB | 1.75 GB | **4480 — over** |
| cardiac CT 4D full, 20 | 83,886,080 | 160.0 | 3.2 GB | 6.4 GB | **6400 — over** |

Even a modest 20-phase cine blows the cap. Separate textures it is.

### 4.5 Store cine frames as `r16float`, not `r32float`

Halves memory (the table above) and, unexpectedly, **improves portability**: r16float is
filterable in *core* WebGPU, whereas the current r32float path needs the optional
`float32-filterable` feature that [render/device.ts:21](render/device.ts#L21) requests.
Verified by sampling a 4-voxel r16float 3D texture on a device requested with **no**
features: voxels 0/1000/2000/3000 sample to 251.5, 750.5, 1250.0, 1750.0, 2250.0, 2750.0 —
exact hardware trilinear interpolation.

Precision is sufficient: float16 represents integers exactly to 2048, then in steps of 2 to
4096. Cardiac CT soft tissue and contrast (−1024 to ~1500 HU) is exact; only dense bone,
metal, and coils quantize, invisibly in a DVR. The verified `CTCardioSeq` range is
−1309..1368, entirely within the exact band.

---

## 5. 4D and 5D

The Field API should stay dimension-agnostic: it takes a frame index and, for smooth
playback, a blend weight between two bound frames (bindingCount 2 → 3: `volA`, `volB`,
`lut`). **All N-dimensional indexing lives in the controller, not the renderer** — which is
what makes "4D/5D slots into the existing philosophy" true rather than aspirational.

That said, on 5D there is **no Slicer pattern to be faithful to**, and this is worth
knowing before designing against a phantom:

- Nested sequences (a sequence whose data nodes are sequences) are permitted by exactly one
  sentence of documentation and have **zero implementations** — not in Slicer core, its
  tests, or SlicerHeart. It cannot work with the browser as written, since a browser has one
  index and `IsNodeCompatibleForBrowsing` requires matching index name/unit/type.
- What "5D" means in Slicer today is *file-format* dimensionality (`c/v` component × `xyz`
  domain × `t` list — so `cxyzt` is a color volume sequence, `vxyzt` a transform sequence or
  4D flow). **There is exactly one `list` axis.** Cardiac phase × contrast timing has no
  first-class representation.
- SlicerHeart flattens every second axis rather than nesting: valve models are *not* stored
  in sequences at all but as independent scripted-module nodes carrying
  `ValveVolumeSequenceIndex` and `CardiacCyclePhase` attributes, recovered in temporal order
  by sorting on the index — precisely so multiple phases can be displayed at once.
- The other sanctioned pattern is **multiple browsers over the same sequences**, each with
  its own proxy nodes parked at a different item.

So: implement 4D faithfully, keep the frame-index plumbing N-D-ready, and treat a genuine
second axis as an open design question we are free to solve better, because there is no
established behavior to break. Multiple browsers over shared sequences is the cheapest
honest answer and it also gives phase-comparison views for free.

---

## 6. Loader notes for `.seq.nrrd` — branch, don't assume

The `CTCardioSeq` sample file is the **legacy** layout, and modern Slicer writes the
opposite on all three counts. Getting this wrong silently produces garbage, so detect it.

Verified header: `dimension: 4`, `sizes: 10 128 104 72`, `kinds: list domain domain domain`,
`space: right-anterior-superior`, `type: short`, `encoding: gzip`.

**Frames are interleaved, not contiguous.** NRRD lists sizes fastest-axis-first, so axis 0
(the `list` axis, extent 10) varies fastest and element `(t,x,y,z)` sits at
`t + 10*(x + 128*(y + 104*z))`. Extracting one frame is a **stride-10 gather**, not a
contiguous slice.

This was confirmed empirically rather than assumed — a naive spatial-smoothness test is
confounded here and appears to favor the wrong answer, because adjacent cardiac phases are
themselves similar. The decisive test is the spread of the 10 values at a fixed voxel across
t: interleaved gives 60.1, contiguous gives 465.4 against a random-voxel baseline of 465.8.
Reading the file as contiguous frames yields *exactly* unrelated noise.

| | this legacy file | what Slicer writes now |
|---|---|---|
| list axis | 0 (`kinds: list domain…`) | 3 (`kinds: domain domain domain list`) |
| frame memory | interleaved, stride = nFrames | contiguous |
| space | `right-anterior-superior` → **no LPS→RAS flip** | `left-posterior-superior` → flip required |

Index metadata comes from custom NRRD key/value fields — `axis <N> index type`,
`axis <N> index values` (space-separated, **URL-encoded**), `DataNodeClassName`, and
per-frame `axis <N> item NNNN <attrName>` — while `IndexName`/`IndexUnit` come from the
*standard* `labels`/`units` fields on the list axis. This particular file carries none of
them, so the fallbacks apply: `IndexName = "frame"`, empty unit, and index values become the
strings `"0".."9"`.

Given the repo has no browser-side NRRD reader at all, the practical path is the same as
the spine pipeline: convert to zarr in a worker, emitting one blob per frame plus a
sequence node, and let the browser stay zarr-only.

---

## 7. M2 work items

1. `sequence` / `sequenceBrowser` mrson node types + Python serializer functions (§3).
2. `SequenceBrowser` controller in TS: string index values, numeric/text compare with
   tolerance, `selectedItemNumber`, `setSelectedItemByIndexValue`, `selectNextItem` with
   looping, and the wall-clock `floor(elapsed*fps + 0.5)` advance (§2.3).
3. `CineImageField`: N resident r16float 3D textures, pre-built per-frame bind groups,
   `setFrame(i, blend)` with two bound frames for inter-frame interpolation; falls back to
   a resident GPU buffer + `copyBufferToTexture` past a memory budget (§4.3, §4.5).
4. `CineFilmstrip`: converge each phase offscreen, cache it, play back from the cache;
   invalidate on camera / TF / crop / size / mode change (§4.2).
5. `.seq.nrrd` → zarr worker with legacy/modern branch detection (§6).
6. Timeline/scrubber UI — borrow from the session recorder
   ([render/recorder.ts](render/recorder.ts),
   [render/demos/mirror-browser.ts:354-390](render/demos/mirror-browser.ts#L354-L390)).
7. Promote the spike and the interleaving check into `render/test/` as regression tests.
