"""Print the bumblebee volume's intensity distribution so we can window the transfer function
precisely instead of guessing. CPU-only, reads the cached NRRD from the Modal Volume."""
import json
import modal

app = modal.App("bee-stats")
cache = modal.Volume.from_name("slicerlive-cache")
image = modal.Image.debian_slim(python_version="3.11").pip_install("pynrrd", "numpy")


@app.function(image=image, volumes={"/cache": cache}, memory=16384, timeout=300)
def stats():
    import nrrd, numpy as np
    data, hdr = nrrd.read("/cache/bumblebee.nrrd")
    s = np.asarray(data[::3, ::3, ::3]).astype(np.float32).ravel()
    ps = [0, 1, 5, 10, 25, 50, 60, 70, 80, 90, 95, 99, 99.9, 100]
    nz = s[s > s.min()]
    return {"dtype": str(data.dtype), "shape": list(data.shape),
            "pct_all": {p: round(float(np.percentile(s, p)), 1) for p in ps},
            "pct_nonmin": {p: round(float(np.percentile(nz, p)), 1) for p in ps},
            "frac_at_min": round(float((s == s.min()).mean()), 3)}


@app.local_entrypoint()
def main():
    print(json.dumps(stats.remote(), indent=2))
