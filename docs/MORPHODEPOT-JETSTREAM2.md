# Target use case: MorphoDepot / MorphoCloud on Jetstream2

*Research note (2026-06-13). Why this is a better target than Cloud Run for the offload, and a hard analysis
of which real MorphoDepot datasets the WebGL client can render locally vs. which need a GPU helper.*

## Why Jetstream2 instead of Cloud Run
Cloud Run is metered per-use and gets expensive fast for a long-lived GPU+Slicer session. **Jetstream2 is
NSF-funded (ACCESS-CI) and FREE for valid research/education** — you apply for an allocation (the "Explore"
tier is just a short abstract, approved in days, 12-month term), and GPU instances (A100/L40S) are included.
So the cost model **inverts**: the warm-GPU-instance and per-session-storage costs that make Cloud Run
intolerable here are ~free on Jetstream2, as long as the use is research. The cold-start / warm-spare tension
(~$50-110/mo on Cloud Run) largely evaporates.

## The target use case
- **SlicerMorphoDepot** (`github.com/MorphoCloud/SlicerMorphoDepot`): GitHub-backed **collaborative segmentation**.
  Each dataset = a GitHub repo with **topic `morphodepot`** + a root **`MorphoDepotAccession.json`** (which
  records `scanDimensions`, `scanSpacing`, specimen/terminology). Repo owners post a scan + terminology;
  segmentors open issues, get assigned, segment in 3D Slicer, and submit work via **pull requests**. Heavy
  classroom/workshop use (many SICB-2026 student repos).
- **MorphoCloud On Demand** (`morphocloud.org`, launching 2026-06-15): already runs **3D Slicer 5.10 +
  SlicerMorph on Jetstream2**, launched via GitHub Issues, flavors from g3.large (16 vCPU/60GB/partial A100)
  to r3.xl (128 vCPU/1TB), 100GB persistent storage, A100/L40S GPUs. Funded NSF DBI/2301405 + NIH HD104435.
  Today it's a **full streamed Slicer desktop**; our offload is the natural lighter-weight evolution.

**Fit:** data already lives in GitHub (pull it client-side), compute is free (the GPU helper costs nothing),
and the workflow is *interactive segmentation* — exactly the offload's local-interaction + gated-write-back
sweet spot (students segment in the browser, push to GitHub). The viewer + on-demand-helper tiers from
`WEB-VIEWER-VISION.md` map directly onto Jetstream2.

## Renderability analysis — 63 datasets (topic:morphodepot, 2026-06-13)
Threshold: a volume becomes a single WebGL2 R32F 3D texture = `nx*ny*nz*4` bytes; any dim > 2048 exceeds
typical `MAX_3D_TEXTURE_SIZE` (many GPUs cap at 1024 — even more conservative). Buckets by float32 size:

| Bucket | Count | Meaning |
|---|---:|---|
| **BROWSER-OK** (≤256 MB f32, dim ≤2048) | **27** | renders comfortably anywhere |
| **BORDERLINE** (256 MB–1 GB f32) | **5** | good desktop GPU; fine as uint16 (halves it) |
| **TOO-BIG** (>1 GB f32 or dim >2048) | **30** | full-res needs a GPU helper or downsampling |

**But the headline is skewed by teaching data:** ~19 of the 27 "BROWSER-OK" are 256×256×130 MRHead/SICB
**workshop/demo copies** (34 MB each). The *real specimen scans* split very differently:
- **Small specimens that fit** (~6-8): Daphnia/waterflea 378×750×175 (198 MB), juvenile bearded dragon (135 MB),
  Mako vertebra (71 MB), incisor (44 MB), knight-anole skull (26 MB), tooth-rat (15 MB).
- **Borderline** (uint16 saves them): rattlesnake (508 MB u16), mouse skull (391), tortuga (209), chicken-wing
  (196), Dasyuridae (159).
- **Too big — the real μCT research scans** (most of them): juvenile alligator 4634×1120×705 (**14.6 GB**, dim
  4634), Canis lupus (11.8 GB), bumblebee-stained (11.4 GB), Plethodon hindlimb (11.3 GB), stickleback fish
  904×441×3698 (5.9 GB, dim 3698), DiceCT cow eye (7.2 GB), Xenopus (6.6 GB), many 1-3 GB skulls/limbs.

So **at full resolution, the majority of genuine research μCT datasets exceed the browser**, while teaching
datasets and small specimens are comfortable.

## What makes the offload work for MorphoDepot anyway (the levers)
1. **uint16, not float32** — μCT/CT is natively 16-bit. The offload currently uploads R32F (4 B/voxel); using
   **R16/uint16 halves GPU memory**, moving all 5 borderline → OK and several 1-2 GB scans → borderline. Easy win.
2. **The segmentation renders regardless of volume size.** MorphoDepot's *actual work product* is the
   segmentation — labelmap + **closed-surface models** (small polydata). Those render locally fine even atop a
   14 GB scan. A segmentor reviewing/editing their 3D segmentation gets local interaction on ANY dataset; only
   the background-volume *display* needs the big texture.
3. **Multi-resolution / OME-Zarr downsampling (MorphoDepot already has zarr tooling).** Load a **downsampled
   level** that fits the browser (a 4× decimated 14 GB alligator ≈ 230 MB → BROWSER-OK), keeping full-res for a
   GPU-helper reslice/VR when the user zooms in. This is the killer combo: multiscale + the offload's per-view
   local/remote split = *every* dataset is viewable, with fidelity scaling to the client.
4. **2D slice viewing is cheap independent of volume size** — a single reslice plane is tiny; reslice
   server-side (or from a low-res level) and only the 3D VR of a huge volume needs the GPU helper.

## Recommended shape on Jetstream2
- **Browser-first** (free, instant): teaching datasets, small specimens, and the **segmentation models** for any
  dataset — client-GPU via the offload.
- **Jetstream2 GPU helper** (free for research): big μCT **volume rendering / full-res reslice** falls back to
  server-side rendering streamed as video — the "Remote render place" from the architecture doc, but on free
  NSF GPUs instead of paid Cloud Run.
- **OME-Zarr multiscale** as the bridge so the browser always shows *something* immediately (low-res) and
  escalates to the helper only when the data demands it — the "pay (compute) only when the data demands it" goal,
  except on Jetstream2 it's free.
- **Next concrete step:** switch the offload volume texture to uint16, and prototype loading a downsampled level
  of one big MorphoDepot scan (e.g. the stickleback or alligator) to validate the multiscale path.
