#!/usr/bin/env python3
"""
GATE 1: the semantic-GAN critic D(seg, ct) — a learned realism score that will serve as
the objective for the differentiable level-set generator. Trained on real (KiTS GT) vs
fake (perturbed GT: dilate/erode/translate/liver-chunk/speckle-tumor/delete-kidney) so it
learns what an anatomically-realistic kidney+tumor segmentation looks like FOR THIS IMAGE.

Validation gate: after training, D must score the real GT ABOVE my known-bad candidates
(liver-chunk + slab). If it can't, the objective is worthless — fix before the generator.

Run:  ~/mlenv/bin/python semantic_gan.py --data ~/kits --epochs 40 --res 96
"""
import argparse, glob, json, os, numpy as np, torch, torch.nn as nn
from scipy import ndimage as ndi

def load_case(pid, D):
    m = json.load(open(f"{D}/{pid}.json")); nx, ny, nz = m["dims"]
    ct = np.fromfile(f"{D}/{pid}.ct.i16", "<i2").reshape(nz, ny, nx).astype(np.float32)
    lab = np.fromfile(f"{D}/{pid}.lab.u8", "u1").reshape(nz, ny, nx)
    return ct, lab

def resample(ct, lab, R):
    z = [R / s for s in ct.shape]
    ctr = ndi.zoom(ct, z, order=1); labr = ndi.zoom(lab, z, order=0)
    ctn = np.clip((ctr + 200) / 600, 0, 1).astype(np.float32)  # HU ~[-200,400] -> [0,1]
    return ctn, labr.astype(np.uint8)

def to_ch(ct, lab):
    return np.stack([ct, (lab == 1).astype(np.float32), (lab == 2).astype(np.float32)], 0)

def perturb(lab, rng):
    """Return an anatomically-WRONG version of a real labelmap (a 'fake')."""
    k = (lab == 1) | (lab == 2); t = (lab == 2); out = lab.copy()
    kind = rng.integers(0, 7)
    if kind == 0:  # over-dilate kidney (leak)
        kk = ndi.binary_dilation(k, iterations=int(rng.integers(2, 5))); out = np.where(kk & (out == 0), 1, out)
    elif kind == 1:  # erode (under-seg)
        kk = ndi.binary_erosion(k, iterations=int(rng.integers(2, 4))); out = np.where(~kk & (out > 0), 0, out)
    elif kind == 2:  # translate
        sh = rng.integers(-12, 13, 3); out = np.roll(out, sh, (0, 1, 2))
    elif kind == 3:  # liver-chunk: paste a big ellipsoid blob adjacent to a kidney
        zz, yy, xx = np.where(k)
        if len(zz):
            i = rng.integers(len(zz)); r = rng.integers(10, 20)
            Z, Y, X = np.ogrid[:lab.shape[0], :lab.shape[1], :lab.shape[2]]
            blob = ((Z - zz[i]) ** 2 + (Y - yy[i]) ** 2 / 1.5 + (X - (xx[i] + rng.integers(-25, 26))) ** 2) < r * r
            out = np.where(blob, 1, out)
    elif kind == 4:  # speckle the tumor: scatter tumor voxels randomly inside kidney
        out[t] = 1
        idx = np.where(out == 1)
        if len(idx[0]) > 500:
            sel = rng.choice(len(idx[0]), size=len(idx[0]) // 20, replace=False)
            out[idx[0][sel], idx[1][sel], idx[2][sel]] = 2
    elif kind == 5:  # delete one kidney (keep only left or right half)
        cx = lab.shape[2] // 2;
        if rng.random() < 0.5: out[:, :, :cx] = 0
        else: out[:, :, cx:] = 0
    else:  # random noise blobs as kidney
        for _ in range(rng.integers(3, 8)):
            zc, yc, xc = [rng.integers(0, s) for s in lab.shape]; r = rng.integers(4, 9)
            Z, Y, X = np.ogrid[:lab.shape[0], :lab.shape[1], :lab.shape[2]]
            out = np.where((Z - zc) ** 2 + (Y - yc) ** 2 + (X - xc) ** 2 < r * r, 1, out)
    return out.astype(np.uint8)

class Critic(nn.Module):
    def __init__(s):
        super().__init__()
        def blk(i, o): return nn.Sequential(nn.Conv3d(i, o, 4, 2, 1), nn.InstanceNorm3d(o), nn.LeakyReLU(0.2, True))
        s.net = nn.Sequential(blk(3, 16), blk(16, 32), blk(32, 64), blk(64, 128), nn.AdaptiveAvgPool3d(1))
        s.fc = nn.Linear(128, 1)
    def forward(s, x): return s.fc(s.net(x).flatten(1))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--data", default=os.path.expanduser("~/kits"))
    ap.add_argument("--epochs", type=int, default=40); ap.add_argument("--res", type=int, default=96)
    ap.add_argument("--out", default=os.path.expanduser("~/critic.pt")); a = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"; print("device", dev, flush=True)
    pids = sorted(os.path.basename(p)[:-5] for p in glob.glob(f"{a.data}/*.json"))
    rng = np.random.default_rng(0); rng.shuffle(pids)
    val = set(pids[:4]); train = [p for p in pids if p not in val]
    print(f"{len(train)} train / {len(val)} val cases", flush=True)
    # preload resampled reals (channels precomputed lazily)
    cache = {}
    def get(pid):
        if pid not in cache:
            ct, lab = load_case(pid, a.data); cache[pid] = resample(ct, lab, a.res)
        return cache[pid]
    D = Critic().to(dev); opt = torch.optim.Adam(D.parameters(), 1e-4, betas=(0.5, 0.9)); bce = nn.BCEWithLogitsLoss()
    B = 4
    for ep in range(a.epochs):
        D.train(); tl = 0; n = 0
        rng2 = np.random.default_rng(ep)
        for _ in range(max(1, len(train) // B)):
            reals, fakes = [], []
            for _ in range(B):
                ct, lab = get(train[rng2.integers(len(train))])
                reals.append(to_ch(ct, lab)); fakes.append(to_ch(ct, perturb(lab, rng2)))
            x = torch.tensor(np.array(reals + fakes), device=dev)
            y = torch.tensor([1.0] * B + [0.0] * B, device=dev).unsqueeze(1)
            opt.zero_grad(); loss = bce(D(x), y); loss.backward(); opt.step(); tl += loss.item(); n += 1
        if ep % 5 == 0 or ep == a.epochs - 1:
            D.eval();
            with torch.no_grad():
                sc = {}
                for pid in list(val):
                    ct, lab = get(pid)
                    sc["REAL " + pid] = D(torch.tensor(to_ch(ct, lab)[None], device=dev)).item()
                    sc["fake-dilate " + pid] = D(torch.tensor(to_ch(ct, perturb(lab, np.random.default_rng(1)))[None], device=dev)).item()
            print(f"ep{ep} loss={tl/n:.3f} | " + " ".join(f"{k.split()[0]}={v:.2f}" for k, v in sc.items()), flush=True)
    torch.save(D.state_dict(), a.out); print("saved", a.out, flush=True)
    # GATE 1: does D rank the real GT ABOVE my known-bad candidates (liver-chunk/slab, speckle)?
    gp = "KiTS-00003"; D.eval()
    if os.path.exists(f"{a.data}/{gp}.json"):
        m = json.load(open(f"{a.data}/{gp}.json")); nx, ny, nz = m["dims"]
        ct = np.fromfile(f"{a.data}/{gp}.ct.i16", "<i2").reshape(nz, ny, nx).astype(np.float32)
        def sc(lab):
            ctn, labr = resample(ct, lab, a.res)
            with torch.no_grad(): return D(torch.tensor(to_ch(ctn, labr)[None], device=dev)).item()
        gt = np.fromfile(f"{a.data}/{gp}.lab.u8", "u1").reshape(nz, ny, nx)
        line = f"GATE {gp}: GT={sc(gt):+.2f}"
        for nm in ("cand", "clean"):
            p = f"{a.data}/{gp}.{nm}.u8"
            if os.path.exists(p): line += f"  {nm}={sc(np.fromfile(p,'u1').reshape(nz,ny,nx)):+.2f}"
        # also an obviously-fake perturbation of THIS case's GT
        line += f"  fake-dilate={sc(perturb(gt, np.random.default_rng(7))):+.2f}"
        print(line + "   (PASS if GT is highest)", flush=True)

if __name__ == "__main__":
    main()
