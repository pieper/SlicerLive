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
CODEC = "av1"   # hardware AV1 via the Rust sidecar; falls back to gzip if it can't start
# Short scaledown so the container scales to ZERO (billing stops) soon after the last client
# releases its WebSocket — the client owns the user-chosen idle timeout, this is just the tail.
SCALEDOWN_S = 20
GPU_RATE_PER_HR = 0.80   # L4 list price (modal.com/pricing); shown in the client's cost meter
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
        # Rust, for the AV1 encode sidecar (native/encode). It links the driver's libnvidia-encode,
        # injected only at RUNTIME — so the sidecar is BUILT at container start, not in the image.
        "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
    )
    .apt_install("build-essential", "pkg-config")
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all",
        "NVIDIA_VISIBLE_DEVICES": "all",
        "DENO_DIR": "/tmp/deno",
        "DENO_NO_UPDATE_CHECK": "1",
        "DEMO": "multi",
        "GPU_RATE_PER_HR": str(GPU_RATE_PER_HR),
        "SCALEDOWN_S": str(SCALEDOWN_S),
    })
    # The renderer is dependency-free TS: shipping these trees IS the deploy.
    .add_local_dir(ROOT / "render", "/app/render")
    .add_local_dir(ROOT / "algorithms", "/app/algorithms")
    .add_local_dir(ROOT / "logic", "/app/logic")
    .add_local_dir(ROOT / "server", "/app/server", ignore=["*.py"])
    .add_local_dir(ROOT / "native", "/app/native", ignore=["target", "**/target"])
)

# The compiled sidecar is cached here between cold starts (keyed by CPU flags — target-cpu=native
# binaries SIGILL on a different host).
build_vol = modal.Volume.from_name("slicerlive-native-build", create_if_missing=True)


@app.function(
    image=image,
    gpu="L4",
    timeout=60 * 60,          # a viewing session may sit open for an hour
    scaledown_window=SCALEDOWN_S,   # transient: GPU scales to zero this long after the last WS drops
    max_containers=4,
    volumes={"/build": build_vol},
)
# A container must serve the page AND hold a long-lived WebSocket at the same time; without this
# the WS occupies the container's only input slot and nothing else is answered.
@modal.concurrent(max_inputs=32)
# The Deno process binds the port only AFTER the scene is on the GPU, so allow for the load.
@modal.web_server(PORT, startup_timeout=300)
def live_renderer():
    import hashlib
    import os

    env = dict(os.environ)
    # Build (or reuse) the AV1 encode sidecar for THIS host, then hand its path to the server.
    if CODEC == "av1":
        try:
            # driver libs are injected as versioned .so only; the crate links the unversioned names
            subprocess.run(["bash", "-c",
                "cd /usr/lib/x86_64-linux-gnu && for l in nvidia-encode nvcuvid cuda; do "
                "[ -e lib$l.so ] || ln -s $(ls lib$l.so.* | head -1) lib$l.so; done"], check=False)
            flags = subprocess.run(["bash", "-c", "lscpu | grep Flags"], capture_output=True, text=True).stdout
            # Key the build dir on CPU (target-cpu=native SIGILLs across hosts) AND on the source
            # (mounted-file mtimes are stable, so cargo's fingerprint never notices edits — a stale
            # cached binary silently served the wrong protocol/codec before this).
            srchash = subprocess.run(
                ["bash", "-c", "find /app/native -name '*.rs' -o -name Cargo.toml | sort | xargs cat | md5sum"],
                capture_output=True, text=True).stdout[:12]
            key = hashlib.md5((flags + srchash).encode()).hexdigest()[:12]
            target = f"/build/target-{key}"
            binp = f"{target}/release/liverender-sidecar"
            if not pathlib.Path(binp).exists():
                subprocess.run(["bash", "-c", "find /app/native -name '*.rs' -exec touch {} +"], check=False)
                subprocess.run(
                    ["cargo", "build", "--release", "-p", "liverender-encode", "--bin", "liverender-sidecar"],
                    cwd="/app/native",
                    env={**env, "CARGO_HOME": "/build/cargo", "CARGO_TARGET_DIR": target,
                         "PATH": "/root/.cargo/bin:" + env.get("PATH", "")},
                    check=True, timeout=600,
                )
                build_vol.commit()
            env["SIDECAR_BIN"] = binp
            env["CODEC"] = "av1"
        except Exception as e:  # noqa: BLE001
            print(f"[modal] sidecar build failed, gzip fallback: {e}")

    subprocess.Popen(
        ["deno", "run", "--unstable-webgpu", "--unstable-net", "--allow-net", "--allow-read",
         "--allow-env", "--allow-run", "--allow-write", "/app/server/live-renderer.ts"],
        cwd="/app", env=env,
    )
