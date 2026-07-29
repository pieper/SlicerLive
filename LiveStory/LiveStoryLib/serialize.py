"""Self-contained SlicerLive scene serializer.

Turns the MRML scene currently loaded in a running 3D Slicer into the SlicerLive
JSON wire format consumed by the WebGPU renderer (render/scene-volume.ts):

    { "blobBase": "blobs/",
      "nodes": { "<id>": {"id","class","name","attrs","refs","blobs"}, ... } }

Scalar volumes are written as chunked, zlib-deflated zarr under
    <blobdir>/<id>.zarr/<dataset>/<kk>.<jj>.<ii>
in C-order (z,y,x), matching render/zarr.ts (DecompressionStream("deflate")).

This is a fresh, dependency-free reimplementation of the retired mrml_sync.py
serializer that publish.py used to call — it lives inside the LiveStory module so
the module is self-sufficient. Runs INSIDE Slicer (needs `slicer`, `vtk`, numpy).
"""
import hashlib
import json
import math
import os
import zlib

import numpy as np
import slicer
import vtk

# numpy dtype -> zarr dtype string understood by render/zarr.ts (ZDT table)
_ZDT = {
    "int8": "|i1", "uint8": "|u1",
    "int16": "<i2", "uint16": "<u2",
    "int32": "<i4", "uint32": "<u4",
    "float32": "<f4", "float64": "<f8",
}


def _mat4(m):
    """vtkMatrix4x4 -> flat row-major list of 16 floats."""
    return [m.GetElement(r, c) for r in range(4) for c in range(4)]


def _volume_ijk_to_ras(volumeNode):
    """IJK->RAS for the volume, folding in any (linear) parent transform to world."""
    m = vtk.vtkMatrix4x4()
    volumeNode.GetIJKToRASMatrix(m)
    tn = volumeNode.GetParentTransformNode()
    if tn is not None and tn.IsTransformToWorldLinear():
        t = vtk.vtkMatrix4x4()
        tn.GetMatrixTransformToWorld(t)
        vtk.vtkMatrix4x4.Multiply4x4(t, m, m)
    return _mat4(m)


def _write_zarr(volumeNode, node_id, blobdir):
    """Write a scalar volume's voxels as chunked zlib zarr; return the ZarrDesc dict.

    arrayFromVolume returns C-order (K,J,I) == (nz,ny,nx), which is exactly the
    render/zarr.ts `shape` convention. Chunks are padded up to full chunk shape
    (the loader reads back only the valid sub-extent)."""
    arr = slicer.util.arrayFromVolume(volumeNode)          # (nz, ny, nx)
    # normalize to little-endian contiguous
    if arr.dtype.byteorder == ">":
        arr = arr.astype(arr.dtype.newbyteorder("<"))
    dt = _ZDT.get(arr.dtype.name)
    if dt is None:                                          # fall back to int16 for exotic types
        arr = arr.astype("<i2")
        dt = "<i2"

    shape = [int(s) for s in arr.shape]                    # [nz, ny, nx]
    chunks = [min(64, shape[0]), min(128, shape[1]), min(128, shape[2])]
    grid = [int(math.ceil(shape[d] / chunks[d])) for d in range(3)]
    cz, cy, cx = chunks

    os.makedirs(blobdir, exist_ok=True)

    # Content-addressed chunk store: each compressed chunk is named by the sha256 of its
    # bytes and written flat under blobdir (deduped across chunks and volumes), so a chunk
    # can never be mistaken for different data. The manifest maps grid coords -> hash.
    total = 0
    chunk_hashes = {}
    for kk in range(grid[0]):
        for jj in range(grid[1]):
            for ii in range(grid[2]):
                sub = arr[kk * cz:(kk + 1) * cz, jj * cy:(jj + 1) * cy, ii * cx:(ii + 1) * cx]
                if sub.shape != (cz, cy, cx):              # pad edge chunks to full shape
                    padded = np.zeros((cz, cy, cx), dtype=arr.dtype)
                    padded[:sub.shape[0], :sub.shape[1], :sub.shape[2]] = sub
                    sub = padded
                raw = np.ascontiguousarray(sub).tobytes()
                comp = zlib.compress(raw, 6)               # zlib-wrapped deflate == DecompressionStream("deflate")
                h = "sha256-" + hashlib.sha256(comp).hexdigest()
                dest = os.path.join(blobdir, h)
                if not os.path.exists(dest):               # dedup: write each unique chunk once
                    with open(dest, "wb") as f:
                        f.write(comp)
                    total += len(comp)
                chunk_hashes[f"{kk}.{jj}.{ii}"] = h

    return {
        "shape": shape, "chunks": chunks, "chunkGrid": grid,
        "dtype": dt, "bytes": total, "chunkHashes": chunk_hashes,
    }


def _tf_points(fn, comps):
    """Sample a vtkColorTransferFunction (comps=3) or vtkPiecewiseFunction (comps=1)
    at its own node positions -> [[s, c0..], ...]."""
    out = []
    n = fn.GetSize()
    if comps == 3:
        val = [0.0] * 6
        for i in range(n):
            fn.GetNodeValue(i, val)
            out.append([val[0], val[1], val[2], val[3]])   # [x, r, g, b]
    else:
        val = [0.0] * 4
        for i in range(n):
            fn.GetNodeValue(i, val)
            out.append([val[0], val[1]])                    # [x, a]
    return out


# ---- per-class attribute extractors ---------------------------------------

def _volume_attrs(n, node_id, blobdir):
    arr = slicer.util.arrayFromVolume(n)
    return {
        "zarr": _write_zarr(n, node_id, blobdir),
        "dims": [int(arr.shape[2]), int(arr.shape[1]), int(arr.shape[0])],  # [nx,ny,nz]
        "comps": 1,
        "ijkToRAS": _volume_ijk_to_ras(n),
    }


def _volume_display_attrs(n, *_):
    c = n.GetColor()
    return {
        "visibility": int(n.GetVisibility()),
        "visibility3D": int(n.GetVisibility3D()) if hasattr(n, "GetVisibility3D") else 1,
        "color": [c[0], c[1], c[2]],
        "opacity": n.GetOpacity(),
        "window": n.GetWindow(),
        "level": n.GetLevel(),
    }


def _volume_property_attrs(n, *_):
    vp = n.GetVolumeProperty()
    return {
        "shade": int(vp.GetShade()),
        "interpolationType": vp.GetInterpolationType(),
        "color": _tf_points(vp.GetRGBTransferFunction(0), 3),
        "scalarOpacity": _tf_points(vp.GetScalarOpacity(0), 1),
        "gradientOpacity": _tf_points(vp.GetGradientOpacity(0), 1),
    }


def _markups_attrs(n, *_):
    dn = n.GetDisplayNode()
    col = dn.GetSelectedColor() if dn else (1.0, 0.85, 0.2)
    pts = []
    for i in range(n.GetNumberOfControlPoints()):
        p = [0.0, 0.0, 0.0]
        n.GetNthControlPointPositionWorld(i, p)
        pts.append({"label": n.GetNthControlPointLabel(i), "position": [p[0], p[1], p[2]]})
    return {"color": [col[0], col[1], col[2]], "controlPoints": pts}


def _camera_attrs(n, *_):
    c = n.GetCamera()
    return {
        "position": list(c.GetPosition()),
        "focalPoint": list(c.GetFocalPoint()),
        "viewUp": list(c.GetViewUp()),
        "viewAngle": c.GetViewAngle(),
        "parallelProjection": int(c.GetParallelProjection()),
        "parallelScale": c.GetParallelScale(),
    }


def _slice_attrs(n, *_):
    return {
        "layoutName": n.GetLayoutName(),
        "xyToRAS": _mat4(n.GetXYToRAS()),
        "dimensions": list(n.GetDimensions()),
        "fieldOfView": list(n.GetFieldOfView()),
        "sliceToRAS": _mat4(n.GetSliceToRAS()),
        "orientation": n.GetOrientation(),
    }


# class -> (attr extractor, ref names to follow)
_EXTRACT = {
    "vtkMRMLScalarVolumeNode": (_volume_attrs, ["display"]),
    "vtkMRMLScalarVolumeDisplayNode": (_volume_display_attrs, []),
    "vtkMRMLVolumePropertyNode": (_volume_property_attrs, []),
    "vtkMRMLGPURayCastVolumeRenderingDisplayNode": (lambda n, *_: {}, ["volumeProperty"]),
    "vtkMRMLMarkupsFiducialNode": (_markups_attrs, []),
    "vtkMRMLCameraNode": (_camera_attrs, []),
    "vtkMRMLSliceNode": (_slice_attrs, []),
}


def _node_refs(n):
    """Reconstruct the wire `refs` dict from a node's MRML node references."""
    refs = {}
    for i in range(n.GetNumberOfNodeReferenceRoles()):
        role = n.GetNthNodeReferenceRole(i)
        ids = []
        for j in range(n.GetNumberOfNodeReferences(role)):
            rid = n.GetNthNodeReferenceID(role, j)
            if rid:
                ids.append(rid)
        if ids:
            refs[role] = ids
    return refs


def serialize_scene(outdir, name):
    """Serialize the live MRML scene -> <outdir>/<name>.json + <outdir>/blobs/... .

    Returns a small summary dict. blobBase is the RELATIVE "blobs/" so the scene is
    portable: serve <outdir> statically and open real.html?scene=<name>.json ."""
    blobdir = os.path.join(outdir, "blobs")
    os.makedirs(blobdir, exist_ok=True)

    nodes = {}
    scene = slicer.mrmlScene
    n_vol = 0
    for i in range(scene.GetNumberOfNodes()):
        node = scene.GetNthNode(i)
        cls = node.GetClassName()
        if cls not in _EXTRACT:
            continue
        extractor, _ = _EXTRACT[cls]
        node_id = node.GetID()
        try:
            attrs = extractor(node, node_id, blobdir)
        except Exception as e:  # noqa: BLE001 - keep exporting the rest of the scene
            slicer.util.errorDisplay(f"LiveStory: skipped {node_id} ({cls}): {e}") if False else None
            print(f"LiveStory: skipped {node_id} ({cls}): {e}")
            continue
        if cls == "vtkMRMLScalarVolumeNode":
            n_vol += 1
        nodes[node_id] = {
            "id": node_id,
            "class": cls,
            "name": node.GetName(),
            "refs": _node_refs(node),
            "attrs": attrs,
            "blobs": [],
        }

    wrapper = {"blobBase": "blobs/", "nodes": nodes}
    scene_path = os.path.join(outdir, f"{name}.json")
    with open(scene_path, "w") as f:
        json.dump(wrapper, f)

    return {"scene": scene_path, "nodes": len(nodes), "volumes": n_vol}
