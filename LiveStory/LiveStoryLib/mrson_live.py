"""mrson live channel — a WebSocket server (QTcpServer, RFC 6455) that streams mrson
change-notifications to a subscribed SlicerLive client, so a SlicerLive view mirrors the
live Slicer scene the way Slicer's own displayable managers do.

Event-driven, entirely on Slicer's main Qt thread (no threads): QTcpServer/QTcpSocket
signals + MRML observers both fire on the main loop, so observer -> WS-send is direct.

Protocol (JSON text frames):
  client -> server:  { "op":"subscribe", "types":[ "camera","image",
                       "volumeRenderingDisplay","scalarVolumeDisplay","transferFunction" ] }
  server -> client:  a snapshot of the subscribed node types as NodeAdded events (each
                     carrying the full mrson node — a per-node static declaration), then a
                     live stream of change notifications:
                       { "event":"NodeAdded", "sourceId", "nodeClass", "node":{...} }   (upsert)
                       { "event":"NodeRemoved", "sourceId" }
                       { "event":"CameraModified", "sourceId", position, focalPoint, viewUp, ... }
                       { "event":"Modified", "sourceId" }

So the JSON is either a static scene declaration (the snapshot) or an adaptive stream of
change notifications, per the LiveScene design.

Start:  from LiveStoryLib import mrson_live; mrson_live.startMrsonLive(2132)
"""
import base64
import hashlib
import json
import struct

import qt
import vtk
import slicer

from . import serialize_mrson as M
from . import mrson_server as HS


_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# vtkMRML class -> neutral mrson type (matches serialize_mrson)
_CLASS_TYPE = {
    "vtkMRMLScalarVolumeNode": "image",
    "vtkMRMLScalarVolumeDisplayNode": "scalarVolumeDisplay",
    "vtkMRMLVolumePropertyNode": "transferFunction",
    "vtkMRMLModelNode": "mesh",
    "vtkMRMLModelDisplayNode": "modelDisplay",
    "vtkMRMLCameraNode": "camera",
    "vtkMRMLViewNode": "view",
    "vtkMRMLSliceNode": "view",
}


def _mrson_type(node):
    cls = node.GetClassName()
    if "VolumeRenderingDisplayNode" in cls:
        return "volumeRenderingDisplay"
    if "MarkupsDisplayNode" in cls:
        return "markupDisplay"
    if cls.startswith("vtkMRMLMarkups"):
        return "markup"
    return _CLASS_TYPE.get(cls)


def _node_event(node):
    """The mrson event to push when `node` is modified (light — never re-writes zarr)."""
    t = _mrson_type(node)
    nid, cls = node.GetID(), node.GetClassName()
    if t == "camera":
        c = node.GetCamera()
        return {"event": "CameraModified", "sourceId": nid,
                "position": list(c.GetPosition()), "focalPoint": list(c.GetFocalPoint()),
                "viewUp": list(c.GetViewUp()), "viewAngle": c.GetViewAngle(),
                "parallelScale": c.GetParallelScale()}
    if t in ("scalarVolumeDisplay", "volumeRenderingDisplay", "modelDisplay", "markupDisplay"):
        mrn, _tf = M._display_node(node)
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": mrn}
    if t == "transferFunction":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._transfer_function_node(node)}
    if t == "markup":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._markup_node(node, nid)}
    return {"event": "Modified", "sourceId": nid}


# ---- RFC 6455 framing (text only) ------------------------------------------

def _accept_key(key):
    return base64.b64encode(hashlib.sha1((key + _WS_MAGIC).encode()).digest()).decode()


def _encode_text(msg):
    data = msg.encode("utf-8")
    n = len(data)
    hdr = bytearray([0x81])  # FIN + text opcode
    if n < 126:
        hdr.append(n)
    elif n < 65536:
        hdr.append(126); hdr += struct.pack(">H", n)
    else:
        hdr.append(127); hdr += struct.pack(">Q", n)
    return bytes(hdr) + data


def _decode_frames(buf):
    """Pop complete frames from bytearray `buf`; return list of (opcode, payload bytes)."""
    out = []
    while len(buf) >= 2:
        b1 = buf[1]
        opcode = buf[0] & 0x0F
        masked = b1 & 0x80
        ln = b1 & 0x7F
        idx = 2
        if ln == 126:
            if len(buf) < idx + 2:
                break
            ln = struct.unpack(">H", bytes(buf[idx:idx + 2]))[0]; idx += 2
        elif ln == 127:
            if len(buf) < idx + 8:
                break
            ln = struct.unpack(">Q", bytes(buf[idx:idx + 8]))[0]; idx += 8
        if masked:
            if len(buf) < idx + 4:
                break
            mask = buf[idx:idx + 4]; idx += 4
        if len(buf) < idx + ln:
            break
        payload = bytearray(buf[idx:idx + ln])
        if masked:
            for i in range(ln):
                payload[i] ^= mask[i % 4]
        del buf[:idx + ln]
        out.append((opcode, bytes(payload)))
    return out


# ---- one connected client --------------------------------------------------

class _WSClient:
    def __init__(self, socket, server):
        self.socket = socket
        self.server = server
        self.buf = bytearray()
        self.handshook = False
        self.types = set()
        self.tags = []          # (vtkObject, observerTag) to remove on disconnect
        socket.connect("readyRead()", self._onReadyRead)
        socket.connect("disconnected()", self._onDisconnected)

    # -- socket io --
    def _onReadyRead(self):
        self.buf += bytes(self.socket.readAll().data())
        if not self.handshook:
            self._tryHandshake()
        if self.handshook:
            for opcode, payload in _decode_frames(self.buf):
                if opcode == 0x8:            # close
                    self.socket.close(); return
                if opcode == 0x1:            # text
                    self._onMessage(payload.decode("utf-8", "replace"))

    def _tryHandshake(self):
        if b"\r\n\r\n" not in self.buf:
            return
        header, _, rest = bytes(self.buf).partition(b"\r\n\r\n")
        self.buf = bytearray(rest)
        key = None
        for line in header.decode("latin1").split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        if not key:
            self.socket.close(); return
        resp = ("HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Accept: " + _accept_key(key) + "\r\n\r\n")
        self.socket.write(qt.QByteArray(resp.encode()))
        self.handshook = True

    def send(self, obj):
        try:
            self.socket.write(qt.QByteArray(_encode_text(json.dumps(obj))))
        except Exception:
            pass

    def _onMessage(self, text):
        try:
            msg = json.loads(text)
        except Exception:
            return
        if msg.get("op") == "subscribe":
            self._subscribe(msg.get("types", []))

    def _onDisconnected(self):
        for obj, tag in self.tags:
            try:
                obj.RemoveObserver(tag)
            except Exception:
                pass
        self.tags = []
        self.server._drop(self)

    # -- subscription + observers --
    def _subscribe(self, types):
        self.types = set(types)
        # Snapshot: reuse the HTTP server's full serialization (writes zarr once), then send
        # every node whose neutral type is subscribed as a NodeAdded (per-node declaration).
        scenePath = HS._ensure_serialized()
        with open(scenePath) as f:
            doc = json.load(f)
        for nid, node in doc.get("nodes", {}).items():
            if node.get("type") in self.types:
                self.send({"event": "NodeAdded", "sourceId": nid,
                           "nodeClass": (node.get("source") or {}).get("mrmlClass"), "node": node})
        self.send({"event": "SnapshotComplete", "sourceId": ""})
        # Observe every current instance of the subscribed types + scene add/remove.
        scene = slicer.mrmlScene
        for i in range(scene.GetNumberOfNodes()):
            n = scene.GetNthNode(i)
            if _mrson_type(n) in self.types:
                self._observeInstance(n)
        self._tags_add(scene, scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, self._onSceneNodeAdded))
        self._tags_add(scene, scene.AddObserver(slicer.vtkMRMLScene.NodeRemovedEvent, self._onSceneNodeRemoved))
        self._tags_add(scene, scene.AddObserver(slicer.vtkMRMLScene.EndCloseEvent, self._onSceneClosed))

    def _onSceneClosed(self, _caller, _event):
        HS.markDirty()
        self.send({"event": "SceneClosed", "sourceId": ""})

    def _observeInstance(self, node):
        self._tags_add(node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onNodeModified))
        # markups fire a dedicated PointModifiedEvent on control-point drags
        if _mrson_type(node) == "markup" and hasattr(node, "PointModifiedEvent"):
            self._tags_add(node, node.AddObserver(node.PointModifiedEvent, self._onNodeModified))

    def _tags_add(self, obj, tag):
        self.tags.append((obj, tag))

    # -- observer callbacks (main thread) --
    def _onNodeModified(self, caller, _event):
        HS.markDirty()          # keep the HTTP snapshot fresh for the next reload/subscribe
        self.send(_node_event(caller))

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onSceneNodeAdded(self, _caller, _event, callData):
        node = callData
        if node is None or _mrson_type(node) not in self.types:
            return
        HS.markDirty()
        ev = _node_event(node)
        if ev.get("event") != "NodeAdded":     # image/mesh: re-serialize to get zarr + full node
            scenePath = HS._ensure_serialized(force=True)
            with open(scenePath) as f:
                doc = json.load(f)
            node_m = doc.get("nodes", {}).get(node.GetID())
            if node_m:
                ev = {"event": "NodeAdded", "sourceId": node.GetID(),
                      "nodeClass": node.GetClassName(), "node": node_m}
        self.send(ev)
        self._observeInstance(node)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onSceneNodeRemoved(self, _caller, _event, callData):
        node = callData
        if node is not None and _mrson_type(node) in self.types:
            self.send({"event": "NodeRemoved", "sourceId": node.GetID()})


# ---- server ----------------------------------------------------------------

class MrsonLiveServer:
    def __init__(self, port):
        self.port = port
        self.clients = []
        self.server = qt.QTcpServer()
        self.server.connect("newConnection()", self._onNewConnection)
        if not self.server.listen(qt.QHostAddress(qt.QHostAddress.Any), port):
            raise RuntimeError(f"mrson live: could not listen on {port}")

    def _onNewConnection(self):
        while self.server.hasPendingConnections():
            sock = self.server.nextPendingConnection()
            self.clients.append(_WSClient(sock, self))

    def _drop(self, client):
        if client in self.clients:
            self.clients.remove(client)

    def stop(self):
        self.server.close()
        self.clients = []


def startMrsonLive(port=2132):
    """Start the mrson live WebSocket server on `port`. Keep a reference (GC would kill it)."""
    logic = MrsonLiveServer(port)
    print(f"\n  mrson live (WebSocket): ws://localhost:{port}/\n")
    return logic
