# A100 (js2-gpu) feature-discovery + training workflow

The MacBook Air is memory-constrained (Deno's off-heap allocator panics on full-res
volumes). **Feature discovery + weight training run here, at full 512³ res.** The Air is
at most the *inference target*. Source of truth for kidney = the IDC KiTS SEGs.

## 0. Reach the box
`js2-gpu` = 10.2.87.13 (User ubuntu, key ~/.ssh/spineps-js2.pem, ProxyJump js2-probe).
It must be **started** on JS2/OpenStack first (jump host `js2-probe` stays up; the GPU
instance does not). Then:  `ssh js2-gpu 'hostname; nvidia-smi'`

## 1. Pull KiTS directly on the box (scalable — toward all-of-IDC)
```
python3 -m venv ~/kenv && . ~/kenv/bin/activate
pip install idc-index highdicom pydicom numpy
python pull_kits.py --out ~/kits --n 20        # or --cases KiTS-00012 KiTS-00013 ...
```
Writes `~/kits/<pid>.ct.i16` / `.lab.u8` / `.json` (same format the Deno feature code
reads). Verify the printed `segs=/map=` per case (kidney->1, tumor/mass->2).

## 2. Discovery substrate — test Deno WebGPU on Vulkan first
```
curl -fsSL https://deno.land/install.sh | sh    # if absent
deno run --unstable-webgpu -A gpu-smoke.ts      # (copy from Air scratchpad/)
```
- **If WebGPU works:** run the exact WGSL feature kernels (algorithms/features/) at full
  res on the A100 GPU — shaders central, fast.
- **If it fails (shader-f16/Vulkan gaps):** run the operator logic on CPU (box has the RAM)
  or a CuPy mirror for discovery; keep the WGSL kernels as the portable inference artifact.

## 3. Port the pipeline (already written on the Air, all portable Deno/TS)
Sync from the Air (or git): `algorithms/features/{runner,kernels}.ts`, `render/device.ts`,
and the assembly + PNG-review scripts (`scratchpad/kits-io.ts`, `assemble2.ts`,
`viz-stages.ts`, `feat-driver.ts`). Point `kits-io.loadCase` at `~/kits`. Run at **full
res** (no downsample) — the isolation problem needs full detail.

## 4. Open problems to solve here (full res, no memory limits)
- **Envelope isolation** (the current blocker): fat-bounded grow leaks through bare areas.
  Try per-side (left/right half-space) seeded growth + per-kidney bounding-box containment
  (kidney ~10–12 cm) so the liver can't be absorbed; then reniform shape-close + keep-2.
- **Calibrate the operator "weights"** across many cases (fat mode, cortex/aorta anchors,
  band edges, texture scales) — now cheap with 20–147 cases.
- **Tumor split**: architectural-disruption + relative-to-cortex enhancement + contour bulge
  (remember the calibration: tumor is *lower* fine-variance than structured normal kidney).
- **Cyst gate** even though the sampled cases had none (build it from the literature).

## 5. Review loop
Emit PNG montages (the writePNG path is dependency-free) to `~/kits/review/`, then
`scp js2-gpu:~/kits/review/*.png` back to the Air's `scratchpad/feat/` for the user to see.

## 6. Deliverables to bring back
- Calibrated feature weights (JSON) + the hardened WGSL kernels.
- `docs/SEGMENTATION-SKILL.md` updates (every place the run exposed vague instructions).
- Dice vs IDC KiTS GT per case (kidney + mass).
