"""mrson peer (WS A) for a ModuleServer -- the app side of LiveSync, with LiveScene as the authority.

Protocol (JSON text frames; superset of the LiveStory live channel so existing clients keep working):
  client -> server
    {"op":"subscribe", "types":[...], "localBulk":[...], "metadataOnly":false}
    {"op":"applyOps", "ops":[...], "tag":n}          -> {"event":"OpAck","tag":n,"seq":s,"applied":k,"errors":[...],
                                                          "created":{clientId: realId}}
    {"op":"reconcile", "nodes":{id: node, ...}}      -> the client's authoritative state after a reconnect:
                                                        every differing known property is applied here, then
                                                        {"event":"Reconciled","applied":k}
    {"op":"getNode", "id":...}                       -> full node (with bulk) for a metadataOnly subscriber
  server -> client
    NodeAdded/NodeRemoved/CameraModified/SnapshotComplete/SceneClosed (as before), every event stamped
    "seq" (monotonic per server run) so a client can tell what it has seen.

put: a client may create nodes ("put"). MRML assigns the real id; the OpAck's "created" map lets the client
alias its provisional id, and the NodeAdded that follows carries "clientId" for the same purpose.

Reuses LiveStoryLib for serialization, op application, observers and framing (imported, not copied).
ASCII only.
"""
import json
import time

import qt
import slicer
import vtk

from LiveStoryLib import mrson_live as ML
from LiveStoryLib import mrson_server as HS
from LiveStoryLib import serialize_mrson as M
from mrson_ws import WsServer

BULK_KEYS = ("zarr",)          # node keys that carry bulk references; stripped for metadataOnly subscribers
SKIP_RECONCILE = {"id", "type", "name", "source", "refs", "zarr", "dims", "voxelType", "comps", "ijkToRAS",
                  "kind", "layoutName", "orientation", "xyToRAS", "dimensions", "markupType", "linePoints", "corners",
                  "segments", "arrangementName", "cursorRAS", "cursorView", "contextMenuRequest"}


def _strip_bulk(node):
    n = dict(node)
    for k in BULK_KEYS:
        if k in n:
            n["bulk"] = {"available": True}
            del n[k]
    return n


class _Peer:
    """One connected client: subscription + MRML observers + coalesced outbound events."""

    def __init__(self, client, server):
        self.client = client
        self.server = server
        self.types = set()
        self.localBulk = set()
        self.metadataOnly = False
        self.tags = []
        self._out = ML._OutCoalescer(ML.FLUSH_MS, self._flush_out)
        self._lastCamSig = None
        self._segDirty = set()
        self._segTimer = qt.QTimer(); self._segTimer.setSingleShot(True); self._segTimer.setInterval(250)
        self._segTimer.connect("timeout()", self._flush_seg_edits)

    # -- outbound --
    def send(self, ev):
        ev = dict(ev); ev["seq"] = self.server.next_seq()
        if self.metadataOnly and ev.get("event") == "NodeAdded" and ev.get("node"):
            ev["node"] = _strip_bulk(ev["node"])
        self.client.send_text(json.dumps(ev))

    def _flush_out(self, batch):
        for ev in batch:
            self.send(ev)

    # -- inbound --
    def on_message(self, msg):
        op = msg.get("op")
        if op == "subscribe":
            self.subscribe(msg.get("types", []), msg.get("localBulk", []), bool(msg.get("metadataOnly")))
        elif op == "applyOps":
            self.apply_ops(msg.get("ops", []), msg.get("tag"))
        elif op == "reconcile":
            self.reconcile(msg.get("nodes") or {})
        elif op == "getNode":
            self.get_node(msg.get("id"))

    def subscribe(self, types, localBulk, metadataOnly):
        self.types = set(types); self.localBulk = set(localBulk or ()); self.metadataOnly = metadataOnly
        scenePath = HS._ensure_serialized(force=True)
        with open(scenePath) as f:
            doc = json.load(f)
        for nid, node in doc.get("nodes", {}).items():
            if node.get("type") in self.types:
                self.send({"event": "NodeAdded", "sourceId": nid, "nodeClass": (node.get("source") or {}).get("mrmlClass"), "node": node})
        self.send({"event": "SnapshotComplete", "sourceId": "", "authority": "replica"})
        scene = slicer.mrmlScene
        for i in range(scene.GetNumberOfNodes()):
            n = scene.GetNthNode(i)
            if ML._mrson_type(n) in self.types:
                self._observe(n)
        self._tag(scene, scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, self._on_scene_node_added))
        self._tag(scene, scene.AddObserver(slicer.vtkMRMLScene.NodeRemovedEvent, self._on_scene_node_removed))
        self._tag(scene, scene.AddObserver(slicer.vtkMRMLScene.EndCloseEvent, self._on_scene_closed))

    def apply_ops(self, ops, tag):
        t0 = time.perf_counter()
        applied, errors, created = 0, [], {}
        for o in ops:
            try:
                if o.get("op") == "put":
                    real = HS._apply_put(o)
                    if real:
                        created[o.get("id")] = real; applied += 1
                        self.server.aliases[real] = o.get("id")
                        # the scene's own NodeAddedEvent fired inside the create (before the alias was known):
                        # send the node again WITH clientId so every subscriber can collapse the provisional id
                        node = slicer.mrmlScene.GetNodeByID(real)
                        if node is not None and ML._mrson_type(node) in self.types:
                            ev = ML._node_event(node)
                            if ev.get("event") == "NodeAdded":
                                ev["clientId"] = o.get("id"); self.send(ev)
                elif HS._apply_op(o):
                    applied += 1
            except Exception as e:  # noqa: BLE001
                errors.append("%s: %r" % (o.get("op"), e))
        if applied:
            HS.markDirty()
        self.send({"event": "OpAck", "tag": tag, "received": len(ops), "applied": applied, "errors": errors,
                   "created": created, "applyMs": round((time.perf_counter() - t0) * 1000, 3)})

    def reconcile(self, nodes):
        """LiveScene wins after a reconnect: apply every differing, patchable property of every node the
        client holds. Bulk, geometry-defining and read-only keys are skipped; markup control points go
        through setControlPoint. Unknown keys are harmless (the applier returns False)."""
        applied = 0
        for nid, cn in nodes.items():
            node = slicer.mrmlScene.GetNodeByID(nid)
            if node is None:
                continue
            try:
                cur = self._serialize_one(node)
            except Exception:  # noqa: BLE001
                cur = None
            for k, v in cn.items():
                if k in SKIP_RECONCILE or not isinstance(v, (int, float, bool, list, str)):
                    continue
                if k == "controlPoints":
                    for i, cp in enumerate(v):
                        pos = cp.get("position") if isinstance(cp, dict) else None
                        if pos and HS._apply_cmd(node, "setControlPoint", {"index": i, "position": pos}):
                            applied += 1
                    continue
                if cur is not None and k in cur and cur[k] == v:
                    continue
                try:
                    if HS._apply_patch(node, "#/" + k, v):
                        applied += 1
                except Exception:  # noqa: BLE001
                    pass
        if applied:
            HS.markDirty()
        self.send({"event": "Reconciled", "applied": applied})

    def _serialize_one(self, node):
        ev = ML._node_event(node)
        return ev.get("node") if ev.get("event") == "NodeAdded" else None

    def get_node(self, nid):
        scenePath = HS._ensure_serialized(force=True)
        with open(scenePath) as f:
            doc = json.load(f)
        node = doc.get("nodes", {}).get(nid)
        if node:
            ev = {"event": "NodeAdded", "sourceId": nid, "nodeClass": (node.get("source") or {}).get("mrmlClass"), "node": node, "seq": self.server.next_seq()}
            self.client.send_text(json.dumps(ev))     # bypass the metadataOnly strip: this IS the bulk request

    # -- observers (same discipline as LiveStoryLib.mrson_live) --
    def _tag(self, obj, tag):
        self.tags.append((obj, tag))

    def _observe(self, node):
        self._tag(node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, self._on_node_modified))
        cls = node.GetClassName()
        t = ML._mrson_type(node)
        if cls == "vtkMRMLInteractionNode":
            for evname in ("InteractionModeChangedEvent", "InteractionModePersistenceChangedEvent"):
                if hasattr(node, evname):
                    self._tag(node, node.AddObserver(getattr(node, evname), self._on_node_modified))
        if t == "markup":
            if hasattr(node, "PointModifiedEvent"):
                self._tag(node, node.AddObserver(node.PointModifiedEvent, self._on_node_modified))
            dn = node.GetDisplayNode()
            if dn is not None:
                self._tag(dn, dn.AddObserver(vtk.vtkCommand.ModifiedEvent, lambda _c, _e, m=node: self._on_node_modified(m, _e)))
        if cls == "vtkMRMLSegmentationNode":
            dn = node.GetDisplayNode()
            if dn is not None:
                self._tag(dn, dn.AddObserver(vtk.vtkCommand.ModifiedEvent, self._on_node_modified))
            if "segmentation" not in self.localBulk:
                try:
                    import vtkSegmentationCorePython as vsc
                    segmentation = node.GetSegmentation()
                    self._tag(segmentation, segmentation.AddObserver(vsc.vtkSegmentation.SourceRepresentationModified, lambda _c, _e, m=node: self._on_seg_edited(m)))
                except Exception as e:  # noqa: BLE001
                    print("mrson_peer: seg labelmap observer failed: %s" % e)

    def _on_seg_edited(self, node):
        self._segDirty.add(node.GetID())
        if not self._segTimer.isActive():
            self._segTimer.start()

    def _flush_seg_edits(self):
        import os
        for segid in list(self._segDirty):
            seg = slicer.mrmlScene.GetNodeByID(segid)
            if seg is None:
                continue
            try:
                node_m = M._segmentation_node(seg, segid, os.path.join(HS._live_dir(), "blobs"))
                HS.markDirty()
                self._out.update(segid, {"event": "NodeAdded", "sourceId": segid, "nodeClass": seg.GetClassName(), "node": node_m})
            except Exception as e:  # noqa: BLE001
                print("mrson_peer: seg re-serialize failed: %s" % e)
        self._segDirty.clear()

    def _on_node_modified(self, caller, _event):
        HS.markDirty()
        ev = ML._node_event(caller)
        if ev.get("event") == "CameraModified":
            sig = (tuple(ev.get("position") or ()), tuple(ev.get("focalPoint") or ()), tuple(ev.get("viewUp") or ()), ev.get("viewAngle"), ev.get("parallelScale"))
            if sig == self._lastCamSig:
                return
            self._lastCamSig = sig
        self._out.update(ev.get("sourceId"), ev)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _on_scene_node_added(self, _caller, _event, callData):
        node = callData
        if node is None or ML._mrson_type(node) not in self.types:
            return
        HS.markDirty()
        ev = ML._node_event(node)
        if ev.get("event") != "NodeAdded":
            scenePath = HS._ensure_serialized(force=True)
            with open(scenePath) as f:
                doc = json.load(f)
            node_m = doc.get("nodes", {}).get(node.GetID())
            if node_m:
                ev = {"event": "NodeAdded", "sourceId": node.GetID(), "nodeClass": node.GetClassName(), "node": node_m}
        alias = self.server.aliases.get(node.GetID())
        if alias:
            ev["clientId"] = alias
        self._out.flush_now()
        self.send(ev)
        self._observe(node)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _on_scene_node_removed(self, _caller, _event, callData):
        node = callData
        if node is not None and ML._mrson_type(node) in self.types:
            self._out.flush_now()
            self.send({"event": "NodeRemoved", "sourceId": node.GetID()})

    def _on_scene_closed(self, _caller, _event):
        HS.markDirty()
        self._out.flush_now()
        self.send({"event": "SceneClosed", "sourceId": ""})

    def teardown(self):
        for obj, tag in list(self.tags):
            try: obj.RemoveObserver(tag)
            except Exception: pass  # noqa: BLE001
        self.tags = []
        try: self._segTimer.stop(); self._out.clear()
        except Exception: pass  # noqa: BLE001


class MrsonPeerServer:
    def __init__(self, port):
        self.port = port
        self.seq = 0
        self.aliases = {}          # real MRML id -> client's provisional id (from put)
        self.peers = {}            # WsClient -> _Peer
        self.server = WsServer(port, on_message=self._on_message, on_close=self._on_close)

    def next_seq(self):
        self.seq += 1
        return self.seq

    def _on_message(self, client, text):
        try:
            msg = json.loads(text)
        except Exception:  # noqa: BLE001
            return
        peer = self.peers.get(client)
        if peer is None:
            peer = self.peers[client] = _Peer(client, self)
        try:
            peer.on_message(msg)
        except Exception as e:  # noqa: BLE001
            client.send_text(json.dumps({"event": "Error", "op": msg.get("op"), "error": repr(e)}))

    def _on_close(self, client):
        peer = self.peers.pop(client, None)
        if peer is not None:
            peer.teardown()

    def stop(self):
        for p in list(self.peers.values()):
            p.teardown()
        self.peers = {}
        self.server.stop()


def startMrsonPeer(port=2132):
    logic = MrsonPeerServer(port)
    print("\n  mrson peer (WebSocket): ws://localhost:%d/\n" % port, flush=True)
    return logic
