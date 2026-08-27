"""mrson server — a custom Slicer WebServer request handler that serves the live MRML
scene as **mrson** (and, in Phase 3, accepts mrson ops so a client can drive Slicer).

Lives in LiveStory for now (self-contained); can migrate to Slicer core later. Built on
Slicer's built-in WebServer module (WebServerLib.BaseRequestHandler), the same substrate
the MCP server uses.

Endpoints (all under /mrson, CORS-enabled so a SlicerLive page on another origin can fetch):
  GET  /mrson/scene.json[?refresh=1]   -> the current scene serialized to mrson
  GET  /mrson/blobs/<path>             -> a content-addressed volume chunk (zarr)
  GET  /mrson/state.json               -> lightweight interactive state (camera/display), no re-serialize
  POST /mrson/ops                      -> apply mrson ops to the scene (Phase 3; stub for now)

Start from the Slicer Python console:
    import sys; sys.path.insert(0, "/Users/pieper/slicer/SlicerLive/LiveStory")
    from LiveStoryLib import mrson_server
    logic = mrson_server.startMrsonServer(2131)
"""
import json
import os
import traceback
import urllib.parse

import slicer
import WebServer
import WebServerLib

from . import serialize_mrson


_STATE = {"dir": None, "serialized": False}


def _live_dir():
    if _STATE["dir"] is None:
        base = slicer.app.temporaryPath if hasattr(slicer.app, "temporaryPath") else "/tmp"
        _STATE["dir"] = os.path.join(base, "mrson_live")
        os.makedirs(_STATE["dir"], exist_ok=True)
    return _STATE["dir"]


def markDirty(*_):
    """Force the next scene.json fetch to re-serialize (call from MRML observers)."""
    _STATE["serialized"] = False


def _ensure_serialized(force=False):
    d = _live_dir()
    if force or not _STATE["serialized"] or not os.path.exists(os.path.join(d, "live.mrson.json")):
        serialize_mrson.serialize_mrson(d, "live")
        _STATE["serialized"] = True
    return os.path.join(d, "live.mrson.json")


def _live_state():
    """Cheap, always-fresh interactive state (no volume re-serialization): camera + display
    per node. This is what a poll/hot-channel uses between full scene fetches."""
    from . import serialize_mrson as M
    nodes = {}
    for cam in slicer.util.getNodesByClass("vtkMRMLCameraNode"):
        nodes[cam.GetID()] = M._camera_node(cam, cam.GetID())
    for vol in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode"):
        for i in range(vol.GetNumberOfDisplayNodes()):
            dn = vol.GetNthDisplayNode(i)
            if dn is None:
                continue
            node, _tf = M._display_node(dn)
            nodes[dn.GetID()] = node
    return {"mrson": 0, "state": True, "nodes": nodes}


# ---- op application (SlicerLive -> Slicer) ---------------------------------

def _apply_op(op):
    """Apply one mrson op to the MRML scene. Returns True if it did something."""
    kind = op.get("op")
    nid = op.get("id")
    node = slicer.mrmlScene.GetNodeByID(nid) if nid else None
    if kind == "del":
        if node is not None:
            slicer.mrmlScene.RemoveNode(node)
            return True
        return False
    if kind == "patch":
        return _apply_patch(node, op.get("path", ""), op.get("value"))
    if kind == "cmd":
        return _apply_cmd(node, op.get("cmd"), op.get("args") or {})
    if kind == "put":
        return _apply_put(op) is not None


_MARKUP_CLASSES = {"fiducial": "vtkMRMLMarkupsFiducialNode", "line": "vtkMRMLMarkupsLineNode",
                   "angle": "vtkMRMLMarkupsAngleNode", "curve": "vtkMRMLMarkupsCurveNode",
                   "closedCurve": "vtkMRMLMarkupsClosedCurveNode", "plane": "vtkMRMLMarkupsPlaneNode",
                   "roi": "vtkMRMLMarkupsROINode"}


def _apply_put(op):
    """Create a node from an mrson `put` (client-created node, e.g. place mode). Returns the REAL MRML
    id (MRML assigns ids; the client's provisional id is aliased by the caller) or None. Markups are
    first-class; anything else is created by its declared mrmlClass and then patched property by
    property (unknown properties are ignored by _apply_patch). Bulk types (image) are not creatable
    over the wire yet."""
    import vtk
    node_m = op.get("node") or {}
    t = node_m.get("type")
    name = node_m.get("name") or ""
    if t == "markup":
        cls = _MARKUP_CLASSES.get(node_m.get("markupType") or "fiducial")
        node = slicer.mrmlScene.AddNewNodeByClass(cls, name)
        node.CreateDefaultDisplayNodes()
        for cp in node_m.get("controlPoints") or []:
            pos = cp.get("position") if isinstance(cp, dict) else cp
            if pos and len(pos) >= 3:
                idx = node.AddControlPoint(vtk.vtkVector3d(float(pos[0]), float(pos[1]), float(pos[2])))
                if isinstance(cp, dict) and cp.get("label"):
                    node.SetNthControlPointLabel(idx, cp["label"])
    elif t == "image":
        return None
    else:
        cls = (node_m.get("source") or {}).get("mrmlClass")
        if not cls:
            return None
        node = slicer.mrmlScene.AddNewNodeByClass(cls, name)
        if hasattr(node, "CreateDefaultDisplayNodes"):
            node.CreateDefaultDisplayNodes()
    for k, v in node_m.items():
        if k in ("id", "type", "name", "source", "refs", "controlPoints", "markupType", "zarr"):
            continue
        try:
            _apply_patch(node, "#/" + k, v)
        except Exception:  # noqa: BLE001
            pass
    return node.GetID()


def _apply_patch(node, path, value):
    """Apply a single-property patch (mrson -> MRML), the dual of serialize_mrson. `path` is a
    URI-fragment JSON pointer, e.g. '#/window' or nested '#/outline2D/opacity'. Display properties
    that mrson FOLDS onto a displayable node (segmentation, markup carry their display node's props)
    map through GetDisplayNode(). Class branches return True when they handle the key and otherwise
    FALL THROUGH, so the generic display-visibility fallback at the end still applies."""
    if node is None:
        return False
    key = [p for p in path.lstrip("#").strip("/").split("/") if p]
    k0 = key[0] if key else ""
    k1 = key[1] if len(key) > 1 else ""
    cls = node.GetClassName()

    if "CameraNode" in cls:
        if k0 == "position": node.SetPosition(*value); node.Modified(); return True
        if k0 == "focalPoint": node.SetFocalPoint(*value); node.Modified(); return True
        if k0 == "viewUp": node.SetViewUp(*value); node.Modified(); return True
        if k0 == "viewAngle": node.GetCamera().SetViewAngle(value); node.Modified(); return True
        if k0 == "parallelScale": node.GetCamera().SetParallelScale(float(value)); node.Modified(); return True
        return False

    if cls == "vtkMRMLSliceNode":
        # dual of serialize_mrson._slice_view_node: out-of-plane scroll + in-plane zoom.
        if k0 == "offset": node.SetSliceOffset(float(value)); return True
        if k0 == "fieldOfView" and isinstance(value, (list, tuple)) and len(value) >= 3:
            node.SetFieldOfView(float(value[0]), float(value[1]), float(value[2])); node.UpdateMatrices(); return True
        return False

    if cls == "vtkMRMLCrosshairNode":
        # SlicerLive cursor -> Slicer's crosshair node: DataProbe observes CursorPositionModifiedEvent, so the
        # streamed Data Probe panel shows the values under the SlicerLive cursor (lossless, no re-implementation)
        if k0 == "cursorRAS" and isinstance(value, (list, tuple)) and len(value) >= 3:
            node.SetCursorPositionRAS([float(value[0]), float(value[1]), float(value[2])]); return True
        if k0 == "crosshairRAS" and isinstance(value, (list, tuple)) and len(value) >= 3:
            node.SetCrosshairRAS([float(value[0]), float(value[1]), float(value[2])]); return True
        if k0 == "mode": node.SetCrosshairMode(int(value)); return True
        return False

    if cls == "vtkMRMLInteractionNode":
        modes = {"place": 1, "viewTransform": 2, "select": 3, "user": 4, "adjustWindowLevel": 5}
        if k0 == "mode" and value in modes: node.SetCurrentInteractionMode(modes[value]); return True
        if k0 == "placeModePersistence": node.SetPlaceModePersistence(1 if value else 0); return True
        return False

    if cls == "vtkMRMLSliceCompositeNode":
        if k0 == "foregroundOpacity": node.SetForegroundOpacity(float(value)); return True
        if k0 == "labelOpacity": node.SetLabelOpacity(float(value)); return True
        if k0 == "compositing": node.SetCompositing(int(value)); return True
        if k0 == "linkedControl": node.SetLinkedControl(1 if value else 0); return True
        if k0 == "hotLinkedControl": node.SetHotLinkedControl(1 if value else 0); return True
        if k0 == "refs" and k1 in ("background", "foreground", "label"):
            vid = value[0] if isinstance(value, (list, tuple)) and value else (value if isinstance(value, str) else None)
            {"background": node.SetBackgroundVolumeID, "foreground": node.SetForegroundVolumeID, "label": node.SetLabelVolumeID}[k1](vid or None)
            return True
        return False

    if "TransformNode" in cls and k0 == "toParent" and isinstance(value, (list, tuple)) and len(value) == 16:
        import vtk
        m = vtk.vtkMatrix4x4()
        for r in range(4):
            for c in range(4):
                m.SetElement(r, c, float(value[r * 4 + c]))
        node.SetMatrixTransformToParent(m)
        return True

    if cls == "vtkMRMLLayoutNode":
        if k0 == "arrangement": node.SetViewArrangement(int(value)); return True
        return False

    if cls == "vtkMRMLVolumePropertyNode":
        # dual of serialize_mrson._transfer_function_node: per-point opacity/colour edits + shade.
        # `#/scalarOpacity/<i>/opacity`, `#/colorStops/<i>/rgba`, `#/shade`. Point x-value stays put;
        # only the edited channel changes (SetNodeValue keeps midpoint/sharpness).
        prop = node.GetVolumeProperty()
        if k0 == "shade":
            prop.SetShade(bool(value)); node.Modified(); return True
        if k0 == "scalarOpacity" and len(key) >= 3 and key[2] == "opacity":
            try: i = int(k1)
            except (ValueError, TypeError): return False
            f = prop.GetScalarOpacity(0)
            if 0 <= i < f.GetSize():
                v = [0.0, 0.0, 0.0, 0.0]; f.GetNodeValue(i, v); v[1] = float(value)
                f.SetNodeValue(i, v); node.Modified(); return True
            return False
        if k0 == "colorStops" and len(key) >= 3 and key[2] == "rgba" and isinstance(value, (list, tuple)) and len(value) >= 3:
            try: i = int(k1)
            except (ValueError, TypeError): return False
            f = prop.GetRGBTransferFunction(0)
            if 0 <= i < f.GetSize():
                v = [0.0] * 6; f.GetNodeValue(i, v)
                v[1], v[2], v[3] = float(value[0]), float(value[1]), float(value[2])
                f.SetNodeValue(i, v); node.Modified(); return True
            return False
        return False

    if cls == "vtkMRMLScalarVolumeDisplayNode":
        # a manual W/L set must switch AutoWindowLevel off first (as the Slicer GUI does on a W/L drag),
        # otherwise the auto computation immediately overrides the value
        if k0 == "window": node.SetAutoWindowLevel(0); node.SetWindow(float(value)); return True
        if k0 == "level": node.SetAutoWindowLevel(0); node.SetLevel(float(value)); return True
        if k0 == "interpolate": node.SetInterpolate(bool(value)); return True
        if k0 == "autoWindowLevel": node.SetAutoWindowLevel(1 if value else 0); return True
        if k0 == "applyThreshold": node.SetApplyThreshold(1 if value else 0); return True
        if k0 == "threshold" and isinstance(value, (list, tuple)) and len(value) >= 2:
            node.SetThreshold(float(value[0]), float(value[1])); return True
        if k0 == "refs" and k1 == "color":
            node.SetAndObserveColorNodeID(value[0] if isinstance(value, (list, tuple)) and value else value); return True
        # visible falls through to the generic display-visibility fallback

    if "VolumeRenderingDisplayNode" in cls:
        if k0 == "cropEnabled": node.SetCroppingEnabled(bool(value)); return True
        # visible falls through

    if cls == "vtkMRMLSegmentationNode":
        dn = node.GetDisplayNode()
        if dn is not None:
            if k0 in ("visible", "visibility"): dn.SetVisibility(bool(value)); return True
            if k0 == "opacity": dn.SetOpacity(float(value)); return True
            if k0 == "fill2D" and k1 == "opacity": dn.SetOpacity2DFill(float(value)); return True
            if k0 == "fill2D" and k1 == "visible": dn.SetVisibility2DFill(bool(value)); return True
            if k0 == "outline2D" and k1 == "opacity": dn.SetOpacity2DOutline(float(value)); return True
            if k0 == "outline2D" and k1 == "visible": dn.SetVisibility2DOutline(bool(value)); return True
            if k0 == "segments" and len(key) >= 3 and key[2] == "visible":   # per-segment visibility
                segn = node.GetSegmentation()
                try: i = int(k1)
                except (ValueError, TypeError): return False
                if 0 <= i < segn.GetNumberOfSegments():
                    dn.SetSegmentVisibility(segn.GetNthSegmentID(i), bool(value)); return True
        return False

    if cls.startswith("vtkMRMLMarkups") and "DisplayNode" not in cls:
        # ROI geometry lives on the node; other markup display props (mrson folds them onto the node)
        # map to the markup's display node -- dual of serialize_mrson._markup_node.
        if k0 == "locked":
            node.SetLocked(bool(value)); node.Modified(); return True
        if cls == "vtkMRMLMarkupsROINode" and k0 == "center":
            try: node.SetCenterWorld(value)
            except Exception: node.SetCenterWorld(*value)  # noqa: BLE001
            node.Modified(); return True
        if cls == "vtkMRMLMarkupsROINode" and k0 == "size":
            try: node.SetSizeWorld(value)
            except Exception: node.SetSize(*value)  # noqa: BLE001
            node.Modified(); return True
        dn = node.GetDisplayNode()
        if dn is not None:
            if k0 in ("visible", "visibility"): dn.SetVisibility(bool(value)); return True
            if k0 == "glyphScale": dn.SetGlyphScale(float(value)); return True
            if k0 == "textScale": dn.SetTextScale(float(value)); return True
            if k0 == "color" and isinstance(value, (list, tuple)) and len(value) >= 3:
                dn.SetSelectedColor(float(value[0]), float(value[1]), float(value[2])); return True
        return False

    if "DisplayNode" in cls and k0 in ("visible", "visibility"):   # scalar/model/etc. display visibility
        node.SetVisibility(bool(value))
        return True

    return False


def _apply_cmd(node, cmd, args):
    if cmd == "placeAt" and node is not None and node.GetClassName() == "vtkMRMLInteractionNode":
        # Place mode, server-authoritative: exactly what vtkMRMLMarkupsDisplayableManager does on a click
        # in a view -- use the selection node's active place class / node (creating the node if needed),
        # add the control point, and leave place mode unless persistence is on.
        import vtk
        ras = args.get("ras")
        if ras is None or node.GetCurrentInteractionMode() != 1:
            return False
        sel = slicer.app.applicationLogic().GetSelectionNode()
        cls = sel.GetActivePlaceNodeClassName() or "vtkMRMLMarkupsFiducialNode"
        target = slicer.mrmlScene.GetNodeByID(sel.GetActivePlaceNodeID() or "")
        if target is None or target.GetClassName() != cls:
            target = slicer.mrmlScene.AddNewNodeByClass(cls)
            target.CreateDefaultDisplayNodes()
            sel.SetActivePlaceNodeID(target.GetID())
        idx = target.AddControlPoint(vtk.vtkVector3d(float(ras[0]), float(ras[1]), float(ras[2])))
        if args.get("label"):
            target.SetNthControlPointLabel(idx, args["label"])
        done = target.GetMaximumNumberOfControlPoints() > 0 and target.GetNumberOfControlPoints() >= target.GetMaximumNumberOfControlPoints()
        if (not node.GetPlaceModePersistence()) and (target.GetMaximumNumberOfControlPoints() <= 0 or done):
            node.SwitchToViewTransformMode()
        return True
    if cmd == "setCursor" and node is not None and node.GetClassName() == "vtkMRMLCrosshairNode":
        # SlicerLive pointer over a slice view -> Slicer's crosshair cursor, in the XYZ+sliceNode form so
        # DataProbe (which needs the slice node + its layers) shows the values under the cursor.
        import vtk
        ras = args.get("ras"); view = args.get("view")
        sn = None
        for n in slicer.util.getNodesByClass("vtkMRMLSliceNode"):
            if n.GetLayoutName() == view: sn = n
        if ras is None:
            node.SetCursorPositionInvalid(); return True
        if sn is None:
            node.SetCursorPositionRAS([float(ras[0]), float(ras[1]), float(ras[2])]); return True
        inv = vtk.vtkMatrix4x4(); vtk.vtkMatrix4x4.Invert(sn.GetXYToRAS(), inv)
        xyz = inv.MultiplyPoint([float(ras[0]), float(ras[1]), float(ras[2]), 1.0])
        node.SetCursorPositionXYZ([xyz[0], xyz[1], xyz[2]], sn)
        return True
    if cmd == "setSliceFrame" and node is not None and node.GetClassName() == "vtkMRMLSliceNode":
        # SlicerLive pan/zoom -> Slicer: in-plane centre (translation column of sliceToRAS) + field of view
        c = args.get("center"); fov = args.get("fov")
        m = node.GetSliceToRAS()
        if c is not None:
            for i in range(3): m.SetElement(i, 3, float(c[i]))
        if fov is not None and len(fov) >= 2:
            node.SetFieldOfView(float(fov[0]), float(fov[1]), float(fov[2]) if len(fov) > 2 else node.GetFieldOfView()[2])
        node.UpdateMatrices(); node.Modified()
        return True
    if cmd == "viewContextMenu" and node is not None and node.GetClassName() in ("vtkMRMLSliceNode", "vtkMRMLViewNode"):
        # right-click in a SlicerLive view -> the app's own view context menu, via the same event the
        # interactor styles use (vtkMRMLInteractionNode::ShowViewContextMenu -> app logic -> subject
        # hierarchy plugin logic builds the QMenu). The QMenu is a top-level -> it streams as a popup
        # region and the click that picks an item routes back through the GUI stream. The menu's
        # exec() runs a nested loop; sockets keep being serviced, so nothing else stalls.
        ras = args.get("ras") or [0.0, 0.0, 0.0]
        inode = node.GetInteractionNode() if hasattr(node, "GetInteractionNode") else slicer.app.applicationLogic().GetInteractionNode()
        ed = slicer.vtkMRMLInteractionEventData()
        ed.SetViewNode(node)
        ed.SetWorldPosition([float(ras[0]), float(ras[1]), float(ras[2])])
        ed.SetDisplayPosition([int(args.get("x", 0)), int(args.get("y", 0))])
        import qt
        # Slicer positions the menu at QCursor::pos(): move the (virtual, offscreen) cursor to the click
        # first so the popup region lands where the user clicked
        lm = slicer.app.layoutManager(); view = None
        if node.GetClassName() == "vtkMRMLSliceNode":
            w = lm.sliceWidget(node.GetLayoutName()); view = w.sliceView() if w else None
        else:
            for i in range(lm.threeDViewCount):
                tw = lm.threeDWidget(i)
                if tw.mrmlViewNode().GetID() == node.GetID(): view = tw.threeDView()
        if view is not None:
            qt.QCursor.setPos(view.mapToGlobal(qt.QPoint(int(args.get("x", 0)), int(args.get("y", 0)))))
        qt.QTimer.singleShot(0, lambda: inode.ShowViewContextMenu(ed))   # defer: don't nest the loop inside the op handler
        return True
    if cmd == "setCameraPose" and node is not None:
        if "position" in args: node.SetPosition(*args["position"])
        if "focalPoint" in args: node.SetFocalPoint(*args["focalPoint"])
        if "viewUp" in args: node.SetViewUp(*args["viewUp"])
        node.Modified()
        return True
    if cmd == "setRoi" and node is not None:
        if "center" in args:
            try: node.SetCenterWorld(args["center"])
            except Exception: node.SetCenterWorld(*args["center"])  # noqa: BLE001
        if "size" in args:
            try: node.SetSizeWorld(args["size"])
            except Exception: node.SetSize(*args["size"])  # noqa: BLE001
        node.Modified()
        return True
    if cmd == "setControlPoint" and node is not None:
        # move one markup control point (SlicerLive drag -> Slicer). World (RAS) coords.
        idx = int(args.get("index", 0))
        pos = args.get("position")
        if pos is None or not (0 <= idx < node.GetNumberOfControlPoints()):
            return False
        try:
            node.SetNthControlPointPositionWorld(idx, pos[0], pos[1], pos[2])
        except Exception:  # noqa: BLE001
            import vtk
            node.SetNthControlPointPositionWorld(idx, vtk.vtkVector3d(pos[0], pos[1], pos[2]))
        return True
    return False


class MrsonRequestHandler(WebServerLib.BaseRequestHandler):
    def __init__(self, logMessage=None):
        self.logMessage = logMessage or (lambda *a: None)

    def canHandleRequest(self, uri: bytes, **_kwargs) -> float:
        return 0.6 if urllib.parse.urlparse(uri).path.startswith(b"/mrson") else 0.0

    def handleRequest(self, method: str, uri: bytes, requestBody: bytes, **_kwargs):
        parsed = urllib.parse.urlparse(uri)
        path = parsed.path.decode()
        try:
            if method == "GET" and path == "/mrson/scene.json":
                refresh = b"refresh" in (parsed.query or b"")
                with open(_ensure_serialized(force=refresh), "rb") as f:
                    return b"application/json", f.read()

            if method == "GET" and path == "/mrson/state.json":
                return b"application/json", json.dumps(_live_state()).encode()

            if method == "GET" and path == "/mrson/recs":
                # list finalized recordings via the tiny meta.json sidecar (avoids parsing the
                # event-heavy recording.json). Each: {name, hasContent, startedAt, endedAt}.
                root = "/tmp/mrson_rec"
                recs = []
                if os.path.isdir(root):
                    for name in sorted(os.listdir(root)):
                        d = os.path.join(root, name)
                        if not os.path.exists(os.path.join(d, "recording.json")):
                            continue
                        entry = {"name": name, "hasContent": True}
                        try:
                            with open(os.path.join(d, "meta.json")) as f:
                                m = json.load(f)
                            entry.update({"hasContent": bool(m.get("hasContent")),
                                          "startedAt": m.get("startedAt"), "endedAt": m.get("endedAt")})
                        except Exception:  # noqa: BLE001
                            pass
                        recs.append(entry)
                return b"application/json", json.dumps({"recordings": recs}).encode()

            if method == "GET" and path.startswith("/mrson/rec/"):
                # serve a file from a recording dir: /mrson/rec/<name>/<relpath> (json / png / blob)
                rest = path[len("/mrson/rec/"):]
                if ".." in rest:
                    return b"application/json", b'{"error":"bad path"}'
                fpath = os.path.join("/tmp/mrson_rec", *rest.split("/"))
                if not os.path.exists(fpath):
                    return b"application/json", b'{"error":"not found"}'
                ext = os.path.splitext(fpath)[1].lower()
                ctype = {".json": b"application/json", ".png": b"image/png",
                         ".jpg": b"image/jpeg", ".jpeg": b"image/jpeg"}.get(ext, b"application/octet-stream")
                with open(fpath, "rb") as f:
                    return ctype, f.read()

            if method == "GET" and path.startswith("/mrson/blobs/"):
                rest = path[len("/mrson/blobs/"):]
                if ".." in rest:
                    return b"application/json", b'{"error":"bad path"}'
                fpath = os.path.join(_live_dir(), "blobs", *rest.split("/"))
                if not os.path.exists(fpath):
                    return b"application/json", b'{"error":"not found"}'
                with open(fpath, "rb") as f:
                    return b"application/octet-stream", f.read()

            if method == "POST" and path == "/mrson/ops":
                return self._apply_ops(requestBody)

            return b"application/json", json.dumps({"error": f"no mrson route for {method} {path}"}).encode()
        except Exception:
            return b"application/json", json.dumps({"error": traceback.format_exc()}).encode()

    def _apply_ops(self, requestBody):
        """Phase 3: apply mrson ops (patch/cmd/del) to the MRML scene — SlicerLive drives Slicer.
        Instrumented: `applyMs` = time in the MRML apply loop, `eventsMs` = time in
        processEvents() (the render/observer fan-out), so the harness can separate transport
        cost from Slicer-side apply cost. Echoes `tag` (client seq) for round-trip correlation."""
        import time
        t0 = time.perf_counter()
        try:
            ops = json.loads(requestBody or b"[]")
        except (json.JSONDecodeError, ValueError) as e:
            return b"application/json", json.dumps({"error": f"parse: {e}"}).encode()
        if isinstance(ops, dict):
            ops = [ops]
        tag = None
        applied, errors = 0, []
        for op in ops:
            if tag is None and isinstance(op, dict) and "tag" in op:
                tag = op["tag"]
            try:
                if _apply_op(op):
                    applied += 1
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
        t1 = time.perf_counter()
        if applied:
            markDirty()
            slicer.app.processEvents()
        t2 = time.perf_counter()
        return b"application/json", json.dumps({
            "ok": not errors, "received": len(ops), "applied": applied, "errors": errors,
            "tag": tag, "applyMs": round((t1 - t0) * 1000, 3), "eventsMs": round((t2 - t1) * 1000, 3),
        }).encode()


def startMrsonServer(port=2131, logMessage=None):
    """Start the mrson server on `port`. Returns the WebServerLogic (stop with .stop()).

    logMessage defaults to a NO-OP: the core WebServerLogic logs every request/response, and each
    print() is a synchronous repaint of Slicer's Python console (main thread) — pure overhead we
    don't want competing with interaction. Pass a real logMessage to debug."""
    log = logMessage or (lambda *a: None)
    _STATE["serialized"] = False
    logic = WebServer.WebServerLogic(
        port=port, logMessage=log,
        enableSlicer=False, enableExec=False, enableStaticPages=False, enableDICOM=False,
        enableCORS=True, requestHandlers=[MrsonRequestHandler(logMessage=log)],
    )
    logic.start()
    print(f"\n  mrson server: http://localhost:{logic.port}/mrson/scene.json  (request logging off)\n")
    return logic
