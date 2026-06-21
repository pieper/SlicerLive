"""Does PyNvVideoCodec accept direct 4-channel (ARGB/ABGR) CPU input so NVENC does the color
convert on-GPU (no cupy, no numpy YUV math)? Try a few formats; report which yield valid H.264."""
import binascii, json, modal
app = modal.App("abgr-probe")
image = modal.Image.debian_slim(python_version="3.11").pip_install("numpy", "PyNvVideoCodec").env(
    {"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
W, H = 1280, 720


def _nals(b):
    t = []; j = 0; n = len(b)
    while j + 3 <= n:
        if b[j] == 0 and b[j+1] == 0 and b[j+2] == 1: t.append(b[j+3] & 0x1f); j += 3
        elif j + 4 <= n and b[j] == 0 and b[j+1] == 0 and b[j+2] == 0 and b[j+3] == 1: t.append(b[j+4] & 0x1f); j += 4
        else: j += 1
    return t


@app.function(gpu="L4", image=image, timeout=120)
def probe():
    import numpy as np, PyNvVideoCodec as nvc, time
    out = {}
    for fmt, shape in [("ARGB", (H, W, 4)), ("ABGR", (H, W, 4))]:
        try:
            enc = nvc.CreateEncoder(W, H, fmt, True, codec="h264", bitrate=6000000,
                                    tuning_info="ultra_low_latency", bf=0, gop=60, rc="cbr")
            frame = np.zeros(shape, np.uint8); frame[..., 0] = 200; frame[..., 1] = 120
            t = time.time(); got = b""
            for _ in range(8):
                bs = enc.Encode(frame)
                if bs:
                    got = bytes(bs); break
            out[fmt] = {"ok": bool(got), "len": len(got), "nals": _nals(got),
                        "per_frame_ms": round((time.time() - t) / 8 * 1000, 1)}
        except Exception as e:
            out[fmt] = {"error": repr(e)[:120]}
    return out


@app.local_entrypoint()
def main():
    print(json.dumps(probe.remote(), indent=2))
