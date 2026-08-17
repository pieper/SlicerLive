# Cardiac volume rendering

Reproduces the rendering options of two CHOP/SlicerHeart papers in the SlicerLive WebGPU
renderer, on public 3D Slicer sample data.

| | |
|---|---|
| **Cianciulli et al.**, *Volume Rendering of CT Images to Inform Closure of Complex Ventricular Septal Defects*, JACC: Case Reports 2025. [doi:10.1016/j.jaccas.2024.102827](https://doi.org/10.1016/j.jaccas.2024.102827) (open access, PMC12011141) | Volume rendering of CTA with a transfer function that shows **myocardium instead of the contrast-filled blood pool**, so the camera can sit *inside* a chamber and look at endocardium — no segmentation. |
| **Iacovella et al.**, *Rapid Visualization of Valves and Myocardium Using Volume Rendering of 3D Cardiac MRI, 4D Cine, and 4D Flow Images*, Radiology: Cardiothoracic Imaging 2026. [doi:10.1148/ryct.250129](https://doi.org/10.1148/ryct.250129) | The same idea plus time: **4D cine playback** of the volume-rendered heart. |

Background and the wider plan: [docs/CARDIAC-RENDERING-PLAN.md](../../docs/CARDIAC-RENDERING-PLAN.md).
The 4D architecture: [docs/SEQUENCES-CINE.md](../../docs/SEQUENCES-CINE.md).

## Run it

```bash
# 1. fetch the two public sample volumes (77 MB, no registration)
mkdir -p examples/cardiac/work && cd examples/cardiac/work
curl -L -o CTA-cardio.nrrd     https://github.com/Slicer/SlicerTestingData/releases/download/SHA256/3b0d4eb1a7d8ebb0c5a89cc0504640f76a030b4e869e33ff34c564c3d3b88ad2
curl -L -o CT-cardio.seq.nrrd  https://github.com/Slicer/SlicerDataStore/releases/download/SHA256/d1a1119969acead6c39c7c3ec69223fa2957edc561bc5bf384a203e2284dbc93
cd ../../..

# 2. NRRD -> zarr chunks + scene json (a few seconds)
deno run -A examples/cardiac/prep.ts

# 3. bundle + serve
deno run -A npm:esbuild examples/cardiac/cardiac-browser.ts --bundle --format=esm --outfile=examples/cardiac/cardiac.js
deno run -A examples/cardiac/serve.ts        # -> http://localhost:8777/cardiac.html

# headless regression checks (needs the server running)
deno run -A --unstable-webgpu examples/cardiac/test/cardiac-render.ts
```

## What's in the page

- **CTA** — the static 512×512×321 cardiac CTA, 4-up MPR + DVR.
- **fly inside** — parks the camera in the largest contrast-filled pool with the
  `CT-EndoVascular` preset. Contrast blood is transparent above 338 HU, so you are looking
  at the endocardial surface from within the chamber. This is the JACC paper's technique.
  Drag to look around.
- **4D cine** — 10 cardiac phases, play / scrub / rate. Each phase is **converged offscreen
  before it is ever shown** (you watch the strip fill in on entry), so the animation is
  neither smeared by cross-frame accumulation nor speckled by single-sample frames.
- **SlicerLive badge** (top-right of the 3D view) — holds **Enable cropping** and
  **Display ROI**, the two switches Slicer's Volume Rendering module has. With the ROI
  displayed, drag its face/corner/centre handles to crop the volume rendering live.
- **preset** — swaps the transfer function live (the 256-entry LUT is rewritten in place;
  no pipeline rebuild).

Shared chrome as in every SlicerLive demo: the "?" cheat-sheet, Slicer-faithful trackball and default slice
planes, shift+move crosshair linking all four views, double-click to maximize, budget-scaled
interaction that converges with temporal AA when idle.

`window.cardiac.state()` exposes mode / preset / slice offsets / frame / playing for a CDP
driver, in the style of seged's `window.seged`.

## Data

Both are 3D Slicer sample data — public, directly downloadable, no registration.

| | |
|---|---|
| `CTA-cardio.nrrd` | 512×512×321, 0.934 × 0.934 × 1.25 mm, LPS in file (flipped to RAS on load) |
| `CT-cardio.seq.nrrd` | 10 cardiac phases × 128×104×72, 1.15 × 1.15 × 2.0 mm, already RAS |

**The 4D file is the legacy `.seq.nrrd` layout and needs care.** Axis 0 is the `list` axis
*and* NRRD's fastest-varying axis, so frames are **interleaved** — element `(t,x,y,z)` lives
at `t + 10*(x + 128*(y + 104*z))`, and extracting a frame is a stride-10 gather. Modern
Slicer writes the opposite on all three counts (axis-3 list, contiguous frames, LPS), so
`prep.ts` branches on `kinds` and `space` rather than assuming. Reading it the modern way
produces noise that is statistically indistinguishable from random voxels — verified, see
[docs/SEQUENCES-CINE.md §6](../../docs/SEQUENCES-CINE.md).

`work/` (downloads) and `data/` (generated zarr) are gitignored; `prep.ts` regenerates
`data/` in a few seconds.

**Published data.** The gallery build streams the zarr from a public, CORS-enabled JS2
container rather than shipping it in the repo:

```
https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive/cardiac/
```

466 objects, 69.7 MB (57 MB CTA + 13 MB cine). The page takes `?data=<url>` to repoint it —
use `?data=data/` to run against a local `prep.ts` output. To re-upload after regenerating,
authenticate with the `CIS230102_IU` application credential in `~/.config/openstack/clouds.yaml`
and PUT each file under `slicerlive/cardiac/`; the container already carries
`X-Container-Read: .r:*,.rlistings` and `Access-Control-Allow-Origin: *`.

## Notes on fidelity

The presets are transcribed verbatim from Slicer's `presets.xml` and SlicerHeart's
`US-VrPresets.mrml` ([presets.ts](presets.ts)). They port to SlicerLive's scalar-only LUT
machinery unchanged because **every cardiac preset in Slicer carries a flat, no-op gradient
opacity** — only the bone/lung/fat/µCT presets use a real gradient curve.

The cine mirrors Slicer's Sequences model ([render/sequence.ts](../../render/sequence.ts)):
string index values with a declared numeric/text type and tolerance, an integer
`selectedItemNumber` ordinal, a browser whose sequence 0 is the master, and wall-clock
playback advance with frame dropping. All frames stay resident as r16float 3D textures and
a frame change is a bind-group swap, which costs nothing per frame — the thing Slicer
structurally cannot do, since it recreates the GPU texture every frame.
