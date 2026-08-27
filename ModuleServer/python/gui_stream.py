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
import struct
import time

import qt
import slicer

from mrson_ws import WsServer

FRAME_MS = 33
FULL_REFRESH_S = 2.0
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
        if not self.regionWidgets:
            return
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

    # ---- frames -----------------------------------------------------------------------------
    def _png(self, w, rect=None):
        img = w.grab(rect) if rect is not None else w.grab()
        buf = qt.QBuffer(); buf.open(qt.QIODevice.WriteOnly)
        img.save(buf, "PNG"); buf.close()
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
            hdr = json.dumps({"region": rid, "seq": self.seq, "x": rect.x() if rect else 0, "y": rect.y() if rect else 0, "w": pw, "h": ph}).encode()
            self._broadcast_bin(struct.pack(">I", len(hdr)) + hdr + png)
        self._watch_modal(now)

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
                client.send_text(json.dumps({"ev": "title", "text": self.mw.windowTitle}))
                client.send_text(json.dumps(self.menus()))
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
        if kind == "down":
            self.pressTarget = t
        qt.QApplication.sendEvent(t, ev)
        if kind == "up":
            self.pressTarget = None
        if kind == "move":
            self._report_cursor(t)

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
        target = qt.QApplication.activePopupWidget() or qt.QApplication.focusWidget() or self.mw
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
