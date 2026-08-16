#!/usr/bin/env python3
"""
Differentiable level-set generator, optimized per-image against the semantic-GAN critic.
 seg = sigmoid(phi) (implicit, intensity-informed shape). Per-image, minimize:
   -w_d * D(seg, ct)   (realism, the learned objective)
   -w_r * <env, tissue-plausibility>   (intensity data-fit: sit on enhancing soft tissue, not fat/bone/air)
   +w_s * TV(env)+TV(tumor)            (smooth reniform boundaries)
Init phi from the semantic candidate (the bad seed-grow output) and see if critic+data
gradient descent repairs it. All in one PyTorch autograd graph on the A100.
Run: ~/mlenv/bin/python diff_gen.py --pid KiTS-00003 --steps 300
"""
import argparse, os, json, numpy as np, torch, torch.nn.functional as F
from scipy import ndimage as ndi
from semantic_gan import Critic, resample

def logit(p): return float(np.log(p / (1 - p)))
def TV(v):
    return (v[1:] - v[:-1]).abs().mean() + (v[:, 1:] - v[:, :-1]).abs().mean() + (v[:, :, 1:] - v[:, :, :-1]).abs().mean()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--pid", default="KiTS-00003"); ap.add_argument("--data", default=os.path.expanduser("~/kits"))
    ap.add_argument("--res", type=int, default=96); ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--critic", default=os.path.expanduser("~/critic.pt"))
    ap.add_argument("--wd", type=float, default=1.0); ap.add_argument("--wr", type=float, default=2.0); ap.add_argument("--ws", type=float, default=0.4)
    a = ap.parse_args(); dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = json.load(open(f"{a.data}/{a.pid}.json")); nx, ny, nz = m["dims"]
    ct = np.fromfile(f"{a.data}/{a.pid}.ct.i16", "<i2").reshape(nz, ny, nx).astype(np.float32)
    gt = np.fromfile(f"{a.data}/{a.pid}.lab.u8", "u1").reshape(nz, ny, nx)
    ctn, gtr = resample(ct, gt, a.res)  # ctn in [0,1] = (HU+200)/600
    # tissue plausibility: +1 enhancing soft tissue (HU~20..300), -1 fat/air(<-30) or bone(>350)
    hu = ctn * 600 - 200
    p = np.where((hu > 15) & (hu < 320), 1.0, np.where((hu < -30) | (hu > 360), -1.0, 0.0)).astype(np.float32)
    # init phi from the semantic candidate (the bad seed-grow output)
    cpath = f"{a.data}/{a.pid}.cand.u8"
    cand = np.fromfile(cpath, "u1").reshape(nz, ny, nx) if os.path.exists(cpath) else gt
    _, candr = resample(ct.astype(np.float32), cand, a.res)
    env0 = (candr > 0).astype(np.float32); t0 = (candr == 2).astype(np.float32)
    phie = torch.tensor(np.where(env0 > 0.5, 2.0, -2.0), dtype=torch.float32, device=dev, requires_grad=True)
    phit = torch.tensor(np.where(t0 > 0.5, 1.0, -3.0), dtype=torch.float32, device=dev, requires_grad=True)
    ct_t = torch.tensor(ctn, device=dev); p_t = torch.tensor(p, device=dev)
    gt_env = torch.tensor(((gtr == 1) | (gtr == 2)).astype(np.float32), device=dev)
    D = Critic().to(dev); D.load_state_dict(torch.load(a.critic, map_location=dev)); D.eval()
    for pmt in D.parameters(): pmt.requires_grad_(False)
    opt = torch.optim.Adam([phie, phit], lr=0.05)
    def dice(pred):  # pred bool tensor vs gt_env
        pi = pred.float(); return (2 * (pi * gt_env).sum() / (pi.sum() + gt_env.sum() + 1e-6)).item()
    print(f"{a.pid} start: D={D(torch.stack([ct_t, torch.sigmoid(phie)*(1-torch.sigmoid(phit)), torch.sigmoid(phie)*torch.sigmoid(phit)])[None]).item():+.2f}  Dice={dice(torch.sigmoid(phie)>0.5):.3f}", flush=True)
    for step in range(a.steps):
        env = torch.sigmoid(phie); t = torch.sigmoid(phit)
        chk = env * (1 - t); cht = env * t
        x = torch.stack([ct_t, chk, cht])[None]
        dscore = D(x).squeeze()
        data = (env * p_t).mean()
        tv = TV(env) + TV(t)
        loss = -a.wd * dscore - a.wr * data + a.ws * tv
        opt.zero_grad(); loss.backward(); opt.step()
        if step % 50 == 0 or step == a.steps - 1:
            with torch.no_grad():
                print(f"  step{step}: D={dscore.item():+.2f} data={data.item():+.3f} tv={tv.item():.3f} Dice={dice(torch.sigmoid(phie)>0.5):.3f}", flush=True)
    # finalize -> labelmap at res, upsample to full grid, save
    with torch.no_grad():
        env = (torch.sigmoid(phie) > 0.5).cpu().numpy(); t = (torch.sigmoid(phit) > 0.5).cpu().numpy()
    lab_r = np.where(env, np.where(t, 2, 1), 0).astype(np.uint8)
    up = ndi.zoom(lab_r, [nz / a.res, ny / a.res, nx / a.res], order=0).astype(np.uint8)
    if up.shape != (nz, ny, nx): up = up[:nz, :ny, :nx]
    up.ravel().tofile(f"{a.data}/{a.pid}.diffgen.u8")
    d = lambda A, B: 2 * (A & B).sum() / (A.sum() + B.sum() + 1e-6)
    pv = up > 0; env_gt = (gt == 1) | (gt == 2)
    print(f"FINAL {a.pid}: kidney(envelope) Dice={d(pv,env_gt):.3f}  (started {d((cand>0),env_gt):.3f})  wrote {a.pid}.diffgen.u8", flush=True)

if __name__ == "__main__":
    main()
