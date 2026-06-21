"""What does PyNvVideoCodec Encode() actually return per call? (empty first? Annex-B? where's SPS?)
Minimal: synthetic NV12 frames, no volume. Fixes our WebCodecs framing once we see the structure."""
import binascii
import json
import modal

app = modal.App("nvenc-frame-probe")
image = modal.Image.debian_slim(python_version="3.11").pip_install("numpy", "PyNvVideoCodec").env(
    {"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
W, H = 1280, 720


def _nals(b):
    types = []; j = 0; n = len(b)
    while j + 3 <= n:
        if b[j] == 0 and b[j+1] == 0 and b[j+2] == 1:
            types.append(b[j+3] & 0x1f); j += 3
        elif j + 4 <= n and b[j] == 0 and b[j+1] == 0 and b[j+2] == 0 and b[j+3] == 1:
            types.append(b[j+4] & 0x1f); j += 4
        else:
            j += 1
    return types


@app.function(gpu="L4", image=image, timeout=120)
def probe():
    import numpy as np, PyNvVideoCodec as nvc
    enc = nvc.CreateEncoder(W, H, "NV12", True, codec="h264", bitrate=6000000,
                            tuning_info="ultra_low_latency", bf=0, gop=60, rc="cbr")
    res = []
    for i in range(6):
        nv12 = np.empty((H * 3 // 2, W), np.uint8)
        nv12[:H] = (i * 30) % 255  # varying Y so frames differ
        nv12[H:] = 128
        bs = enc.Encode(nv12)
        b = bytes(bs) if bs is not None else b""
        res.append({"call": i, "type": type(bs).__name__, "len": len(b),
                    "hex16": binascii.hexlify(b[:16]).decode(), "nals": _nals(b)})
    tail = enc.EndEncode()
    tb = bytes(tail) if tail is not None else b""
    res.append({"call": "end", "type": type(tail).__name__, "len": len(tb), "nals": _nals(tb)})
    return res


@app.local_entrypoint()
def main():
    for r in probe.remote():
        print(json.dumps(r))
