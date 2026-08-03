"""mrson recorder — records the live Slicer session to disk as an mrson stream, so it can be
replayed / scrubbed in SlicerLive. The authoritative, Slicer-side counterpart of the browser
SceneRecorder (render/recorder.ts): it observes the SAME MRML change stream the live WebSocket
server emits (reusing mrson_live._node_event) and persists it as the video-codec model —

  KEYFRAMES  (periodic full mrson scene serialization, via serialize_mrson — picks up bulk data
             like an edited labelmap; blobs are content-addressed so unchanged CT chunks dedup)
  + DELTAS   (each MRML change as an mrson event: NodeAdded / NodeRemoved / CameraModified /
             SegmentationDisplayModified — appended to events.jsonl as it happens)
  + THUMBS   (periodic screenshots of Slicer's ACTUAL layout — the 4-up — via the ScreenCapture
             module, which renders the VTK views correctly, unlike a plain Qt widget grab)
  + MARKS    (LiveStory / semantic-step markers)

CONTINUOUS across sessions: one recorder ROLLS OVER on each mrmlScene.Clear(). StartCloseEvent
writes a final keyframe (scene still populated) and FINALIZES recording.json for the just-worked
session (so it's ready before the browser even hears SceneClosed); EndCloseEvent begins a fresh
session dir for whatever comes next. So you work → close → that session is available for replay,
work again → close → the next one is available, without restarting anything.

Output per session:  /tmp/mrson_rec/rec-<ms>/
    recording.json        # manifest: startedAt, keyframes[], events[], thumbs[], marks[]
    events.jsonl          # the streaming delta log (same content, appended live)
    key0.mrson.json ...   # full-scene keyframes
    blobs/                # content-addressed zarr chunks
    thumbs/<ms>.png       # 4-up screenshots

Start:  from LiveStoryLib import mrson_recorder; r = mrson_recorder.startRecorder()
"""
import json
import os
import time

import qt
import vtk
import slicer

from . import serialize_mrson as M
from . import mrson_live as L
from . import mrson_server as HS

REC_ROOT = "/tmp/mrson_rec"

# neutral mrson types worth recording (everything serialize_mrson / _node_event handle)
RECORDED_TYPES = {
    "image", "segmentation", "markup", "camera", "view", "layout", "mesh",
    "scalarVolumeDisplay", "volumeRenderingDisplay", "modelDisplay", "markupDisplay",
    "transferFunction",
}


def _now_ms():
    return int(time.time() * 1000)


class MrsonRecorder:
    def __init__(self, root=REC_ROOT, thumb_ms=1500, keyframe_ms=20000):
        self.root = root
        self._thumb_ms = thumb_ms
        self._keyframe_ms = keyframe_ms
        self.scene_tags = []      # persistent scene-level observers (survive session rollover)
        self.node_tags = []       # per-session node observers (removed on finalize)
        self.lastFinalized = None
        self._session = False     # is a session currently open?
        try:
            import ScreenCapture
            self._screen = ScreenCapture.ScreenCaptureLogic()
        except Exception as e:  # noqa: BLE001
            self._screen = None
            print("mrson_recorder: ScreenCapture unavailable (%s); no thumbnails" % e)
        self._timer = qt.QTimer()
        self._timer.setInterval(self._thumb_ms)
        self._timer.connect("timeout()", self._onTick)

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self):
        scene = slicer.mrmlScene
        self._sceneTag(scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, self._onNodeAdded))
        self._sceneTag(scene.AddObserver(slicer.vtkMRMLScene.NodeRemovedEvent, self._onNodeRemoved))
        self._sceneTag(scene.AddObserver(slicer.vtkMRMLScene.StartCloseEvent, self._onStartClose))
        self._sceneTag(scene.AddObserver(slicer.vtkMRMLScene.EndCloseEvent, self._onEndClose))
        self._beginSession()
        print("\n  mrson recorder: %s  (recording; close the scene in Slicer to finalize + replay)\n" % self.dir)
        return self

    def _beginSession(self):
        self.startedAt = _now_ms()
        self.dir = os.path.join(self.root, "rec-%d" % self.startedAt)
        os.makedirs(os.path.join(self.dir, "thumbs"), exist_ok=True)
        self.events = []
        self.keyframes = []
        self.thumbs = []
        self.marks = []
        self._lastCamSig = None
        self._nkey = 0
        self._finalized = False
        self._last_key_t = -1e18
        self._evfile = open(os.path.join(self.dir, "events.jsonl"), "a")
        self._session = True
        self.keyframe()                                  # seed keyframe = current full scene
        for i in range(slicer.mrmlScene.GetNumberOfNodes()):
            n = slicer.mrmlScene.GetNthNode(i)
            if L._mrson_type(n) in RECORDED_TYPES:
                self._observeInstance(n)
        self._timer.start()

    def _finalizeSession(self):
        if not self._session or self._finalized:
            return self.lastFinalized
        self._finalized = True
        self._timer.stop()
        for obj, tag in list(self.node_tags):
            try:
                obj.RemoveObserver(tag)
            except Exception:  # noqa: BLE001
                pass
        self.node_tags = []
        try:
            self._evfile.close()
        except Exception:  # noqa: BLE001
            pass
        manifest = {
            "mrsonRecording": 1, "id": os.path.basename(self.dir),
            "startedAt": self.startedAt, "endedAt": _now_ms(),
            "blobBase": "blobs/", "keyframes": self.keyframes,
            "events": self.events, "thumbs": self.thumbs, "marks": self.marks,
        }
        with open(self.manifestPath(), "w") as f:
            json.dump(manifest, f)
        self.lastFinalized = self.manifestPath()
        self._session = False
        print("\n  mrson recorder FINALIZED: %s  (%d events, %d keyframes, %d thumbs) — ready for replay\n"
              % (self.lastFinalized, len(self.events), len(self.keyframes), len(self.thumbs)))
        return self.lastFinalized

    def _sceneTag(self, tag):
        self.scene_tags.append((slicer.mrmlScene, tag))

    def _observeInstance(self, node):
        self._nodeTag(node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onModified))
        if L._mrson_type(node) == "markup" and hasattr(node, "PointModifiedEvent"):
            self._nodeTag(node, node.AddObserver(node.PointModifiedEvent, self._onModified))
        if L._mrson_type(node) in ("markup", "segmentation"):
            dn = node.GetDisplayNode()
            if dn is not None:
                self._nodeTag(dn, dn.AddObserver(vtk.vtkCommand.ModifiedEvent, lambda _c, _e, m=node: self._onModified(m, _e)))

    def _nodeTag(self, obj, tag):
        self.node_tags.append((obj, tag))

    # ── change capture (the delta stream) ────────────────────────────────────
    def _onModified(self, caller, _event):
        if not self._session or self._finalized:
            return
        ev = L._node_event(caller)
        if ev.get("event") == "CameraModified":     # drop unchanged-pose echoes
            sig = (tuple(ev.get("position") or ()), tuple(ev.get("focalPoint") or ()),
                   tuple(ev.get("viewUp") or ()), ev.get("viewAngle"), ev.get("parallelScale"))
            if sig == self._lastCamSig:
                return
            self._lastCamSig = sig
        self._append(ev)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeAdded(self, _caller, _event, callData):
        node = callData
        if not self._session or node is None or L._mrson_type(node) not in RECORDED_TYPES:
            return
        ev = L._node_event(node)
        if ev.get("event") != "NodeAdded":           # image/mesh/seg: re-serialize to get zarr + full node
            HS._ensure_serialized(force=True)
            with open(os.path.join(HS._live_dir(), "live.mrson.json")) as f:
                doc = json.load(f)
            nm = doc.get("nodes", {}).get(node.GetID())
            if nm:
                ev = {"event": "NodeAdded", "sourceId": node.GetID(), "nodeClass": node.GetClassName(), "node": nm}
        self._append(ev)
        self._observeInstance(node)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeRemoved(self, _caller, _event, callData):
        node = callData
        if self._session and node is not None and L._mrson_type(node) in RECORDED_TYPES:
            self._append({"event": "NodeRemoved", "sourceId": node.GetID()})

    def _append(self, ev):
        if not self._session or self._finalized:
            return
        t = _now_ms()
        rec = dict(ev)
        rec["t"] = t
        self.events.append(rec)
        try:
            self._evfile.write(json.dumps(rec) + "\n")
            self._evfile.flush()
        except Exception:  # noqa: BLE001
            pass
        if t - self._last_key_t >= self._keyframe_ms:
            self.keyframe()

    # ── keyframes + thumbnails ────────────────────────────────────────────────
    def keyframe(self):
        name = "key%d" % self._nkey
        self._nkey += 1
        try:
            M.serialize_mrson(self.dir, name)           # writes <name>.mrson.json + blobs/
            t = _now_ms()
            self.keyframes.append({"t": t, "scene": name + ".mrson.json"})
            self._last_key_t = t
        except Exception as e:  # noqa: BLE001
            print("mrson_recorder: keyframe failed: %s" % e)

    def _onTick(self):
        self._captureThumb()

    def _captureThumb(self):
        if self._screen is None or not self._session or self._finalized:
            return
        t = _now_ms()
        rel = os.path.join("thumbs", "%d.png" % t)
        path = os.path.join(self.dir, rel)
        try:
            self._screen.captureImageFromView(None, path)    # None = the whole app layout (4-up), VTK-correct
            if os.path.exists(path):
                self.thumbs.append({"t": t, "file": rel})
        except Exception as e:  # noqa: BLE001
            print("mrson_recorder: thumb failed: %s" % e)

    def mark(self, label, note=None, role=None):
        m = {"t": _now_ms(), "label": label, "note": note, "role": role}
        self.marks.append(m)
        self._captureThumb()
        return m

    # ── rollover (scene close) ────────────────────────────────────────────────
    def _onStartClose(self, _caller, _event):
        # capture the final full state, then finalize NOW (before the nodes are removed) so the
        # recording ends at the last meaningful scene — and is ready before the browser's SceneClosed.
        if self._session and not self._finalized:
            self.keyframe()
            self._finalizeSession()

    def _onEndClose(self, _caller, _event):
        self._beginSession()                            # roll over to a fresh session for the next work

    def stop(self):
        self._finalizeSession()
        for obj, tag in list(self.scene_tags):
            try:
                obj.RemoveObserver(tag)
            except Exception:  # noqa: BLE001
                pass
        self.scene_tags = []

    def manifestPath(self):
        return os.path.join(self.dir, "recording.json")


def startRecorder(root=REC_ROOT, thumb_ms=1500, keyframe_ms=20000):
    """Start recording the live Slicer session. Rolls over on each scene close (finalizes the ended
    session, begins a fresh one). Keep the returned reference (or slicer.mrsonRecorder) alive."""
    old = getattr(slicer, "mrsonRecorder", None)
    if old is not None:
        try:
            old.stop()
        except Exception:  # noqa: BLE001
            pass
    r = MrsonRecorder(root=root, thumb_ms=thumb_ms, keyframe_ms=keyframe_ms)
    r.start()
    slicer.mrsonRecorder = r
    return r
