"""Isolate where the cold-start seconds actually go: Volume reads, cupy init, encoder init.
No rendering. One cold run gives the real breakdown."""
import json
import os
import time
import modal

app = modal.App("iso-probe")
cache = modal.Volume.from_name("slicerlive-cache")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("numpy", "zarr<3", "numcodecs", "cupy-cuda12x[ctk]", "PyNvVideoCodec")
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)


def _nfiles(p):
    return sum(len(fs) for _, _, fs in os.walk(p)) if os.path.exists(p) else -1


@app.function(gpu="L4", image=image, volumes={"/cache": cache}, memory=32768, timeout=300)
def iso():
    T = {"container_alive_at": round(time.time() % 1000, 2)}
    t = time.time(); import numpy as np; T["import_numpy_s"] = round(time.time() - t, 2)
    t = time.time(); import zarr; T["import_zarr_s"] = round(time.time() - t, 2)

    cz, fz = "/cache/bumblebee_coarse.zarr", "/cache/bumblebee.zarr"
    T["coarse_files"] = _nfiles(cz); T["full_files"] = _nfiles(fz)

    if os.path.exists(cz):
        t = time.time(); z = zarr.open(cz, mode="r"); T["coarse_open_s"] = round(time.time() - t, 2)
        t = time.time(); c = z[:]; T["coarse_read_s"] = round(time.time() - t, 2)
        T["coarse_MB"] = round(c.nbytes / 1e6, 1)

    t = time.time(); import cupy as cp; T["import_cupy_s"] = round(time.time() - t, 2)
    t = time.time()
    a = cp.arange(1000, dtype=cp.float32); _ = cp.clip(a * .5 + 1, 0, 255).astype(cp.uint8)
    cp.cuda.runtime.deviceSynchronize(); T["cupy_first_op_s"] = round(time.time() - t, 2)

    t = time.time(); import PyNvVideoCodec as nvc; T["import_nvc_s"] = round(time.time() - t, 2)
    t = time.time()
    enc = nvc.CreateEncoder(1280, 720, "NV12", True, codec="h264", bitrate=6000000,
                            tuning_info="ultra_low_latency", bf=0, gop=60, rc="cbr")
    T["make_encoder_s"] = round(time.time() - t, 2)
    t = time.time()
    for _ in range(5):
        enc.Encode(np.full((1080, 1280), 128, np.uint8))
    T["encode_5frames_s"] = round(time.time() - t, 2)

    if os.path.exists(fz):
        t = time.time(); f = zarr.open(fz, mode="r")[:]; T["full_read_s"] = round(time.time() - t, 2)
        T["full_MB"] = round(f.nbytes / 1e6, 1)
    return T


@app.local_entrypoint()
def main():
    print(json.dumps(iso.remote(), indent=2))
