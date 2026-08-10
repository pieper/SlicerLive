"""Parallel-upload the staged spine-review files to the JS2 Swift bucket.

Reads staging.json ([[src_abs, bucket_key], ...]) plus the top-level docs, PUTs
each with the auth token from $OS_TOKEN, verifies status + byte count, retries
transient failures.
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import urllib.request

SW = "https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/"
TOK = os.environ["OS_TOKEN"]
EXP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "export")

CT = {".gz": "application/gzip", ".json": "application/json", ".png": "image/png",
      ".jsonl": "application/x-ndjson"}

jobs = [tuple(j) for j in json.load(open(f"{EXP}/staging.json"))]
for extra in ("cases.json", "payload.json", "dice_mets.jsonl", "dice_mm.jsonl"):
    jobs.append((f"{EXP}/{extra}", extra))

def put(job, tries=3):
    src, key = job
    data = open(src, "rb").read()
    ext = os.path.splitext(src)[1]
    try:  # resumable: skip objects already uploaded with the right size
        req = urllib.request.Request(SW + key, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            if int(r.headers.get("Content-Length", -1)) == len(data):
                return key, len(data), None
    except Exception:
        pass
    for t in range(tries):
        try:
            req = urllib.request.Request(SW + key, data=data, method="PUT", headers={
                "X-Auth-Token": TOK,
                "Content-Type": CT.get(ext, "application/octet-stream")})
            with urllib.request.urlopen(req, timeout=120) as r:
                if r.status in (200, 201):
                    return key, len(data), None
        except Exception as e:
            err = str(e)
            time.sleep(2 * (t + 1))
    return key, len(data), err

done = 0
fails = []
with ThreadPoolExecutor(max_workers=12) as ex:
    for key, n, err in ex.map(put, jobs):
        done += 1
        if err:
            fails.append((key, err))
        if done % 50 == 0 or done == len(jobs):
            print(f"{done}/{len(jobs)} uploaded", flush=True)

if fails:
    print("FAILURES:")
    for k, e in fails:
        print(" ", k, e)
    sys.exit(1)
print("all uploads ok")
