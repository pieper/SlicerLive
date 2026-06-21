# Modal LiveRenderer spikes

Throwaway spikes to find out — empirically — whether **LiveRenderer on Modal** is real (see
`../../docs/LIVE-ARCHITECTURE.md`, Phase 1). Two files, in the order you should run them:

## 1. `vulkan_probe.py` — the minimal floor (run this first)

The make-or-break, stripped to nothing: can a *minimal* container get a **Vulkan stack onto the GPU**, and
what is the true minimal cold start? No browser, no Xvfb — just `wgpu` (Python WebGPU → Vulkan on Linux) +
the Vulkan loader. If this fails, LiveRenderer-on-Modal is dead or a minutes-to-configure project — which is
the answer we want either way.

It reports, for a cold and a warm call:
- **GPU present?** (`nvidia-smi`)
- **Were the NVIDIA *graphics* libs injected?** — the crux. NVIDIA's runtime only mounts `libGLX_nvidia.so`
  etc. when `NVIDIA_DRIVER_CAPABILITIES` includes `graphics`/`all`; the default `compute,utility` gives CUDA
  but **no Vulkan**. The image sets `all`; whether Modal honors it is what this exposes.
- **Does Vulkan enumerate the GPU?** (`vulkaninfo --summary`) — NVIDIA vs software `lavapipe` vs nothing.
- **wgpu adapter + device** — `backend_type=Vulkan` and `device=NVIDIA L4` == win.
- **Minimal cold start** — client-observed cold vs warm wall time. This is the honest floor (GPU memory
  snapshots don't help graphics code, so don't expect them to rescue this number).

```bash
modal run vulkan_probe.py
```

**Reading the verdict line:**
- `Vulkan sees NVIDIA: True` + `wgpu backend: Vulkan` → the GPU graphics stack works; build LiveRenderer on it.
- `Vulkan software-only: True` → graphics caps were **not** injected; next step is whether Modal can be made
  to inject them at all (support question) before this is viable.
- `minimal cold start: a few seconds` → the few-seconds story holds. `tens of seconds` → needs a warm pool
  (`min_containers`/`buffer_containers`), not a cold path.

## 2. `liverenderer_probe.py` — fidelity + throughput (only if #1 is green)

The heavier test: headless Chromium under Xvfb rendering **WebGL2** (the renderer string + a frame), plus an
**S3 → Modal throughput** measurement (MB/s, TTFB, Gbps) for sizing big transfers like the Visible Human
cryosection set. This is closer to the real renderer (vtk.js is WebGL2 in a browser) and answers the
volume-rendering-fidelity and data-transfer questions — but it's pointless to run if `vulkan_probe.py` shows
no GPU graphics stack.

```bash
modal run liverenderer_probe.py                         # GL + cold start + default throughput
modal run liverenderer_probe.py --url "<https-s3-url>"  # throughput against a real (big) object
```

Throughput targets: the default is a small guaranteed-public AWS Open Data file. For the real number, point
`--url` at a multi-GB **IDC** object (`idc-index` gives `aws_url` → `https://idc-open-data.s3.amazonaws.com/<key>`)
or the **Visible Human** set wherever it's hosted on S3. IDC open-data is AWS Open Data → **free egress**.

## Configure Modal (free tier — ~5 min)

```bash
pip install modal
modal setup        # opens a browser; sign in, creates a free workspace + token in ~/.modal.toml
```

Nothing else to configure. The first `modal run` spends a few minutes **building** the image (cached after
that) — the cold-start number is only meaningful on later runs once the image is built. An L4 is ~$0.80/hr
and each run is seconds of GPU time, well within the free tier's monthly credits.
