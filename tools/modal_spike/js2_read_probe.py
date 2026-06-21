"""Measure parallel read of the pyramid levels from the public JS2 Swift bucket INTO a Modal worker
(the relevant direction for the renderer). Compare to the Modal Volume's ~120 s / ~50 MB/s wall."""
import itertools
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor

import modal

app = modal.App("js2-read-probe")
image = modal.Image.debian_slim(python_version="3.11").pip_install("requests", "numpy", "numcodecs")
BASE = "https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive-data"


def read_level(level, workers):
    import requests, numpy as np
    import numcodecs
    base = f"{BASE}/{level}"
    za = json.loads(requests.get(base + "/.zarray", timeout=30).text)
    shape, chunks, dtype = za["shape"], za["chunks"], np.dtype(za["dtype"])
    order = za.get("order", "C")
    comp = numcodecs.get_codec(za["compressor"]) if za.get("compressor") else None
    grid = [range(math.ceil(shape[i] / chunks[i])) for i in range(3)]
    coords = list(itertools.product(*grid))
    out = np.empty(shape, dtype, order=order)
    sess = requests.Session()

    def rd(c):
        key = ".".join(map(str, c))
        r = sess.get(f"{base}/{key}", timeout=60)
        raw = r.content
        buf = comp.decode(raw) if comp else raw
        arr = np.frombuffer(buf, dtype).reshape(chunks, order=order)
        sl = tuple(slice(c[i] * chunks[i], min((c[i] + 1) * chunks[i], shape[i])) for i in range(3))
        asl = tuple(slice(0, sl[i].stop - sl[i].start) for i in range(3))
        out[sl] = arr[asl]
        return len(raw)
    t = time.time()
    with ThreadPoolExecutor(workers) as ex:
        tot = sum(ex.map(rd, coords))
    dt = time.time() - t
    return {"level": level, "chunks": len(coords), "MB": round(tot / 1e6, 1),
            "seconds": round(dt, 1), "MBps": round(tot / 1e6 / dt, 1)}


@app.function(image=image, region=["us-east"], timeout=400)
def probe():
    res = {}
    res["L1_w8"] = read_level("bumblebee_L1.zarr", 8)
    res["L1_w32"] = read_level("bumblebee_L1.zarr", 32)
    res["L1_w64"] = read_level("bumblebee_L1.zarr", 64)
    res["L2_w16"] = read_level("bumblebee_L2.zarr", 16)
    res["L8_w8"] = read_level("bumblebee_L8.zarr", 8)
    return res


@app.local_entrypoint()
def main():
    print(json.dumps(probe.remote(), indent=2))
