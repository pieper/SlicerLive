"""Set Cache-Control on the JS2 objects the SlicerLive live gallery reads.

Swift/RGW object POST replaces metadata without touching the body (verified: ETag
unchanged), so each object's existing content_type is re-sent alongside the new
Cache-Control. The container listing already carries content_type, so this costs one
request per object rather than a HEAD + POST pair.

Three tiers, because "immutable" is not equally true of everything:

  bulk data   public, max-age=31536000, immutable
      zarr chunks, weights, scan volumes — 99.9% of the bytes. Never rewritten in
      place, so a year with no revalidation is right.

  per-item metadata   public, max-age=86400
      text/json nested two or more levels deep: mets/<case>/zarr/meta.json,
      versions/<build>/<scan>/meta.json. These belong to one case or one build and
      change only if that item is regenerated. Cached hard for a day — no round trip
      on a repeat visit — but self-healing within a day, unlike immutable. There are
      ~400 of them, so making these revalidate would cost ~400 round trips per visit.

  entry pointers   public, max-age=600, must-revalidate
      text/json at depth 0 or 1: cases.json, scans.json, cardiac/cta.json,
      colorize/colorize.json. These say which data exists and where, they DO get
      regenerated in place, and there are only ~17 of them. Marking these immutable
      would pin a returning visitor to a stale index for a year with no recovery.
"""
import functools, json, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
print = functools.partial(print, flush=True)   # so progress is visible when piped

B = "https://js2.jetstream-cloud.org:8001/swift/v1/"
TOK = open(sys.argv[1]).read().strip()
CONTAINERS = sys.argv[2:]
BLOB = "public, max-age=31536000, immutable"
PER_ITEM = "public, max-age=86400"
POINTER = "public, max-age=600, must-revalidate"
TEXT_EXT = (".json", ".jsonl", ".txt", ".csv", ".md")
DRY = os.environ.get("DRY") == "1"

def listing(container):
    out, marker = [], ""
    while True:
        u = f"{B}{container}/?limit=1000&format=json"
        if marker:
            u += "&marker=" + urllib.parse.quote(marker, safe="")
        req = urllib.request.Request(u, headers={"X-Auth-Token": TOK})
        with urllib.request.urlopen(req, timeout=90) as r:
            page = json.load(r)
        if not page:
            break
        out += page
        marker = page[-1]["name"]
    return out

def policy(name):
    if not name.lower().endswith(TEXT_EXT):
        return BLOB
    return POINTER if name.count("/") <= 1 else PER_ITEM

def head_ctype(container, name):
    """Objects written through the S3 API have no content_type in the SWIFT listing (457 of
    livecodec-demo's 465), so fall back to a HEAD, which does report it."""
    url = B + container + "/" + urllib.parse.quote(name)
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"X-Auth-Token": TOK})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.headers.get("Content-Type")
    except Exception:
        return None

def post(job, tries=4):
    container, name, ctype = job
    if not ctype:
        ctype = head_ctype(container, name)
    url = B + container + "/" + urllib.parse.quote(name)
    # Swift/RGW POST REPLACES metadata: omitting Content-Type silently rewrites it to the
    # request's own type (curl defaults to application/x-www-form-urlencoded). Refuse rather
    # than damage the object — this already cost four objects their correct type once.
    if not ctype:
        return f"{container}/{name}: no content_type from listing OR head, refusing to POST"
    hdrs = {"X-Auth-Token": TOK, "Cache-Control": policy(name), "Content-Type": ctype}
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=b"", method="POST", headers=hdrs)
            with urllib.request.urlopen(req, timeout=120) as r:
                if r.status in (200, 202, 204):
                    return None
                err = f"HTTP {r.status}"
        except Exception as e:
            err = str(e)
            time.sleep(1.5 * (t + 1))
    return f"{container}/{name}: {err}"

total = fails = 0
for c in CONTAINERS:
    try:
        objs = listing(c)
    except Exception as e:
        print(f"{c}: LIST FAILED {e}")
        continue
    jobs = [(c, o["name"], o.get("content_type")) for o in objs]
    npt = sum(1 for j in jobs if policy(j[1]) is POINTER)
    npi = sum(1 for j in jobs if policy(j[1]) is PER_ITEM)
    print(f"{c}: {len(jobs)} objects ({npt} pointers, {npi} per-item, "
          f"{len(jobs)-npt-npi} bulk)" + (" [DRY RUN]" if DRY else ""))
    if DRY:
        for j in jobs:
            if policy(j[1]) is POINTER:
                print(f"    pointer -> {j[1]}")
        continue
    done = 0
    with ThreadPoolExecutor(12) as ex:
        for err in ex.map(post, jobs):
            done += 1
            if err:
                fails += 1
                print("  FAIL", err)
            if done % 400 == 0:
                print(f"    {done}/{len(jobs)}")
    total += len(jobs)
    print(f"  done {len(jobs)}")
print(f"\n{total} objects updated, {fails} failures")
sys.exit(1 if fails else 0)
