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
import os
import struct

import qt
import vtk
import slicer

from . import serialize_mrson as M
from . import mrson_server as HS
from .segedit_capture import SegEditCapture


_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# inbound rate limit: coalesce per-node Modified echoes to at most one per FLUSH_MS (~30Hz). Small
# enough to look continuous, large enough that a kHz source can't saturate the wire or the client.
FLUSH_MS = 33

# --- optional profiling of the Slicer-side send path (measure a REAL drag) ---------------------
# Off by default (zero cost). startProfile() -> drag in Slicer -> dragStats() reports per-event
# serialize/send time, event rate, inter-event gaps, and outbound bytesToWrite, from a bounded ring
# buffer (no console printing — printing would itself repaint the main thread and skew the result).
_COALESCE = {"on": True}   # A/B switch: outbound coalescer vs immediate send (camera dedup stays on)


def setCoalesce(v):
    _COALESCE["on"] = bool(v)
    return "coalesce=%s (camera dedup always on)" % _COALESCE["on"]


def _new_prof():
    return {"on": False, "produced": {}, "camDropped": 0, "sent": 0, "flushes": 0,
            "btwWire": 0, "inOps": 0, "t0": None, "tN": None}


_prof = _new_prof()


def startProfile():
    global _prof
    on_flag = {"on": True}
    _prof = _new_prof(); _prof.update(on_flag)
    return "mrson profiling ON (drag a markup in Slicer, then call dragStats())"


def stopProfile():
    _prof["on"] = False
    return "mrson profiling OFF"


def dragStats():
    produced = dict(_prof["produced"])
    total_prod = sum(produced.values())
    dur = (_prof["tN"] - _prof["t0"]) if (_prof["t0"] and _prof["tN"]) else 0.0
    return {
        # PRODUCED = raw Modified events entering the observer (after camera-pose dedup drops).
        "produced": produced, "producedTotal": total_prod,
        "cameraDropped": _prof["camDropped"],           # redundant camera events killed at the source
        # SENT = what actually went on the wire after coalescing (latest-wins per node, ~30Hz).
        "sent": _prof["sent"], "flushes": _prof["flushes"],
        "durSec": round(dur, 2),
        "producedPerSec": round(total_prod / dur, 0) if dur > 0 else -1,
        "sentPerSec": round(_prof["sent"] / dur, 0) if dur > 0 else -1,
        "coalesceRatio": round(total_prod / _prof["sent"], 1) if _prof["sent"] else None,
        "bytesToWriteMaxAtFlush": _prof["btwWire"],      # should stay small now (was 7513 backed up)
        "inboundOps": _prof["inOps"],
    }

# vtkMRML class -> neutral mrson type (matches serialize_mrson)
_CLASS_TYPE = {
    "vtkMRMLScalarVolumeNode": "image",
    "vtkMRMLSegmentationNode": "segmentation",
    "vtkMRMLScalarVolumeDisplayNode": "scalarVolumeDisplay",
    "vtkMRMLVolumePropertyNode": "transferFunction",
    "vtkMRMLModelNode": "mesh",
    "vtkMRMLModelDisplayNode": "modelDisplay",
    "vtkMRMLCameraNode": "camera",
    "vtkMRMLViewNode": "view",
    "vtkMRMLSliceNode": "view",
    "vtkMRMLLayoutNode": "layout",
    "vtkMRMLCrosshairNode": "crosshair",
    "vtkMRMLInteractionNode": "interaction",
    "vtkMRMLSelectionNode": "selection",
    "vtkMRMLSliceCompositeNode": "sliceComposite",
    "vtkMRMLLabelMapVolumeNode": "image",
    "vtkMRMLLabelMapVolumeDisplayNode": "labelMapDisplay",
    "vtkMRMLColorTableNode": "colorTable",
    "vtkMRMLProceduralColorNode": "colorTable",
}


def _mrson_type(node):
    cls = node.GetClassName()
    if "VolumeRenderingDisplayNode" in cls:
        return "volumeRenderingDisplay"
    if cls.startswith("vtkMRMLMarkups"):
        # markup display nodes are vtkMRMLMarkups<Type>DisplayNode (e.g.
        # vtkMRMLMarkupsFiducialDisplayNode) AND the base vtkMRMLMarkupsDisplayNode.
        # They start with vtkMRMLMarkups too, so classify by DisplayNode to avoid
        # serializing a display node as a control-point markup (GetNumberOfControlPoints crash).
        return "markupDisplay" if "DisplayNode" in cls else "markup"
    return _CLASS_TYPE.get(cls)


def _seg_for_display(dn):
    """The segmentation node whose display node is `dn` (reverse of GetDisplayNode)."""
    for seg in slicer.util.getNodesByClass("vtkMRMLSegmentationNode"):
        if seg.GetDisplayNodeID() == dn.GetID():
            return seg
    return None


def _node_event(node):
    """The mrson event to push when `node` is modified (light — never re-writes zarr)."""
    t = _mrson_type(node)
    nid, cls = node.GetID(), node.GetClassName()
    # segmentation (node OR its display node): a light display-only event (opacity/visibility/
    # colour) — the client updates fill/outline + 3D field in place, re-baking only if needed.
    if cls == "vtkMRMLSegmentationNode":
        return M._segmentation_display_event(node)
    if "SegmentationDisplayNode" in cls:
        seg = _seg_for_display(node)
        return M._segmentation_display_event(seg) if seg is not None else {"event": "Modified", "sourceId": nid}
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
    if t == "layout":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._layout_node(node, nid)}
    if t == "sliceComposite":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._slice_composite_node(node, nid)}
    if t == "labelMapDisplay":
        mrn, _tf = M._display_node(node)
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": mrn}
    if t == "colorTable":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._color_table_node(node, nid)}
    if t == "crosshair":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._crosshair_node(node, nid)}
    if t == "interaction":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._interaction_node(node, nid)}
    if t == "selection":
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": M._selection_node(node, nid)}
    if t == "view":                              # slice scroll / 3d view changes
        vn = M._slice_view_node(node, nid) if cls == "vtkMRMLSliceNode" else M._3d_view_node(node, nid)
        return {"event": "NodeAdded", "sourceId": nid, "nodeClass": cls, "node": vn}
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


# ---- outbound coalescer (server half of impedance matching) -----------------

class _OutCoalescer:
    """Rate-limit the Slicer->client event stream to one message per node per FLUSH_MS, latest-wins
    (the server analogue of the client's Coalescer). A native Slicer drag fires camera + markup
    Modified in sub-millisecond bursts every render frame; sending each immediately backs up the
    socket (measured: bytesToWrite climbing to 7.5KB with multi-second stalls). Coalescing collapses
    each burst to one send per node so the client always drains — the same discipline the inbound
    (client->Slicer) ops already use, which is why dragging in SlicerLive never stutters.

    LEADING-EDGE INLINE: when >= interval has elapsed, update() flushes immediately (driven by the
    incoming events, NOT a timer) so the client sees updates promptly and the cadence can't STARVE
    during a drag (the earlier immediate-send worked around a starvable timer; this doesn't rely on
    one). A QTimer only covers the TRAILING flush after events stop, so the final pose always lands."""

    def __init__(self, interval_ms, flush):
        import time
        self._interval = interval_ms / 1000.0
        self._flush = flush              # flush(list_of_events)
        self._pending = {}               # sourceId -> latest event
        self._last = -1e18
        self._clock = time.perf_counter
        self._timer = qt.QTimer()
        self._timer.setSingleShot(True)
        self._timer.connect("timeout()", self._onTimer)

    def update(self, key, value):
        self._pending[key] = value       # latest wins
        now = self._clock()
        if now - self._last >= self._interval:
            self._doFlush()              # leading edge — no timer dependency
        elif not self._timer.isActive():
            wait = int(max(1, (self._interval - (now - self._last)) * 1000))
            self._timer.start(wait)      # trailing flush only

    def _onTimer(self):
        self._doFlush()

    def _doFlush(self):
        self._timer.stop()
        if not self._pending:
            return
        self._last = self._clock()
        batch = list(self._pending.values())
        self._pending = {}
        self._flush(batch)

    def flush_now(self):
        """Drain pending in order before an out-of-band structural send (add/remove/close)."""
        self._doFlush()

    def clear(self):
        self._timer.stop()
        self._pending = {}


# ---- one connected client --------------------------------------------------

class _WSClient:
    def __init__(self, socket, server):
        self.socket = socket
        self.server = server
        self.buf = bytearray()
        self.handshook = False
        self.types = set()
        self.localBulk = set()  # node types whose bulk UPDATES the consumer reproduces locally (skip re-stream)
        self.tags = []          # (vtkObject, observerTag) to remove on disconnect
        self._out = _OutCoalescer(FLUSH_MS, self._flushOut)   # rate-limit Slicer->client live events
        self._lastCamSig = None                               # camera pose dedup (skip unchanged)
        # segmentation labelmap edits fire vtkSegmentation.SourceRepresentationModified (not Modified);
        # debounce a stroke's burst into one re-serialize so live painting mirrors to the client.
        self._segDirty = set()
        self._segTimer = qt.QTimer()
        self._segTimer.setSingleShot(True)
        self._segTimer.setInterval(250)
        self._segTimer.connect("timeout()", self._flushSegEdits)
        # seged INTENT channel: when a client subscribes to "segEdit", stream one SegEdit op per
        # committed Segment-Editor stroke (raw human intent) so the WebGPU SegEditDriver reproduces it.
        self._segEditCap = None
        socket.connect("readyRead()", self._onReadyRead)
        socket.connect("disconnected()", self._onDisconnected)

    def _onSegEdited(self, node):
        self._segDirty.add(node.GetID())
        if not self._segTimer.isActive():
            self._segTimer.start()

    def _flushSegEdits(self):
        """Re-serialize each edited segmentation (merged labelmap → content-addressed zarr into the live
        blob dir; unchanged chunks dedup) and send it as a NodeAdded upsert, so painting in Slicer mirrors
        live to the client (the SegmentationDisplayableManager re-fetches on the zarr-signature change)."""
        for segid in list(self._segDirty):
            seg = slicer.mrmlScene.GetNodeByID(segid)
            if seg is None:
                continue
            try:
                node_m = M._segmentation_node(seg, segid, os.path.join(HS._live_dir(), "blobs"))
                HS.markDirty()
                self._out.update(segid, {"event": "NodeAdded", "sourceId": segid, "nodeClass": seg.GetClassName(), "node": node_m})
            except Exception as e:  # noqa: BLE001
                print("mrson_live: seg re-serialize failed: %s" % e)
        self._segDirty.clear()

    def _flushOut(self, batch):
        if _prof["on"]:
            _prof["flushes"] += 1; _prof["sent"] += len(batch)
            try: _prof["btwWire"] = max(_prof["btwWire"], self.socket.bytesToWrite())
            except Exception: pass  # noqa: BLE001
        for ev in batch:
            self.send(ev)

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
        op = msg.get("op")
        if op == "subscribe":
            self._subscribe(msg.get("types", []), msg.get("localBulk", []))
        elif op == "applyOps":
            self._applyOps(msg.get("ops", []), msg.get("tag"))

    def _applyOps(self, ops, tag):
        """Apply SlicerLive -> Slicer ops over the SAME WebSocket the events stream on: one
        ordered, low-overhead control channel (no per-op HTTP, no CORS, no Content-Length quirks).
        Applying fires the MRML observers synchronously, so the echo (and every other subscriber's
        echo) goes out before the OpAck.

        NO processEvents() here: this runs inside the socket readyRead handler (already on the event
        loop). Forcing a re-entrant processEvents() per op made Slicer render synchronously on every
        one of a ~30Hz browser-driven op stream — a classic Qt/VTK jank source. Applying the op marks
        the views dirty; Slicer renders them on its own render scheduler at its natural rate (and a
        burst of ops decoded in one readyRead collapses to a single render). Smoother, event-driven."""
        import time
        if _prof["on"]:
            _prof["inOps"] += len(ops)
        t0 = time.perf_counter()
        applied = 0
        for o in ops:
            try:
                if HS._apply_op(o):
                    applied += 1
            except Exception:  # noqa: BLE001
                pass
        if applied:
            HS.markDirty()
        self.send({"event": "OpAck", "tag": tag, "received": len(ops), "applied": applied,
                   "applyMs": round((time.perf_counter() - t0) * 1000, 3), "eventsMs": 0})

    def teardown(self):
        """Remove MRML observers and close the socket (so a restart doesn't leak clients/observers)."""
        for obj, tag in list(self.tags):
            try:
                obj.RemoveObserver(tag)
            except Exception:  # noqa: BLE001
                pass
        self.tags = []
        if self._segEditCap is not None:
            try:
                self._segEditCap.stop()
            except Exception:  # noqa: BLE001
                pass
            self._segEditCap = None
        try:
            self._segTimer.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._out.clear()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.socket.close()
        except Exception:  # noqa: BLE001
            pass

    def _onDisconnected(self):
        self.teardown()
        self.server._drop(self)

    # -- subscription + observers --
    def _subscribe(self, types, localBulk=()):
        self.types = set(types)
        # localBulk: node types whose BULK-DATA UPDATES the consumer will reproduce LOCALLY (it has the
        # same deterministic op/filter), so the writer suppresses re-streaming their bulk on change. The
        # INITIAL snapshot still carries the bulk (geometry + starting data); only per-change re-serialize
        # is skipped. General mechanism (not seged-specific): e.g. a consumer that recomputes a filter or
        # re-fetches a deterministic server result needn't be sent the heavy result. (Dual, TODO: a
        # WRITER-declared bulk-by-reference mode — stream a URI, e.g. an IDC bucket, instead of inline.)
        self.localBulk = set(localBulk or ())
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
        # seged: stream committed Segment-Editor strokes as SegEdit intents (sent DIRECT, not coalesced —
        # each committed stroke is a discrete event that must not be dropped by latest-wins).
        if "segEdit" in self.types and self._segEditCap is None:
            self._segEditCap = SegEditCapture(sink=lambda ev: self.send(ev)).start()

    def _onSceneClosed(self, _caller, _event):
        HS.markDirty()
        self._out.flush_now()          # drain pending live events before the structural event
        self.send({"event": "SceneClosed", "sourceId": ""})

    def _observeInstance(self, node):
        self._tags_add(node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onNodeModified))
        if node.GetClassName() == "vtkMRMLInteractionNode":
            for evname in ("InteractionModeChangedEvent", "InteractionModePersistenceChangedEvent"):
                if hasattr(node, evname):
                    self._tags_add(node, node.AddObserver(getattr(node, evname), self._onNodeModified))
        # markups fire a dedicated PointModifiedEvent on control-point drags
        if _mrson_type(node) == "markup" and hasattr(node, "PointModifiedEvent"):
            self._tags_add(node, node.AddObserver(node.PointModifiedEvent, self._onNodeModified))
        # markup display props (visibility/colour/glyphScale) live on the display node; mrson folds
        # them onto the markup node, so re-send the MARKUP node when its display node changes.
        if _mrson_type(node) == "markup":
            dn = node.GetDisplayNode()
            if dn is not None:
                self._tags_add(dn, dn.AddObserver(vtk.vtkCommand.ModifiedEvent, lambda _c, _e, m=node: self._onNodeModified(m, _e)))
        # segmentation: 2D fill/outline/visibility live on the display node — observe it too
        if node.GetClassName() == "vtkMRMLSegmentationNode":
            dn = node.GetDisplayNode()
            if dn is not None:
                self._tags_add(dn, dn.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onNodeModified))
            # LABELMAP edits (paint/threshold/…) → SourceRepresentationModified on the vtkSegmentation.
            # SKIP when the consumer declared local authority over segmentation bulk (localBulk): it
            # reproduces edits itself (e.g. seged via SegEdit intents), so re-streaming the heavy labelmap
            # is wasted work + wire contention. The initial snapshot already gave it the geometry + start.
            if "segmentation" not in self.localBulk:
                try:
                    import vtkSegmentationCorePython as vsc
                    segmentation = node.GetSegmentation()
                    self._tags_add(segmentation, segmentation.AddObserver(
                        vsc.vtkSegmentation.SourceRepresentationModified, lambda _c, _e, m=node: self._onSegEdited(m)))
                except Exception as e:  # noqa: BLE001
                    print("mrson_live: seg labelmap observer failed: %s" % e)

    def _tags_add(self, obj, tag):
        self.tags.append((obj, tag))

    # -- observer callbacks (main thread) --
    def _onNodeModified(self, caller, _event):
        HS.markDirty()          # keep the HTTP snapshot fresh for the next reload/subscribe
        ev = _node_event(caller)
        # Camera dedup: a native markup drag continuously changes scene bounds, so the renderer
        # touches the camera every frame -> ModifiedEvent fires with an UNCHANGED pose (only the
        # clip range moved). Those carry nothing the client can use -> drop them at the source.
        if ev.get("event") == "CameraModified":
            sig = (tuple(ev.get("position") or ()), tuple(ev.get("focalPoint") or ()),
                   tuple(ev.get("viewUp") or ()), ev.get("viewAngle"), ev.get("parallelScale"))
            if sig == self._lastCamSig:
                if _prof["on"]:
                    _prof["camDropped"] += 1
                return
            self._lastCamSig = sig
        if _prof["on"]:
            import time
            now = time.perf_counter()
            if _prof["t0"] is None:
                _prof["t0"] = now
            _prof["tN"] = now
            _prof["produced"][caller.GetClassName()] = _prof["produced"].get(caller.GetClassName(), 0) + 1
        # Coalesce onto the wire (latest-wins per node, ~30Hz) instead of sending every burst event.
        # Toggleable so we can A/B whether the coalescer (vs immediate send) is the slowness. Camera
        # dedup above is unconditional (unambiguously correct).
        if _COALESCE["on"]:
            self._out.update(ev.get("sourceId"), ev)
        else:
            if _prof["on"]:
                _prof["sent"] += 1
            self.send(ev)

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
        self._out.flush_now()          # keep structural events ordered w.r.t. coalesced live events
        self.send(ev)
        self._observeInstance(node)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onSceneNodeRemoved(self, _caller, _event, callData):
        node = callData
        if node is not None and _mrson_type(node) in self.types:
            self._out.flush_now()
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
        # tear DOWN every client (remove MRML observers, stop its flush timer, close the socket) so
        # a restart doesn't leave leaked _WSClient objects with dangling observers/timers.
        for c in list(self.clients):
            try:
                c.teardown()
            except Exception:  # noqa: BLE001
                pass
        self.clients = []
        self.server.close()


def deepClean():
    """Sweep EVERY _WSClient still alive (including ones leaked by earlier restarts) and fully tear
    it down — removes any dangling MRML observers and stops any surviving flush timer. Safe to run
    before a fresh startMrsonLive(). Returns how many were cleaned + observers removed."""
    import gc
    cleaned = removed = 0
    for c in [o for o in gc.get_objects() if type(o).__name__ == "_WSClient"]:
        try:
            removed += len(getattr(c, "tags", []))
            c.teardown()
            cleaned += 1
        except Exception:  # noqa: BLE001
            pass
    gc.collect()
    return {"clients_cleaned": cleaned, "observers_removed": removed}


def startMrsonLive(port=2132):
    """Start the mrson live WebSocket server on `port`. Keep a reference (GC would kill it)."""
    logic = MrsonLiveServer(port)
    print(f"\n  mrson live (WebSocket): ws://localhost:{port}/\n")
    return logic
