"""spine-review zarr pyramid worker.

For each case in the spine-review bucket's cases.json, build browser-ready
volumes and upload them back to the bucket:

  <coll>/<pid>/zarr/ct_low/k.j.i      CT resampled to 4 mm iso   (<i2, deflate)
  <coll>/<pid>/zarr/ct_med/k.j.i      CT resampled to 1.5 mm iso (<i2, deflate)
  <coll>/<pid>/zarr/spineps_med/...   SPINEPS vert labels on the med grid (|u1, raw labels incl. 100+)
  <coll>/<pid>/zarr/ref_med/...       reference SEG labels on the med grid (|u1, vertebra ints)
  <coll>/<pid>/zarr/meta.json         ZarrDescs + ijkToRAS (RAS!) + ranges — uploaded LAST (= done marker)

CT comes from the public idc-open-data GCS bucket by crdc_series_uuid; the
SPINEPS mask from the spine-review bucket; the reference SEG from idc-open-data
by its own crdc_series_uuid, rasterised in its native geometry then resampled
(the same approach as dice_compare.py — never paste frames into a foreign grid).

Chunks are 64^3, edge chunks zero-padded to full shape, zlib-deflated — exactly
what SlicerLive's render/zarr.ts fetchZarrVolume expects. Geometry is published
as ijkToRAS (LPS->RAS sign flip on the first two rows).

Auth: OS_TOKEN env var (swift PUT). Resumable: cases whose meta.json answers a
HEAD are skipped, so an expired token just means re-run with a fresh one.
"""
import io, json, os, sys, time, zlib
from concurrent.futures import ThreadPoolExecutor
import urllib.request

import numpy as np
import pydicom
import SimpleITK as sitk

SW = "https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/"
GCS = "https://storage.googleapis.com"
TOK = os.environ["OS_TOKEN"]
TMP = "/tmp/zarrwork"
CHUNK = 64
MED_MM = 1.5
LOW_MM = 4.0

NAME = {1:"C1",2:"C2",3:"C3",4:"C4",5:"C5",6:"C6",7:"C7",8:"T1",9:"T2",10:"T3",11:"T4",
        12:"T5",13:"T6",14:"T7",15:"T8",16:"T9",17:"T10",18:"T11",19:"T12",20:"L1",21:"L2",
        22:"L3",23:"L4",24:"L5",25:"L6",26:"S1",27:"Cocc",28:"T13",29:"S2",30:"S3"}

def http(url, tries=5, timeout=180):
    for t in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception:
            if t == tries - 1:
                raise
            time.sleep(3 * (t + 1))

def swift_put(key, data, ctype="application/octet-stream", tries=5):
    for t in range(tries):
        try:
            req = urllib.request.Request(SW + key, data=data, method="PUT",
                headers={"X-Auth-Token": TOK, "Content-Type": ctype})
            with urllib.request.urlopen(req, timeout=300) as r:
                if r.status in (200, 201):
                    return
        except Exception:
            if t == tries - 1:
                raise
            time.sleep(2 * (t + 1))

def swift_head(key):
    try:
        req = urllib.request.Request(SW + key, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception:
        return False

def gcs_list(uuid):
    names, tok = [], None
    while True:
        u = f"{GCS}/storage/v1/b/idc-open-data/o?prefix={uuid}/&maxResults=1000"
        if tok:
            u += f"&pageToken={tok}"
        d = json.loads(http(u).decode())
        names += [i["name"] for i in d.get("items", [])]
        tok = d.get("nextPageToken")
        if not tok:
            return names

def gcs_fetch_dir(uuid, dest):
    os.makedirs(dest, exist_ok=True)
    names = gcs_list(uuid)
    def one(n):
        p = os.path.join(dest, os.path.basename(n))
        with open(p, "wb") as f:
            f.write(http(f"{GCS}/idc-open-data/{n}"))
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(one, names))
    return len(names)

# ── geometry ──────────────────────────────────────────────────────────────────
def ijk_to_ras(img):
    """4x4 ijkToRAS from a SimpleITK (LPS) image: negate the L and P rows."""
    d = np.array(img.GetDirection()).reshape(3, 3)
    s = np.diag(img.GetSpacing())
    o = np.array(img.GetOrigin())
    m = np.eye(4)
    m[:3, :3] = d @ s
    m[:3, 3] = o
    f = np.diag([-1.0, -1.0, 1.0, 1.0])
    return (f @ m).round(6).tolist()

def make_grid(ref_img, mm):
    """An axis-aligned-in-index-space grid covering ref_img at `mm` iso spacing."""
    sz = ref_img.GetSize()
    sp = ref_img.GetSpacing()
    nsz = [max(1, int(round(sz[i] * sp[i] / mm))) for i in range(3)]
    g = sitk.Image(nsz, sitk.sitkInt16)
    g.SetSpacing((mm, mm, mm))
    g.SetDirection(ref_img.GetDirection())
    g.SetOrigin(ref_img.GetOrigin())
    return g

def resample(img, grid, nearest, default=0, pixel=None):
    return sitk.Resample(img, grid, sitk.Transform(),
                         sitk.sitkNearestNeighbor if nearest else sitk.sitkLinear,
                         default, pixel or img.GetPixelID())

# ── zarr ──────────────────────────────────────────────────────────────────────
def zarr_stage(stagedir, prefix, arr, dtype):
    """arr: numpy C-order (z,y,x). Writes ONE deflated chunk (the whole volume) under
    stagedir/prefix as 0.0.0; returns the ZarrDesc. The object store throttles per
    request (~2.4 s each regardless of size), so one big object per volume wins."""
    nz, ny, nx = arr.shape
    d = os.path.join(stagedir, prefix)
    os.makedirs(d, exist_ok=True)
    gz = zlib.compress(arr.tobytes(), 6)
    with open(os.path.join(d, "0.0.0"), "wb") as f:
        f.write(gz)
    return {"shape": [nz, ny, nx], "chunks": [nz, ny, nx], "chunkGrid": [1, 1, 1],
            "dtype": dtype, "bytes": len(gz), "dir": prefix.rsplit("/", 1)[-1], "dataset": "."}

def upload_stage(stagedir):
    """Upload every staged file to SW at its stagedir-relative key (few, large objects)."""
    for root, _, names in os.walk(stagedir):
        for n in names:
            full = os.path.join(root, n)
            key = os.path.relpath(full, stagedir)
            swift_put(key, open(full, "rb").read())

# ── reference SEG rasterisation (from dice_compare.py) ────────────────────────
def code_to_label(txt):
    t = (txt or "").strip().replace(" vertebra", "").replace("Vertebra", "").strip()
    for k, v in NAME.items():
        if v.lower() == t.lower():
            return k
    return None

def ref_seg_image(dcmdir):
    import glob as g
    files = [f for f in g.glob(os.path.join(dcmdir, "*.dcm"))]
    ds = pydicom.dcmread(files[0])
    lut = {}
    for s in ds.SegmentSequence:
        code = None
        seq = getattr(s, "SegmentedPropertyTypeCodeSequence", None)
        if seq:
            code = getattr(seq[0], "CodeMeaning", None)
        lut[int(s.SegmentNumber)] = code_to_label(code) or code_to_label(getattr(s, "SegmentLabel", "") or "")
    arr = ds.pixel_array
    if arr.ndim == 2:
        arr = arr[None]
    pf = ds.PerFrameFunctionalGroupsSequence
    sh = ds.SharedFunctionalGroupsSequence[0]
    ps = [float(x) for x in sh.PixelMeasuresSequence[0].PixelSpacing]
    try:
        iop = [float(x) for x in sh.PlaneOrientationSequence[0].ImageOrientationPatient]
    except Exception:
        iop = [float(x) for x in pf[0].PlaneOrientationSequence[0].ImageOrientationPatient]
    row, col = np.array(iop[:3]), np.array(iop[3:])
    nrm = np.cross(row, col)
    pos = np.array([[float(x) for x in f.PlanePositionSequence[0].ImagePositionPatient] for f in pf])
    proj = pos @ nrm
    uniq = np.unique(np.round(proj, 3))
    dz = float(np.median(np.diff(uniq))) if len(uniq) > 1 else 1.0
    zindex = {round(v, 3): i for i, v in enumerate(uniq)}
    vol = np.zeros((len(uniq), int(ds.Rows), int(ds.Columns)), np.uint8)
    for i, f in enumerate(pf):
        lab = lut.get(int(f.SegmentIdentificationSequence[0].ReferencedSegmentNumber))
        z = zindex.get(round(float(proj[i]), 3))
        if lab is None or z is None:
            continue
        vol[z][arr[i].astype(bool)] = lab
    img = sitk.GetImageFromArray(vol)
    img.SetSpacing((ps[1], ps[0], abs(dz) or 1.0))
    img.SetOrigin(tuple(float(x) for x in pos[int(np.argmin(proj) if dz > 0 else np.argmax(proj))]))
    img.SetDirection(tuple(np.array([row, col, nrm]).T.flatten()))
    return img

# ── per-case ──────────────────────────────────────────────────────────────────
def process(case):
    pid, coll = case["pid"], case["collection"]
    base = f"{coll}/{pid}/zarr"
    if swift_head(f"{base}/meta.json"):
        return "skip"
    t0 = time.time()
    work = f"{TMP}/{pid}"
    ctdir, refdir = f"{work}/ct", f"{work}/ref"
    n_ct = gcs_fetch_dir(case["ct"]["crdc_series_uuid"], ctdir)
    gcs_fetch_dir(case["ref_seg"]["crdc_series_uuid"], refdir)

    rd = sitk.ImageSeriesReader()
    rd.SetFileNames(rd.GetGDCMSeriesFileNames(ctdir))
    ct = rd.Execute()
    if ct.GetPixelID() != sitk.sitkInt16:
        ct = sitk.Cast(ct, sitk.sitkInt16)

    sp_gz = http(SW + case["files"]["vert_msk"])
    sp_path = f"{work}/vert_msk.nii.gz"
    open(sp_path, "wb").write(sp_gz)
    sp = sitk.ReadImage(sp_path)
    ref = ref_seg_image(refdir)

    med = make_grid(ct, MED_MM)
    low = make_grid(ct, LOW_MM)
    ct_med = sitk.GetArrayFromImage(resample(ct, med, False, -1024))
    ct_low = sitk.GetArrayFromImage(resample(ct, low, False, -1024))
    sp_med = sitk.GetArrayFromImage(resample(sp, med, True, 0, sitk.sitkUInt8)).astype(np.uint8)
    ref_med = sitk.GetArrayFromImage(resample(ref, med, True, 0, sitk.sitkUInt8)).astype(np.uint8)

    meta = {
        "pid": pid, "collection": coll, "generated_by": "zarr_worker",
        "med_mm": MED_MM, "low_mm": LOW_MM,
        "ijkToRAS_med": ijk_to_ras(med), "ijkToRAS_low": ijk_to_ras(low),
        "ct_range": [int(ct_med.min()), int(ct_med.max())],
        "spineps_labels": sorted(int(v) for v in np.unique(sp_med) if v),
        "ref_labels": sorted(int(v) for v in np.unique(ref_med) if v),
        "n_ct_instances": n_ct,
        "volumes": {},
    }
    stage = f"{work}/stage"
    meta["volumes"]["ct_med"] = zarr_stage(stage, f"{base}/ct_med", ct_med.astype(np.int16), "<i2")
    meta["volumes"]["ct_low"] = zarr_stage(stage, f"{base}/ct_low", ct_low.astype(np.int16), "<i2")
    meta["volumes"]["spineps_med"] = zarr_stage(stage, f"{base}/spineps_med", sp_med, "|u1")
    meta["volumes"]["ref_med"] = zarr_stage(stage, f"{base}/ref_med", ref_med, "|u1")
    upload_stage(stage)
    swift_put(f"{base}/meta.json", json.dumps(meta).encode(), "application/json")
    import shutil
    shutil.rmtree(work, ignore_errors=True)
    return f"ok {time.time()-t0:.0f}s ct={n_ct} med={list(ct_med.shape)}"

def main():
    os.makedirs(TMP, exist_ok=True)
    cases = json.loads(http(SW + "cases.json").decode())["cases"]
    cases.sort(key=lambda c: c["ct"].get("instances") or 9e9)
    done = 0
    for i, c in enumerate(cases, 1):
        try:
            r = process(c)
        except Exception as e:
            import traceback
            r = f"FAIL {type(e).__name__}: {e}"
            traceback.print_exc()
        done += r.startswith(("ok", "skip"))
        print(f"[{i}/{len(cases)}] {c['collection']}/{c['pid']}: {r}", flush=True)
        if i % 5 == 0 or i == len(cases):
            status = {"done": done, "total": len(cases), "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            try:
                swift_put("zarr_status.json", json.dumps(status).encode(), "application/json")
            except Exception:
                pass
    print("ZARR WORKER DONE", flush=True)

if __name__ == "__main__":
    main()
