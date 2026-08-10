"""Build cases.json for the spine-review bucket.

Merges the pid->IDC-UID crosswalks (mets_work/mm_work) with the per-case Dice
records and the per-level detail from the dashboard payload, and records the
bucket-relative paths of the exported SPINEPS files.
"""
import json, os, sys

OLD_SP = "/private/tmp/claude-501/-Users-pieper/294149cb-87fc-4ce4-8b46-c56a0d458efc/scratchpad"
EXP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "export")

mets_work = json.load(open(f"{OLD_SP}/mets_work.json"))
mm_work = json.load(open(f"{OLD_SP}/mm_work.json"))
payload = json.load(open(f"{EXP}/payload.json"))

dice = {}
for coll, fn in (("mets", "dice_mets.jsonl"), ("myeloma", "dice_mm.jsonl")):
    for line in open(f"{EXP}/{fn}"):
        r = json.loads(line)
        dice[(coll, str(r["pid"]))] = r

pay = {(c["coll"] if c["coll"] != "mm" else "myeloma", str(c["pid"])): c
       for c in payload["cases"]}
# payload uses coll names; check actual values
colls = {c["coll"] for c in payload["cases"]}
print("payload coll values:", colls, file=sys.stderr)

def flatten_dir(coll_dir):
    """spwN/segs/seg_<pid>/files -> {pid: {kind: relpath}}"""
    out = {}
    base = f"{EXP}/{coll_dir}"
    for spw in sorted(os.listdir(base)):
        segs = os.path.join(base, spw, "segs")
        if not os.path.isdir(segs):
            continue
        for d in sorted(os.listdir(segs)):
            if not d.startswith("seg_"):
                continue
            pid = d[4:]
            files = {}
            for f in os.listdir(os.path.join(segs, d)):
                if f.startswith("._"):
                    continue
                if f.endswith("seg-vert_msk.nii.gz"): files["vert_msk"] = f
                elif f.endswith("seg-spine_msk.nii.gz"): files["spine_msk"] = f
                elif f.endswith("ctd.json"): files["centroids"] = f
                elif f.endswith("snp.png"): files["snapshot"] = f
            out[pid] = (os.path.join(segs, d), files)
    return out

mets_files = flatten_dir("mets_out")
mm_files = flatten_dir("mm_out")
print(f"files: mets={len(mets_files)} mm={len(mm_files)}", file=sys.stderr)

cases = []
staging = []  # (src_abs, bucket_key)
for coll, work, files in (("mets", mets_work, mets_files), ("myeloma", mm_work, mm_files)):
    for w in work:
        pid = str(w["pid"])
        if pid not in files:
            print(f"MISSING files for {coll}/{pid}", file=sys.stderr)
            continue
        srcdir, fmap = files[pid]
        rec = {
            "pid": pid,
            "collection": coll,
            "idc_collection_id": "spine_mets_ct_seg" if coll == "mets" else "ct_images_in_multiple_myeloma",
            "ct": {"crdc_series_uuid": w["uuid"], "instances": w.get("slices")},
            "ref_seg": {"crdc_series_uuid": w["seg_uuid"], "n_segments": w.get("nseg"),
                        "source": "expert" if coll == "mets" else "nnUNet"},
            "files": {},
        }
        if w.get("ct_uid"):
            rec["ct"]["SeriesInstanceUID"] = w["ct_uid"]
        for kind, fn in fmap.items():
            key = f"{coll}/{pid}/{fn}"
            rec["files"][kind] = key
            staging.append((os.path.join(srcdir, fn), key))
        d = dice.get((coll, pid))
        if d:
            rec["compare"] = {k: d.get(k) for k in
                              ("ok", "n_ref_labels", "n_agree", "n_shifted", "shift_mode",
                               "mean_dice_same", "mean_dice_best", "shape")}
        p = pay.get((coll, pid)) or pay.get(("mm", pid))
        if p:
            rec["levels"] = p.get("detail")
            # enrich each level with the BEST-match Dice ("db") from the dice rows —
            # the payload detail only carries Dice vs the same-named level, but for a
            # shifted case the interesting number is how well the bone matches under
            # its better name
            if d and rec["levels"]:
                by_ref = {row["ref"]: row for row in d.get("rows", [])}
                for name, det in rec["levels"].items():
                    row = by_ref.get(name)
                    if row:
                        det["db"] = row.get("dice_best")
        cases.append(rec)

doc = {
    "name": "spine-review",
    "description": "SPINEPS vertebra segmentations for 121 IDC cases (Spine-Mets-CT-SEG + CT Images in Multiple Myeloma), exported for browser review over IDC CTs. Reference SEGs and CTs are NOT here: fetch from the public idc-open-data bucket by crdc_series_uuid (s3://idc-open-data/<uuid>/*.dcm, also on GCS).",
    "generated": "2026-08-08",
    "base_url": "https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/",
    "idc": {
        "bucket": "idc-open-data",
        "s3_http": "https://idc-open-data.s3.amazonaws.com/<crdc_series_uuid>/<instance_uuid>.dcm",
        "gcs_http": "https://storage.googleapis.com/idc-open-data/<crdc_series_uuid>/<instance_uuid>.dcm",
        "gcs_list": "https://storage.googleapis.com/storage/v1/b/idc-open-data/o?prefix=<crdc_series_uuid>/",
    },
    "spineps_labels": "vert_msk: 1-7=C1-C7, 8-19=T1-T12, 20-25=L1-L6, 26=S1, 28=T13; 100+n = INTERVERTEBRAL DISC below vertebra n (semantic class 100 in spine_msk) — bone-only analyses must exclude labels > 100",
    "level_order": payload.get("levels"),
    "cases": cases,
}
json.dump(doc, open(f"{EXP}/cases.json", "w"), indent=1)
json.dump(staging, open(f"{EXP}/staging.json", "w"))
print(f"cases.json: {len(cases)} cases, {len(staging)} files to upload", file=sys.stderr)
