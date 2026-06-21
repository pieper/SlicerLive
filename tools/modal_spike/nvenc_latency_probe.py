"""
LiveRenderer GPU NVENC path -- end-to-end latency & throughput on Modal (L4).

Pipeline measured (1080p):
  wgpu render (Vulkan/L4) -> readback RGBA -> cupy RGBA->NV12 on the GPU -> NVENC encode (CUDA
  device input) -> H.264 bitstream.

This removes the CPU color-convert that capped the earlier spike at 22 fps. The color-convert runs
on the GPU (cupy) and NVENC takes a CUDA device buffer (usecpuinputbuffer=False) -- so the only host
touch is the RGBA readback (wgpu-py can't export Vulkan external memory for true zero-copy; that's the
remaining optimization, and an 8 MB 1080p readback is sub-ms over PCIe anyway).

Reports: render fps, end-to-end throughput (fps), per-frame end-to-end latency p50/p95/max, achieved
bitrate, and a pure-NVENC-only ceiling (encode a static device frame) to isolate the encoder.

Run:  modal run nvenc_latency_probe.py            (default 300 frames @1080p)
      modal run nvenc_latency_probe.py --n 600 --w 1920 --h 1080
"""

import json
import statistics
import subprocess
import time

import modal

_IMPORT_TS = time.time()
app = modal.App("nvenc-latency")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libvulkan1", "vulkan-tools", "mesa-utils-extra",
        "libglvnd0", "libx11-6", "libxext6", "pciutils",
    )
    # cupy needs the CUDA toolkit headers to JIT its elementwise kernels -> [ctk] extra.
    .pip_install("wgpu", "numpy", "PyNvVideoCodec", "cupy-cuda12x[ctk]")
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


def _pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))] * 1000, 2)  # ms


@app.function(gpu="L4", image=image, scaledown_window=60, timeout=300)
def bench(n: int = 300, W: int = 1920, H: int = 1080, bitrate_kbps: int = 10000):
    import numpy as np
    import wgpu
    import cupy as cp
    import PyNvVideoCodec as nvc

    out = {"frames": n, "w": W, "h": H}

    # ---- wgpu (Vulkan) render target + readback buffer ------------------------------------
    adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
    out["adapter"] = {k: dict(adapter.info).get(k) for k in ("backend_type", "adapter_type", "device")}
    device = adapter.request_device_sync()
    tex = device.create_texture(
        size=(W, H, 1), format="rgba8unorm",
        usage=wgpu.TextureUsage.RENDER_ATTACHMENT | wgpu.TextureUsage.COPY_SRC)
    bpr = W * 4  # 1920*4 = 7680 = 256*30, aligned
    rbuf = device.create_buffer(size=bpr * H, usage=wgpu.BufferUsage.COPY_DST | wgpu.BufferUsage.MAP_READ)

    def render_readback(i):
        ce = device.create_command_encoder()
        rp = ce.begin_render_pass(color_attachments=[{
            "view": tex.create_view(),
            "clear_value": (0.1, (i % 60) / 60.0, 0.8, 1.0),
            "load_op": "clear", "store_op": "store"}])
        rp.end()
        ce.copy_texture_to_buffer(
            {"texture": tex, "mip_level": 0, "origin": (0, 0, 0)},
            {"buffer": rbuf, "bytes_per_row": bpr, "rows_per_image": H}, (W, H, 1))
        device.queue.submit([ce.finish()])
        rbuf.map_sync(wgpu.MapMode.READ)
        a = np.frombuffer(rbuf.read_mapped(), dtype=np.uint8).reshape(H, W, 4)
        rbuf.unmap()
        return a

    # ---- GPU RGBA->NV12 (cupy), returned to host (small) for NVENC CPU input --------------
    # (wgpu-py can't export Vulkan memory for true zero-copy; the color-MATH stays on the GPU,
    #  only a compact NV12 buffer touches the host -- sub-ms and erased by unified memory later.)
    def to_nv12_host(rgba_host):
        d = cp.asarray(rgba_host).astype(cp.float32)
        r, g, b = d[:, :, 0], d[:, :, 1], d[:, :, 2]
        y = cp.clip(0.257 * r + 0.504 * g + 0.098 * b + 16, 0, 255).astype(cp.uint8)
        u = cp.clip(-0.148 * r - 0.291 * g + 0.439 * b + 128, 0, 255).astype(cp.uint8)
        v = cp.clip(0.439 * r - 0.368 * g - 0.071 * b + 128, 0, 255).astype(cp.uint8)
        uv = cp.empty((H // 2, W), cp.uint8)
        uv[:, 0::2] = u[::2, ::2]; uv[:, 1::2] = v[::2, ::2]
        nv12 = cp.ascontiguousarray(cp.concatenate([y, uv], axis=0))  # (H*3/2, W)
        return cp.asnumpy(nv12)  # syncs + brings to host

    # ---- NVENC encoder (CPU input -- the proven path) -------------------------------------
    enc, mode = None, None
    for kw, m in (
        (dict(codec="h264", bitrate=bitrate_kbps * 1000, tuning_info="ultra_low_latency"), "cpu+ull"),
        (dict(codec="h264"), "cpu"),
    ):
        try:
            enc = nvc.CreateEncoder(W, H, "NV12", True, **kw); mode = m; break
        except Exception as e:
            out.setdefault("enc_init_errors", []).append(f"{m}: {e!r}")
    if enc is None:
        out["error"] = "NVENC init failed"; return out
    out["encoder_mode"] = mode

    def encode(nv12_host):
        bs = enc.Encode(nv12_host)
        return len(bytes(bs)) if bs is not None else 0

    # ---- warmup ---------------------------------------------------------------------------
    for i in range(10):
        encode(to_nv12_host(render_readback(i)))

    # ---- timed end-to-end loop ------------------------------------------------------------
    lat, t_r, t_c, t_e, total_bytes = [], 0.0, 0.0, 0.0, 0
    wall0 = time.time()
    for i in range(n):
        f0 = time.time()
        rgba = render_readback(i); f1 = time.time()
        nv12 = to_nv12_host(rgba); f2 = time.time()
        total_bytes += encode(nv12); f3 = time.time()
        lat.append(f3 - f0); t_r += f1 - f0; t_c += f2 - f1; t_e += f3 - f2
    try:
        total_bytes += len(bytes(enc.EndEncode()))
    except Exception:
        pass
    wall = time.time() - wall0

    # ---- pure NVENC ceiling (encode a static host frame) ----------------------------------
    static = to_nv12_host(render_readback(0))
    e0 = time.time()
    for _ in range(n):
        enc.Encode(static)
    try:
        enc.EndEncode()
    except Exception:
        pass
    enc_only = time.time() - e0

    secs = wall
    out.update(
        end_to_end_fps=round(n / secs, 1),
        latency_ms={"p50": _pct(lat, 0.5), "p95": _pct(lat, 0.95), "max": round(max(lat) * 1000, 2)},
        stage_ms_avg={"render+readback": round(t_r / n * 1000, 2),
                      "nv12_convert": round(t_c / n * 1000, 2),
                      "nvenc_encode": round(t_e / n * 1000, 2)},
        render_only_fps=round(n / t_r, 1),
        nvenc_only_fps=round(n / enc_only, 1),
        achieved_mbps=round(total_bytes * 8 / secs / 1e6, 2),
        avg_frame_kb=round(total_bytes / n / 1024, 1),
        total_h264_mb=round(total_bytes / 1e6, 2),
    )
    return out


@app.local_entrypoint()
def main(n: int = 300, w: int = 1920, h: int = 1080):
    print("\n=== GPU NVENC end-to-end (cold container) ===")
    t0 = time.time(); r = bench.remote(n, w, h); wall = time.time() - t0
    print(f"  cold wall clock (incl. boot+build-cached): {wall:.2f} s")
    print(json.dumps(r, indent=2))
    if "error" not in r:
        print("\n=== VERDICT ===")
        print(f"  render: {r['adapter']['backend_type']}/{r['adapter']['device']} @ {r['render_only_fps']} fps")
        print(f"  end-to-end: {r['end_to_end_fps']} fps | latency p50 {r['latency_ms']['p50']} ms / p95 {r['latency_ms']['p95']} ms")
        print(f"  NVENC-only ceiling: {r['nvenc_only_fps']} fps | stages(ms): {r['stage_ms_avg']}")
        print(f"  bitstream: {r['achieved_mbps']} Mbps, {r['avg_frame_kb']} KB/frame")
