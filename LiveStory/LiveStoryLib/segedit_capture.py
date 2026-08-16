"""SegEditCapture — observe the Slicer Segment Editor and emit one mrson SegEdit *intent* op per
committed action, WITHOUT modifying anything (observation only). This is the emission half of the
"seged" live-editing loop: the user paints/erases in Slicer's real Segment Editor as normal, and each
committed stroke streams to a SlicerLive/seged client as a SegEdit op, which the WebGPU SegEditDriver
replays with its native effect — so disparities between Slicer's pipeline and the WebGPU one are
visible side by side. (The authoritative labelmap still rides its own channel; this is the raw intent.)

The SegEdit contract (algorithms/seg-edit-driver.ts):
  stroke  = { kind:"stroke", segmentId, effect, points:[[R,A,S]...], brush:{shape,diameterMm},
              mode:"add"|"remove", view:{orientation,offset} }
Carried as { event:"SegEdit", sourceId:<segNodeId>, edit:<stroke> }.

v1 captures Paint/Erase strokes (the common case, and what the recorder already proves). Scissors and
grow-from-seeds intents are the next kinds (same carrier, different `kind`).

Usage:
    cap = SegEditCapture(sink=lambda ev: client.send(ev))   # ev = {"event":"SegEdit", ...}
    cap.start()      # observes existing + future segment-editor nodes; installs slice-view watchers
    ...
    cap.stop()       # removes every observer
"""
import time

import qt
import vtk
import slicer

# Paint/Erase strokes are drawn in the 2D slice views; watch all three.
_SLICE_VIEWS = ("Red", "Green", "Yellow")
# Live-feedback throttle: coalesce a fast drag's MouseMove burst to ~30 Hz on the wire. The skipped
# moves are NOT lost — the next segment spans from the last EMITTED point to the current one (a longer
# capsule), which Paint interpolates, so the stroke stays continuous.
_MOVE_MIN_S = 0.03


class SegEditCapture:
    def __init__(self, sink):
        self.sink = sink                 # sink(event_dict) — how the emitted SegEdit op leaves
        self._segEd = None               # the active vtkMRMLSegmentEditorNode
        self._sceneTags = []             # scene observers (new editor nodes)
        self._editorTags = []            # (segEditorNode, tag) — active-effect changes
        self._interactorTags = []        # (interactor, tag) — slice-view mouse
        self._stroke = None              # {"last": [R,A,S], "lastEmit": t} while the left button is down

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self):
        scene = slicer.mrmlScene
        self._sceneTags.append((scene, scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, self._onNodeAdded)))
        for segEd in slicer.util.getNodesByClass("vtkMRMLSegmentEditorNode"):
            self._observeEditor(segEd)
        return self

    def stop(self):
        self._removeStrokeCapture()
        for obj, tag in self._editorTags + self._sceneTags:
            try:
                obj.RemoveObserver(tag)
            except Exception:  # noqa: BLE001
                pass
        self._editorTags = []
        self._sceneTags = []
        self._segEd = None

    # ── segment-editor observation ─────────────────────────────────────────────
    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeAdded(self, _caller, _event, node):
        if node is not None and node.GetClassName() == "vtkMRMLSegmentEditorNode":
            self._observeEditor(node)

    def _observeEditor(self, segEd):
        self._segEd = segEd
        self._editorTags.append((segEd, segEd.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onEditorModified)))
        if segEd.GetActiveEffectName():
            self._installStrokeCapture()

    def _onEditorModified(self, caller, _event):
        self._segEd = caller
        # Watch the slice interactors only while an effect is active (paint/erase), so we're inert otherwise.
        if caller.GetActiveEffectName():
            self._installStrokeCapture()
        else:
            self._removeStrokeCapture()

    # ── slice-view stroke capture (watch the same events the effect consumes) ──
    def _installStrokeCapture(self):
        if self._interactorTags:
            return
        lm = slicer.app.layoutManager()
        if lm is None:
            return
        for name in _SLICE_VIEWS:
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
            # HIGH priority + never abort: we observe, we don't steal the events from the effect.
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

    def _ras(self, interactor, sliceNode):
        x, y = interactor.GetEventPosition()
        m = sliceNode.GetXYToRAS()
        ras = [0.0, 0.0, 0.0, 1.0]
        m.MultiplyPoint([float(x), float(y), 0.0, 1.0], ras)
        return [ras[0], ras[1], ras[2]]

    # INCREMENTAL emission (live feedback): press → dab; each move → a capsule from the last emitted
    # point to the current one; release → the final capsule. Every segment is add-idempotent, so the
    # WebGPU PaintEffect welds them into one continuous tube — the user sees the stroke grow LIVE
    # instead of waiting for mouse-up. (The recorder keeps its own commit-on-release capture for replay.)
    def _onStrokeEvent(self, interactor, event, sliceNode):
        if self._segEd is None:
            return
        if event == "LeftButtonPressEvent":
            p = self._ras(interactor, sliceNode)
            self._stroke = {"last": p, "lastEmit": 0.0}
            self._emit([p], sliceNode)                          # initial dab (a click paints immediately)
            self._stroke["lastEmit"] = time.time()
        elif event == "MouseMoveEvent":
            if self._stroke is None:
                return
            now = time.time()
            if now - self._stroke["lastEmit"] < _MOVE_MIN_S:    # throttle; the next segment spans the gap
                return
            cur = self._ras(interactor, sliceNode)
            self._emit([self._stroke["last"], cur], sliceNode)
            self._stroke["last"] = cur
            self._stroke["lastEmit"] = now
        elif event == "LeftButtonReleaseEvent":
            if self._stroke is None:
                return
            cur = self._ras(interactor, sliceNode)
            if cur != self._stroke["last"]:
                self._emit([self._stroke["last"], cur], sliceNode)
            self._stroke = None

    def _brush(self, segEd):
        # BrushAbsoluteDiameter / BrushSphere are COMMON parameters — stored as BARE node attributes
        # (no "Paint."/"Erase." prefix). BrushAbsoluteDiameter is kept in mm by the effect even in
        # relative mode (it recomputes screenPixels·relative%·mmPerPixel → absolute as the brush moves).
        brush = {"shape": "sphere" if (segEd.GetAttribute("BrushSphere") in ("1", "true", "True")) else "disk"}
        diam = segEd.GetAttribute("BrushAbsoluteDiameter")
        if diam:
            try:
                brush["diameterMm"] = float(diam)
            except (ValueError, TypeError):
                pass
        return brush

    def _emit(self, points, sliceNode):
        segEd = self._segEd
        if segEd is None or not points:
            return
        effect = segEd.GetActiveEffectName() or ""
        segnode = segEd.GetSegmentationNode()
        edit = {
            "kind": "stroke",
            "segmentId": segEd.GetSelectedSegmentID() or "",
            "effect": effect,
            "points": points,
            "brush": self._brush(segEd),
            "mode": "remove" if effect.lower().startswith("erase") else "add",
            "view": {"orientation": sliceNode.GetOrientation(), "offset": sliceNode.GetSliceOffset()},
        }
        try:
            self.sink({"event": "SegEdit", "sourceId": (segnode.GetID() if segnode else ""), "edit": edit})
        except Exception as e:  # noqa: BLE001
            print("SegEditCapture: sink failed: %s" % e)
