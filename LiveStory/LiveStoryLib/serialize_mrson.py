"""Serialize the live MRML scene to **mrson** (Medical Reality Scripted Object Notation).

Neutral, Slicer-independent scene JSON — the format defined at ~/slicer/mrson
(schema/mrson-core.struct.json). This is the "neutralized" successor to serialize.py:
same content-addressed zarr blobs, but nodes are keyed by a neutral `type`
(image / transferFunction / markup / camera / view) instead of the vtkMRML class,
MRML's display-node explosion is folded into the displayable node, and the vtkMRML
class name is preserved under `source.mrmlClass` for lossless reverse mapping.

    { "mrson": 0, "blobBase": "blobs/", "nodes": { "<id>": { "type", "id", ... } } }

Runs INSIDE Slicer (needs slicer, vtk, numpy). Reuses the zarr writer + helpers
from serialize.py so the two stay byte-compatible on the blob channel.
"""
import json
import os

import slicer

from . import serialize as S  # reuse _write_zarr, _mat4, _volume_ijk_to_ras, _tf_points, _node_refs


def _zarr_desc(vol, node_id, blobdir):
    """Reuse serialize.py's zarr writer; coerce `bytes` to a string (mrson int64-safe rule)."""
    desc = S._write_zarr(vol, node_id, blobdir)
    desc["bytes"] = str(desc["bytes"])
    return desc


def _vr_display_and_property(volumeNode):
    """(vrDisplayNode, volumePropertyNode) for a scalar volume, or (None, None)."""
    try:
        vrLogic = slicer.modules.volumerendering.logic()
        dn = vrLogic.GetFirstVolumeRenderingDisplayNode(volumeNode)
        return (dn, dn.GetVolumePropertyNode()) if dn else (None, None)
    except Exception:
        return (None, None)


def _image_node(vol, node_id, blobdir):
    """vtkMRMLScalarVolumeNode -> mrson `image` node (display folded in, TF referenced)."""
    arr = slicer.util.arrayFromVolume(vol)
    n = {
        "type": "image", "id": node_id, "name": vol.GetName(), "frame": "RAS",
        "dims": [int(arr.shape[2]), int(arr.shape[1]), int(arr.shape[0])],  # [nx,ny,nz]
        "comps": 1,
        "ijkToRAS": S._volume_ijk_to_ras(vol),
        "zarr": _zarr_desc(vol, node_id, blobdir),
        "source": {"mrmlClass": vol.GetClassName()},
        "refs": {}, "attrs": {}, "blobs": {},
    }
    disp = vol.GetDisplayNode()
    if disp is not None:
        c = disp.GetColor()
        n["color"] = [c[0], c[1], c[2], 1.0]
        n["window"] = disp.GetWindow()
        n["level"] = disp.GetLevel()
    vrDisp, vpn = _vr_display_and_property(vol)
    if vrDisp is not None:
        n["visible"] = bool(vrDisp.GetVisibility())
    if vpn is not None:
        n["refs"]["transferFunction"] = [vpn.GetID()]
    return n


def _transfer_function_node(vpn, node_id):
    """vtkMRMLVolumePropertyNode -> mrson `transferFunction` node."""
    vp = vpn.GetVolumeProperty()
    color = [{"value": p[0], "rgba": [p[1], p[2], p[3], 1.0]} for p in S._tf_points(vp.GetRGBTransferFunction(0), 3)]
    sop = [{"value": p[0], "opacity": p[1]} for p in S._tf_points(vp.GetScalarOpacity(0), 1)]
    gop = [{"value": p[0], "opacity": p[1]} for p in S._tf_points(vp.GetGradientOpacity(0), 1)]
    return {
        "type": "transferFunction", "id": node_id, "name": vpn.GetName(), "frame": "RAS",
        "colorStops": color, "scalarOpacity": sop, "gradientOpacity": gop,
        "shade": bool(vp.GetShade()),
        "source": {"mrmlClass": vpn.GetClassName()},
    }


def _markup_node(n, node_id):
    dn = n.GetDisplayNode()
    col = dn.GetSelectedColor() if dn else (1.0, 0.85, 0.2)
    pts = []
    for i in range(n.GetNumberOfControlPoints()):
        p = [0.0, 0.0, 0.0]
        n.GetNthControlPointPositionWorld(i, p)
        pts.append({"label": n.GetNthControlPointLabel(i), "position": [p[0], p[1], p[2]], "selected": True})
    mtype = {"vtkMRMLMarkupsFiducialNode": "fiducial", "vtkMRMLMarkupsLineNode": "line",
             "vtkMRMLMarkupsCurveNode": "curve", "vtkMRMLMarkupsPlaneNode": "plane",
             "vtkMRMLMarkupsROINode": "roi"}.get(n.GetClassName(), "fiducial")
    return {
        "type": "markup", "id": node_id, "name": n.GetName(), "frame": "RAS",
        "markupType": mtype, "color": [col[0], col[1], col[2], 1.0], "controlPoints": pts,
        "source": {"mrmlClass": n.GetClassName()},
    }


def _camera_node(n, node_id):
    c = n.GetCamera()
    return {
        "type": "camera", "id": node_id, "name": n.GetName(),
        "position": list(c.GetPosition()), "focalPoint": list(c.GetFocalPoint()),
        "viewUp": list(c.GetViewUp()), "viewAngle": c.GetViewAngle(),
        "parallelScale": c.GetParallelScale(),
        "source": {"mrmlClass": n.GetClassName()},
    }


def _slice_view_node(n, node_id):
    return {
        "type": "view", "id": node_id, "name": n.GetName(), "kind": "slice",
        "layoutName": n.GetLayoutName(), "orientation": n.GetOrientation(),
        "sliceToRAS": S._mat4(n.GetSliceToRAS()), "xyToRAS": S._mat4(n.GetXYToRAS()),
        "dimensions": [int(d) for d in n.GetDimensions()],
        "fieldOfView": list(n.GetFieldOfView()),
        "source": {"mrmlClass": n.GetClassName()},
    }


def _3d_view_node(n, node_id):
    node = {"type": "view", "id": node_id, "name": n.GetName(), "kind": "3d",
            "layoutName": n.GetLayoutName(), "refs": {},
            "source": {"mrmlClass": n.GetClassName()}}
    for cam in slicer.util.getNodesByClass("vtkMRMLCameraNode"):
        if cam.GetActiveTag() == n.GetID():
            node["refs"]["camera"] = [cam.GetID()]
    return node


def serialize_mrson(outdir, name):
    """Serialize the live MRML scene -> <outdir>/<name>.mrson.json + <outdir>/blobs/... .

    Returns a summary dict. blobBase is the relative "blobs/" so the scene is portable."""
    blobdir = os.path.join(outdir, "blobs")
    os.makedirs(blobdir, exist_ok=True)

    nodes = {}
    scene = slicer.mrmlScene

    for vol in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode"):
        vid = vol.GetID()
        try:
            nodes[vid] = _image_node(vol, vid, blobdir)
            _, vpn = _vr_display_and_property(vol)
            if vpn is not None and vpn.GetID() not in nodes:
                nodes[vpn.GetID()] = _transfer_function_node(vpn, vpn.GetID())
        except Exception as e:  # noqa: BLE001
            print(f"mrson: skipped image {vid}: {e}")

    builders = [
        ("vtkMRMLMarkupsFiducialNode", _markup_node),
        ("vtkMRMLMarkupsLineNode", _markup_node),
        ("vtkMRMLMarkupsCurveNode", _markup_node),
        ("vtkMRMLCameraNode", _camera_node),
        ("vtkMRMLSliceNode", _slice_view_node),
        ("vtkMRMLViewNode", _3d_view_node),
    ]
    for cls, build in builders:
        for n in slicer.util.getNodesByClass(cls):
            nid = n.GetID()
            if nid in nodes:
                continue
            try:
                nodes[nid] = build(n, nid)
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped {nid} ({cls}): {e}")

    wrapper = {"mrson": 0, "blobBase": "blobs/", "nodes": nodes}
    scene_path = os.path.join(outdir, f"{name}.mrson.json")
    with open(scene_path, "w") as f:
        json.dump(wrapper, f)

    kinds = {}
    for nd in nodes.values():
        kinds[nd["type"]] = kinds.get(nd["type"], 0) + 1
    return {"scene": scene_path, "nodes": len(nodes), "byType": kinds}
