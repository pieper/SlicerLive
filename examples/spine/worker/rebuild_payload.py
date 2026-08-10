"""Rebuild the dashboard payload.json from (re-run) dice jsonls.

Keeps the existing payload's snapshots and level order; recomputes every number
from the new records (used for the discs-excluded correction — the original
comparison had folded SPINEPS's disc labels into the vertebrae).

  python3 rebuild_payload.py <export_dir>   # expects payload.json (old) + dice_{mets,mm}.jsonl (new)
"""
import json, os, sys

EXP = sys.argv[1]
old = json.load(open(f"{EXP}/payload.json"))
LEVELS = old["levels"]
snap = {(c["coll"], str(c["pid"])): c.get("snap") for c in old["cases"]}

cases = []
for coll, fn in (("mets", "dice_mets.jsonl"), ("myeloma", "dice_mm.jsonl")):
    for line in open(f"{EXP}/{fn}"):
        r = json.loads(line)
        pid = str(r["pid"])
        c = {"pid": pid, "coll": coll, "ok": r.get("ok", False)}
        if r.get("ok"):
            rows = {x["ref"]: x for x in r["rows"]}
            c["vals"] = [round(1 - rows[lv]["dice_same"], 4) if lv in rows else None for lv in LEVELS]
            c["detail"] = {lv: {"d": rows[lv]["dice_same"], "b": rows[lv]["best"], "s": rows[lv]["shift"],
                                "v": rows[lv]["ref_vox"], "db": rows[lv]["dice_best"]} for lv in rows}
            inv = [1 - x["dice_same"] for x in r["rows"]]
            c["n_lv"] = len(r["rows"])
            c["n_bad"] = sum(1 for x in r["rows"] if x["dice_same"] < 0.5)
            c["n_shift"] = r.get("n_shifted", 0)
            c["worst"] = round(max(inv), 4) if inv else None
            c["mean"] = round(sum(inv) / len(inv), 4) if inv else None
            c["mdice"] = r.get("mean_dice_same")
        s = snap.get((coll, pid))
        if s:
            c["snap"] = s
        cases.append(c)

out = {"levels": LEVELS, "cases": cases}
json.dump(out, open(f"{EXP}/payload.json", "w"))
n_ok = sum(1 for c in cases if c.get("ok"))
print(f"payload.json rebuilt: {len(cases)} cases ({n_ok} ok)", file=sys.stderr)
