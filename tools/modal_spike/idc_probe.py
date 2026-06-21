"""
Find a very large IDC dataset (too big for the browser, fits a Modal L4) and measure how fast it
moves into Modal. Pair with a local curl of the same object to compare against a residential link.

Step 1 (this script, on Modal): query idc-index for the largest series overall + the largest CT/MR
volume series; for the chosen series, list its S3 objects and pick the largest single object; measure
single-stream HTTPS download throughput Modal-side (capped). Prints the object's public https URL so
the same object can be curl'd locally for the residential comparison.

Run:  modal run idc_probe.py
"""

import json
import time
import urllib.request
import xml.etree.ElementTree as ET

import modal

app = modal.App("idc-probe")
image = modal.Image.debian_slim(python_version="3.11").pip_install("idc-index", "pandas", "requests")


def _list_objects(bucket, prefix):
    """List a series prefix via the public S3 REST API (no creds). Returns [(key, size_bytes)]."""
    url = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}/"
    xml = urllib.request.urlopen(url, timeout=60).read()
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    root = ET.fromstring(xml)
    out = []
    for c in root.findall("s3:Contents", ns):
        out.append((c.find("s3:Key", ns).text, int(c.find("s3:Size", ns).text)))
    return out


def _measure(url, cap_gb=2.0):
    import requests
    t0 = time.time(); total = 0; cap = int(cap_gb * 1024**3)
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        ttfb = time.time() - t0
        for chunk in r.iter_content(1 << 20):
            total += len(chunk)
            if total >= cap:
                break
    dt = time.time() - t0
    mb = total / 1024**2
    return {"downloaded_mb": round(mb, 1), "seconds": round(dt, 2), "ttfb_s": round(ttfb, 3),
            "MBps": round(mb / dt, 1), "Gbps": round(mb * 8 / 1000 / dt, 2)}


@app.function(image=image, region=["us-east"], timeout=900)
def find_and_measure():
    from idc_index import IDCClient

    c = IDCClient()
    df = c.index
    cols = list(df.columns)
    size_col = "series_size_MB" if "series_size_MB" in cols else next(x for x in cols if "size" in x.lower())
    url_col = "series_aws_url" if "series_aws_url" in cols else next(x for x in cols if "aws_url" in x.lower())

    def describe(row):
        return {k: (row.get(k) if hasattr(row, "get") else row[k])
                for k in ("SeriesInstanceUID", "collection_id", "Modality", size_col, url_col)
                if k in cols}

    biggest = df.nlargest(5, size_col)
    vol = df[df["Modality"].isin(["CT", "MR", "PT"])].nlargest(5, size_col) if "Modality" in cols else biggest

    out = {"index_columns": cols, "rows": int(len(df)),
           "top5_overall": [describe(r) for _, r in biggest.iterrows()],
           "top5_volume_CT_MR_PT": [describe(r) for _, r in vol.iterrows()]}

    # Pick the largest single OBJECT from the biggest overall series for a clean throughput test.
    chosen = biggest.iloc[0]
    s3url = str(chosen[url_col])                       # e.g. s3://idc-open-data/<uuid>/*
    p = s3url[5:].rstrip("*").rstrip("/")
    bucket, _, prefix = p.partition("/")
    try:
        objs = _list_objects(bucket, prefix)
        objs.sort(key=lambda x: -x[1])
        key, sz = objs[0]
        https = f"https://{bucket}.s3.amazonaws.com/{key}"
        out["chosen_series"] = describe(chosen)
        out["chosen_series_total_MB"] = round(float(chosen[size_col]), 1)
        out["chosen_series_object_count"] = len(objs)
        out["largest_object"] = {"url": https, "size_MB": round(sz / 1024**2, 1)}
        out["modal_download_single"] = _measure(https)

        # Parallel x16 (what s5cmd-style multi-stream gets cloud-side, near the bucket).
        import concurrent.futures, requests
        batch = objs[:16]; tot = sum(s for _, s in batch)

        def _dl(k):
            n = 0
            with requests.get(f"https://{bucket}.s3.amazonaws.com/{k}", stream=True, timeout=120) as r:
                for c in r.iter_content(1 << 20):
                    n += len(c)
            return n
        t = time.time()
        with concurrent.futures.ThreadPoolExecutor(16) as ex:
            list(ex.map(lambda ks: _dl(ks[0]), batch))
        dt = time.time() - t
        out["modal_parallel16"] = {"MB": round(tot / 1024**2, 1), "s": round(dt, 2),
                                   "MBps": round(tot / 1024**2 / dt, 1),
                                   "Gbps": round(tot * 8 / 1e9 / dt, 2)}
    except Exception as e:
        out["object_error"] = repr(e)
    return out


@app.local_entrypoint()
def main():
    r = find_and_measure.remote()
    print(json.dumps(r, indent=2))
    obj = r.get("largest_object")
    if obj:
        print("\n--- COPY THIS URL to curl locally for the residential number ---")
        print(obj["url"], f"({obj['size_MB']} MB)")
