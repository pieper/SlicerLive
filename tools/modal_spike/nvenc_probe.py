"""
LiveRenderer render->encode spike on Modal: wgpu (Vulkan, NVIDIA L4) renders a frame, NVENC
(NVIDIA hardware H.264) encodes it to a video bitstream -- all in one scale-to-zero container.

What this settles:
  - Does NVENC initialize in a Modal GPU container (libnvidia-encode is mounted)?
  - Can a wgpu-rendered frame be fed to NVENC end-to-end -> valid H.264 bytes?
  - Throughput (frames/s, encode time) for the LiveRenderer pixel path.

ZERO-COPY NOTE: "straight from the wgpu buffer" (no CPU hop) needs Vulkan<->CUDA external-memory
interop (VK_KHR_external_memory_fd -> cudaImportExternalMemory) so NVENC reads the wgpu texture's
device memory directly. That's the optimization. This spike first proves the pipeline with a
readback hop (render -> map to host -> NVENC), then reports whether the interop libs are present.

Run:
    modal run nvenc_probe.py
"""

import json
import subprocess
import time

import modal

_IMPORT_TS = time.time()
app = modal.App("nvenc-probe")

# Reuse the proven GL/Vulkan recipe + NVIDIA's Python Video Codec SDK (NVENC) + numpy.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1", "vulkan-tools", "mesa-utils-extra",
        "libglvnd0", "libx11-6", "libxext6", "pciutils",
    )
    .pip_install("wgpu", "numpy", "PyNvVideoCodec")
    .run_commands(
        "mkdir -p /usr/share/vulkan/icd.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)

W, H = 1280, 720  # 1280*4 = 5120 bytes/row, divisible by 256 (no copy padding needed)


def _run(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip() or "(empty)"
    except Exception as e:
        return f"(failed: {e})"


def _wgpu_render_frames(n):
    """Render n frames with wgpu (Vulkan) and read each back as an HxWx4 uint8 RGBA array."""
    import wgpu
    import numpy as np

    adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
    info = dict(adapter.info)
    device = adapter.request_device_sync()

    tex = device.create_texture(
        size=(W, H, 1), format="rgba8unorm",
        usage=wgpu.TextureUsage.RENDER_ATTACHMENT | wgpu.TextureUsage.COPY_SRC,
    )
    bpr = W * 4
    buf = device.create_buffer(size=bpr * H, usage=wgpu.BufferUsage.COPY_DST | wgpu.BufferUsage.MAP_READ)

    frames, t_render = [], 0.0
    for i in range(n):
        t0 = time.time()
        ce = device.create_command_encoder()
        rp = ce.begin_render_pass(color_attachments=[{
            "view": tex.create_view(),
            "clear_value": (0.1, (i % 60) / 60.0, 0.8, 1.0),  # vary color per frame
            "load_op": "clear", "store_op": "store",
        }])
        rp.end()
        ce.copy_texture_to_buffer(
            {"texture": tex, "mip_level": 0, "origin": (0, 0, 0)},
            {"buffer": buf, "bytes_per_row": bpr, "rows_per_image": H},
            (W, H, 1),
        )
        device.queue.submit([ce.finish()])
        buf.map_sync(wgpu.MapMode.READ)
        rgba = np.frombuffer(buf.read_mapped(), dtype=np.uint8).reshape(H, W, 4).copy()
        buf.unmap()
        frames.append(rgba)
        t_render += time.time() - t0
    return info, frames, t_render


def _nvenc_encode(frames):
    """Encode RGBA frames with NVENC. Returns (ok, total_bytes, seconds, note)."""
    import numpy as np
    import PyNvVideoCodec as nvc

    # NVENC wants NV12 most reliably; convert RGBA -> NV12 (BT.601) on the CPU for the spike.
    def rgba_to_nv12(rgba):
        r = rgba[:, :, 0].astype(np.float32); g = rgba[:, :, 1].astype(np.float32); b = rgba[:, :, 2].astype(np.float32)
        y = (0.257 * r + 0.504 * g + 0.098 * b + 16).clip(0, 255).astype(np.uint8)
        u = (-0.148 * r - 0.291 * g + 0.439 * b + 128).clip(0, 255).astype(np.uint8)
        v = (0.439 * r - 0.368 * g - 0.071 * b + 128).clip(0, 255).astype(np.uint8)
        u2 = u[::2, ::2]; v2 = v[::2, ::2]
        uv = np.empty((H // 2, W), np.uint8); uv[:, 0::2] = u2; uv[:, 1::2] = v2
        return np.concatenate([y, uv], axis=0)  # (H*3/2, W)

    enc = None
    for kwargs in (
        dict(format="NV12", codec="h264"),
        dict(format="NV12"),
    ):
        try:
            enc = nvc.CreateEncoder(W, H, kwargs.get("format", "NV12"), True, **{k: v for k, v in kwargs.items() if k != "format"})
            break
        except Exception as e:
            last = repr(e)
    if enc is None:
        return False, 0, 0.0, f"CreateEncoder failed: {last}"

    total, t0 = 0, time.time()
    for f in frames:
        nv12 = rgba_to_nv12(f)
        try:
            bs = enc.Encode(nv12)
        except Exception as e:
            return False, total, time.time() - t0, f"Encode failed: {e!r}"
        total += len(bytes(bs)) if bs is not None else 0
    try:
        tail = enc.EndEncode()
        total += len(bytes(tail)) if tail is not None else 0
    except Exception:
        pass
    return True, total, time.time() - t0, "ok"


@app.function(gpu="L4", image=image, scaledown_window=60, timeout=300)
def probe(n_frames: int = 120):
    out = {"import_to_call_s": round(time.time() - _IMPORT_TS, 3)}
    out["nvidia_smi"] = _run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"])
    out["nvenc_lib"] = _run(["bash", "-c", "ls /usr/lib/x86_64-linux-gnu/libnvidia-encode.so* 2>/dev/null || echo MISSING"])
    # zero-copy interop building blocks present?
    out["cuda_lib"] = _run(["bash", "-c", "ls /usr/lib/x86_64-linux-gnu/libcuda.so* 2>/dev/null || echo MISSING"])

    try:
        info, frames, t_render = _wgpu_render_frames(n_frames)
        out["wgpu_adapter"] = {k: info.get(k) for k in ("backend_type", "adapter_type", "device", "description")}
        out["render_s"] = round(t_render, 3)
        out["render_fps"] = round(n_frames / t_render, 1) if t_render else None
    except Exception as e:
        out["wgpu_error"] = repr(e)
        return out

    ok, nbytes, enc_s, note = _nvenc_encode(frames)
    out["nvenc"] = {
        "ok": ok, "note": note,
        "h264_bytes": nbytes,
        "encode_s": round(enc_s, 3),
        "encode_fps": round(len(frames) / enc_s, 1) if enc_s else None,
        "avg_frame_kb": round(nbytes / len(frames) / 1024, 1) if frames else None,
    }
    out["probe_seconds"] = round(time.time() - out["import_to_call_s"] - _IMPORT_TS, 1) if False else None
    return out


@app.local_entrypoint()
def main(n: int = 120):
    print("\n=== COLD: wgpu render -> NVENC encode ===")
    t0 = time.time(); r = probe.remote(n); wall = time.time() - t0
    print(f"  cold wall clock: {wall:.2f} s")
    print(json.dumps(r, indent=2))

    nv = r.get("nvenc") or {}
    print("\n=== VERDICT ===")
    print(f"  wgpu render:   {r.get('wgpu_adapter', {}).get('backend_type')} / {r.get('wgpu_adapter', {}).get('device')}  @ {r.get('render_fps')} fps")
    print(f"  NVENC encode:  {'OK' if nv.get('ok') else 'FAILED'}  ({nv.get('note')})  @ {nv.get('encode_fps')} fps, {nv.get('h264_bytes')} H.264 bytes")
    print(f"  zero-copy interop libs: libcuda={'yes' if 'MISSING' not in r.get('cuda_lib','') else 'NO'} libnvidia-encode={'yes' if 'MISSING' not in r.get('nvenc_lib','') else 'NO'}")
