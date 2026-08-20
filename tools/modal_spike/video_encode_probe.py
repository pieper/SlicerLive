"""
What hardware ENCODE paths does the render container actually have?

The renderer already owns a Vulkan device (wgpu). If that same device exposes the Vulkan video
encode queue, patches can be encoded on the GPU that drew them, with no browser sandbox and no
extra copy out to a separate encoder API. This probe reports, on the real L4 image:
  - Vulkan video encode extensions + a queue family with VIDEO_ENCODE set
  - which codecs (H.264 / H.265 / AV1) that queue advertises
  - whether NVENC and the NVJPG (nvJPEG) engines are present as a fallback path

    modal run tools/modal_spike/video_encode_probe.py
"""

import pathlib
import subprocess

import modal

ROOT = pathlib.Path(__file__).resolve().parents[2] if modal.is_local() else pathlib.Path("/app")
app = modal.App("slicerlive-video-encode-probe")

# EXACTLY the renderer's image recipe — anything less and the NVIDIA ICD fails to load, Vulkan
# silently falls back to llvmpipe, and every capability answer is about a software rasteriser.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1", "vulkan-tools",
        "mesa-utils-extra",
        "libglvnd0", "libx11-6", "libxext6",
        "curl", "unzip", "ca-certificates", "pciutils", "findutils",
    )
    .run_commands(
        "mkdir -p /usr/share/vulkan/icd.d /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)


@app.function(image=image, gpu="L4", timeout=600)
def probe() -> dict:
    def sh(cmd: str) -> str:
        try:
            p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=120)
            return (p.stdout + p.stderr).strip()
        except Exception as e:  # noqa: BLE001
            return f"(failed: {e})"

    info = sh("vulkaninfo 2>/dev/null")
    encode_ext = sorted({
        line.strip().split(":")[0].strip()
        for line in info.splitlines()
        if "video_encode" in line.lower() and line.strip().startswith("VK_")
    })
    # queue families that advertise VIDEO_ENCODE
    qf, cur, keep = [], [], False
    for line in info.splitlines():
        if line.strip().startswith("queueProperties") or line.strip().startswith("VkQueueFamilyProperties"):
            if keep and cur:
                qf.append("\n".join(cur))
            cur, keep = [line.strip()], False
        elif cur is not None:
            cur.append(line.rstrip())
            if "VIDEO_ENCODE" in line:
                keep = True
    if keep and cur:
        qf.append("\n".join(cur))

    return {
        "gpu": sh("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader"),
        "vulkan_device": sh("vulkaninfo --summary 2>/dev/null | grep deviceName | head -3"),
        "video_ext_any": sh("vulkaninfo 2>/dev/null | grep -io 'VK_KHR_video[a-z0-9_]*' | sort -u | head -20"),
        "video_encode_extensions": encode_ext,
        "encode_queue_families": len(qf),
        "encode_queue_detail": "\n---\n".join(q[:600] for q in qf[:3]),
        "nvenc_lib": sh("ls -1 /usr/lib/x86_64-linux-gnu/libnvidia-encode* 2>/dev/null | head -3") or "(absent)",
        "nvjpeg_lib": sh("ls -1 /usr/lib/x86_64-linux-gnu/libnvjpeg* /usr/local/cuda*/lib64/libnvjpeg* 2>/dev/null | head -3") or "(absent)",
        "nvidia_smi_encoder": sh("nvidia-smi -q | grep -A3 -i 'encoder' | head -20"),
    }


@app.local_entrypoint()
def main():
    import json
    print(json.dumps(probe.remote(), indent=2))
