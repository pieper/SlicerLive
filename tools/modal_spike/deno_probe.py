"""
Does the SlicerLive renderer itself run on a Modal GPU container?

vulkan_probe.py already proved (2026-06-20, L4, driver 580.95.05) that Modal injects the NVIDIA
graphics libs and that -- once we write the Vulkan ICD / EGL vendor JSONs ourselves -- Vulkan
enumerates the real GPU. This probe reuses that image recipe and adds DENO, then runs the actual
TS/WebGPU code (render/, deno_probe.ts): adapter identity, a synthetic multi-field render, and the
REAL demo=multi scene (CTACardio + CTAAbdomenPanoramix + transform gizmo) -- stream-in time from
JetStream2 and traceSamples timings at streaming resolutions.

    modal run tools/modal_spike/deno_probe.py

PNGs land in tools/modal_spike/out/ for visual verification (they must match a local render).
"""

import json
import pathlib
import time

import modal

_IMPORT_TS = time.time()
DENO_VERSION = "v2.9.5"
# Local: the repo root, whose render/ tree we ship. In the container this module is re-imported
# from /root, where those parents don't exist — the sources are already at /app by then.
ROOT = pathlib.Path(__file__).resolve().parents[2] if modal.is_local() else pathlib.Path("/app")

app = modal.App("slicerlive-deno-probe")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1", "vulkan-tools",          # Vulkan loader + vulkaninfo
        "mesa-utils-extra",                     # pulls the GL userspace libs NVIDIA needs
        "libglvnd0", "libx11-6", "libxext6",   # glvnd dispatch + Xlib (libGLX_nvidia links these)
        "curl", "unzip", "ca-certificates",
    )
    .run_commands(
        # Modal mounts the NVIDIA driver libs but NOT these vendor JSONs (vulkan_probe.py finding).
        "mkdir -p /usr/share/vulkan/icd.d /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
        # Deno: pinned binary, not the install script (deterministic image layer).
        f"curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/download/{DENO_VERSION}"
        "/deno-x86_64-unknown-linux-gnu.zip",
        "unzip -o /tmp/deno.zip -d /usr/local/bin && chmod +x /usr/local/bin/deno && rm /tmp/deno.zip",
    )
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all",
        "NVIDIA_VISIBLE_DEVICES": "all",
        "DENO_DIR": "/tmp/deno",
        "DENO_NO_UPDATE_CHECK": "1",
    })
    # The renderer is dependency-free TS: the whole app is just these source trees
    # (render/ pulls in algorithms/ + logic/ through the scene builders).
    .add_local_dir(ROOT / "render", "/app/render")
    .add_local_dir(ROOT / "algorithms", "/app/algorithms")
    .add_local_dir(ROOT / "logic", "/app/logic")
    .add_local_file(ROOT / "tools/modal_spike/deno_probe.ts", "/app/tools/modal_spike/deno_probe.ts")
)


@app.function(image=image, gpu="L4", timeout=900)
def probe(launched_at: float) -> dict:
    import subprocess

    cold = time.time() - launched_at
    out = {"container_start_s": round(cold, 2)}

    def run(cmd, **kw):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=kw.get("timeout", 120))
            return (p.stdout + p.stderr).strip()
        except Exception as e:  # noqa: BLE001
            return f"(failed: {e})"

    out["nvidia_smi"] = run(["bash", "-lc", "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader"])
    out["vulkaninfo"] = run(["bash", "-lc", "vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName|apiVersion' | head -6"])

    t0 = time.time()
    log = run(["deno", "run", "--unstable-webgpu", "-A", "/app/tools/modal_spike/deno_probe.ts", "/tmp/out"], timeout=800)
    out["deno_wall_s"] = round(time.time() - t0, 1)
    out["log"] = log
    for line in log.splitlines():
        if line.startswith("PROBE_JSON "):
            out["result"] = json.loads(line[len("PROBE_JSON "):])

    pngs = {}
    for name in ("synthetic.png", "multi.png"):
        p = pathlib.Path("/tmp/out") / name
        if p.exists():
            pngs[name] = p.read_bytes()
    out["pngs"] = pngs
    return out


@app.local_entrypoint()
def main():
    res = probe.remote(_IMPORT_TS)
    outdir = ROOT / "tools/modal_spike/out"
    outdir.mkdir(exist_ok=True)
    for name, data in res.pop("pngs", {}).items():
        (outdir / name).write_bytes(data)
        print(f"wrote {outdir / name} ({len(data)/1e3:.0f} kB)")
    print(res.pop("log", ""))
    print(json.dumps(res, indent=2))
