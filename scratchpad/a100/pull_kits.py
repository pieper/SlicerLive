#!/usr/bin/env python3
"""
Pull KiTS (IDC c4kc_kits) CT + SEG directly on the training box and reconstruct each
case into raw arrays matching the SlicerLive cache format:
    <out>/<PatientID>.ct.i16   int16 HU volume, C-order (k slowest) = x + nx*(y + ny*z)
    <out>/<PatientID>.lab.u8   uint8 labelmap on the CT grid (1=kidney, 2=mass)  [KiTS19]
    <out>/<PatientID>.json     { pid, dims:[nx,ny,nz], ijkToRAS(row-major 4x4), spacing,
                                 names, seg_labels }

Source of truth = the IDC KiTS segmentations (per project decision). PatientID in the
c4kc_kits collection is "KiTS-00XXX", so we can pair CT+SEG per case directly.

Setup on the box (Ubuntu, one time):
    python3 -m venv ~/kenv && . ~/kenv/bin/activate
    pip install idc-index highdicom pydicom numpy
Run:
    python pull_kits.py --out ~/kits --n 20            # first 20 cases
    python pull_kits.py --out ~/kits --cases KiTS-00012 KiTS-00013

Notes:
  * highdicom maps the SEG onto the CT source frames (correct geometry), so the labelmap
    is aligned to the reconstructed CT grid without hand-rolled resampling.
  * KiTS19 (c4kc_kits) has two segments: kidney and tumor/mass. We map by SegmentLabel
    substring (kidney->1, tumor/mass->2); verify the mapping printed per case.
"""
import argparse, json, os, sys, tempfile, shutil
import numpy as np


def log(*a):
    print(*a, flush=True)


def dcm_files(d):
    import glob
    return [f for f in glob.glob(os.path.join(d, "**", "*"), recursive=True) if os.path.isfile(f)]


def reconstruct_ct(ct_dir):
    """Sort CT slices into an int16 HU volume + ijkToRAS (row-major 4x4, RAS mm)."""
    import pydicom
    ds = [pydicom.dcmread(f) for f in dcm_files(ct_dir)]
    ds = [d for d in ds if hasattr(d, "ImagePositionPatient") and hasattr(d, "pixel_array")]
    # slice normal from ImageOrientationPatient
    iop = np.array(ds[0].ImageOrientationPatient, float)
    row, col = iop[:3], iop[3:]
    normal = np.cross(row, col)
    ds.sort(key=lambda d: np.dot(np.array(d.ImagePositionPatient, float), normal))
    nz = len(ds)
    ny, nx = int(ds[0].Rows), int(ds[0].Columns)
    vol = np.empty((nz, ny, nx), dtype=np.int16)
    for k, d in enumerate(ds):
        arr = d.pixel_array.astype(np.float32)
        slope = float(getattr(d, "RescaleSlope", 1.0)); inter = float(getattr(d, "RescaleIntercept", 0.0))
        vol[k] = np.round(arr * slope + inter).astype(np.int16)
    # affine (LPS mm) -> convert to RAS. Columns: x-dir*sx, y-dir*sy, z-dir*sz, origin
    ps = [float(v) for v in ds[0].PixelSpacing]  # [row(y), col(x)]
    sy, sx = ps[0], ps[1]
    pos0 = np.array(ds[0].ImagePositionPatient, float)
    pos1 = np.array(ds[-1].ImagePositionPatient, float)
    kdir = (pos1 - pos0) / max(1, (nz - 1))
    # array fast axis i = column index (image x) -> IOP row-triplet (`row`), colSpacing sx
    # array axis j     = row index    (image y) -> IOP col-triplet (`col`), rowSpacing sy
    A = np.eye(4)
    A[:3, 0] = row * sx      # i (x, columns)
    A[:3, 1] = col * sy      # j (y, rows)
    A[:3, 2] = kdir          # k (slice)
    A[:3, 3] = pos0
    lps2ras = np.diag([-1, -1, 1, 1])
    A = lps2ras @ A
    # vol is (z,y,x); flatten to x + nx*(y+ny*z) = C-order of (z,y,x)
    ct = np.ascontiguousarray(vol).reshape(-1)  # already k slowest, x fastest
    return ct, (nx, ny, nz), A, (sx, sy, float(np.linalg.norm(kdir))), [d.SOPInstanceUID for d in ds], ds


def reconstruct_seg(seg, ct_datasets, dims):
    """Map DICOM SEG onto CT frames via highdicom; return uint8 labelmap + label names."""
    import numpy as np
    nx, ny, nz = dims
    src_uids = [d.SOPInstanceUID for d in ct_datasets]
    seg_nums = [s.SegmentNumber for s in seg.SegmentSequence]
    names = {int(s.SegmentNumber): str(getattr(s, "SegmentLabel", f"seg{s.SegmentNumber}")) for s in seg.SegmentSequence}
    # pixels aligned to source instances: (num_src, ny, nx, num_segments), values 0/1
    vol = np.zeros((nz, ny, nx), dtype=np.uint8)
    pmap = seg.get_pixels_by_source_instance(source_sop_instance_uids=src_uids, segment_numbers=seg_nums,
                                             combine_segments=False, skip_overlap_checks=True,
                                             ignore_spatial_locations=True)
    # pmap shape (nz, ny, nx, S). Assign label = SegmentNumber (highest wins => mass over kidney)
    for si, num in enumerate(seg_nums):
        vol[pmap[..., si] > 0] = num
    return np.ascontiguousarray(vol).reshape(-1), names


def kits_label_map(names):
    """Map SegmentNumber -> canonical KiTS label (1 kidney, 2 mass)."""
    out = {}
    for num, nm in names.items():
        low = nm.lower()
        out[num] = 2 if ("tumor" in low or "mass" in low or "neoplasm" in low) else 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=0, help="first N cases (0 = all)")
    ap.add_argument("--cases", nargs="*", default=None, help="explicit PatientIDs")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    import highdicom as hd
    from idc_index import IDCClient
    c = IDCClient()
    idx = c.index
    kits = idx[idx.collection_id == "c4kc_kits"]
    pats = sorted(kits.PatientID.unique())
    if args.cases:
        pats = [p for p in pats if p in set(args.cases)]
    elif args.n:
        pats = pats[: args.n]
    log(f"{len(pats)} case(s) to pull")
    for pid in pats:
        try:
            g = kits[kits.PatientID == pid]
            ct_series = g[g.Modality == "CT"].SeriesInstanceUID.tolist()
            seg_series = g[g.Modality == "SEG"].SeriesInstanceUID.tolist()
            if not ct_series or not seg_series:
                log(f"{pid}: missing CT or SEG series, skip"); continue
            tmp = tempfile.mkdtemp(prefix=f"{pid}_")
            ctd = os.path.join(tmp, "ct"); segd = os.path.join(tmp, "seg")
            os.makedirs(ctd); os.makedirs(segd)
            # SEG first -> read the CT series it was actually drawn on (native GT grid)
            c.download_from_selection(seriesInstanceUID=[seg_series[0]], downloadDir=segd, dirTemplate="")
            seg = hd.seg.segread(dcm_files(segd)[0])
            ref = None
            try:
                ref = seg.ReferencedSeriesSequence[0].SeriesInstanceUID
            except Exception:
                pass
            ct_uid = ref if (ref in ct_series) else ct_series[0]
            if ref and ref not in ct_series:
                log(f"{pid}: SEG-referenced CT series not in IDC list; using {ct_uid[-12:]} (may need geom resample)")
            c.download_from_selection(seriesInstanceUID=[ct_uid], downloadDir=ctd, dirTemplate="")
            ct, dims, A, spacing, _uids, ds = reconstruct_ct(ctd)
            lab_raw, names = reconstruct_seg(seg, ds, dims)
            remap = kits_label_map(names)
            lab = np.zeros_like(lab_raw)
            for num, canon in remap.items():
                lab[lab_raw == num] = canon
            ct.astype("<i2").tofile(os.path.join(args.out, f"{pid}.ct.i16"))
            lab.astype("u1").tofile(os.path.join(args.out, f"{pid}.lab.u8"))
            meta = {"pid": pid, "dims": list(dims), "ijkToRAS": A.reshape(-1).tolist(),
                    "spacing": list(spacing), "names": {str(k): v for k, v in names.items()},
                    "labelMap": {str(k): int(v) for k, v in remap.items()}}
            json.dump(meta, open(os.path.join(args.out, f"{pid}.json"), "w"))
            nk = int((lab == 1).sum()); nm = int((lab == 2).sum())
            log(f"{pid}: dims={dims} kidney={nk} mass={nm} segs={names} map={remap}")
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception as e:
            log(f"{pid}: ERROR {e}")
    log("done")


if __name__ == "__main__":
    main()
