#!/usr/bin/env python3
"""Build the colorize-volume demo data from IDC.

    python3 prep.py [--down N] [--out data/]

Fetches one NLST CT series and its TotalSegmentator SEG straight from the IDC public
S3 bucket, and writes what the browser needs:

    data/blobs/ct.zarr/0/k.j.i        int16 HU,  deflate-compressed 64^3 chunks
    data/blobs/labels.zarr/0/k.j.i    uint8 segment number (0 = unlabelled)
    data/colorize.json                geometry, palette, groups, segment names

The label volume stays a LABEL volume — the RGBA colorize happens in the shader, so
segment opacities remain independently controllable at runtime. Baking RGBA here would
freeze them (and double the bytes).

THE SEG IS ROW-FLIPPED relative to its own reference series:

    CT  ImageOrientationPatient  [1,0,0,  0, 1,0]   ImagePositionPatient y = -145.00
    SEG ImageOrientationPatient  [1,0,0,  0,-1,0]   frame 0              y = +144.43

so the SEG column axis runs -y while the CT runs +y. Every SEG frame is flipped on the
row axis before it indexes the CT grid. This fails SILENTLY if you skip it — the labels
land on plausible-looking but wrong anatomy — so prep.py asserts on mean HU per label at
the end (liver ~60 HU, lung ~-850, bone >300). Do not remove that check.
"""
import argparse, io, json, os, sys, urllib.parse, urllib.request, zlib
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pydicom

S3 = "https://idc-open-data.s3.us-east-1.amazonaws.com"
NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
CT_UUID  = "54f72056-5619-4843-93ff-9d468e74eb6c"   # NLST 218750, 512x512x299 @ 0.566/1.25 mm
SEG_UUID = "af5c1dc6-31dd-4d9d-89e3-57d5e9da4e00"   # TotalSegmentator v1.5.6, 86 segments
CHUNK = 64

# Segment groups. Every one of the 86 segments belongs to exactly one group (asserted below),
# so a group slider always accounts for everything on screen.
GROUPS = [
    ("Organs",     [1, 2, 3, 4, 5, 10, 11, 12]),
    ("Heart",      [39, 40, 41, 42, 43]),
    ("Vessels",    [7, 8, 9, 44, 45, 46, 47]),
    ("Lungs",      [13, 14, 15, 16, 17, 38]),
    ("Intestines", [6, 37, 48, 49, 50]),
    ("Vertebrae",  list(range(18, 37))),
    ("Ribs",       list(range(51, 75))),
    ("Other bone", [75, 76, 77, 78, 79, 80, 81, 82]),
    ("Muscle",     [83, 84, 85, 86]),
]


def s3_keys(prefix):
    out, tok = [], None
    while True:
        u = f"{S3}/?list-type=2&prefix={prefix}/"
        if tok:
            u += "&continuation-token=" + urllib.parse.quote(tok, safe="")
        x = ET.fromstring(urllib.request.urlopen(u).read())
        out += [c.findtext(NS + "Key") for c in x.findall(NS + "Contents")]
        if x.findtext(NS + "IsTruncated") != "true":
            break
        tok = x.findtext(NS + "NextContinuationToken")
    return sorted(k for k in out if k.endswith(".dcm"))


def fetch(key):
    return urllib.request.urlopen(f"{S3}/{key}").read()


def load_ct():
    keys = s3_keys(CT_UUID)
    print(f"CT: {len(keys)} instances")
    with ThreadPoolExecutor(16) as ex:
        ds = list(ex.map(lambda k: pydicom.dcmread(io.BytesIO(fetch(k))), keys))
    ds.sort(key=lambda d: float(d.ImagePositionPatient[2]))          # ascending z (feet -> head)
    d0 = ds[0]
    vol = np.stack([d.pixel_array.astype(np.int16) for d in ds])
    slope = float(getattr(d0, "RescaleSlope", 1)); inter = float(getattr(d0, "RescaleIntercept", 0))
    hu = (vol * slope + inter).astype(np.int16)
    zs = np.array([float(d.ImagePositionPatient[2]) for d in ds])
    dz = float(np.median(np.diff(zs)))
    assert np.allclose(np.diff(zs), dz, atol=1e-3), "non-uniform slice spacing"
    return hu, d0, dz


def ijk_to_ras(d0, dz, nz):
    """4x4 ijk->RAS for the sorted stack. DICOM is LPS; negate the L and P rows for RAS."""
    iop = [float(v) for v in d0.ImageOrientationPatient]
    col_dir, row_dir = np.array(iop[:3]), np.array(iop[3:6])       # +i (columns), +j (rows)
    dr, dc = float(d0.PixelSpacing[0]), float(d0.PixelSpacing[1])  # [between rows, between cols]
    slice_dir = np.cross(col_dir, row_dir)
    if dz < 0:
        slice_dir, dz = -slice_dir, -dz
    m = np.eye(4)
    m[:3, 0] = col_dir * dc          # i indexes columns (x)
    m[:3, 1] = row_dir * dr          # j indexes rows (y)
    m[:3, 2] = slice_dir * dz
    m[:3, 3] = [float(v) for v in d0.ImagePositionPatient]
    m[0, :] *= -1                    # LPS -> RAS
    m[1, :] *= -1
    return m


def load_labels(hu_shape):
    keys = s3_keys(SEG_UUID)
    print(f"SEG: {len(keys)} object(s)")
    d = pydicom.dcmread(io.BytesIO(fetch(keys[0])))
    seg_iop = [float(v) for v in d.SharedFunctionalGroupsSequence[0].PlaneOrientationSequence[0].ImageOrientationPatient]
    flip_rows = seg_iop[4] < 0       # column axis runs -y: see the module docstring
    print(f"  SEG IOP {seg_iop} -> flip rows: {flip_rows}")
    bits = d.pixel_array
    zs = sorted({round(float(f.PlanePositionSequence[0].ImagePositionPatient[2]), 3)
                 for f in d.PerFrameFunctionalGroupsSequence})
    assert len(zs) == hu_shape[0], f"SEG has {len(zs)} planes, CT has {hu_shape[0]}"
    zidx = {z: i for i, z in enumerate(zs)}
    lab = np.zeros(hu_shape, np.uint8)
    for i, f in enumerate(d.PerFrameFunctionalGroupsSequence):
        sn = int(f.SegmentIdentificationSequence[0].ReferencedSegmentNumber)
        z = zidx[round(float(f.PlanePositionSequence[0].ImagePositionPatient[2]), 3)]
        m = bits[i]
        if flip_rows:
            m = m[::-1, :]
        lab[z][m.astype(bool)] = sn
    names = {int(s.SegmentNumber): str(s.SegmentLabel) for s in d.SegmentSequence}
    pal = {}
    for s in d.SegmentSequence:
        v = getattr(s, "RecommendedDisplayCIELabValue", None)
        pal[int(s.SegmentNumber)] = cielab_to_rgb([int(t) for t in v]) if v else (200, 200, 200)
    return lab, names, pal


def cielab_to_rgb(v):
    L = v[0] / 65535 * 100; a = v[1] / 65535 * 255 - 128; b = v[2] / 65535 * 255 - 128
    fy = (L + 16) / 116; fx = fy + a / 500; fz = fy - b / 200
    f = lambda t: t ** 3 if t ** 3 > 0.008856 else (t - 16 / 116) / 7.787
    X, Y, Z = f(fx) * 0.95047, f(fy) * 1.0, f(fz) * 1.08883
    R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
    G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
    B = 0.0557 * X - 0.2040 * Y + 1.0570 * Z
    g = lambda c: 1.055 * max(c, 0) ** (1 / 2.4) - 0.055 if c > 0.0031308 else 12.92 * max(c, 0)
    return tuple(int(round(255 * min(1, max(0, g(c))))) for c in (R, G, B))


def downsample(hu, lab, D):
    """CT by box mean (also denoises); labels by majority vote, so thin ribs survive."""
    if D == 1:
        return hu, lab
    nz, ny, nx = (s // D * D for s in hu.shape)
    h = hu[:nz, :ny, :nx].reshape(nz // D, D, ny // D, D, nx // D, D)
    hu2 = h.mean(axis=(1, 3, 5)).astype(np.int16)
    l = lab[:nz, :ny, :nx].reshape(nz // D, D, ny // D, D, nx // D, D).transpose(0, 2, 4, 1, 3, 5)
    l = l.reshape(nz // D, ny // D, nx // D, D ** 3)
    # majority vote ignoring background unless the block is entirely background
    out = np.zeros(l.shape[:3], np.uint8)
    flat = l.reshape(-1, D ** 3)
    nz_any = (flat > 0).any(axis=1)
    idx = np.where(nz_any)[0]
    for chunkstart in range(0, len(idx), 1_000_000):
        sel = idx[chunkstart:chunkstart + 1_000_000]
        block = flat[sel]
        block = np.where(block == 0, 255, block)          # park background out of the way
        cnt = np.apply_along_axis(lambda r: np.bincount(r, minlength=256)[:255].argmax(), 1, block)
        out.reshape(-1)[sel] = cnt
    return hu2, out


def write_zarr(outdir, name, vol, dtype):
    nz, ny, nx = vol.shape
    grid = [-(-nz // CHUNK), -(-ny // CHUNK), -(-nx // CHUNK)]
    d = os.path.join(outdir, "blobs", f"{name}.zarr", "0")
    os.makedirs(d, exist_ok=True)
    written = 0
    for kk in range(grid[0]):
        for jj in range(grid[1]):
            for ii in range(grid[2]):
                c = np.zeros((CHUNK, CHUNK, CHUNK), vol.dtype)
                z0, y0, x0 = kk * CHUNK, jj * CHUNK, ii * CHUNK
                sub = vol[z0:z0 + CHUNK, y0:y0 + CHUNK, x0:x0 + CHUNK]
                c[:sub.shape[0], :sub.shape[1], :sub.shape[2]] = sub
                blob = zlib.compress(c.tobytes(), 6)
                open(os.path.join(d, f"{kk}.{jj}.{ii}"), "wb").write(blob)
                written += len(blob)
    print(f"  {name}: {nx}x{ny}x{nz} -> {grid[0]*grid[1]*grid[2]} chunks, {written/1048576:.1f} MB")
    return {"dir": f"{name}.zarr", "dataset": "0", "shape": [nz, ny, nx],
            "chunks": [CHUNK] * 3, "chunkGrid": grid, "dtype": dtype, "bytes": written}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--down", type=int, default=1, help="integer downsample factor")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "data"))
    a = ap.parse_args()

    hu, d0, dz = load_ct()
    m = ijk_to_ras(d0, dz, hu.shape[0])
    print(f"CT {hu.shape[2]}x{hu.shape[1]}x{hu.shape[0]}  spacing {d0.PixelSpacing[1]}/{d0.PixelSpacing[0]}/{dz}")
    lab, names, pal = load_labels(hu.shape)

    assert sorted(n for _, g in GROUPS for n in g) == sorted(names), "GROUPS must partition the segments"

    # crop to the labelled body: the scan's air margin is a third of the voxels and renders nothing
    zs, ys, xs = np.where(lab > 0)
    pad = 4
    x0, x1 = max(0, xs.min() - pad), min(hu.shape[2], xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(hu.shape[1], ys.max() + 1 + pad)
    z0, z1 = max(0, zs.min() - pad), min(hu.shape[0], zs.max() + 1 + pad)
    hu, lab = hu[z0:z1, y0:y1, x0:x1], lab[z0:z1, y0:y1, x0:x1]
    m = m @ np.array([[1, 0, 0, x0], [0, 1, 0, y0], [0, 0, 1, z0], [0, 0, 0, 1]], float)
    print(f"cropped to {hu.shape[2]}x{hu.shape[1]}x{hu.shape[0]}")

    if a.down > 1:
        hu, lab = downsample(hu, lab, a.down)
        m = m @ np.diag([a.down, a.down, a.down, 1.0])
        print(f"downsampled x{a.down} -> {hu.shape[2]}x{hu.shape[1]}x{hu.shape[0]}")

    # ---- the alignment assertion. Silent misregistration is the failure mode here.
    def mean_hu(nums):
        sel = np.isin(lab, nums)
        return float(hu[sel].mean()) if sel.any() else float("nan")
    liver, lung, bone = mean_hu([5]), mean_hu([13, 14, 15, 16, 17]), mean_hu(list(range(51, 75)))
    print(f"alignment check: liver {liver:.1f} HU, lung {lung:.1f} HU, ribs {bone:.1f} HU")
    assert 30 < liver < 90, f"liver {liver:.1f} HU is not liver — SEG/CT misaligned"
    assert lung < -700, f"lung {lung:.1f} HU is not lung — SEG/CT misaligned"
    assert bone > 200, f"ribs {bone:.1f} HU are not bone — SEG/CT misaligned"

    os.makedirs(a.out, exist_ok=True)
    ct_desc = write_zarr(a.out, "ct", hu, "<i2")
    lab_desc = write_zarr(a.out, "labels", lab, "|u1")

    present = sorted(int(v) for v in np.unique(lab) if v)
    manifest = {
        "source": {
            "collection": "nlst", "patientID": "218750",
            "ctSeriesInstanceUID": "1.3.6.1.4.1.14519.5.2.1.7009.9004.139859765152523282624455168995",
            "segSeriesInstanceUID": "1.2.276.0.7230010.3.1.3.313263360.35342.1706317560.962438",
            "studyInstanceUID": "1.3.6.1.4.1.14519.5.2.1.7009.9004.327064502759230583173361683324",
            "analysisResult": "totalsegmentator_ct_segmentations",
            "algorithm": "TotalSegmentator v1.5.6",
            "doi": "10.5281/zenodo.8347011", "license": "CC BY 4.0",
        },
        "ijkToRAS": [float(v) for v in m.flatten()],
        "clim": [-1000, 1600],
        "ct": ct_desc, "labels": lab_desc,
        "segments": [{"num": n, "name": names[n], "color": list(pal[n])} for n in present],
        "groups": [{"name": g, "segments": [n for n in nums if n in present]} for g, nums in GROUPS],
    }
    with open(os.path.join(a.out, "colorize.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    total = (ct_desc["bytes"] + lab_desc["bytes"]) / 1048576
    print(f"wrote {a.out}/colorize.json — {len(present)} segments, {total:.1f} MB of blobs")


if __name__ == "__main__":
    main()
