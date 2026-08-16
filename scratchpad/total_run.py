#!/usr/bin/env python3
# Run TotalSegmentator (trusted open tool) for the kidney on a cached KiTS case,
# write its prediction back as a lab.u8 on our grid, and score vs GT. Then we RENDER
# it (render3d.ts) and LOOK — verify the open tool by inspection, don't trust blindly.
import numpy as np, nibabel as nib, json, subprocess, os, sys
pid = sys.argv[1]; D = "/home/ubuntu/kits"
meta = json.load(open(f"{D}/{pid}.json")); nx, ny, nz = meta["dims"]
ct = np.fromfile(f"{D}/{pid}.ct.i16", dtype="<i2").reshape(nz, ny, nx).transpose(2, 1, 0)  # (nx,ny,nz)=data[i,j,k]
aff = np.array(meta["ijkToRAS"], float).reshape(4, 4)
nib.save(nib.Nifti1Image(np.ascontiguousarray(ct.astype(np.int16)), aff), f"/tmp/{pid}_ct.nii.gz")
out = f"/tmp/{pid}_ts"; os.makedirs(out, exist_ok=True)
subprocess.run(["/home/ubuntu/tsenv/bin/TotalSegmentator", "-i", f"/tmp/{pid}_ct.nii.gz", "-o", out,
                "--roi_subset", "kidney_left", "kidney_right"], check=True)
kl = nib.load(f"{out}/kidney_left.nii.gz").get_fdata() > 0
kr = nib.load(f"{out}/kidney_right.nii.gz").get_fdata() > 0
pred = (kl | kr)  # (nx,ny,nz)
lab = np.ascontiguousarray(pred.transpose(2, 1, 0)).astype("u1").ravel()  # -> C-order x fastest
lab.tofile(f"{D}/{pid}.tspred.u8")
gt = np.fromfile(f"{D}/{pid}.lab.u8", dtype="u1")
pv = lab.astype(bool); env = (gt == 1) | (gt == 2); k1 = (gt == 1)
d = lambda a, b: 2 * (a & b).sum() / (a.sum() + b.sum() + 1e-9)
print(f"{pid}: TotalSeg kidney vox={int(pv.sum())} | Dice vs GT-kidney(1)={d(pv,k1):.3f}  vs GT-envelope(1+2)={d(pv,env):.3f}")
print(f"wrote {D}/{pid}.tspred.u8")
