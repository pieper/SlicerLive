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
    return False   # 'put' (create/replace whole node) not yet implemented


def _apply_patch(node, path, value):
    """patch a single property. path is a URI-fragment JSON pointer, e.g. '#/position'."""
    if node is None:
        return False
    key = [p for p in path.lstrip("#").strip("/").split("/") if p]
    k0 = key[0] if key else ""
    cls = node.GetClassName()
    if "CameraNode" in cls:
        if k0 == "position": node.SetPosition(*value)
        elif k0 == "focalPoint": node.SetFocalPoint(*value)
        elif k0 == "viewUp": node.SetViewUp(*value)
        elif k0 == "viewAngle": node.GetCamera().SetViewAngle(value)
        else: return False
        node.Modified()
        return True
    if cls == "vtkMRMLScalarVolumeDisplayNode":
        if k0 == "window": node.SetWindow(float(value))
        elif k0 == "level": node.SetLevel(float(value))
        else: return False
        return True
    if "DisplayNode" in cls and k0 in ("visible", "visibility"):
        node.SetVisibility(bool(value))
        return True
    return False


def _apply_cmd(node, cmd, args):
    if cmd == "setCameraPose" and node is not None:
        if "position" in args: node.SetPosition(*args["position"])
        if "focalPoint" in args: node.SetFocalPoint(*args["focalPoint"])
        if "viewUp" in args: node.SetViewUp(*args["viewUp"])
        node.Modified()
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
        """Phase 3: apply mrson ops (patch/cmd/del) to the MRML scene — SlicerLive drives Slicer."""
        try:
            ops = json.loads(requestBody or b"[]")
        except (json.JSONDecodeError, ValueError) as e:
            return b"application/json", json.dumps({"error": f"parse: {e}"}).encode()
        if isinstance(ops, dict):
            ops = [ops]
        applied, errors = 0, []
        for op in ops:
            try:
                if _apply_op(op):
                    applied += 1
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
        if applied:
            markDirty()
            slicer.app.processEvents()
        return b"application/json", json.dumps({"ok": not errors, "received": len(ops), "applied": applied, "errors": errors}).encode()


def startMrsonServer(port=2131, logMessage=None):
    """Start the mrson server on `port`. Returns the WebServerLogic (stop with .stop())."""
    log = logMessage or (lambda *a: print("mrson:", *a))
    _STATE["serialized"] = False
    logic = WebServer.WebServerLogic(
        port=port, logMessage=log,
        enableSlicer=False, enableExec=False, enableStaticPages=False, enableDICOM=False,
        enableCORS=True, requestHandlers=[MrsonRequestHandler(logMessage=log)],
    )
    logic.start()
    print(f"\n  mrson server: http://localhost:{logic.port}/mrson/scene.json\n")
    return logic
