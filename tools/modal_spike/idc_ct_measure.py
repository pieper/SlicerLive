"""
Find the largest *reconstructed* CT volume in IDC (SOP = CT Image Storage, i.e. renderable, not raw
projection data) that fits an L4 for volume rendering, and measure how fast the whole series moves
into Modal (parallel). Reports VRAM-fit sanity for the L4.

Run:  modal run idc_ct_measure.py
"""

import json
import time
import urllib.request
import xml.etree.ElementTree as ET

import modal

app = modal.App("idc-ct")
image = modal.Image.debian_slim(python_version="3.11").pip_install("idc-index", "pandas", "requests")
NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}


def _list_all(bucket, prefix):
    keys, token = [], None
    while True:
        u = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}/"
        if token:
            u += "&continuation-token=" + urllib.request.quote(token)
        root = ET.fromstring(urllib.request.urlopen(u, timeout=60).read())
        for c in root.findall("s3:Contents", NS):
            keys.append((c.find("s3:Key", NS).text, int(c.find("s3:Size", NS).text)))
        nxt = root.find("s3:NextContinuationToken", NS)
        token = nxt.text if nxt is not None else None
        if not token:
            return keys


@app.function(image=image, region=["us-east"], timeout=900)
def measure():
    import pandas as pd
    import requests
    import concurrent.futures
    from idc_index import IDCClient

    df = IDCClient().index
    ct = df[(df["Modality"] == "CT") & (df["sop_class_name"] == "CT Image Storage")]
    top = ct.nlargest(8, "series_size_MB")
    cols = ["collection_id", "SeriesInstanceUID", "series_size_MB", "instanceCount",
            "BodyPartExamined", "SeriesDescription", "aws_bucket", "series_aws_url"]
    out = {"top8_reconstructed_CT": [{k: r[k] for k in cols if k in df.columns} for _, r in top.iterrows()]}

    # also show what the giant 9GB ldct series actually IS (likely raw projection)
    big = df.nlargest(3, "series_size_MB")
    big = df[df["collection_id"] == "ldct_and_projection_data"].nlargest(3, "series_size_MB")
    out["ldct_giant_series_sopclass"] = [
        {k: r[k] for k in ("series_size_MB", "sop_class_name", "instanceCount", "Modality") if k in df.columns}
        for _, r in big.iterrows()]

    row = top.iloc[0]
    s3 = str(row["series_aws_url"]); p = s3[5:].rstrip("*").rstrip("/")
    bucket, _, prefix = p.partition("/")
    objs = _list_all(bucket, prefix)
    tot = sum(s for _, s in objs)
    out["chosen"] = {k: row[k] for k in cols if k in df.columns}
    out["chosen_objects"] = len(objs)
    out["chosen_total_MB"] = round(tot / 1024**2, 1)
    out["avg_object_MB"] = round(tot / len(objs) / 1024**2, 2)

    def dl(k):
        n = 0
        with requests.get(f"https://{bucket}.s3.amazonaws.com/{k}", stream=True, timeout=120) as r:
            for c in r.iter_content(1 << 20):
                n += len(c)
        return n
    t = time.time()
    with concurrent.futures.ThreadPoolExecutor(64) as ex:
        list(ex.map(lambda ks: dl(ks[0]), objs))
    dt = time.time() - t
    out["modal_parallel64_download"] = {"s": round(dt, 2), "MBps": round(tot / 1024**2 / dt, 1),
                                        "Gbps": round(tot * 8 / 1e9 / dt, 2)}
    # L4 VRAM fit: assume int16 voxels already; raw bytes ~= series_size if uncompressed-ish.
    out["L4_vram_note"] = f"raw ~{out['chosen_total_MB']/1024:.1f} GB; VR needs ~1.5-2x w/ gradient+buffers vs 23 GB L4"
    return out


@app.local_entrypoint()
def main():
    print(json.dumps(measure.remote(), indent=2, default=str))
