"""
Minimal GPU-graphics capability probe on Modal -- RESULT: hardware GL + Vulkan WORK on an L4.

The question this answers: can a minimal Modal container get a hardware GPU graphics stack
(Vulkan and/or OpenGL/EGL) on the GPU, and what is the true minimal cold start? This is the
floor LiveRenderer would build on (slicerlive.js renders via WebGL2 -> ANGLE -> GL/EGL).

EMPIRICAL FINDING (2026-06-20, Modal L4, driver 580.95.05):
  - Modal honors NVIDIA_DRIVER_CAPABILITIES=all and mounts the NVIDIA driver LIBS, but does NOT
    inject the Vulkan ICD JSON or the EGL vendor JSON, and the minimal image is missing GL
    userspace libs -> by default Vulkan/GL silently fall back to Mesa llvmpipe (software, CPU).
  - FIX (this image): install the GL userspace (mesa-utils-extra pulls the needed libs) + the
    Xlib/glvnd deps, and write the two vendor JSONs (Vulkan ICD -> libGLX_nvidia.so.0; EGL ->
    libEGL_nvidia.so.0). Then the real "NVIDIA L4" enumerates as a DISCRETE_GPU under Vulkan,
    EGL_EXT_platform_device (surfaceless headless GL) works, and wgpu binds the GPU.
  - Cold start ~5-6 s cold / ~2 s warm for this small image. The "few-seconds LiveRenderer"
    story holds; a warm pool (min_containers) makes it sub-second.

Run:
    modal setup
    modal run vulkan_probe.py
"""

import json
import subprocess
import time

import modal

_IMPORT_TS = time.time()

app = modal.App("vulkan-probe")

# The working recipe: Vulkan loader + tools + EGL utils + the GL userspace + glvnd/Xlib deps,
# then persist the NVIDIA Vulkan ICD and EGL vendor JSONs (Modal injects the libs, not the JSONs).
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1", "vulkan-tools",          # Vulkan loader + vulkaninfo
        "mesa-utils-extra",                     # eglinfo + pulls the GL userspace libs NVIDIA needs
        "libglvnd0", "libx11-6", "libxext6",   # glvnd dispatch + Xlib (libGLX_nvidia links these)
        "pciutils", "binutils",                 # diagnostics (lspci, nm)
    )
    .pip_install("wgpu")
    .run_commands(
        # NVIDIA Vulkan ICD (the lib that exports vk_icdGetInstanceProcAddr on driver 580).
        "mkdir -p /usr/share/vulkan/icd.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
        # NVIDIA EGL vendor library (for surfaceless headless GL via EGL_EXT_platform_device).
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)


def _run(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip() or "(empty)"
    except Exception as e:
        return f"(failed: {e})"


def _clean(s):
    return "\n".join(l for l in s.splitlines() if "XDG_RUNTIME_DIR" not in l)


def _wgpu_probe():
    res = {}
    try:
        import wgpu
        res["version"] = getattr(wgpu, "__version__", "?")
        adapter = None
        for fn in (
            lambda: wgpu.gpu.request_adapter_sync(power_preference="high-performance"),
            lambda: wgpu.gpu.request_adapter(power_preference="high-performance"),
        ):
            try:
                adapter = fn(); break
            except Exception as e:
                res.setdefault("adapter_errors", []).append(repr(e))
        if adapter is None:
            res["adapter"] = None; return res
        info = getattr(adapter, "info", None)
        res["adapter_info"] = dict(info) if info else {}
        try:
            dev = (adapter.request_device_sync() if hasattr(adapter, "request_device_sync")
                   else adapter.request_device())
            res["device_created"] = bool(dev)
        except Exception as e:
            res["device_error"] = repr(e)
    except Exception as e:
        res["error"] = repr(e)
    return res


@app.function(gpu="L4", image=image, scaledown_window=60, timeout=180)
def probe():
    t_call = time.time()
    out = {"import_to_call_s": round(t_call - _IMPORT_TS, 3)}

    out["nvidia_smi"] = _run(
        ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"]
    )

    # Vulkan: does the default loader scan now enumerate the real NVIDIA GPU (vs only llvmpipe)?
    vinfo = _clean(_run(["bash", "-c", "vulkaninfo --summary 2>&1 | sed -n '/Devices:/,$p' | head -n 40"]))
    out["vulkan_devices"] = vinfo

    # EGL: NVIDIA vendor + surfaceless device platform (the path Chromium WebGL2 actually uses).
    out["egl"] = _run(
        ["bash", "-c",
         "eglinfo 2>&1 | grep -iE 'platform_device|egl vendor string|opengl renderer' | head -n 20"]
    )

    out["wgpu"] = _wgpu_probe()

    # The ULTIMATE target: wgpu on its VULKAN backend (real WebGPU), not the GL fallback.
    # Force the backend and report which device+backend wgpu binds.
    out["wgpu_vulkan_forced"] = _run(
        ["bash", "-c",
         "WGPU_BACKEND_TYPE=Vulkan python3 -c \"import wgpu,json;"
         "a=wgpu.gpu.request_adapter_sync(power_preference='high-performance');"
         "i=dict(a.info);print('WGPU_VK '+json.dumps({k:i.get(k) for k in "
         "('backend_type','adapter_type','device','description')}))\" 2>&1 | grep WGPU_VK || echo '(failed)'"]
    )

    ai = out["wgpu"].get("adapter_info") or {}
    dev = (ai.get("device") or ai.get("description") or "").lower()
    out["gpu_render_ok"] = ("nvidia" in dev) or ("nvidia" in vinfo.lower() and "discrete" in vinfo.lower())
    out["probe_seconds"] = round(time.time() - t_call, 3)
    return out


@app.local_entrypoint()
def main():
    print("\n=== COLD (scaled-to-zero -> probe) ===")
    t0 = time.time(); cold = probe.remote(); w_cold = time.time() - t0
    print(f"  client wall clock: {w_cold:.2f} s")
    print(json.dumps(cold, indent=2))

    t0 = time.time(); _ = probe.remote(); w_warm = time.time() - t0

    ai = (cold.get("wgpu") or {}).get("adapter_info") or {}
    print("\n=== VERDICT ===")
    print(f"  GPU present:           {'nvidia' in cold.get('nvidia_smi','').lower()}")
    print(f"  hardware GPU render:   {cold.get('gpu_render_ok')}")
    print(f"  wgpu backend / device: {ai.get('backend_type')} / {ai.get('device') or ai.get('description')}")
    print(f"  Vulkan enumerates:     {'NVIDIA' if 'nvidia' in cold.get('vulkan_devices','').lower() else 'software only'}")
    print(f"  minimal cold start:    {w_cold:.2f} s   (warm: {w_warm:.2f} s, overhead ~{w_cold - w_warm:.2f} s)")
