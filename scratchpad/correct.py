#!/usr/bin/env python3
"""
Correction toolkit for the render->LOOK->correct inner loop. Applies ONE anatomy-motivated
edit (chosen by the vision judge after looking at the 3D render) to a labelmap, saves the
result, prints a summary + Dice vs GT. Chain edits: each writes <pid>.<tag>.u8.
Ops:
  despeckle              tumor->largest coherent CC; drop tiny kidney islands (open r1)
  open N / close N / erode N / dilate N
  keep2                  keep the 2 largest connected kidney components
  keepcompact FILL       keep kidney comps with bbox-fill >= FILL (drop jagged liver / thin)
  trimz LO HI            zero voxels outside axial-slice band [LO,HI] (cut superior liver)
  trimlat LO HI          keep only |x-mid|/nx in [LO,HI] (drop midline/too-lateral junk)
  fillholes
Usage: correct.py --pid KiTS-00003 --in cand --out s1 --op despeckle
"""
import argparse, os, json, numpy as np
from scipy import ndimage as ndi

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--pid", required=True); ap.add_argument("--data", default=os.path.expanduser("~/kits"))
    ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--out", required=True); ap.add_argument("--op", required=True); ap.add_argument("--args", nargs="*", default=[])
    a = ap.parse_args()
    m = json.load(open(f"{a.data}/{a.pid}.json")); nx, ny, nz = m["dims"]
    lab = np.fromfile(f"{a.data}/{a.pid}.{a.inp}.u8", "u1").reshape(nz, ny, nx).copy()
    ct = np.fromfile(f"{a.data}/{a.pid}.ct.i16", "<i2").reshape(nz, ny, nx)
    # spine midline x for laterality ops
    bone = ct > 300; sx = np.argwhere(bone[:, ny // 3:, nx // 3:2 * nx // 3])
    midx = (sx[:, 2].mean() + nx // 3) if len(sx) else nx // 2
    op = a.op; A = [float(x) for x in a.args]
    env = (lab > 0)
    if op == "despeckle":
        t = (lab == 2); lab2, n = ndi.label(ndi.binary_opening(t, iterations=1))
        if n: sizes = ndi.sum(np.ones_like(lab2), lab2, range(1, n + 1)); big = 1 + int(np.argmax(sizes)); t = lab2 == big
        else: t = np.zeros_like(env)
        k = ndi.binary_opening(env, iterations=1)
        lab = np.where(k, np.where(t & k, 2, 1), 0).astype(np.uint8)
    elif op in ("open", "close", "erode", "dilate"):
        N = int(A[0]) if A else 1; f = {"open": ndi.binary_opening, "close": ndi.binary_closing, "erode": ndi.binary_erosion, "dilate": ndi.binary_dilation}[op]
        k = f(env, iterations=N); t = (lab == 2) & k; lab = np.where(k, np.where(t, 2, 1), 0).astype(np.uint8)
    elif op == "keep2":
        lab2, n = ndi.label(env); sizes = ndi.sum(np.ones_like(lab2), lab2, range(1, n + 1)) if n else []
        keep = set(1 + np.argsort(sizes)[::-1][:2]) if n else set(); k = np.isin(lab2, list(keep))
        t = (lab == 2) & k; lab = np.where(k, np.where(t, 2, 1), 0).astype(np.uint8)
    elif op == "keepcompact":
        fmin = A[0] if A else 0.24; lab2, n = ndi.label(env); k = np.zeros_like(env)
        for i in range(1, n + 1):
            comp = lab2 == i; sz = comp.sum()
            if sz < 15000: continue
            zz, yy, xx = np.where(comp); bb = (zz.ptp() + 1) * (yy.ptp() + 1) * (xx.ptp() + 1); fill = sz / bb
            if fill >= fmin: k |= comp
        t = (lab == 2) & k; lab = np.where(k, np.where(t, 2, 1), 0).astype(np.uint8)
    elif op == "trimz":
        lo, hi = int(A[0]), int(A[1]); lab[:lo] = 0; lab[hi:] = 0
    elif op == "trimlat":
        lo, hi = A[0], A[1]
        for x in range(nx):
            latf = abs(x - midx) / nx
            if latf < lo or latf > hi: lab[:, :, x] = 0
    elif op == "fillholes":
        for z in range(nz): lab[z] = np.where(ndi.binary_fill_holes(lab[z] > 0) & (lab[z] == 0), 1, lab[z])
    else:
        raise SystemExit(f"unknown op {op}")
    lab.tofile(f"{a.data}/{a.pid}.{a.out}.u8")
    gt = np.fromfile(f"{a.data}/{a.pid}.lab.u8", "u1").reshape(nz, ny, nx)
    d = lambda P, G: 2 * (P & G).sum() / (P.sum() + G.sum() + 1e-6)
    envg = (gt == 1) | (gt == 2)
    lab2, ncomp = ndi.label(lab > 0)
    print(f"{a.pid} [{a.inp}]--{op}{A if A else ''}-->[{a.out}]: kidneyDice={d(lab>0,envg):.3f} tumorDice={d(lab==2,gt==2):.3f} vox={int((lab>0).sum())} comps={ncomp} midx={int(midx)}", flush=True)

if __name__ == "__main__":
    main()
