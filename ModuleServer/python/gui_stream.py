"""GUI stream (WS B) -- stream a Slicer main window's chrome + module panels to a client as pixels,
and take synthetic pointer/wheel/key events back. Runs inside the ModuleServer (headless Slicer).

Slicer-independent wire format (no Qt types; a non-Slicer server can implement the same):
  client -> server (JSON text):
    {"op":"subscribe"}                      start streaming; server replies title + menus + regions
    {"op":"resize", "w":1440, "h":900}      client window size; the app window follows it (so the
                                            app's OWN layout engine lays out the view cells)
    {"op":"pointer", "type":"move|down|up|dblclick", "region":id, "x":..,"y":..,
        "button":0|1|2, "buttons":bitmask, "mods":{"shift","ctrl","alt","meta"}}
    {"op":"wheel", "region":id, "x":..,"y":.., "dx":.., "dy":.., "mods":{...}}
    {"op":"key", "type":"down|up", "key":DOMkey, "text":"", "mods":{...}}
    {"op":"hover", "region":id, "x":..,"y":..}   pointer dwelled: ask the app for a tooltip
    {"op":"triggerAction", "id":"a12"}      fire a menu action (native menus on the client)
    {"op":"a11yClick", "id":"w7f..."}       activate a widget from the accessibility tree (button click / mouse press+release at centre)
    {"op":"a11yFocus", "id"}                give it keyboard focus
    {"op":"a11ySet", "id", "value"}         set its value (text / number / checked / combobox text)
    {"op":"a11yQuery"}                      re-send the tree now
    {"op":"ping", "t"} -> {"ev":"pong","t"}  round-trip measurement
    {"op":"quality", "codec":"png|webp|jpeg", "quality":10..100}   frame codec for slow links (frame header carries "fmt")
    <- {"ev":"stats", "bytesPerS", "framesPerS", "codec", "quality"}  every 2 s while frames flow
    <- {"ev":"quitIntercepted"}             a Quit reached the server and was swallowed (host owns the lifecycle)
    {"op":"shutdown"}                       really close the server's main window (lets the next Close through)
    <- {"ev":"a11y", "nodes":[{id,region,role,name,value,x,y,w,h,enabled,focused,checked?}]}   (region-local coords; sent on change)
    {"op":"selectModule", "name":"SampleData"}
  server -> client (JSON text):
    {"ev":"regions", "w","h", "dpr", "viewport":{x,y,w,h}, "regions":[{id,kind,title,x,y,w,h,z}],
                     "cells":[{id,kind:"slice|3d|plot|table",name,x,y,w,h,view:{x,y,w,h}}]}
    {"ev":"menus", "menus":[{title, items:[{id,text,shortcut,enabled,checkable,checked,sep,items?}]}]}
    {"ev":"title", "text"}   {"ev":"cursor", "shape"}   {"ev":"blocked", "title"} / {"ev":"unblocked"}
  server -> client (binary): <u32 BE header length><JSON header {"region","seq","x","y","w","h"}><PNG>
    x,y = offset of this (possibly partial) frame inside the region; w,h = frame pixel size (at dpr).

Regions (window coordinates): menubar, toolbars, docks, statusbar, the CONTROLLER BAR of every
slice/3D/plot/table view, whole plot/table views, splitter handles, and every visible top-level
popup/dialog (kind "popup", z>0). The slice/3D VIEW surfaces are never streamed: `cells` tells the
client where the app laid them out, and the client renders its own views there (SlicerLive), kept
in sync over the mrson channel. Nothing here depends on Qt reaching a screen (see bootstrap).

Capture is PAINT-DRIVEN: a global event filter records QEvent.Paint rects per region (dirty rects);
a 33 ms timer grabs only dirty regions, only their dirty sub-rect, and skips frames whose PNG hash
is unchanged. A slow full re-grab (every 2 s) guards against missed paints. ASCII only.
"""
import hashlib
import json
import re
import struct
import time

import qt
import slicer

from mrson_ws import WsServer

FRAME_MS = 33
FULL_REFRESH_S = 2.0
A11Y_PERIOD_S = 0.5
STATS_PERIOD_S = 2.0         # bytes/s + frames/s report cadence (only while frames flow)          # semantic-tree refresh cadence (only broadcast when it changed)
BLOCKED_AFTER_S = 1.0


def _win_pos(mw, w):
    if w.isWindow():
        return [w.geometry.x() - mw.geometry.x(), w.geometry.y() - mw.geometry.y()]
    p = mw.mapFromGlobal(w.mapToGlobal(qt.QPoint(0, 0)))
    return [p.x(), p.y()]


_KEYMAP = {
    "Enter": qt.Qt.Key_Return, "Backspace": qt.Qt.Key_Backspace, "Tab": qt.Qt.Key_Tab, "Escape": qt.Qt.Key_Escape,
    "Delete": qt.Qt.Key_Delete, "ArrowLeft": qt.Qt.Key_Left, "ArrowRight": qt.Qt.Key_Right, "ArrowUp": qt.Qt.Key_Up,
    "ArrowDown": qt.Qt.Key_Down, "Home": qt.Qt.Key_Home, "End": qt.Qt.Key_End, "PageUp": qt.Qt.Key_PageUp,
    "PageDown": qt.Qt.Key_PageDown, " ": qt.Qt.Key_Space, "Shift": qt.Qt.Key_Shift, "Control": qt.Qt.Key_Control,
    "Alt": qt.Qt.Key_Alt, "Meta": qt.Qt.Key_Meta, "CapsLock": qt.Qt.Key_CapsLock,
}
for _i in range(1, 13):
    _KEYMAP["F%d" % _i] = getattr(qt.Qt, "Key_F%d" % _i)

_CURSORS = {0: "default", 1: "default", 2: "crosshair", 3: "wait", 4: "text", 5: "ns-resize", 6: "ew-resize",
            7: "nesw-resize", 8: "nwse-resize", 9: "move", 10: "none", 11: "row-resize", 12: "col-resize",
            13: "pointer", 14: "not-allowed", 15: "help", 16: "progress", 17: "grab", 18: "grabbing", 19: "wait", 20: "copy"}


def _mods(m):
    m = m or {}
    r = qt.Qt.NoModifier
    if m.get("shift"): r |= qt.Qt.ShiftModifier
    if m.get("ctrl"): r |= qt.Qt.ControlModifier
    if m.get("alt"): r |= qt.Qt.AltModifier
    if m.get("meta"): r |= qt.Qt.MetaModifier
    return r


_BUTTON = {0: qt.Qt.LeftButton, 1: qt.Qt.MiddleButton, 2: qt.Qt.RightButton}


def _buttons(mask):
    r = qt.Qt.NoButton
    if mask & 1: r |= qt.Qt.LeftButton
    if mask & 2: r |= qt.Qt.RightButton
    if mask & 4: r |= qt.Qt.MiddleButton
    return r


class _PaintFilter(qt.QObject):
    """Records paint rects (window coords) so the tick grabs only what changed."""

    def __init__(self, stream):
        super().__init__()
        self.stream = stream

    def eventFilter(self, obj, ev):
        try:
            t = ev.type()
            if t == qt.QEvent.Paint and obj.isWidgetType():
                self.stream.note_paint(obj, ev.rect())
            elif t in (qt.QEvent.Show, qt.QEvent.Hide, qt.QEvent.Resize, qt.QEvent.Move) and obj.isWidgetType() and obj.isWindow():
                self.stream.structureDirty = True
            elif t == qt.QEvent.Close and obj.isWidgetType() and str(obj) == self.stream.mwKey and not self.stream.allowQuit:
                # A Quit reaching the headless server (streamed File > Exit, Ctrl+Q forwarded, a module calling
                # slicer.util.exit) would pop "save before exit?" and then kill the ModuleServer. The host owns
                # the lifecycle: swallow it here (before closeEvent runs) and tell clients.
                ev.ignore()
                self.stream._broadcast_text({"ev": "quitIntercepted"})
                return True
        except Exception:  # noqa: BLE001
            pass
        return False


class GuiStream:
    def __init__(self, port):
        self.mw = slicer.util.mainWindow()
        self.actions = {}
        self.regionWidgets = {}      # region id -> widget
        self.regionRects = {}        # region id -> [x,y,w,h] window coords
        self.regionsByWindow = {}    # id(window widget) -> [region ids]
        self.dirty = {}              # region id -> QRect (region-local) or None for "all"
        self.lastHash = {}
        self.seq = 0
        self.lastRegionsSig = None
        self.structureDirty = True
        self.lastFull = 0.0
        self.pressTarget = None
        self.lastCursor = None
        self.blockedSince = None
        self.blockedSent = False
        self.subscribers = []
        self.grabbing = False
        self.hoverTarget = None                          # widget last entered (Enter/Leave staging)
        self.mwKey = str(self.mw)                        # PythonQt wrappers are not identity-stable; str() is
        self.allowQuit = False                           # set True (e.g. by the launcher's shutdown op) to let a Close through
        self.codec, self.quality = "png", 100          # S13: negotiated by the client (webp/jpeg + quality on slow links)
        self.statBytes = 0; self.statFrames = 0; self.statSince = time.perf_counter(); self.statSentIdle = 0
        self.server = WsServer(port, on_message=self._on_message, on_close=self._on_close)
        self.paintFilter = _PaintFilter(self)
        slicer.app.installEventFilter(self.paintFilter)
        self.timer = qt.QTimer()
        self.timer.setInterval(FRAME_MS)
        self.timer.connect("timeout()", self._tick)

    # ---- dirty tracking ---------------------------------------------------------------------
    def note_paint(self, w, rect):
        """Hot path (thousands of paints/s during a repaint storm): no string formatting, no per-region
        Qt calls -- one mapToGlobal for the painted widget, then integer rect math against cached rects."""
        if not self.regionWidgets or self.grabbing:
            return                               # paints raised by our own grab() are not changes (else grab->paint->dirty->grab forever)
        top = w.window()
        topKey = id(top) if top is not None else 0
        byWindow = self.regionsByWindow.get(topKey)
        if not byWindow:
            return
        wx, wy = _win_pos(self.mw, w)
        px, py, pw, ph = wx + rect.x(), wy + rect.y(), rect.width(), rect.height()
        for rid in byWindow:
            rx, ry, rW, rH = self.regionRects[rid]
            ix0, iy0 = max(px, rx), max(py, ry)
            ix1, iy1 = min(px + pw, rx + rW), min(py + ph, ry + rH)
            if ix1 <= ix0 or iy1 <= iy0:
                continue
            r = qt.QRect(ix0 - rx, iy0 - ry, ix1 - ix0, iy1 - iy0)
            cur = self.dirty.get(rid, "none")
            if cur is None:
                continue                         # already "all"
            self.dirty[rid] = r if isinstance(cur, str) else cur.united(r)   # never compare a QRect with an int (raises)
            self.paintCount = getattr(self, "paintCount", 0) + 1

    # ---- regions + cells ----------------------------------------------------------------------
    def regions(self):
        mw = self.mw
        out, cells, widgets, rects = [], [], {}, {}

        def add(w, kind, rid=None, z=0, title=""):
            rid = rid or (w.objectName or ("%s@%x" % (w.className(), id(w))))
            if not w.isVisible() or w.width <= 0 or w.height <= 0:
                return
            x, y = _win_pos(mw, w)
            out.append({"id": rid, "kind": kind, "title": title, "x": x, "y": y, "w": w.width, "h": w.height, "z": z})
            widgets[rid] = w; rects[rid] = [x, y, w.width, w.height]

        mb = mw.menuBar()
        if mb is not None:
            add(mb, "menubar", "menubar")
        for t in mw.findChildren("QToolBar"):
            if str(t.parent()) == str(mw):
                add(t, "toolbar")
        for d in mw.findChildren("QDockWidget"):
            add(d, "dock", title=d.windowTitle)
        add(mw.statusBar(), "statusbar", "statusbar")
        # view cells from the app's own layout engine; controller bars stream, view surfaces do not
        lm = slicer.app.layoutManager()
        vp = lm.viewport()
        def cell(w, kind, name, vieww, ctrl, nid):
            if not w.isVisible():
                return
            x, y = _win_pos(mw, w); vx, vy = _win_pos(mw, vieww)
            cells.append({"id": nid, "kind": kind, "name": name, "x": x, "y": y, "w": w.width, "h": w.height,
                          "view": {"x": vx, "y": vy, "w": vieww.width, "h": vieww.height}})
            if ctrl is not None:
                add(ctrl, "controller", "ctrl:" + nid, title=name)
        for name in lm.sliceViewNames():
            sw = lm.sliceWidget(name)
            cell(sw, "slice", name, sw.sliceView(), sw.sliceController(), sw.mrmlSliceNode().GetID())
        for i in range(lm.threeDViewCount):
            tw = lm.threeDWidget(i)
            cell(tw, "3d", tw.mrmlViewNode().GetLayoutName(), tw.threeDView(), tw.threeDController(), tw.mrmlViewNode().GetID())
        for i in range(getattr(lm, "plotViewCount", 0)):
            pw = lm.plotWidget(i)
            if pw.isVisible():
                add(pw, "plotview", "plot:%d" % i)   # whole widget (controller + chart) as pixels
        for i in range(getattr(lm, "tableViewCount", 0)):
            tw = lm.tableWidget(i)
            if tw.isVisible():
                add(tw, "tableview", "table:%d" % i)
        for h in vp.findChildren("QSplitterHandle"):
            add(h, "splitter", "split@%x" % id(h))
        z = 1
        for w in qt.QApplication.topLevelWidgets():
            if w.isVisible() and str(w) != str(mw) and w.width > 0 and w.height > 0 and not w.isMinimized():
                add(w, "popup", "popup@%x" % id(w), z=z, title=w.windowTitle)
                z += 1
        vx, vy = _win_pos(mw, vp)
        self.regionWidgets, self.regionRects = widgets, rects
        # PythonQt wrappers are not stable objects, but the wrapped QWidget* is: key by id(window()) captured
        # ONCE here so the paint hook never formats or wraps anything.
        byWindow = {}
        for rid, w in widgets.items():
            byWindow.setdefault(id(w.window()), []).append(rid)
        self.regionsByWindow = byWindow
        return {"ev": "regions", "w": mw.width, "h": mw.height, "dpr": mw.devicePixelRatio(),
                "viewport": {"x": vx, "y": vy, "w": vp.width, "h": vp.height}, "regions": out, "cells": cells}

    # ---- menus ------------------------------------------------------------------------------
    def menus(self):
        self.actions = {}
        mb = self.mw.menuBar()
        allMenus = list(self.mw.findChildren("QMenu"))

        def children_of(parent):
            return [m for m in allMenus if str(m.parent()) == str(parent)]

        def items(menu):
            subs = {m.title: m for m in children_of(menu)}
            res = []
            for a in menu.actions():
                if a.isSeparator():
                    res.append({"sep": True}); continue
                aid = "a%d" % (len(self.actions) + 1)
                self.actions[aid] = a
                it = {"id": aid, "text": a.text, "shortcut": a.shortcut.toString(), "enabled": a.isEnabled(),
                      "checkable": a.isCheckable(), "checked": a.isChecked()}
                sub = subs.get(a.text)
                if sub is not None:
                    it["items"] = items(sub)
                res.append(it)
            return res

        return {"ev": "menus", "menus": [{"title": m.title, "items": items(m)} for m in children_of(mb)]}


    # ---- accessibility tree (S12) ---------------------------------------------------------
    # Pixels are opaque to screen readers and to automation. Every streamed region also publishes the
    # visible widgets underneath it as a semantic tree (role/name/value/rect), built from plain QWidget
    # properties PythonQt exposes (QAccessible is not wrapped). The client lays ARIA elements over the
    # pixels and gets click/set/focus-by-name from the same ids.
    _ROLE_CLASSES = None

    def _role(self, w):
        if w.inherits("QAbstractButton"):
            if w.inherits("QCheckBox") or (w.checkable and not w.inherits("QToolButton")):
                return "checkbox"
            return "button"
        if w.inherits("QLineEdit"):
            return "textbox"
        if w.inherits("QAbstractSpinBox"):
            return "spinbutton"
        if w.inherits("QComboBox"):
            return "combobox"
        if w.inherits("QAbstractSlider"):
            return "slider"
        if w.inherits("QTabBar"):
            return "tablist"
        if w.inherits("QGroupBox"):
            return "group"
        if w.inherits("QLabel"):
            return "label" if w.text else None
        cls = w.className()
        if cls in ("ctkCollapsibleButton", "ctkCollapsibleGroupBox"):
            return "group"
        if cls.startswith("qMRML") and cls.endswith("ComboBox"):
            return "combobox"
        if cls in ("ctkSliderWidget", "ctkDoubleSlider", "ctkRangeWidget", "ctkDoubleRangeSlider"):
            return "slider"
        if cls in ("ctkDoubleSpinBox",):
            return "spinbutton"
        if cls in ("QTreeView", "QListView", "QTableView", "QTreeWidget", "QListWidget", "QTableWidget", "qMRMLSubjectHierarchyTreeView", "qMRMLSegmentsTableView"):
            return "grid"
        if cls in ("QPlainTextEdit", "QTextEdit", "ctkPythonConsole"):
            return "textbox"
        return None

    def _text(self, w, prop):
        try:
            v = getattr(w, prop)
            return v() if callable(v) else v
        except Exception:  # noqa: BLE001
            return None

    def _name_value(self, w, role):
        name = self._text(w, "accessibleName") or ""
        value = None
        if role in ("button", "checkbox", "label", "group"):
            name = name or (self._text(w, "text") or self._text(w, "title") or "")
        if role == "textbox":
            value = self._text(w, "text")
            if value is None:
                value = self._text(w, "toPlainText")
        elif role == "spinbutton":
            value = self._text(w, "value")
            if value is None:
                value = self._text(w, "text")
        elif role == "combobox":
            value = self._text(w, "currentText") or self._text(w, "currentNodeID")
        elif role == "slider":
            value = self._text(w, "value")
        elif role == "tablist":
            try:
                value = w.tabText(w.currentIndex)
            except Exception:  # noqa: BLE001
                value = None
        elif role == "checkbox":
            value = bool(self._text(w, "checked"))
        if not name:
            name = self._text(w, "toolTip") or self._text(w, "placeholderText") or self._text(w, "objectName") or ""
        name = str(name).replace("&", "")
        if isinstance(value, float):
            value = round(value, 4)
        return name[:120], value

    def a11y(self):
        nodes, widgets = [], {}
        for rid, root in self.regionWidgets.items():
            rw, rh = root.width, root.height
            composites = set()                                  # widgets whose children are implementation detail
            for w in root.findChildren(qt.QWidget):
                try:
                    if not w.visible:
                        continue
                    role = self._role(w)
                    if role is None:
                        continue
                    p, inner = w.parent(), False
                    while p is not None and str(p) != str(root):
                        if str(p) in composites:
                            inner = True; break
                        p = p.parent()
                    if inner:
                        continue
                    if role in ("combobox", "slider", "spinbutton", "grid", "tablist") or w.className().startswith(("ctk", "qMRML")):
                        composites.add(str(w))
                    tl = w.mapTo(root, w.rect.topLeft())
                    x, y, ww, wh = tl.x(), tl.y(), w.width, w.height
                    if x + ww <= 0 or y + wh <= 0 or x >= rw or y >= rh:
                        continue                                    # scrolled out of the region
                    m = re.search(r"0x[0-9a-fA-F]+", str(w))
                    wid = "w" + (m.group(0)[2:] if m else str(len(widgets)))
                    widgets[wid] = w
                    name, value = self._name_value(w, role)
                    n = {"id": wid, "region": rid, "role": role, "name": name, "x": x, "y": y, "w": ww, "h": wh,
                         "enabled": bool(w.enabled), "focused": bool(w.hasFocus())}
                    if value is not None:
                        n["value"] = value
                    if role in ("slider", "spinbutton"):
                        lo, hi = self._text(w, "minimum"), self._text(w, "maximum")
                        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
                            n["min"], n["max"] = lo, hi
                    if role == "checkbox":
                        n["checked"] = bool(value)
                    nodes.append(n)
                except Exception:  # noqa: BLE001
                    continue
        self.a11yWidgets = widgets
        return {"ev": "a11y", "nodes": nodes}

    def _tick_a11y(self, now):
        if now - getattr(self, "lastA11y", 0) < A11Y_PERIOD_S:
            return
        self.lastA11y = now
        tree = self.a11y()
        sig = json.dumps(tree, sort_keys=True)
        if sig != getattr(self, "lastA11ySig", None):
            self.lastA11ySig = sig
            self._broadcast_text(tree)

    def _a11y_widget(self, msg):
        w = getattr(self, "a11yWidgets", {}).get(msg.get("id"))
        if w is None:
            self.a11y()
            w = self.a11yWidgets.get(msg.get("id"))
        return w

    def _a11y_click(self, msg):
        w = self._a11y_widget(msg)
        if w is None:
            return
        if w.inherits("QAbstractButton"):
            w.click()
        else:
            c = qt.QPoint(w.width // 2, w.height // 2)
            gp = w.mapToGlobal(c)
            for et in (qt.QEvent.MouseButtonPress, qt.QEvent.MouseButtonRelease):
                qt.QApplication.sendEvent(w, qt.QMouseEvent(et, qt.QPointF(c), qt.QPointF(gp), qt.Qt.LeftButton,
                                                             qt.Qt.LeftButton if et == qt.QEvent.MouseButtonPress else qt.Qt.NoButton, qt.Qt.NoModifier))
        self.lastA11y = 0

    def _a11y_set(self, msg):
        w = self._a11y_widget(msg)
        if w is None:
            return
        v = msg.get("value")
        if hasattr(w, "setCurrentNodeID"):                      # qMRMLNodeComboBox & friends: node id, or node name
            node = slicer.mrmlScene.GetNodeByID(str(v)) or slicer.mrmlScene.GetFirstNodeByName(str(v))
            w.setCurrentNodeID(node.GetID() if node is not None else "")
        elif w.inherits("QAbstractButton"):
            w.setChecked(bool(v))
        elif w.inherits("QLineEdit"):
            w.setText(str(v)); w.editingFinished()
        elif w.inherits("QComboBox"):
            i = w.findText(str(v))
            if i >= 0:
                w.setCurrentIndex(i)
            elif hasattr(w, "setCurrentNodeID"):
                w.setCurrentNodeID(str(v))
        elif hasattr(w, "setValue"):
            w.setValue(float(v) if w.inherits("QDoubleSpinBox") or w.className() in ("ctkSliderWidget", "ctkDoubleSpinBox", "ctkDoubleSlider") else int(v))
        elif hasattr(w, "setPlainText"):
            w.setPlainText(str(v))
        elif hasattr(w, "setText"):
            w.setText(str(v))
        self.lastA11y = 0

    # ---- frames -----------------------------------------------------------------------------
    def _png(self, w, rect=None):
        self.grabbing = True
        try:
            img = w.grab(rect) if rect is not None else w.grab()
        finally:
            self.grabbing = False
        buf = qt.QBuffer(); buf.open(qt.QIODevice.WriteOnly)
        fmt, q = self.codec, self.quality
        if fmt == "webp":
            img.save(buf, "WEBP", q)              # q=100 -> lossless-ish; lower = lossy, for remote links
        elif fmt == "jpeg":
            img.save(buf, "JPEG", q)
        else:
            img.save(buf, "PNG")
        buf.close()
        return bytes(buf.data().data()), img.width(), img.height()

    def _tick(self):
        if not self.subscribers:
            return
        now = time.perf_counter()
        full = self.structureDirty or (now - self.lastFull) > FULL_REFRESH_S
        if full:
            self.structureDirty = False; self.lastFull = now
            reg = self.regions()
            sig = json.dumps(reg, sort_keys=True)
            if sig != self.lastRegionsSig:
                self.lastRegionsSig = sig
                self._broadcast_text(reg)
                for g in set(self.lastHash) - set(self.regionWidgets):
                    self.lastHash.pop(g, None)
            todo = {rid: None for rid in self.regionWidgets}
        else:
            todo = {rid: r for rid, r in self.dirty.items() if rid in self.regionWidgets}
        self.dirty = {}
        for rid, rect in todo.items():
            w = self.regionWidgets[rid]
            try:
                png, pw, ph = self._png(w, rect)
            except Exception:  # noqa: BLE001
                continue
            h = hashlib.blake2b(png, digest_size=16).digest()
            key = (rid, rect.x(), rect.y(), pw, ph) if rect is not None else rid
            if rect is None and self.lastHash.get(rid) == h:
                continue
            if rect is not None and self.lastHash.get(key) == h:
                continue
            self.lastHash[key] = h
            if rect is not None:
                self.lastHash.pop(rid, None)     # full-frame hash is stale once a partial landed
            self.seq += 1
            if rect is not None:
                self.partialSent = getattr(self, "partialSent", 0) + 1
            hdr = json.dumps({"region": rid, "seq": self.seq, "x": rect.x() if rect else 0, "y": rect.y() if rect else 0, "w": pw, "h": ph, "fmt": self.codec}).encode()
            self._broadcast_bin(struct.pack(">I", len(hdr)) + hdr + png)
            self.statBytes += 4 + len(hdr) + len(png); self.statFrames += 1
        if now - self.statSince >= STATS_PERIOD_S:
            dt = now - self.statSince
            if self.statFrames or self.statSentIdle < 1:      # one trailing zero-report then quiet
                self._broadcast_text({"ev": "stats", "bytesPerS": int(self.statBytes / dt), "framesPerS": round(self.statFrames / dt, 1), "codec": self.codec, "quality": self.quality})
                self.statSentIdle = 0 if self.statFrames else self.statSentIdle + 1
            self.statBytes = 0; self.statFrames = 0; self.statSince = now
        self._watch_modal(now)
        self._tick_a11y(now)

    def _watch_modal(self, now):
        m = qt.QApplication.activeModalWidget()
        if m is not None and not m.isVisible():
            m = None                                     # a closed-but-not-yet-deleted modal still reports here
            if self.blockedSent:
                self._broadcast_text({"ev": "unblocked"})
            self.blockedSince = None; self.blockedSent = False
            return
        if self.blockedSince is None:
            self.blockedSince = now
        elif not self.blockedSent and now - self.blockedSince > BLOCKED_AFTER_S:
            self.blockedSent = True
            try:
                title, cls = m.windowTitle, m.className()
            except Exception:  # noqa: BLE001  (the modal can be deleted between the check and the read)
                title, cls = "", ""
            self._broadcast_text({"ev": "blocked", "title": title, "className": cls})

    def _broadcast_text(self, obj):
        for c in self.subscribers:
            c.send_text(json.dumps(obj))

    def _broadcast_bin(self, data):
        for c in self.subscribers:
            c.send_binary(data)

    # ---- inbound ----------------------------------------------------------------------------
    def _on_close(self, client):
        if client in self.subscribers:
            self.subscribers.remove(client)
        if not self.subscribers:
            self.timer.stop()

    def _on_message(self, client, text):
        try:
            msg = json.loads(text)
        except Exception:  # noqa: BLE001
            return
        op = msg.get("op")
        try:
            if op == "subscribe":
                if client not in self.subscribers:
                    self.subscribers.append(client)
                self.lastHash = {}; self.lastRegionsSig = None; self.structureDirty = True
                if msg.get("codec") in ("png", "webp", "jpeg"):
                    self.codec = msg["codec"]; self.quality = max(10, min(100, int(msg.get("quality", 100))))
                client.send_text(json.dumps({"ev": "title", "text": self.mw.windowTitle}))
                client.send_text(json.dumps(self.menus()))
                if qt.QApplication.activeModalWidget() is None:
                    client.send_text(json.dumps({"ev": "unblocked"}))   # a reconnect must clear a stale "blocked" banner
                self.timer.start()
            elif op == "resize":
                self.mw.resize(int(msg["w"]), int(msg["h"])); self.structureDirty = True
            elif op == "pointer":
                self._pointer(msg)
            elif op == "wheel":
                self._wheel(msg)
            elif op == "key":
                self._key(msg)
            elif op == "hover":
                self._hover(msg)
            elif op == "triggerAction":
                a = self.actions.get(msg.get("id"))
                if a is not None:
                    a.trigger()
            elif op == "selectModule":
                slicer.util.selectModule(msg.get("name"))
            elif op == "ping":
                client.send_text(json.dumps({"ev": "pong", "t": msg.get("t")}))
            elif op == "quality":                     # client-driven adaptation: codec + quality for everyone (frames are broadcast)
                codec = msg.get("codec", "png")
                if codec in ("png", "webp", "jpeg"):
                    self.codec = codec
                self.quality = max(10, min(100, int(msg.get("quality", 100))))
                self.lastHash = {}                    # re-send everything at the new quality
            elif op == "shutdown":                    # the host really wants the server gone
                self.allowQuit = True
                qt.QTimer.singleShot(0, lambda: slicer.util.mainWindow().close())
            elif op == "a11yQuery":
                self.lastA11ySig = None; self.lastA11y = 0
            elif op == "a11yClick":
                self._a11y_click(msg)
            elif op == "a11yFocus":
                w = self._a11y_widget(msg)
                if w is not None:
                    w.setFocus()
                self.lastA11y = 0
            elif op == "a11ySet":
                self._a11y_set(msg)
        except Exception as e:  # noqa: BLE001
            client.send_text(json.dumps({"ev": "error", "op": op, "error": repr(e)}))

    def _target(self, msg):
        root = self.regionWidgets.get(msg.get("region"))
        if root is None:
            return None, None, None
        p = qt.QPoint(int(msg.get("x", 0)), int(msg.get("y", 0)))
        popup = qt.QApplication.activePopupWidget()
        if popup is not None and str(popup) != str(root) and str(popup) != str(root.window()):
            if msg.get("type") == "down":
                popup.close()
        t = root.childAt(p) or root
        local = t.mapFrom(root, p)
        return t, local, t.mapToGlobal(local)

    def _pointer(self, msg):
        kind = msg.get("type")
        t, local, gp = self._target(msg)
        if t is None:
            return
        if kind in ("move", "up") and self.pressTarget is not None:
            t = self.pressTarget
            local = t.mapFromGlobal(gp)
        etype = {"move": qt.QEvent.MouseMove, "down": qt.QEvent.MouseButtonPress,
                 "up": qt.QEvent.MouseButtonRelease, "dblclick": qt.QEvent.MouseButtonDblClick}.get(kind)
        if etype is None:
            return
        button = _BUTTON.get(int(msg.get("button", 0)), qt.Qt.LeftButton) if kind != "move" else qt.Qt.NoButton
        ev = qt.QMouseEvent(etype, qt.QPointF(local), qt.QPointF(gp), button, _buttons(int(msg.get("buttons", 0))), _mods(msg.get("mods")))
        # The window-system staging a real click gets before the widget sees it (QWidgetWindow does this
        # for native input; sendEvent() straight to the child skips it -- typing after a click went to the
        # previously focused widget, hover styling never changed, sliders only page-stepped):
        if kind == "move" and self.pressTarget is None:
            self._stage_hover(t, local, gp)
        if kind == "down":
            self.pressTarget = t
            self._stage_focus(t, gp)
        qt.QApplication.sendEvent(t, ev)
        if kind == "up":
            self.pressTarget = None
        if kind == "move":
            self._report_cursor(t)

    def _stage_focus(self, t, gp):
        """Focus-on-click by Qt's focus policy (walk up to the first widget accepting ClickFocus), and make the
        target's window the active window (popups, focus frames and shortcuts depend on it)."""
        try:
            win = t.window()
            if win is not None and str(qt.QApplication.activeWindow()) != str(win):
                win.activateWindow()
                try:
                    qt.QApplication.setActiveWindow(win)      # offscreen/hidden windows never get activated by a window system
                except Exception:  # noqa: BLE001
                    pass
            w = t
            while w is not None:
                if int(w.focusPolicy) & int(qt.Qt.ClickFocus) and w.isEnabled():
                    if str(qt.QApplication.focusWidget()) != str(w):
                        w.setFocus(qt.Qt.MouseFocusReason)
                    break
                w = w.parentWidget()
        except Exception:  # noqa: BLE001
            pass

    def _stage_hover(self, t, local, gp):
        """Enter/Leave (+ HoverEnter/HoverMove for WA_Hover widgets) when the widget under the pointer changes."""
        try:
            prev = self.hoverTarget
            same = prev is not None and str(prev) == str(t)
            if not same:
                if prev is not None:
                    try:
                        qt.QApplication.sendEvent(prev, qt.QEvent(qt.QEvent.Leave))
                        if prev.testAttribute(qt.Qt.WA_Hover):
                            qt.QApplication.sendEvent(prev, qt.QHoverEvent(qt.QEvent.HoverLeave, qt.QPointF(-1, -1), qt.QPointF(gp), qt.QPointF(local)))
                    except Exception:  # noqa: BLE001
                        pass
                self.hoverTarget = t
                try:
                    qt.QApplication.sendEvent(t, qt.QEnterEvent(qt.QPointF(local), qt.QPointF(t.mapTo(t.window(), local)), qt.QPointF(gp)))
                except Exception:  # noqa: BLE001
                    qt.QApplication.sendEvent(t, qt.QEvent(qt.QEvent.Enter))
                if t.testAttribute(qt.Qt.WA_Hover):
                    qt.QApplication.sendEvent(t, qt.QHoverEvent(qt.QEvent.HoverEnter, qt.QPointF(local), qt.QPointF(gp), qt.QPointF(-1, -1)))
            elif t.testAttribute(qt.Qt.WA_Hover):
                qt.QApplication.sendEvent(t, qt.QHoverEvent(qt.QEvent.HoverMove, qt.QPointF(local), qt.QPointF(gp), qt.QPointF(local)))
        except Exception:  # noqa: BLE001
            pass

    def _report_cursor(self, t):
        try:
            c = t.cursor                          # PythonQt: QWidget.cursor is a property
            c = c() if callable(c) else c
            shape = int(c.shape())
        except Exception:  # noqa: BLE001
            return
        if shape != self.lastCursor:
            self.lastCursor = shape
            self._broadcast_text({"ev": "cursor", "shape": _CURSORS.get(shape, "default")})

    def _hover(self, msg):
        t, local, gp = self._target(msg)
        if t is None:
            return
        qt.QApplication.sendEvent(t, qt.QHelpEvent(qt.QEvent.ToolTip, local, gp))   # QToolTip -> a top-level -> popup region

    def _wheel(self, msg):
        t, local, gp = self._target(msg)
        if t is None:
            return
        ev = qt.QWheelEvent(qt.QPointF(local), qt.QPointF(gp), qt.QPoint(0, 0),
                            qt.QPoint(int(-msg.get("dx", 0)), int(-msg.get("dy", 0))),
                            _buttons(int(msg.get("buttons", 0))), _mods(msg.get("mods")), qt.Qt.NoScrollPhase, False)
        qt.QApplication.sendEvent(t, ev)

    def _key(self, msg):
        key = msg.get("key", "")
        text = msg.get("text", "")
        qk = _KEYMAP.get(key)
        if qk is None:
            qk = ord(key.upper()) if len(key) == 1 else 0
            if len(key) == 1 and not text:
                text = key
        etype = qt.QEvent.KeyPress if msg.get("type") == "down" else qt.QEvent.KeyRelease
        target = qt.QApplication.activePopupWidget() or qt.QApplication.focusWidget()
        if target is None:                       # no active window (offscreen): the window remembers its focus widget
            for win in ([self.hoverTarget.window()] if self.hoverTarget is not None else []) + [self.mw]:
                try:
                    fw = win.focusWidget()
                except Exception:  # noqa: BLE001
                    fw = None
                if fw is not None:
                    target = fw; break
        target = target or self.mw
        qt.QApplication.sendEvent(target, qt.QKeyEvent(etype, qk, _mods(msg.get("mods")), text))

    def stop(self):
        self.timer.stop()
        try: slicer.app.removeEventFilter(self.paintFilter)
        except Exception: pass  # noqa: BLE001
        self.server.stop()


def startGuiStream(port=2133):
    logic = GuiStream(port)
    print("\n  gui stream (WebSocket): ws://localhost:%d/\n" % port, flush=True)
    return logic
