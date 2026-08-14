#!/usr/bin/env python3
"""Build ReMINDer's collection index from the IDC public API — metadata only, no pixels.

    python3 examples/remind/worker/build_index.py -o examples/remind/remind-index.json

The ReMIND collection (Brain Resection Multimodal Imaging Database, BWH; IDC
`remind`, DOI 10.7937/3rag-d070) is 114 patients x exactly 2 studies:

  * the study that CONTAINS ULTRASOUND is the intra-operative one (114/114 — the
    deidentified StudyDate is 1982-12-25 for every study in the collection, so
    dates carry no ordering at all and US presence is the only honest signal),
  * the other is the pre-operative MRI.

Within that, the surgical timeline is spelled out in the series descriptions:

    preop MR  ->  US_pre_dura  ->  US_post_dura  ->  US_pre_imri  ->  intraop MR

and every SEG names its own reference series:

    "<structure> seg - MR ref: <SeriesDescription>"

which resolves to exactly one MR series in the same study for all 356 SEGs (a
duplicate reference description inside one study would be ambiguous — the script
checks and reports, it does not guess).

Output: one compact JSON the dashboard and the viewer both read. Series carry
their `crdc_series_uuid`, which is the object-store prefix the browser lists
under idc-open-data — so the viewer needs nothing from this file but the index
itself.
"""
import argparse, collections, json, re, sys, time, urllib.error, urllib.request

API = "https://api.imaging.datacommons.cancer.gov/v2"
COLLECTION = "remind"
FIELDS = ["PatientID", "StudyInstanceUID", "StudyDate", "SeriesInstanceUID",
          "SeriesNumber", "SeriesDescription", "Modality", "crdc_series_uuid", "aws_bucket"]

# The surgical timeline. Rank is the row order in the compare viewer; the US keys
# are matched against the series description, the MR keys against the study class.
TIMELINE = [
    ("preop",      0, "pre-op MRI"),
    ("pre_dura",   1, "iUS before dura opening"),
    ("post_dura",  2, "iUS after dura opening"),
    ("pre_imri",   3, "iUS before intra-op MRI"),
    ("intraop",    4, "intra-op MRI"),
]
US_TIMEPOINT = {"US_pre_dura": "pre_dura", "US_post_dura": "post_dura", "US_pre_imri": "pre_imri"}
SEG_RE = re.compile(r"^(.*?) seg - MR ref: (.*)$")


def post_json(url, body, tries=6):
    """POST with retries — the IDC API rate-limits bursts with a bare 429 HTML page."""
    data = json.dumps(body).encode()
    for t in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method="POST",
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if t == tries - 1:
                raise
            wait = 5 * (t + 1)
            print(f"  API {type(e).__name__} ({e}) — retry in {wait}s", file=sys.stderr)
            time.sleep(wait)


def fetch_series():
    """Every series in the collection, one row each, with counts and sizes."""
    d = post_json(f"{API}/cohorts/manifest/preview", {
        "cohort_def": {"name": COLLECTION, "description": f"{COLLECTION} series index",
                       "filters": {"collection_id": [COLLECTION]}},
        "fields": FIELDS, "counts": "True", "group_size": "True", "page_size": 5000,
    })
    m = d["manifest"]
    if m["rowsReturned"] != m["totalFound"]:
        raise SystemExit(f"paged result ({m['rowsReturned']}/{m['totalFound']}) — add nextPage handling")
    return m["manifest_data"], d["cohort_def"]["filterSet"]["idc_data_version"]


def collection_meta():
    with urllib.request.urlopen(f"{API}/collections", timeout=300) as r:
        for c in json.loads(r.read().decode())["collections"]:
            if c["collection_id"] == COLLECTION:
                return c
    raise SystemExit(f"collection {COLLECTION} not found in the IDC API")


def build(rows):
    by_case = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        by_case[r["PatientID"]][r["StudyInstanceUID"]].append(r)

    cases, warnings = [], []
    for pid in sorted(by_case):
        studies = by_case[pid]
        us_studies = [k for k, ss in studies.items() if any(s["Modality"] == "US" for s in ss)]
        if len(studies) != 2 or len(us_studies) != 1:
            warnings.append(f"{pid}: {len(studies)} studies, {len(us_studies)} with US — skipped")
            continue
        intraop_uid = us_studies[0]
        preop_uid = next(k for k in studies if k != intraop_uid)

        series, seg_rows = [], []
        for study_uid, klass in ((preop_uid, "preop"), (intraop_uid, "intraop")):
            for s in sorted(studies[study_uid], key=lambda x: int(x["SeriesNumber"] or 0)):
                if s["Modality"] == "SEG":
                    seg_rows.append((study_uid, s))
                    continue
                tp = US_TIMEPOINT.get(s["SeriesDescription"], klass) if s["Modality"] == "US" else klass
                if s["Modality"] == "US" and s["SeriesDescription"] not in US_TIMEPOINT:
                    warnings.append(f"{pid}: unrecognised US description {s['SeriesDescription']!r}")
                series.append({
                    "u": s["crdc_series_uuid"], "si": s["SeriesInstanceUID"], "m": s["Modality"],
                    "d": s["SeriesDescription"], "sn": int(s["SeriesNumber"] or 0),
                    "n": s["instance_count"], "b": s["group_size"], "tp": tp,
                    "st": study_uid, "bk": s["aws_bucket"], "segs": [],
                })

        # attach each SEG to the series it names, inside its own study
        by_desc = collections.defaultdict(list)
        for e in series:
            by_desc[(e["st"], e["d"])].append(e)
        for study_uid, s in seg_rows:
            m = SEG_RE.match(s["SeriesDescription"] or "")
            if not m:
                warnings.append(f"{pid}: SEG description does not name a reference: {s['SeriesDescription']!r}")
                continue
            structure, ref_desc = m.group(1), m.group(2)
            targets = by_desc.get((study_uid, ref_desc), [])
            if len(targets) != 1:
                warnings.append(f"{pid}: SEG {structure!r} -> {ref_desc!r} matched {len(targets)} series")
                continue
            targets[0]["segs"].append({
                "u": s["crdc_series_uuid"], "si": s["SeriesInstanceUID"], "s": structure,
                "b": s["group_size"], "bk": s["aws_bucket"],
            })

        rank = {k: r for k, r, _ in TIMELINE}
        series.sort(key=lambda e: (rank.get(e["tp"], 9), e["sn"]))
        cases.append({
            "pid": pid,
            "studies": {"preop": preop_uid, "intraop": intraop_uid},
            "bytes": sum(e["b"] + sum(g["b"] for g in e["segs"]) for e in series),
            "series": series,
        })
    return cases, warnings


def summarize(cases, rows):
    """Cohort-level counts the dashboard shows without touching a single voxel."""
    tp_cases = collections.Counter()      # cases having >=1 series at a timepoint
    tp_series = collections.Counter()
    seq = collections.Counter()           # MR sequence descriptions, by timepoint class
    struct = collections.Counter()        # segmented structures
    struct_cases = collections.defaultdict(set)
    mod = collections.Counter()
    for c in cases:
        seen = set()
        for e in c["series"]:
            mod[e["m"]] += 1
            tp_series[e["tp"]] += 1
            seen.add(e["tp"])
            if e["m"] == "MR":
                seq[e["d"]] += 1
            for g in e["segs"]:
                mod["SEG"] += 1
                struct[g["s"]] += 1
                struct_cases[g["s"]].add(c["pid"])
        for t in seen:
            tp_cases[t] += 1
    return {
        "cases": len(cases),
        "series": sum(len(c["series"]) + sum(len(e["segs"]) for e in c["series"]) for c in cases),
        "studies": 2 * len(cases),
        "bytes": sum(c["bytes"] for c in cases),
        "modalities": dict(mod),
        "timeline": [{"key": k, "rank": r, "label": lab,
                      "cases": tp_cases.get(k, 0), "series": tp_series.get(k, 0)} for k, r, lab in TIMELINE],
        "sequences": dict(seq.most_common()),
        "structures": {k: {"series": v, "cases": len(struct_cases[k])} for k, v in struct.most_common()},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out", default="examples/remind/remind-index.json")
    ap.add_argument("--raw", help="write the untouched API manifest here too")
    a = ap.parse_args()

    print(f"querying {API} for collection {COLLECTION}…", file=sys.stderr)
    rows, version = fetch_series()
    meta = collection_meta()
    print(f"  {len(rows)} series, IDC data version {version}", file=sys.stderr)
    if a.raw:
        json.dump(rows, open(a.raw, "w"))

    cases, warnings = build(rows)
    stats = summarize(cases, rows)
    doc = {
        "collection": COLLECTION,
        "idc_version": version,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "generated_by": "examples/remind/worker/build_index.py",
        "source": {
            "doi": meta.get("source_doi"), "url": meta.get("source_url"),
            "cancer_type": meta.get("cancer_type"), "location": meta.get("location"),
            "subject_count": meta.get("subject_count"), "date_updated": meta.get("date_updated"),
            "portal": f"https://portal.imaging.datacommons.cancer.gov/explore/filters/?collection_id={COLLECTION}",
            "bucket": "https://idc-open-data.s3.us-east-1.amazonaws.com/",
        },
        "timeline": [{"key": k, "rank": r, "label": lab} for k, r, lab in TIMELINE],
        "stats": stats,
        "cases": cases,
    }
    with open(a.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {a.out}: {stats['cases']} cases, {stats['series']} series, "
          f"{stats['bytes'] / 1e9:.1f} GB referenced", file=sys.stderr)
    for w in warnings:
        print("  WARN " + w, file=sys.stderr)


if __name__ == "__main__":
    main()
