"""Serialize the live MRML scene to **mrson** (Medical Reality Scripted Object Notation).

Neutral, Slicer-independent scene JSON — the format defined at ~/slicer/mrson
(schema/mrson-core.struct.json). Neutralizes the MRML scene: nodes keyed by a neutral
`type` (image / mesh / markup / camera / view / transferFunction / *Display) instead of
the vtkMRML class, with the vtkMRML class preserved under `source.mrmlClass` for lossless
reverse mapping.

Display nodes are kept INDEPENDENT, as in MRML: a displayable node references one or more
`*Display` nodes through refs.display, and each display node carries `viewRefs` (the view
ids it applies to; empty = all views). This preserves the "display scenario" — e.g. the
same volume rendered with a different transfer function in different views.

    { "mrson": 0, "blobBase": "blobs/", "nodes": { "<id>": { "type", "id", ... } } }

Runs INSIDE Slicer (needs slicer, vtk, numpy). Reuses the zarr writer + helpers from
serialize.py so the two stay byte-compatible on the blob channel.
"""
import json
import os

import slicer

from . import serialize as S  # reuse _write_zarr, _mat4, _volume_ijk_to_ras, _tf_points, _node_refs


def _rgba(c):
    return [c[0], c[1], c[2], 1.0]


def _zarr_desc(vol, node_id, blobdir):
    desc = S._write_zarr(vol, node_id, blobdir)
    desc["bytes"] = str(desc["bytes"])          # mrson int64-safe rule
    return desc


def _view_refs(dn):
    return [dn.GetNthViewNodeID(i) for i in range(dn.GetNumberOfViewNodeIDs())]


# ---- transfer function -----------------------------------------------------

def _transfer_function_node(vpn):
    vp = vpn.GetVolumeProperty()
    color = [{"value": p[0], "rgba": [p[1], p[2], p[3], 1.0]} for p in S._tf_points(vp.GetRGBTransferFunction(0), 3)]
    sop = [{"value": p[0], "opacity": p[1]} for p in S._tf_points(vp.GetScalarOpacity(0), 1)]
    gop = [{"value": p[0], "opacity": p[1]} for p in S._tf_points(vp.GetGradientOpacity(0), 1)]
    return {
        "type": "transferFunction", "id": vpn.GetID(), "name": vpn.GetName(), "frame": "RAS",
        "colorStops": color, "scalarOpacity": sop, "gradientOpacity": gop,
        "shade": bool(vp.GetShade()), "source": {"mrmlClass": vpn.GetClassName()},
    }


# ---- display nodes (independent, view-scoped) ------------------------------

def _display_node(dn):
    """A single MRML display node -> (mrson display node, optional (tfId, tfNode))."""
    cls = dn.GetClassName()
    node = {"id": dn.GetID(), "name": dn.GetName(), "frame": "RAS",
            "visible": bool(dn.GetVisibility()), "viewRefs": _view_refs(dn),
            "refs": {}, "source": {"mrmlClass": cls}}
    tf = None
    if cls == "vtkMRMLScalarVolumeDisplayNode":
        node.update({"type": "scalarVolumeDisplay", "window": dn.GetWindow(), "level": dn.GetLevel(),
                     "color": _rgba(dn.GetColor()), "interpolate": bool(dn.GetInterpolate())})
    elif "VolumeRenderingDisplayNode" in cls:
        node["type"] = "volumeRenderingDisplay"
        vpn = dn.GetVolumePropertyNode()
        if vpn is not None:
            node["refs"]["transferFunction"] = [vpn.GetID()]
            tf = (vpn.GetID(), _transfer_function_node(vpn))
        try:                                    # crop state (SlicerLive crops only when enabled)
            node["cropEnabled"] = bool(dn.GetCroppingEnabled())
            rid = dn.GetROINodeID()
            if rid:
                node["refs"]["roi"] = [rid]
        except Exception:  # noqa: BLE001
            pass
    elif cls == "vtkMRMLModelDisplayNode":
        node.update({"type": "modelDisplay", "color": _rgba(dn.GetColor()), "opacity": dn.GetOpacity(),
                     "representation": {0: "points", 1: "wireframe", 2: "surface"}.get(dn.GetRepresentation(), "surface"),
                     "edgeVisibility": bool(dn.GetEdgeVisibility())})
    elif "MarkupsDisplayNode" in cls:
        node.update({"type": "markupDisplay", "color": _rgba(dn.GetColor()),
                     "selectedColor": _rgba(dn.GetSelectedColor())})
        if hasattr(dn, "GetGlyphScale"):
            node["glyphScale"] = dn.GetGlyphScale()
        if hasattr(dn, "GetTextScale"):
            node["textScale"] = dn.GetTextScale()
    else:
        node.update({"type": "modelDisplay", "color": _rgba(dn.GetColor()), "opacity": dn.GetOpacity()})
    return node, tf


def _displays_for(displayable):
    """All display nodes of a displayable -> (display id list, {id: node}, {tfId: tfNode}).

    Iterates GetNthDisplayNode so multiple display nodes (e.g. several volume-rendering
    displays with different transfer functions, each scoped to different views) are all captured."""
    ids, nodes, tfs = [], {}, {}
    for i in range(displayable.GetNumberOfDisplayNodes()):
        dn = displayable.GetNthDisplayNode(i)
        if dn is None or dn.GetID() in nodes:
            continue
        mrn, tf = _display_node(dn)
        ids.append(dn.GetID())
        nodes[dn.GetID()] = mrn
        if tf is not None:
            tfs[tf[0]] = tf[1]
    return ids, nodes, tfs


# ---- displayable + other nodes ---------------------------------------------

def _image_node(vol, node_id, blobdir):
    arr = slicer.util.arrayFromVolume(vol)
    return {
        "type": "image", "id": node_id, "name": vol.GetName(), "frame": "RAS",
        "dims": [int(arr.shape[2]), int(arr.shape[1]), int(arr.shape[0])],  # [nx,ny,nz]
        "comps": 1,
        "ijkToRAS": S._volume_ijk_to_ras(vol),
        "zarr": _zarr_desc(vol, node_id, blobdir),
        "refs": {}, "source": {"mrmlClass": vol.GetClassName()},
    }


def _markup_node(n, node_id):
    pts = []
    for i in range(n.GetNumberOfControlPoints()):
        p = [0.0, 0.0, 0.0]
        n.GetNthControlPointPositionWorld(i, p)
        pts.append({"label": n.GetNthControlPointLabel(i), "position": [p[0], p[1], p[2]], "selected": True})
    mtype = {"vtkMRMLMarkupsFiducialNode": "fiducial", "vtkMRMLMarkupsLineNode": "line",
             "vtkMRMLMarkupsCurveNode": "curve", "vtkMRMLMarkupsPlaneNode": "plane",
             "vtkMRMLMarkupsROINode": "roi"}.get(n.GetClassName(), "fiducial")
    node = {
        "type": "markup", "id": node_id, "name": n.GetName(), "frame": "RAS",
        "markupType": mtype, "controlPoints": pts,
        "refs": {}, "source": {"mrmlClass": n.GetClassName()},
    }
    if n.GetClassName() == "vtkMRMLMarkupsROINode":   # ROI box (RAS): center + full size
        c = [0.0, 0.0, 0.0]
        n.GetCenterWorld(c)
        s = [0.0, 0.0, 0.0]
        try:
            n.GetSizeWorld(s)          # fills the array (world extents)
        except Exception:  # noqa: BLE001
            s = list(n.GetSize())      # 0-arg return (local extents)
        node["center"] = list(c)
        node["size"] = list(s)
    return node


def _camera_node(n, node_id):
    c = n.GetCamera()
    return {
        "type": "camera", "id": node_id, "name": n.GetName(),
        "position": list(c.GetPosition()), "focalPoint": list(c.GetFocalPoint()),
        "viewUp": list(c.GetViewUp()), "viewAngle": c.GetViewAngle(),
        "parallelScale": c.GetParallelScale(), "source": {"mrmlClass": n.GetClassName()},
    }


def _slice_view_node(n, node_id):
    return {
        "type": "view", "id": node_id, "name": n.GetName(), "kind": "slice",
        "layoutName": n.GetLayoutName(), "orientation": n.GetOrientation(),
        "sliceToRAS": S._mat4(n.GetSliceToRAS()), "xyToRAS": S._mat4(n.GetXYToRAS()),
        "dimensions": [int(d) for d in n.GetDimensions()],
        "fieldOfView": list(n.GetFieldOfView()), "source": {"mrmlClass": n.GetClassName()},
    }


def _3d_view_node(n, node_id):
    node = {"type": "view", "id": node_id, "name": n.GetName(), "kind": "3d",
            "layoutName": n.GetLayoutName(), "refs": {}, "source": {"mrmlClass": n.GetClassName()}}
    for cam in slicer.util.getNodesByClass("vtkMRMLCameraNode"):
        if cam.GetActiveTag() == n.GetID():
            node["refs"]["camera"] = [cam.GetID()]
    return node


# ---- driver ----------------------------------------------------------------

def _add_displayable(nodes, displayable, build_fn, node_id, blobdir=None):
    """Build a displayable node, its independent display nodes, and any TF nodes."""
    node = build_fn(displayable, node_id, blobdir) if blobdir is not None else build_fn(displayable, node_id)
    disp_ids, disp_nodes, tf_nodes = _displays_for(displayable)
    if disp_ids:
        node.setdefault("refs", {})["display"] = disp_ids
    nodes[node_id] = node
    nodes.update(disp_nodes)
    nodes.update(tf_nodes)


def serialize_mrson(outdir, name):
    """Serialize the live MRML scene -> <outdir>/<name>.mrson.json + <outdir>/blobs/... ."""
    blobdir = os.path.join(outdir, "blobs")
    os.makedirs(blobdir, exist_ok=True)
    nodes = {}

    for vol in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode"):
        try:
            _add_displayable(nodes, vol, _image_node, vol.GetID(), blobdir)
        except Exception as e:  # noqa: BLE001
            print(f"mrson: skipped image {vol.GetID()}: {e}")

    for cls in ("vtkMRMLModelNode",):
        for m in slicer.util.getNodesByClass(cls):
            if m.GetID() in nodes:
                continue
            try:
                _add_displayable(nodes, m, lambda n, nid: {"type": "mesh", "id": nid, "name": n.GetName(),
                                 "frame": "RAS", "refs": {}, "source": {"mrmlClass": n.GetClassName()}}, m.GetID())
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped mesh {m.GetID()}: {e}")

    for cls in ("vtkMRMLMarkupsFiducialNode", "vtkMRMLMarkupsLineNode", "vtkMRMLMarkupsCurveNode", "vtkMRMLMarkupsROINode"):
        for mk in slicer.util.getNodesByClass(cls):
            if mk.GetID() in nodes:
                continue
            try:
                _add_displayable(nodes, mk, _markup_node, mk.GetID())
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped markup {mk.GetID()}: {e}")

    simple = [("vtkMRMLCameraNode", _camera_node), ("vtkMRMLSliceNode", _slice_view_node),
              ("vtkMRMLViewNode", _3d_view_node)]
    for cls, build in simple:
        for n in slicer.util.getNodesByClass(cls):
            if n.GetID() in nodes:
                continue
            try:
                nodes[n.GetID()] = build(n, n.GetID())
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped {n.GetID()} ({cls}): {e}")

    wrapper = {"mrson": 0, "blobBase": "blobs/", "nodes": nodes}
    scene_path = os.path.join(outdir, f"{name}.mrson.json")
    with open(scene_path, "w") as f:
        json.dump(wrapper, f)

    kinds = {}
    for nd in nodes.values():
        kinds[nd["type"]] = kinds.get(nd["type"], 0) + 1
    return {"scene": scene_path, "nodes": len(nodes), "byType": kinds}
