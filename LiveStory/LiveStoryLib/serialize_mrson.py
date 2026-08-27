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


_ZARR_CACHE = {}   # node id -> (imageData MTime, blobdir, desc): a transform drag re-serializes ONLY metadata


def _zarr_desc(vol, node_id, blobdir):
    img = vol.GetImageData()
    key = (img.GetMTime() if img is not None else 0, blobdir)
    hit = _ZARR_CACHE.get(node_id)
    if hit is not None and hit[0] == key:
        return dict(hit[1])
    desc = S._write_zarr(vol, node_id, blobdir)
    desc["bytes"] = str(desc["bytes"])          # mrson int64-safe rule
    _ZARR_CACHE[node_id] = (key, desc)
    return dict(desc)


def _transform_ref(node):
    """refs.transform for a transformable node (world coordinates are ALSO baked into ijkToRAS /
    control points, so a client that ignores transforms still sees the right geometry)."""
    tn = node.GetParentTransformNode() if hasattr(node, "GetParentTransformNode") else None
    return {"transform": [tn.GetID()]} if tn is not None else {}


def _transform_node(n, node_id):
    import vtk
    toParent = vtk.vtkMatrix4x4(); toWorld = vtk.vtkMatrix4x4()
    linear = bool(n.IsTransformToWorldLinear())
    if hasattr(n, "GetMatrixTransformToParent"):
        n.GetMatrixTransformToParent(toParent)
    if linear:
        n.GetMatrixTransformToWorld(toWorld)
    parent = n.GetParentTransformNode()
    return {"type": "transform", "id": node_id, "name": n.GetName(), "frame": "RAS",
            "transformType": "linear" if linear else "nonlinear",
            "toParent": S._mat4(toParent), "toWorld": S._mat4(toWorld) if linear else None,
            "refs": {"parent": [parent.GetID()]} if parent is not None else {},
            "source": {"mrmlClass": n.GetClassName()}}


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
                     "color": _rgba(dn.GetColor()), "interpolate": bool(dn.GetInterpolate()),
                     "autoWindowLevel": bool(dn.GetAutoWindowLevel()),
                     "applyThreshold": bool(dn.GetApplyThreshold()),
                     "threshold": [dn.GetLowerThreshold(), dn.GetUpperThreshold()]})
        if dn.GetColorNodeID():
            node["refs"]["color"] = [dn.GetColorNodeID()]
    elif cls == "vtkMRMLLabelMapVolumeDisplayNode":
        node.update({"type": "labelMapDisplay", "interpolate": False})
        if dn.GetColorNodeID():
            node["refs"]["color"] = [dn.GetColorNodeID()]
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
        "labelmap": vol.GetClassName() == "vtkMRMLLabelMapVolumeNode",
        "refs": _transform_ref(vol), "source": {"mrmlClass": vol.GetClassName()},
    }


def _markup_node(n, node_id):
    pts = []
    for i in range(n.GetNumberOfControlPoints()):
        p = [0.0, 0.0, 0.0]
        n.GetNthControlPointPositionWorld(i, p)
        pts.append({"label": n.GetNthControlPointLabel(i), "position": [p[0], p[1], p[2]], "selected": True})
    import vtk
    cls = n.GetClassName()
    mtype = {"vtkMRMLMarkupsFiducialNode": "fiducial", "vtkMRMLMarkupsLineNode": "line",
             "vtkMRMLMarkupsAngleNode": "angle", "vtkMRMLMarkupsCurveNode": "curve",
             "vtkMRMLMarkupsClosedCurveNode": "closedCurve", "vtkMRMLMarkupsPlaneNode": "plane",
             "vtkMRMLMarkupsROINode": "roi"}.get(cls, "fiducial")
    node = {
        "type": "markup", "id": node_id, "name": n.GetName(), "frame": "RAS",
        "markupType": mtype, "controlPoints": pts, "locked": bool(n.GetLocked()),
        "refs": {}, "source": {"mrmlClass": cls},
    }
    if "Curve" in cls:                       # open/closed curve: the interpolated world polyline
        try:
            cp = n.GetCurvePointsWorld()
            if cp is not None:
                m = cp.GetNumberOfPoints()
                step = max(1, m // 200)      # downsample to keep the segment count bounded
                node["linePoints"] = [list(cp.GetPoint(i)) for i in range(0, m, step)]
                node["closed"] = (cls == "vtkMRMLMarkupsClosedCurveNode")
        except Exception:  # noqa: BLE001
            pass
    if cls == "vtkMRMLMarkupsPlaneNode":     # plane border: 4 world corners
        try:
            cor = vtk.vtkPoints()
            n.GetPlaneCornerPointsWorld(cor)
            node["corners"] = [list(cor.GetPoint(i)) for i in range(cor.GetNumberOfPoints())]
        except Exception:  # noqa: BLE001
            pass
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
    dn = n.GetDisplayNode()
    if dn is not None:
        sc = dn.GetSelectedColor()     # colour of selected control points (Slicer's default markup look)
        node["color"] = [sc[0], sc[1], sc[2], 1.0]
        node["visible"] = bool(dn.GetVisibility())
        node["glyphScale"] = float(dn.GetGlyphScale())
        if hasattr(dn, "GetTextScale"):
            node["textScale"] = float(dn.GetTextScale())
    return node


def _ensure_labelmap_geometry(seg, lm):
    """An EMPTY segmentation exports to a labelmap with NO scalars (ExportAllSegments allocates nothing
    when there's nothing to write), so dims/ijkToRAS/zarr would be missing and a consumer couldn't build
    the grid. Materialize the segmentation's REFERENCE geometry as an all-zero labelmap so geometry (and
    a zero labelmap) always stream — a consumer like seged needs the grid even before anything is painted."""
    import numpy as np
    import vtk
    img = lm.GetImageData()
    if img is not None and img.GetPointData() is not None and img.GetPointData().GetScalars() is not None:
        return
    try:
        import vtkSegmentationCorePython as vsc
        geom = seg.GetSegmentation().GetConversionParameter(
            slicer.vtkSegmentationConverter.GetReferenceImageGeometryParameterName())
        if not geom:
            return
        oi = vsc.vtkOrientedImageData()
        slicer.vtkSegmentationConverter.DeserializeImageGeometry(geom, oi, True, vtk.VTK_UNSIGNED_CHAR, 1)
        dims = oi.GetDimensions()
        m = vtk.vtkMatrix4x4()
        oi.GetImageToWorldMatrix(m)
        slicer.util.updateVolumeFromArray(lm, np.zeros((dims[2], dims[1], dims[0]), np.uint8))
        lm.SetIJKToRASMatrix(m)
    except Exception as e:  # noqa: BLE001
        print("serialize_mrson: reference-geometry materialize failed: %s" % e)


def _segmentation_node(seg, node_id, blobdir):
    """vtkMRMLSegmentationNode -> mrson `segmentation` node: the merged binary labelmap as a
    content-addressed zarr blob + per-segment {labelValue, color}. Volume-based only (no surface)."""
    import vtk
    lm = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLabelMapVolumeNode")
    slicer.modules.segmentations.logic().ExportAllSegmentsToLabelmapNode(
        seg, lm, slicer.vtkSegmentation.EXTENT_REFERENCE_GEOMETRY)
    _ensure_labelmap_geometry(seg, lm)               # EMPTY seg → materialize the reference geometry (zeros)
    zarr = _zarr_desc(lm, node_id, blobdir)          # content-hashed labelmap chunks
    arr = slicer.util.arrayFromVolume(lm)
    m = vtk.vtkMatrix4x4()
    lm.GetIJKToRASMatrix(m)
    segn = seg.GetSegmentation()
    segments = []
    for i in range(segn.GetNumberOfSegments()):
        sid = segn.GetNthSegmentID(i)
        s = segn.GetSegment(sid)
        c = s.GetColor()
        segments.append({"id": sid, "name": s.GetName(), "labelValue": int(s.GetLabelValue()),
                         "color": [c[0], c[1], c[2], 1.0]})
    slicer.mrmlScene.RemoveNode(lm)
    node = {
        "type": "segmentation", "id": node_id, "name": seg.GetName(), "frame": "RAS",
        "segments": segments,
        "dims": [int(arr.shape[2]), int(arr.shape[1]), int(arr.shape[0])],
        "ijkToRAS": [m.GetElement(r, c) for r in range(4) for c in range(4)],
        "zarr": zarr, "refs": {}, "source": {"mrmlClass": seg.GetClassName()},
    }
    dn = seg.GetDisplayNode()
    if dn is not None:
        node["visible"] = bool(dn.GetVisibility())
        node["opacity"] = float(dn.GetOpacity())
        # 2D slice display: independent fill + outline visibility/opacity (Slicer's defaults
        # are fill 0.5 + outline 1.0, both visible) — SlicerLive mirrors these per-slice.
        node["fill2D"] = {"visible": bool(dn.GetVisibility2DFill()), "opacity": float(dn.GetOpacity2DFill())}
        node["outline2D"] = {"visible": bool(dn.GetVisibility2DOutline()), "opacity": float(dn.GetOpacity2DOutline())}
    return node


def _segmentation_display_event(seg):
    """A LIGHT display-only mrson event for a segmentation (no zarr re-export): overall
    visibility/opacity + 2D fill/outline settings + per-segment {labelValue, color, visible}.
    Emitted when the segmentation or its display node is modified so SlicerLive updates the
    slice fill/outline + 3D field in place (re-baking only if a colour / segment visibility
    actually changed). sourceId is the SEGMENTATION node id (the client keys display on it)."""
    dn = seg.GetDisplayNode()
    disp = {
        "visible": True, "opacity": 1.0,
        "fill2D": {"visible": True, "opacity": 0.5},
        "outline2D": {"visible": True, "opacity": 1.0},
        "segments": [],
    }
    if dn is not None:
        disp["visible"] = bool(dn.GetVisibility())
        disp["opacity"] = float(dn.GetOpacity())
        disp["fill2D"] = {"visible": bool(dn.GetVisibility2DFill()), "opacity": float(dn.GetOpacity2DFill())}
        disp["outline2D"] = {"visible": bool(dn.GetVisibility2DOutline()), "opacity": float(dn.GetOpacity2DOutline())}
    segn = seg.GetSegmentation()
    for i in range(segn.GetNumberOfSegments()):
        sid = segn.GetNthSegmentID(i)
        s = segn.GetSegment(sid)
        c = s.GetColor()
        vis = True
        if dn is not None:
            try:
                vis = bool(dn.GetSegmentVisibility(sid))
            except Exception:  # noqa: BLE001
                vis = True
        disp["segments"].append({"id": sid, "labelValue": int(s.GetLabelValue()),
                                 "color": [c[0], c[1], c[2], 1.0], "visible": vis})
    return {"event": "SegmentationDisplayModified", "sourceId": seg.GetID(), "display": disp}


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
        # offset = the out-of-plane scroll position (mm along the slice normal); a clean scalar
        # dual to SetSliceOffset (the sliceToRAS translation encodes it, but the scalar round-trips).
        "offset": n.GetSliceOffset(),
        "fieldOfView": list(n.GetFieldOfView()), "source": {"mrmlClass": n.GetClassName()},
    }


_LAYOUT_NAMES = {2: "conventional", 3: "fourUp", 4: "oneUp3D", 6: "oneUpRed", 7: "oneUpYellow",
                 8: "oneUpGreen", 15: "dual3D", 16: "conventionalWidescreen", 30: "fourByThree"}


def _layout_node(n, node_id):
    arr = n.GetViewArrangement()
    return {
        "type": "layout", "id": node_id, "name": n.GetName(),
        "arrangement": int(arr), "arrangementName": _LAYOUT_NAMES.get(arr, "other"),
        "source": {"mrmlClass": n.GetClassName()},
    }


_INTERACTION_MODES = {1: "place", 2: "viewTransform", 3: "select", 4: "user", 5: "adjustWindowLevel"}


def _crosshair_node(n, node_id):
    ras = [0.0, 0.0, 0.0]; n.GetCursorPositionRAS(ras)
    xras = list(n.GetCrosshairRAS())          # VTK python: returns a tuple
    return {"type": "crosshair", "id": node_id, "name": n.GetName(),
            "mode": int(n.GetCrosshairMode()), "thickness": int(n.GetCrosshairThickness()),
            "behavior": int(n.GetCrosshairBehavior()), "cursorRAS": ras, "crosshairRAS": xras,
            "source": {"mrmlClass": n.GetClassName()}}


def _interaction_node(n, node_id):
    return {"type": "interaction", "id": node_id, "name": n.GetName(),
            "mode": _INTERACTION_MODES.get(int(n.GetCurrentInteractionMode()), "viewTransform"),
            "placeModePersistence": bool(n.GetPlaceModePersistence()),
            "source": {"mrmlClass": n.GetClassName()}}


def _selection_node(n, node_id):
    return {"type": "selection", "id": node_id, "name": n.GetName(),
            "activePlaceNodeClassName": n.GetActivePlaceNodeClassName() or "",
            "activePlaceNodeID": n.GetActivePlaceNodeID() or "",
            "activeVolumeID": n.GetActiveVolumeID() or "", "secondaryVolumeID": n.GetSecondaryVolumeID() or "",
            "activeLabelVolumeID": n.GetActiveLabelVolumeID() or "",
            "source": {"mrmlClass": n.GetClassName()}}


def _slice_composite_node(n, node_id):
    refs = {}
    for key, getter in (("background", n.GetBackgroundVolumeID), ("foreground", n.GetForegroundVolumeID), ("label", n.GetLabelVolumeID)):
        v = getter()
        if v:
            refs[key] = [v]
    return {"type": "sliceComposite", "id": node_id, "name": n.GetName(), "layoutName": n.GetLayoutName(),
            "refs": refs, "foregroundOpacity": float(n.GetForegroundOpacity()), "labelOpacity": float(n.GetLabelOpacity()),
            "compositing": int(n.GetCompositing()),          # 0 alpha, 1 reverse alpha, 2 add, 3 subtract
            "linkedControl": bool(n.GetLinkedControl()), "hotLinkedControl": bool(n.GetHotLinkedControl()),
            "source": {"mrmlClass": n.GetClassName()}}


def _color_table_node(n, node_id, max_entries=4096):
    """A colour node as an RGBA table. Discrete tables keep their integer index (label value -> colour);
    procedural (continuous) nodes are sampled to 256 entries across their range and marked `continuous`."""
    entries = []
    continuous = False
    try:
        ncol = int(n.GetNumberOfColors())
    except Exception:  # noqa: BLE001
        ncol = 0
    ctf = n.GetColorTransferFunction() if hasattr(n, "GetColorTransferFunction") else None
    if ctf is not None and (ncol <= 0 or ncol > max_entries):
        lo, hi = ctf.GetRange()
        for i in range(256):
            x = lo + (hi - lo) * i / 255.0
            c = [0.0, 0.0, 0.0]; ctf.GetColor(x, c)
            entries.append([c[0], c[1], c[2], 1.0])
        continuous = True
        rng = [lo, hi]
    else:
        rng = None
        rgba = [0.0, 0.0, 0.0, 0.0]
        for i in range(min(ncol, max_entries)):
            n.GetColor(i, rgba)
            entries.append([rgba[0], rgba[1], rgba[2], rgba[3]])
    return {"type": "colorTable", "id": node_id, "name": n.GetName(), "entries": entries,
            "continuous": continuous, "range": rng, "source": {"mrmlClass": n.GetClassName()}}


def _3d_view_node(n, node_id):
    node = {"type": "view", "id": node_id, "name": n.GetName(), "kind": "3d",
            "layoutName": n.GetLayoutName(), "refs": _transform_ref(n), "source": {"mrmlClass": n.GetClassName()}}
    for cam in slicer.util.getNodesByClass("vtkMRMLCameraNode"):
        # match camera->view by layout name (GetActiveTag() is deprecated and, being a
        # vtkDeprecation warning, prints to the Python console on EVERY call → main-thread repaint)
        if cam.GetLayoutName() == n.GetLayoutName():
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
                                 "frame": "RAS", "refs": _transform_ref(n), "source": {"mrmlClass": n.GetClassName()}}, m.GetID())
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped mesh {m.GetID()}: {e}")

    # CurveNode also returns ClosedCurve (subclass); Angle + Plane are separate roots. The
    # `id in nodes` guard below dedups any overlap.
    for cls in ("vtkMRMLMarkupsFiducialNode", "vtkMRMLMarkupsLineNode", "vtkMRMLMarkupsAngleNode",
                "vtkMRMLMarkupsCurveNode", "vtkMRMLMarkupsPlaneNode", "vtkMRMLMarkupsROINode"):
        for mk in slicer.util.getNodesByClass(cls):
            if mk.GetID() in nodes:
                continue
            try:
                _add_displayable(nodes, mk, _markup_node, mk.GetID())
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped markup {mk.GetID()}: {e}")

    for seg in slicer.util.getNodesByClass("vtkMRMLSegmentationNode"):
        if seg.GetID() in nodes:
            continue
        try:
            nodes[seg.GetID()] = _segmentation_node(seg, seg.GetID(), blobdir)
        except Exception as e:  # noqa: BLE001
            print(f"mrson: skipped segmentation {seg.GetID()}: {e}")

    simple = [("vtkMRMLLayoutNode", _layout_node), ("vtkMRMLCameraNode", _camera_node),
              ("vtkMRMLSliceNode", _slice_view_node), ("vtkMRMLViewNode", _3d_view_node),
              ("vtkMRMLCrosshairNode", _crosshair_node), ("vtkMRMLInteractionNode", _interaction_node),
              ("vtkMRMLSelectionNode", _selection_node), ("vtkMRMLSliceCompositeNode", _slice_composite_node),
              ("vtkMRMLTransformNode", _transform_node)]
    for cls, build in simple:
        for n in slicer.util.getNodesByClass(cls):
            if n.GetID() in nodes:
                continue
            try:
                nodes[n.GetID()] = build(n, n.GetID())
            except Exception as e:  # noqa: BLE001
                print(f"mrson: skipped {n.GetID()} ({cls}): {e}")

    # colour tables: only the ones some display node references (Slicer has ~100 colour nodes)
    for nd in list(nodes.values()):
        for cid in (nd.get("refs") or {}).get("color", []):
            if cid in nodes:
                continue
            cn = slicer.mrmlScene.GetNodeByID(cid)
            if cn is not None:
                try:
                    nodes[cid] = _color_table_node(cn, cid)
                except Exception as e:  # noqa: BLE001
                    print(f"mrson: skipped color table {cid}: {e}")

    wrapper = {"mrson": 0, "blobBase": "blobs/", "nodes": nodes}
    scene_path = os.path.join(outdir, f"{name}.mrson.json")
    with open(scene_path, "w") as f:
        json.dump(wrapper, f)

    kinds = {}
    for nd in nodes.values():
        kinds[nd["type"]] = kinds.get(nd["type"], 0) + 1
    return {"scene": scene_path, "nodes": len(nodes), "byType": kinds}
