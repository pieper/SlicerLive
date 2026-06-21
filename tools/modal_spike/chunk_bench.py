"""
Optimize Zarr chunking for Modal Volume IO. The 120 s full read was serial per-chunk latency
(1561 chunks). Test: chunk size (file count) x serial-vs-parallel read, COLD (fresh container).

build()   writes variants from the cached bee.npy (single 5.7 GB file -> fast load).
readtest() runs in a FRESH container (cold Volume view) and times cold reads of each variant.

Run:  modal run chunk_bench.py
"""
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import modal

app = modal.App("chunk-bench")
cache = modal.Volume.from_name("slicerlive-cache")
image = modal.Image.debian_slim(python_version="3.11").pip_install("numpy", "zarr<3", "numcodecs")

VARIANTS = {"c256": (256, 256, 256), "c512": (512, 512, 512)}  # c128 already = bumblebee.zarr


def _nfiles(p):
    return sum(len(fs) for _, _, fs in os.walk(p)) if os.path.exists(p) else -1


def _blocks(shape, chunks):
    b = []
    for i in range(0, shape[0], chunks[0]):
        for j in range(0, shape[1], chunks[1]):
            for k in range(0, shape[2], chunks[2]):
                b.append((slice(i, min(i + chunks[0], shape[0])),
                          slice(j, min(j + chunks[1], shape[1])),
                          slice(k, min(k + chunks[2], shape[2]))))
    return b


@app.function(image=image, volumes={"/cache": cache}, memory=49152, timeout=1200)
def build():
    import numpy as np, zarr
    from numcodecs import Blosc
    comp = Blosc(cname="zstd", clevel=3, shuffle=Blosc.BITSHUFFLE)
    data = np.load("/cache/bee.npy")  # single file, fast
    out = {}
    # c128 already exists as bumblebee.zarr; (re)write the coarser variants
    for name, cs in VARIANTS.items():
        p = f"/cache/cb_{name}.zarr"
        z = zarr.open(p, mode="w", shape=data.shape, chunks=cs, dtype=data.dtype, compressor=comp)
        z[:] = data
        out[name] = {"files": _nfiles(p), "MB": round(sum(os.path.getsize(os.path.join(dp, f))
                     for dp, _, fs in os.walk(p) for f in fs) / 1e6, 1)}
    cache.commit()
    return out


@app.function(image=image, volumes={"/cache": cache}, memory=49152, timeout=1200)
def readtest():
    import numpy as np, zarr
    res = {}

    def serial(p):
        z = zarr.open(p, mode="r"); t = time.time(); _ = z[:]; return round(time.time() - t, 1)

    def parallel(p, workers):
        z = zarr.open(p, mode="r"); out = np.empty(z.shape, z.dtype)
        blks = _blocks(z.shape, z.chunks)

        def rd(sl):
            out[sl] = z[sl]
        t = time.time()
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(rd, blks))
        return round(time.time() - t, 1)

    # each path is cold on first access in this fresh container; use a DISTINCT path per measurement
    res["c512_serial"] = serial("/cache/cb_c512.zarr")     # 36 files
    res["c256_serial"] = serial("/cache/cb_c256.zarr")     # ~210 files
    res["c128_parallel64"] = parallel("/cache/bumblebee.zarr", 64)  # 1560 files, parallel
    # for parallel timings of the coarse-chunk variants we need cold paths -> they were warmed above;
    # so re-measure parallel on the still-cold full original at different worker counts:
    res["c128_files"] = _nfiles("/cache/bumblebee.zarr")
    res["c256_files"] = _nfiles("/cache/cb_c256.zarr")
    res["c512_files"] = _nfiles("/cache/cb_c512.zarr")
    return res


@app.local_entrypoint()
def main():
    print("building variants…")
    print(json.dumps(build.remote(), indent=2))
    print("cold read test (fresh container)…")
    print(json.dumps(readtest.remote(), indent=2))
