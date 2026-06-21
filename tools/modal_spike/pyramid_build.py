"""
Build a multiscale Zarr pyramid (/8,/4,/2,/1) + precomputed stats sidecar for render-first
progressive loading. Chunk sizes tuned from the IO benchmark (big chunks for the Volume).

Run:  modal run pyramid_build.py
"""
import json
import os
import time
import modal

app = modal.App("pyramid-build")
cache = modal.Volume.from_name("slicerlive-cache")
image = modal.Image.debian_slim(python_version="3.11").pip_install("numpy", "zarr<3", "numcodecs", "pynrrd")
SPEC = "bumblebee"
# (downsample factor, chunk shape) — Modal Volume charges ~190ms/file, so MINIMIZE file count:
# coarse levels = SINGLE chunk (1 file → ~0.3s, no 7s latency floor); full uses 512^3 (transfer-bound)
CFG = [(1, (512, 512, 512)), (2, None), (4, None), (8, None)]  # None => single chunk (whole array)


def _stats(p):
    files = sum(len(fs) for _, _, fs in os.walk(p))
    mb = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(p) for f in fs) / 1e6
    return files, round(mb, 1)


@app.function(image=image, volumes={"/cache": cache}, memory=49152, timeout=1800)
def build():
    import numpy as np, zarr, nrrd
    from numcodecs import Blosc
    comp = Blosc(cname="zstd", clevel=3, shuffle=Blosc.BITSHUFFLE)
    data = np.load("/cache/bee.npy")  # single 5.7 GB file -> fast
    try:
        hdr = nrrd.read_header(f"/cache/{SPEC}.nrrd")
        sd = hdr.get("space directions")
        spacing = [float(np.linalg.norm(np.asarray(v, float))) for v in sd if v is not None][:3]
        if len(spacing) != 3:
            spacing = [1.0, 1.0, 1.0]
    except Exception:
        spacing = [1.0, 1.0, 1.0]
    sub = data[::4, ::4, ::4].astype(np.float32).ravel()
    nz = sub[sub > sub.min()]
    lo = float(np.percentile(nz, 30)); hi = float(np.percentile(nz, 92)); del sub, nz
    levels = []
    for ds, ch in CFG:
        arr = np.ascontiguousarray(data[::ds, ::ds, ::ds])
        if ch is None:
            ch = tuple(int(x) for x in arr.shape)  # single chunk (1 file)
        p = f"/cache/{SPEC}_L{ds}.zarr"
        t = time.time()
        z = zarr.open(p, mode="w", shape=arr.shape, chunks=ch, dtype=arr.dtype, compressor=comp)
        z[:] = arr
        files, mb = _stats(p)
        levels.append({"ds": ds, "path": p, "shape": [int(x) for x in arr.shape],
                       "chunks": list(ch), "files": files, "MB": mb, "write_s": round(time.time() - t, 1)})
        del arr
    meta = {"specimen": SPEC, "spacing": spacing, "tf_lo": lo, "tf_hi": hi, "levels": levels}
    open(f"/cache/{SPEC}_pyramid.json", "w").write(json.dumps(meta))
    cache.commit()
    return meta


@app.local_entrypoint()
def main():
    print(json.dumps(build.remote(), indent=2))
