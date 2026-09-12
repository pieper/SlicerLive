"""Export the fiber bundles of a running Slicer scene for the SlicerLive tractography demo.

Run it INSIDE Slicer — from the Python console:

    exec(open('/path/to/SlicerLive/tools/export_tracts.py').read())

or through the Slicer MCP server's execute_python tool.

Each bundle is written as a directory of CHUNKS, each holding 5% of that bundle's streamlines:

    <slug>/c00.bin … c19.bin

    u32 lineCount, u32 pointCount            header
    u32 offsets[lineCount + 1]               first point index of each streamline
    i16 xyz[pointCount * 3]                  RAS mm, quantized: p = q * scale + origin

plus a manifest.json naming the tract groups in Subject-Hierarchy order, each bundle's colour and
opacity from its line display node, every chunk's size, and the fraction a viewer loads by default.

Three choices matter, all of them about how this gets served:

* STREAMLINES ARE SHUFFLED DETERMINISTICALLY (seeded by the bundle name) before chunking, so every
  chunk is a uniform random sample of its bundle and the first N chunks are a uniform random N*5%.
  A viewer showing 10% pulls two chunks per bundle; sliding to 25% pulls three more, and never
  re-fetches what it already has.
* CHUNKS ARE SEPARATE OBJECTS, not byte ranges of one file, so each is independently cacheable with
  `immutable` on a JS2 container — the same shape as the zarr chunks the other gallery demos use.
* POSITIONS ARE int16 AT 0.01 mm about the scene centre — 6 bytes a point (a third of float32) with
  10 um resolution, far below the ~1.5 mm point spacing of the tractography itself.

The tract DATA is not committed; this script is what regenerates it.
"""

import json
import os
import re
import zlib

import numpy as np
import slicer
import vtk
from vtk.util import numpy_support as vnp

OUT_DIR = "/tmp/slicerlive-tracts"
# The raw whole-brain cloud is 3x the geometry of every named bundle combined and overlaps them all;
# the demo shows the clustered, anatomically named tracts that the folder hierarchy organizes.
EXCLUDE_NAMES = ("Steve-tract",)
SCALE = 0.01              # mm per quantization step
CHUNK_FRACTION = 0.05     # streamlines per chunk, as a fraction of the bundle
DEFAULT_FRACTION = 0.10   # what a viewer loads before the user asks for more


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def export_tracts(out_dir=OUT_DIR, exclude=EXCLUDE_NAMES, scale=SCALE,
                  chunk_fraction=CHUNK_FRACTION, default_fraction=DEFAULT_FRACTION):
    n_chunks = int(round(1.0 / chunk_fraction))
    os.makedirs(out_dir, exist_ok=True)
    sh = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(slicer.mrmlScene)
    coll = slicer.mrmlScene.GetNodesByClass("vtkMRMLFiberBundleNode")
    coll.UnRegister(None)

    nodes, bounds = [], [1e9, -1e9, 1e9, -1e9, 1e9, -1e9]
    for i in range(coll.GetNumberOfItems()):
        n = coll.GetItemAsObject(i)
        if n.GetName() in exclude:
            continue
        b = n.GetPolyData().GetBounds()
        for a in range(3):
            bounds[a * 2] = min(bounds[a * 2], b[a * 2])
            bounds[a * 2 + 1] = max(bounds[a * 2 + 1], b[a * 2 + 1])
        nodes.append(n)
    if not nodes:
        raise RuntimeError("no vtkMRMLFiberBundleNode to export")
    origin = [round((bounds[a * 2] + bounds[a * 2 + 1]) / 2, 4) for a in range(3)]

    bundles, groups = [], []
    for n in nodes:
        pd = n.GetPolyData()
        item = sh.GetItemByDataNode(n)
        group = sh.GetItemName(sh.GetItemParent(item)) if item else ""
        if group not in groups:
            groups.append(group)

        points = vnp.vtk_to_numpy(pd.GetPoints().GetData()).astype(np.float64)
        cells = pd.GetLines()
        offsets = vnp.vtk_to_numpy(cells.GetOffsetsArray()).astype(np.int64)     # lineCount + 1
        conn = vnp.vtk_to_numpy(cells.GetConnectivityArray()).astype(np.int64)
        line_count = len(offsets) - 1

        rng = np.random.default_rng(zlib.crc32(n.GetName().encode()) & 0xFFFFFFFF)
        order = rng.permutation(line_count)

        name = slug(n.GetName())
        os.makedirs(os.path.join(out_dir, name), exist_ok=True)
        edges = [int(round(k * line_count / n_chunks)) for k in range(n_chunks + 1)]
        chunks, total_points = [], 0
        for k in range(n_chunks):
            a, b = edges[k], edges[k + 1]
            if b <= a:      # a bundle with fewer streamlines than chunks leaves some empty
                chunks.append({"file": None, "lines": 0, "points": 0, "bytes": 0})
                continue
            picked = order[a:b]
            lens = (offsets[1:] - offsets[:-1])[picked]
            chunk_offsets = np.zeros(len(picked) + 1, dtype=np.uint32)
            chunk_offsets[1:] = np.cumsum(lens)
            idx = np.concatenate([conn[offsets[o]:offsets[o + 1]] for o in picked])
            quantized = np.round((points[idx] - np.array(origin)) / scale).astype(np.int16)
            rel = f"{name}/c{k:02d}.bin"
            with open(os.path.join(out_dir, rel), "wb") as f:
                f.write(np.array([len(picked), len(idx)], dtype=np.uint32).tobytes())
                f.write(chunk_offsets.tobytes())
                f.write(np.ascontiguousarray(quantized).tobytes())
            total_points += int(len(idx))
            chunks.append({"file": rel, "lines": int(len(picked)), "points": int(len(idx)),
                           "bytes": os.path.getsize(os.path.join(out_dir, rel))})

        display = n.GetLineDisplayNode()
        bundles.append({
            "name": n.GetName(),
            "group": group,
            "slug": name,
            "lines": int(line_count),
            "points": total_points,
            "color": [round(c, 4) for c in (display.GetColor() if display else (1, 1, 1))],
            "opacity": round(display.GetOpacity(), 3) if display else 1.0,
            "chunks": chunks,
        })

    manifest = {
        "name": slicer.mrmlScene.GetURL() or "Slicer tractography",
        "origin": origin,
        "scale": scale,
        "boundsRAS": [round(x, 2) for x in bounds],
        "groups": groups,
        "chunkFraction": chunk_fraction,
        "defaultFraction": default_fraction,
        "bundles": bundles,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    return {
        "dir": out_dir,
        "bundles": len(bundles),
        "groups": groups,
        "chunksPerBundle": n_chunks,
        "chunkFiles": sum(1 for b in bundles for c in b["chunks"] if c["file"]),
        "totalLines": sum(b["lines"] for b in bundles),
        "totalPoints": sum(b["points"] for b in bundles),
        "totalBytes": sum(c["bytes"] for b in bundles for c in b["chunks"]),
        "boundsRAS": manifest["boundsRAS"],
    }


if __name__ == "__main__" or "slicer" in dir():
    __result = json.dumps(export_tracts(), indent=1)
    print(__result)
