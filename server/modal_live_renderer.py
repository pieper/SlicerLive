"""
LiveRenderer on Modal -- server/live-renderer.ts running on a transient GPU container, with the
browser here doing interaction + reconstruction.

    modal serve server/modal_live_renderer.py      # dev: hot-reloads on edit, prints the URL
    modal deploy server/modal_live_renderer.py     # persistent URL

DEMO=multi (the default here) serves the selftest MULTI-VOLUME scene -- CTACardio +
CTAAbdomenPanoramix composited per sample, with the interactive transform gizmo on Panoramix.
The gizmo's picking/drag math runs in the browser; the matrix it produces is a ws message and the
compositing happens on the L4.

Empirical, this image on an L4 (tools/modal_spike/deno_probe.py, 2026-08-20):
  container start ~6 s -> Deno WebGPU adapter "NVIDIA L4" in 0.7 s -> 99.5 MB of scene streamed
  from JetStream2 in 3.4 s (29 MB/s) -> traceSamples 35 ms @1024^2, 89 ms @4K.
So a cold hit is ~11 s to first frame; scaledown_window keeps it warm between interactions.
"""

import pathlib
import subprocess

import modal

DENO_VERSION = "v2.9.5"
PORT = 8787
ROOT = pathlib.Path(__file__).resolve().parents[1] if modal.is_local() else pathlib.Path("/app")

app = modal.App("slicerlive-live-renderer")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1", "vulkan-tools",          # Vulkan loader + vulkaninfo
        "mesa-utils-extra",                     # pulls the GL userspace libs NVIDIA needs
        "libglvnd0", "libx11-6", "libxext6",   # glvnd dispatch + Xlib (libGLX_nvidia links these)
        "curl", "unzip", "ca-certificates",
    )
    .run_commands(
        # Modal mounts the NVIDIA driver libs but NOT these vendor JSONs (tools/modal_spike/
        # vulkan_probe.py finding) -- without them wgpu silently falls back to llvmpipe (CPU).
        "mkdir -p /usr/share/vulkan/icd.d /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
        f"curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/download/{DENO_VERSION}"
        "/deno-x86_64-unknown-linux-gnu.zip",
        "unzip -o /tmp/deno.zip -d /usr/local/bin && chmod +x /usr/local/bin/deno && rm /tmp/deno.zip",
    )
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all",
        "NVIDIA_VISIBLE_DEVICES": "all",
        "DENO_DIR": "/tmp/deno",
        "DENO_NO_UPDATE_CHECK": "1",
        "DEMO": "multi",
    })
    # The renderer is dependency-free TS: shipping these four trees IS the deploy.
    .add_local_dir(ROOT / "render", "/app/render")
    .add_local_dir(ROOT / "algorithms", "/app/algorithms")
    .add_local_dir(ROOT / "logic", "/app/logic")
    .add_local_dir(ROOT / "server", "/app/server", ignore=["*.py"])
)


@app.function(
    image=image,
    gpu="L4",
    timeout=60 * 60,          # a viewing session may sit open for an hour
    scaledown_window=300,     # transient: the GPU goes away 5 min after the last request
    max_containers=4,
)
# A container must serve the page AND hold a long-lived WebSocket at the same time; without this
# the WS occupies the container's only input slot and nothing else is answered.
@modal.concurrent(max_inputs=32)
# The Deno process binds the port only AFTER the scene is on the GPU, so allow for the load.
@modal.web_server(PORT, startup_timeout=180)
def live_renderer():
    subprocess.Popen(
        ["deno", "run", "--unstable-webgpu", "--allow-net", "--allow-read", "--allow-env",
         "/app/server/live-renderer.ts"],
        cwd="/app",
    )
