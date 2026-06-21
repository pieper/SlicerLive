"""
Benchmark load/decompress paths for the bumblebee volume, to answer: how much faster than gzip-NRRD
can we get with Zarr (zstd, chunked) + a coarse multiscale level + raw .npy mmap?

CPU-only (reads the cached NRRD from the Modal Volume). Reports decompress times + sizes so we can
size the JS2-bucket Zarr win and the render-first coarse level.

Run:  modal run zarr_bench.py
"""
import json
import os
import time

import modal

app = modal.App("zarr-bench")
cache = modal.Volume.from_name("slicerlive-cache")
image = modal.Image.debian_slim(python_version="3.11").pip_install("pynrrd", "numpy", "zarr<3", "numcodecs")


def _dirsize(p):
    return sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(p) for f in fs)


@app.function(image=image, volumes={"/cache": cache}, memory=49152, timeout=900)
def bench():
    import nrrd, numpy as np, zarr
    from numcodecs import Blosc
    out = {}

    # 1) current path: gzip-NRRD decompress
    t = time.time(); data, hdr = nrrd.read("/cache/bumblebee.nrrd")
    out["nrrd_gunzip_s"] = round(time.time() - t, 1)
    out["shape"] = list(data.shape); out["dtype"] = str(data.dtype)
    out["raw_GB"] = round(data.nbytes / 1e9, 2)

    # 2) raw .npy: save once, then mmap-open (instant) and full-load
    t = time.time(); np.save("/cache/bee.npy", data); cache.commit()
    out["npy_save_s"] = round(time.time() - t, 1)
    out["npy_GB"] = round(os.path.getsize("/cache/bee.npy") / 1e9, 2)
    t = time.time(); _ = np.load("/cache/bee.npy", mmap_mode="r"); out["npy_mmap_open_s"] = round(time.time() - t, 2)
    t = time.time(); _ = np.array(np.load("/cache/bee.npy")); out["npy_full_load_s"] = round(time.time() - t, 1)

    # 3) Zarr zstd, chunked
    comp = Blosc(cname="zstd", clevel=3, shuffle=Blosc.BITSHUFFLE)
    t = time.time()
    z = zarr.open("/cache/bee.zarr", mode="w", shape=data.shape, chunks=(128, 128, 128),
                  dtype=data.dtype, compressor=comp)
    z[:] = data; cache.commit()
    out["zarr_write_s"] = round(time.time() - t, 1)
    out["zarr_GB"] = round(_dirsize("/cache/bee.zarr") / 1e9, 2)
    t = time.time(); _ = zarr.open("/cache/bee.zarr", mode="r")[:]; out["zarr_full_read_s"] = round(time.time() - t, 1)

    # 4) coarse multiscale level (4x downsample) — the render-first level
    coarse = np.ascontiguousarray(data[::4, ::4, ::4])
    del data
    t = time.time()
    zc = zarr.open("/cache/bee_coarse.zarr", mode="w", shape=coarse.shape, chunks=(64, 64, 64),
                   dtype=coarse.dtype, compressor=comp)
    zc[:] = coarse; cache.commit()
    out["coarse_shape"] = list(coarse.shape)
    out["coarse_MB"] = round(_dirsize("/cache/bee_coarse.zarr") / 1e6, 1)
    t = time.time(); _ = zarr.open("/cache/bee_coarse.zarr", mode="r")[:]; out["coarse_read_s"] = round(time.time() - t, 2)
    return out


@app.local_entrypoint()
def main():
    print(json.dumps(bench.remote(), indent=2))
