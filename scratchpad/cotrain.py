#!/usr/bin/env python3
"""
Adversarial CO-TRAINING for the differentiable level-set generator + semantic-GAN critic.
Alternates:
  G-phase: optimize the target's phi vs the CURRENT D  (-wd*D - wr*data + ws*TV + wv*volume)
  D-phase: train D on real (train-set GT) vs fake (perturbed GT + the target's current phi output)
so D learns to reject the generator's tricks (speckle) and the generator is pushed toward
realistic, intensity-anchored, smooth shapes. Monitors Dice (not used in the objective).
Run: ~/mlenv/bin/python cotrain.py --pid KiTS-00003 --rounds 12
"""
import argparse, os, glob, json, numpy as np, torch, torch.nn as nn
from scipy import ndimage as ndi
from semantic_gan import Critic, resample, to_ch, load_case, perturb

def TV(v): return (v[1:]-v[:-1]).abs().mean() + (v[:,1:]-v[:,:-1]).abs().mean() + (v[:,:,1:]-v[:,:,:-1]).abs().mean()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--pid", default="KiTS-00003"); ap.add_argument("--data", default=os.path.expanduser("~/kits"))
    ap.add_argument("--res", type=int, default=96); ap.add_argument("--rounds", type=int, default=12)
    ap.add_argument("--gk", type=int, default=25); ap.add_argument("--dj", type=int, default=40)
    ap.add_argument("--wd", type=float, default=1.0); ap.add_argument("--wr", type=float, default=4.0)
    ap.add_argument("--ws", type=float, default=3.0); ap.add_argument("--wv", type=float, default=2.0)
    a = ap.parse_args(); dev = "cuda" if torch.cuda.is_available() else "cpu"; R = a.res
    pids = sorted(os.path.basename(p)[:-5] for p in glob.glob(f"{a.data}/*.json"))
    trainp = [p for p in pids if p != a.pid]
    # preload training reals (ct, gt) resampled
    reals = []
    for p in trainp[:40]:
        ct, lab = load_case(p, a.data); ctn, labr = resample(ct, lab, R); reals.append((ctn, labr))
    # target
    m = json.load(open(f"{a.data}/{a.pid}.json")); nx, ny, nz = m["dims"]
    tct = np.fromfile(f"{a.data}/{a.pid}.ct.i16", "<i2").reshape(nz, ny, nx).astype(np.float32)
    tgt = np.fromfile(f"{a.data}/{a.pid}.lab.u8", "u1").reshape(nz, ny, nx)
    ctn, gtr = resample(tct, tgt, R)
    cand = np.fromfile(f"{a.data}/{a.pid}.cand.u8", "u1").reshape(nz, ny, nx) if os.path.exists(f"{a.data}/{a.pid}.cand.u8") else tgt
    _, candr = resample(tct, cand, R)
    hu = ctn * 600 - 200
    p_plaus = np.where((hu > 15) & (hu < 320), 1.0, np.where((hu < -30) | (hu > 360), -1.0, 0.0)).astype(np.float32)
    ct_t = torch.tensor(ctn, device=dev); p_t = torch.tensor(p_plaus, device=dev)
    gt_env = torch.tensor(((gtr == 1) | (gtr == 2)).astype(np.float32), device=dev)
    vol_target = float(((candr > 0).mean()))  # expected envelope volume fraction from the seed candidate
    phie = torch.tensor(np.where(candr > 0, 2.0, -2.0), dtype=torch.float32, device=dev, requires_grad=True)
    phit = torch.tensor(np.where(candr == 2, 1.0, -3.0), dtype=torch.float32, device=dev, requires_grad=True)
    D = Critic().to(dev)
    if os.path.exists(os.path.expanduser("~/critic.pt")): D.load_state_dict(torch.load(os.path.expanduser("~/critic.pt"), map_location=dev))
    dopt = torch.optim.Adam(D.parameters(), 1e-4, betas=(0.5, 0.9)); bce = nn.BCEWithLogitsLoss()
    def dice():
        with torch.no_grad(): pi = (torch.sigmoid(phie) > 0.5).float()
        return (2 * (pi * gt_env).sum() / (pi.sum() + gt_env.sum() + 1e-6)).item()
    rng = np.random.default_rng(0)
    print(f"{a.pid}: co-train {a.rounds} rounds, res {R}, {len(reals)} reals. start Dice={dice():.3f} volTgt={vol_target:.4f}", flush=True)
    for rd in range(a.rounds):
        # ---- G phase: optimize phi vs current D ----
        gopt = torch.optim.Adam([phie, phit], lr=0.05)
        for _ in range(a.gk):
            env = torch.sigmoid(phie); t = torch.sigmoid(phit); chk = env * (1 - t); cht = env * t
            dsc = D(torch.stack([ct_t, chk, cht])[None]).squeeze()
            data = (env * p_t).mean(); tv = TV(env) + TV(t); vol = (env.mean() - vol_target) ** 2
            loss = -a.wd * dsc - a.wr * data + a.ws * tv + a.wv * 50 * vol
            gopt.zero_grad(); loss.backward(); gopt.step()
        # snapshot generator output as a fake (detached)
        with torch.no_grad():
            env = torch.sigmoid(phie); t = torch.sigmoid(phit); gen_fake = torch.stack([ct_t, env * (1 - t), env * t]).cpu().numpy()
            dsc_now = D(torch.stack([ct_t, env * (1 - t), env * t])[None]).item()
        # ---- D phase: real (train GT) vs fake (perturbed GT + gen snapshot) ----
        D.train()
        for _ in range(a.dj):
            rl, fk = [], []
            for _ in range(4):
                ctn2, labr2 = reals[rng.integers(len(reals))]
                rl.append(to_ch(ctn2, labr2)); fk.append(to_ch(ctn2, perturb(labr2, rng)))
            fk[rng.integers(len(fk))] = gen_fake  # inject the generator's current output as a hard fake
            x = torch.tensor(np.array(rl + fk), device=dev); y = torch.tensor([1.] * 4 + [0.] * 4, device=dev)[:, None]
            dopt.zero_grad(); bce(D(x), y).backward(); dopt.step()
        D.eval()
        with torch.no_grad():
            gt_sc = D(torch.tensor(to_ch(ctn, gtr)[None], device=dev)).item()
        print(f" round{rd}: genD(before Dstep)={dsc_now:+.2f} -> after: GT={gt_sc:+.2f}  Dice={dice():.3f}  env%={float(torch.sigmoid(phie).mean()):.4f}", flush=True)
    # finalize
    with torch.no_grad(): env = (torch.sigmoid(phie) > 0.5).cpu().numpy(); t = (torch.sigmoid(phit) > 0.5).cpu().numpy()
    lab_r = np.where(env, np.where(t, 2, 1), 0).astype(np.uint8)
    up = ndi.zoom(lab_r, [nz / R, ny / R, nx / R], order=0).astype(np.uint8)
    if up.shape != (nz, ny, nx): up = up[:nz, :ny, :nx]
    up.ravel().tofile(f"{a.data}/{a.pid}.cotrain.u8")
    d = lambda A, B: 2 * (A & B).sum() / (A.sum() + B.sum() + 1e-6)
    print(f"FINAL {a.pid}: Dice={d(up>0,(tgt==1)|(tgt==2)):.3f} (cand {d(cand>0,(tgt==1)|(tgt==2)):.3f})  wrote {a.pid}.cotrain.u8", flush=True)

if __name__ == "__main__":
    main()
