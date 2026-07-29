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
        """Phase 3: apply mrson ops (put/patch/del/cmd) to the MRML scene. Stub for now."""
        try:
            ops = json.loads(requestBody or b"[]")
        except (json.JSONDecodeError, ValueError) as e:
            return b"application/json", json.dumps({"error": f"parse: {e}"}).encode()
        if isinstance(ops, dict):
            ops = [ops]
        # TODO(phase3): dispatch put/patch/del/cmd -> MRML mutations.
        return b"application/json", json.dumps({"ok": True, "received": len(ops), "applied": 0}).encode()


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
