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
        # segmentation labelmap edits fire vtkSegmentation.SourceRepresentationModified (NOT the node's
        # Modified). Debounce a burst of them (a paint stroke fires several) into one re-serialize.
        self._segDirty = set()
        self._segTimer = qt.QTimer()
        self._segTimer.setSingleShot(True)
        self._segTimer.setInterval(250)
        self._segTimer.connect("timeout()", self._flushSegEdits)
        # INTENT capture: while a segment-editor effect is active, observe the slice interactors and
        # record one SegEdit/stroke op per committed stroke (the raw human input — points in RAS + brush
        # + view frame — so any applier can replay it; the authoritative result rides the seg re-serialize).
        self._segEd = None
        self._interactorTags = []
        self._stroke = None

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
        self._segDirty = set()
        self._firstContentT = None       # time of the first real data node (image/seg/markup/mesh)
        self._evfile = open(os.path.join(self.dir, "events.jsonl"), "a")
        self._session = True
        self._segEd = None
        self._interactorTags = []
        self._stroke = None
        self.keyframe()                                  # seed keyframe = current full scene
        for i in range(slicer.mrmlScene.GetNumberOfNodes()):
            n = slicer.mrmlScene.GetNthNode(i)
            if L._mrson_type(n) in RECORDED_TYPES:
                self._observeInstance(n)
        for segEd in slicer.util.getNodesByClass("vtkMRMLSegmentEditorNode"):
            self._observeSegEditor(segEd)
        self._timer.start()

    def _finalizeSession(self):
        if not self._session or self._finalized:
            return self.lastFinalized
        self._finalized = True
        self._timer.stop()
        self._segTimer.stop()
        self._segDirty.clear()
        self._removeStrokeCapture()
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
        endedAt = _now_ms()
        hasContent = self._firstContentT is not None
        # The scrub timeline starts at the first real content (right after the Clear), so an empty
        # lead-in doesn't pad the recording — a session is effectively "from Clear (first data) to Clear".
        startedAt = self._firstContentT if hasContent else self.startedAt
        thumbs = [th for th in self.thumbs if th["t"] >= startedAt] or self.thumbs
        manifest = {
            "mrsonRecording": 1, "id": os.path.basename(self.dir),
            "startedAt": startedAt, "rawStartedAt": self.startedAt, "endedAt": endedAt,
            "hasContent": hasContent, "blobBase": "blobs/", "keyframes": self.keyframes,
            "events": self.events, "thumbs": thumbs, "marks": self.marks,
        }
        # git-style history: seal the event stream into a content-addressed commit chain (hashes are
        # byte-identical to render/commits.ts — see render/test/commits-conformance.test.ts), so the
        # recording carries `commits`/`head`/`root` that SlicerLive verifies without recomputing.
        head = None
        try:
            from . import mrson_commits
            commits = mrson_commits.seal_stream(self.events, interval_ms=1000, role="module")
            manifest["commits"] = commits
            manifest["root"] = commits[0]["hash"] if commits else None
            head = commits[-1]["hash"] if commits else None
            manifest["head"] = head
        except Exception as e:  # noqa: BLE001
            print("mrson_recorder: sealing failed: %s" % e)
        with open(self.manifestPath(), "w") as f:
            json.dump(manifest, f)
        # tiny sidecar so /mrson/recs can list sessions without parsing the full (event-heavy) manifest
        with open(os.path.join(self.dir, "meta.json"), "w") as f:
            json.dump({"id": manifest["id"], "hasContent": hasContent,
                       "startedAt": startedAt, "endedAt": endedAt, "head": head}, f)
        self.lastFinalized = self.manifestPath()
        self._session = False
        print("\n  mrson recorder FINALIZED: %s  (%d events, %d keyframes, %d thumbs, content=%s) — ready for replay\n"
              % (self.lastFinalized, len(self.events), len(self.keyframes), len(thumbs), hasContent))
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
        # segmentation LABELMAP edits (paint/threshold/etc.): observe the source-representation-modified
        # event on the vtkSegmentation so mid-session edits are captured (the node's Modified does NOT fire).
        if node.GetClassName() == "vtkMRMLSegmentationNode":
            try:
                import vtkSegmentationCorePython as vsc
                segmentation = node.GetSegmentation()
                self._nodeTag(segmentation, segmentation.AddObserver(
                    vsc.vtkSegmentation.SourceRepresentationModified, lambda _c, _e, m=node: self._onSegEdited(m)))
            except Exception as e:  # noqa: BLE001
                print("mrson_recorder: seg labelmap observer failed: %s" % e)

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
        if node is not None and node.GetClassName() == "vtkMRMLSegmentEditorNode":
            self._observeSegEditor(node)
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
        if self._firstContentT is None and self._is_content(node):
            self._firstContentT = self.events[-1]["t"] if self.events else _now_ms()
        self._observeInstance(node)

    @staticmethod
    def _is_content(node):
        """Real user data that marks the meaningful start of a session — image / segmentation / markup /
        user model. EXCLUDES Slicer's slice-intersection display models (vtkMRMLModelNode infrastructure
        recreated after every Clear), which would otherwise anchor the trim to t≈0 and defeat it."""
        t = L._mrson_type(node)
        if t in ("image", "segmentation", "markup"):
            return True
        if t == "mesh":
            try:
                if node.GetAttribute("SliceLogic.IsSliceModelNode") == "1" or node.GetHideFromEditors():
                    return False
            except Exception:  # noqa: BLE001
                pass
            return True
        return False

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeRemoved(self, _caller, _event, callData):
        node = callData
        if self._session and node is not None and L._mrson_type(node) in RECORDED_TYPES:
            self._append({"event": "NodeRemoved", "sourceId": node.GetID()})

    def _onSegEdited(self, node):
        if not self._session or self._finalized:
            return
        self._segDirty.add(node.GetID())
        if not self._segTimer.isActive():
            self._segTimer.start()

    # ── intent capture: strokes while an effect is active ─────────────────────
    def _observeSegEditor(self, segEd):
        if not self._session:
            return
        self._segEd = segEd
        self._nodeTag(segEd, segEd.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onSegEdModified))
        if segEd.GetActiveEffectName():
            self._installStrokeCapture()

    def _onSegEdModified(self, caller, _event):
        if not self._session or self._finalized:
            return
        self._segEd = caller
        if caller.GetActiveEffectName():
            self._installStrokeCapture()
        else:
            self._removeStrokeCapture()

    def _installStrokeCapture(self):
        if self._interactorTags:
            return
        lm = slicer.app.layoutManager()
        if lm is None:
            return
        for name in ("Red", "Green", "Yellow"):
            sw = lm.sliceWidget(name)
            if not sw:
                continue
            try:
                interactor = sw.sliceView().interactor()
                sliceNode = sw.mrmlSliceNode()
            except Exception:  # noqa: BLE001
                continue
            if interactor is None or sliceNode is None:
                continue
            # HIGH priority + never abort: we watch the same events the effect consumes without stealing them.
            for evt in ("LeftButtonPressEvent", "MouseMoveEvent", "LeftButtonReleaseEvent"):
                tag = interactor.AddObserver(evt, lambda c, e, sn=sliceNode: self._onStrokeEvent(c, e, sn), 10.0)
                self._interactorTags.append((interactor, tag))

    def _removeStrokeCapture(self):
        for obj, tag in self._interactorTags:
            try:
                obj.RemoveObserver(tag)
            except Exception:  # noqa: BLE001
                pass
        self._interactorTags = []
        self._stroke = None

    def _addStrokePoint(self, interactor, sliceNode):
        x, y = interactor.GetEventPosition()
        m = sliceNode.GetXYToRAS()
        ras = [0.0, 0.0, 0.0, 1.0]
        m.MultiplyPoint([float(x), float(y), 0.0, 1.0], ras)
        self._stroke["points"].append([ras[0], ras[1], ras[2]])

    def _onStrokeEvent(self, interactor, event, sliceNode):
        if not self._session or self._finalized or self._segEd is None:
            return
        if event == "LeftButtonPressEvent":
            self._stroke = {"points": []}
            self._addStrokePoint(interactor, sliceNode)
        elif event == "MouseMoveEvent":
            if self._stroke is not None:
                self._addStrokePoint(interactor, sliceNode)
        elif event == "LeftButtonReleaseEvent":
            if self._stroke is None:
                return
            self._addStrokePoint(interactor, sliceNode)
            self._commitStroke(sliceNode)
            self._stroke = None

    def _commitStroke(self, sliceNode):
        pts = self._stroke.get("points") if self._stroke else None
        if not pts:
            return
        segEd = self._segEd
        effect = segEd.GetActiveEffectName() or ""
        brush = {"shape": "sphere" if (segEd.GetAttribute("Paint.BrushSphere") in ("1", "true", "True")) else "disk"}
        diam = segEd.GetAttribute("Paint.BrushAbsoluteDiameter") or segEd.GetAttribute("Erase.BrushAbsoluteDiameter")
        if diam:
            try:
                brush["diameterMm"] = float(diam)
            except (ValueError, TypeError):
                pass
        segnode = segEd.GetSegmentationNode()
        edit = {
            "kind": "stroke",
            "segmentId": segEd.GetSelectedSegmentID() or "",
            "effect": effect,
            "points": pts,
            "brush": brush,
            "mode": "remove" if effect.lower().startswith("erase") else "add",
            "view": {"orientation": sliceNode.GetOrientation(), "offset": sliceNode.GetSliceOffset()},
        }
        self._append({"event": "SegEdit", "sourceId": (segnode.GetID() if segnode else ""), "edit": edit})

    def _flushSegEdits(self):
        """Re-serialize each edited segmentation (merged labelmap → content-addressed zarr; unchanged
        chunks dedup, so this is incremental) and append it as a NodeAdded upsert — the AUTHORITATIVE
        result the reader fast-forwards to. (Intent strokes are a separate channel, added next.)"""
        if not self._session or self._finalized:
            return
        for segid in list(self._segDirty):
            seg = slicer.mrmlScene.GetNodeByID(segid)
            if seg is None:
                continue
            try:
                node_m = M._segmentation_node(seg, segid, os.path.join(self.dir, "blobs"))
                self._append({"event": "NodeAdded", "sourceId": segid, "nodeClass": seg.GetClassName(), "node": node_m})
            except Exception as e:  # noqa: BLE001
                print("mrson_recorder: seg re-serialize failed: %s" % e)
        self._segDirty.clear()

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
