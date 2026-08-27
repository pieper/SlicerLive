"""GUI stream (WS B) -- stream a Slicer main window's chrome + module panels to a client as pixels,
and take synthetic pointer/wheel/key events back. Runs inside the ModuleServer (headless Slicer).

Slicer-independent wire format (no Qt types; a non-Slicer server can implement the same):
  client -> server (JSON text):
    {"op":"subscribe", "dpr":1}             start streaming; server replies "regions" + "menus"
    {"op":"resize", "w":1440, "h":900}      size of the client's window; the app window follows it
    {"op":"pointer", "type":"move|down|up|dblclick", "region":id, "x":.., "y":..,
        "button":0|1|2, "buttons":bitmask, "mods":{"shift","ctrl","alt","meta"}}
    {"op":"wheel", "region":id, "x":..,"y":.., "dx":.., "dy":.., "mods":{...}}
    {"op":"key", "type":"down|up", "key":DOMkey, "text":"", "mods":{...}}
    {"op":"triggerAction", "id":"a12"}      fire a menu action (native menus on the client)
    {"op":"selectModule", "name":"SampleData"}
  server -> client:
    text  {"ev":"regions", "w","h", "viewport":{x,y,w,h}, "regions":[{id,kind,title,x,y,w,h,z}]}
          {"ev":"menus", "menus":[{title, items:[{id,text,shortcut,enabled,checkable,checked,sep,items?}]}]}
          {"ev":"title", "text"}
    binary <u32 BE header length><JSON header {"region","seq","w","h"}><PNG bytes>
Regions are the app window's parts in WINDOW coordinates: toolbars, docks (module panel, python
console), status bar, menu bar (clients with native menus ignore it), and every visible top-level
popup/dialog (kind "popup", z>0). The central layout viewport is reported but never streamed -- the
client renders its own views there (SlicerLive) and keeps them in sync over the mrson channel.

Frames: a QTimer grabs each region (QWidget.grab paints even though nothing is on screen -- see
bootstrap._make_invisible), PNG-encodes, and skips unchanged regions by hashing the PNG.
ASCII only.
"""
import hashlib
import json
import struct

import qt
import slicer

from mrson_ws import WsServer, WsClient   # tiny RFC6455 server shared with the mrson live channel

FRAME_MS = 66            # ~15 Hz grab cadence; change detection makes idle cost ~0 bytes


def _rect(w):
    g = w.geometry
    return [g.x(), g.y(), g.width(), g.height()]


def _win_pos(mw, w):
    """Top-left of widget `w` in main-window coordinates (works for children and top-levels)."""
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


class GuiStream:
    def __init__(self, port):
        self.mw = slicer.util.mainWindow()
        self.actions = {}        # action id -> QAction
        self.regionWidgets = {}  # region id -> QWidget
        self.lastHash = {}       # region id -> png hash
        self.seq = 0
        self.lastRegionsSig = None
        self.pressTarget = None  # implicit mouse grab while a button is down
        self.server = WsServer(port, on_message=self._on_message, on_close=self._on_close)
        self.subscribers = []
        self.timer = qt.QTimer()
        self.timer.setInterval(FRAME_MS)
        self.timer.connect("timeout()", self._tick)

    # ---- regions ----------------------------------------------------------------------------
    def regions(self):
        mw = self.mw
        out, widgets = [], {}

        def add(w, kind, rid=None, z=0, title=""):
            rid = rid or (w.objectName or ("%s@%x" % (w.className(), id(w))))
            if not w.isVisible() or w.width <= 0 or w.height <= 0:   # PythonQt: QWidget width/height are properties
                return
            x, y = _win_pos(mw, w)
            out.append({"id": rid, "kind": kind, "title": title, "x": x, "y": y, "w": w.width, "h": w.height, "z": z})
            widgets[rid] = w

        mb = mw.menuBar()
        if mb is not None:
            add(mb, "menubar", "menubar")
        for t in mw.findChildren("QToolBar"):
            if str(t.parent()) == str(mw):
                add(t, "toolbar")
        for d in mw.findChildren("QDockWidget"):
            add(d, "dock", title=d.windowTitle)
        add(mw.statusBar(), "statusbar", "statusbar")
        z = 1
        for w in qt.QApplication.topLevelWidgets():
            if w.isVisible() and str(w) != str(mw) and w.width > 0 and w.height > 0 and not w.isMinimized():
                add(w, "popup", "popup@%x" % id(w), z=z, title=w.windowTitle)
                z += 1
        vp = slicer.app.layoutManager().viewport()
        vx, vy = _win_pos(mw, vp)
        self.regionWidgets = widgets
        return {"ev": "regions", "w": mw.width, "h": mw.height,
                "viewport": {"x": vx, "y": vy, "w": vp.width, "h": vp.height}, "regions": out}

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
    def _png(self, w):
        img = w.grab()
        buf = qt.QBuffer(); buf.open(qt.QIODevice.WriteOnly)
        img.save(buf, "PNG"); buf.close()
        return bytes(buf.data().data()), img.width(), img.height()

    def _tick(self):
        if not self.subscribers:
            return
        reg = self.regions()
        sig = json.dumps(reg, sort_keys=True)
        if sig != self.lastRegionsSig:
            self.lastRegionsSig = sig
            self._broadcast_text(reg)
            gone = set(self.lastHash) - set(self.regionWidgets)
            for g in gone:
                self.lastHash.pop(g, None)
        for rid, w in self.regionWidgets.items():
            try:
                png, pw, ph = self._png(w)
            except Exception:  # noqa: BLE001
                continue
            h = hashlib.blake2b(png, digest_size=16).digest()
            if self.lastHash.get(rid) == h:
                continue
            self.lastHash[rid] = h
            self.seq += 1
            hdr = json.dumps({"region": rid, "seq": self.seq, "w": pw, "h": ph}).encode()
            self._broadcast_bin(struct.pack(">I", len(hdr)) + hdr + png)

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
                self.lastHash = {}; self.lastRegionsSig = None
                client.send_text(json.dumps({"ev": "title", "text": self.mw.windowTitle}))
                client.send_text(json.dumps(self.menus()))
                self.timer.start()
            elif op == "resize":
                self.mw.resize(int(msg["w"]), int(msg["h"]))
            elif op == "pointer":
                self._pointer(msg)
            elif op == "wheel":
                self._wheel(msg)
            elif op == "key":
                self._key(msg)
            elif op == "triggerAction":
                a = self.actions.get(msg.get("id"))
                if a is not None:
                    a.trigger()
            elif op == "selectModule":
                slicer.util.selectModule(msg.get("name"))
        except Exception as e:  # noqa: BLE001
            client.send_text(json.dumps({"ev": "error", "op": op, "error": repr(e)}))

    def _target(self, msg):
        """Resolve (target widget, local QPoint, global QPoint) for a region-relative point."""
        root = self.regionWidgets.get(msg.get("region"))
        if root is None:
            return None, None, None
        p = qt.QPoint(int(msg.get("x", 0)), int(msg.get("y", 0)))
        popup = qt.QApplication.activePopupWidget()
        if popup is not None and str(popup) != str(root) and str(popup) != str(root.window()):
            # Qt closes an open popup on a press outside it
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
            # implicit grab: deliver to the widget that received the press
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


def startGuiStream(port=2133):
    logic = GuiStream(port)
    print("\n  gui stream (WebSocket): ws://localhost:%d/\n" % port, flush=True)
    return logic
