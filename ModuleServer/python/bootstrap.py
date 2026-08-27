"""ModuleServer bootstrap -- runs INSIDE a stock 3D Slicer to turn it into a ModuleServer.

A ModuleServer is a headless Slicer that (1) mirrors LiveScene state over the mrson channels and
(2) will stream legacy module GUIs to a browser (gui_stream, M2). It is one of possibly many
servers a SlicerLive page talks to; it never owns the scene (LiveScene is authoritative).

Launched by ModuleServer/launch.ts:
    Slicer --no-splash --ignore-slicerrc --python-script ModuleServer/python/bootstrap.py

Configuration is by environment (the launcher sets these):
    MODULESERVER_ROOT        SlicerLive repo root (to import LiveStory/LiveStoryLib)
    MODULESERVER_STATE       path of the JSON state file to write once READY
    MODULESERVER_HTTP_PORT   mrson HTTP (scene.json + blobs)      default 2131
    MODULESERVER_WS_PORT     mrson live WebSocket (events/ops)   default 2132
    MODULESERVER_MCP_PORT    MCP server port, 0 = disabled        default 2126
    MODULESERVER_MCP_SERVER  path to slicer-mcp-server.py (needed if MCP port != 0)
    MODULESERVER_SHOW        "1" = keep the main window visible (debugging)

Why a REAL, SHOWN-but-invisible main window and not --no-main-window: with --no-main-window
slicer.app.layoutManager() is None and installed extensions crash at startup (SlicerHeart
registers custom layouts in onStartupCompleted). Legacy modules assume a main window exists.
Invisibility = Qt::WA_DontShowOnScreen on the main window and (via a global event filter) on
every top-level widget at show time, plus dropping the Dock icon on macOS -- see _make_invisible.
Moving windows off-screen does NOT work (macOS clamps them back and re-clamps popups onto the
screen), and macOS bundles ship only the cocoa QPA plugin (no "offscreen"). Linux containers
can additionally use QT_QPA_PLATFORM=offscreen or xvfb.

ASCII only in this file (Slicer style).
"""
import json
import os
import sys
import traceback

import qt
import slicer


def _env(name, default=None):
    v = os.environ.get(name)
    return default if v is None or v == "" else v


STATE_PATH = _env("MODULESERVER_STATE")
ROOT = _env("MODULESERVER_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
HTTP_PORT = int(_env("MODULESERVER_HTTP_PORT", 2131))
WS_PORT = int(_env("MODULESERVER_WS_PORT", 2132))
MCP_PORT = int(_env("MODULESERVER_MCP_PORT", 2126))
MCP_SERVER = _env("MODULESERVER_MCP_SERVER")
GUI_PORT = int(_env("MODULESERVER_GUI_PORT", 2133))
SHOW = _env("MODULESERVER_SHOW", "0") == "1"
PLATFORM = _env("MODULESERVER_PLATFORM", "")
ROLES = [r for r in _env("MODULESERVER_ROLES", "module").split(",") if r]


def _emit(obj):
    """One machine-readable line on stdout (the launcher scans for READY/ERROR), flushed."""
    print(json.dumps(obj), flush=True)


class _NoScreenFilter(qt.QObject):
    """Global event filter: any top-level widget about to be shown (popups, dialogs, tool windows,
    message boxes, file dialogs) gets Qt::WA_DontShowOnScreen just before Qt would create/show its
    native window. The widget is still isVisible() and paints via grab()/render() -- which is all the
    GUI stream needs -- but nothing ever reaches the user's screen. Measured on macOS 2026-08-27:
    QComboBoxPrivateContainer and QMessageBox both 'visible', never exposed, grab()-able. This is
    what makes the ModuleServer invisible: moving windows off-screen is clamped back by macOS and
    popups are re-clamped onto the screen, so an attribute at show time is the only reliable seam."""

    def eventFilter(self, obj, ev):
        try:
            if (ev.type() == qt.QEvent.Show and obj.isWidgetType() and obj.isWindow()
                    and not obj.testAttribute(qt.Qt.WA_DontShowOnScreen)):
                obj.setAttribute(qt.Qt.WA_DontShowOnScreen, True)
        except Exception:  # noqa: BLE001
            pass
        return False


def _drop_dock_icon():
    """macOS: turn this process into a UIElement (no Dock icon, no menu bar, never steals focus)
    at runtime via NSApp.setActivationPolicy(NSApplicationActivationPolicyAccessory). No PyObjC
    and no Info.plist edit needed; QT_MAC_DISABLE_FOREGROUND_APPLICATION_TRANSFORM does nothing
    for a bundled app. Verified with `lsappinfo`: type Foreground -> UIElement."""
    if sys.platform != "darwin":
        return False
    import ctypes
    import ctypes.util
    objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc"))
    objc.objc_getClass.restype = ctypes.c_void_p
    objc.sel_registerName.restype = ctypes.c_void_p
    objc.objc_msgSend.restype = ctypes.c_void_p
    objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    nsapp = objc.objc_msgSend(objc.objc_getClass(b"NSApplication"), objc.sel_registerName(b"sharedApplication"))
    send = ctypes.cast(objc.objc_msgSend, ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long))
    return bool(send(nsapp, objc.sel_registerName(b"setActivationPolicy:"), 1))


def _make_invisible():
    """Keep a REAL, SHOWN main window (layoutManager, module panels, timers all behave normally --
    legacy modules assume one) but never let it, or anything it opens, reach the screen.
    --show / MODULESERVER_SHOW=1 skips all of this for debugging."""
    mw = slicer.util.mainWindow()
    if SHOW:
        return {"visible": True}
    slicer.app.setQuitOnLastWindowClosed(False)              # invisible windows don't count as 'open' (QTBUG-17994)
    slicer.moduleServerNoScreen = _NoScreenFilter()          # keep a reference or it is GC'd
    slicer.app.installEventFilter(slicer.moduleServerNoScreen)
    dock = False
    try:
        dock = _drop_dock_icon()
    except Exception as e:  # noqa: BLE001
        _emit({"warn": "could not drop dock icon", "error": str(e)})
    if mw is not None:
        mw.hide()
        mw.setAttribute(qt.Qt.WA_DontShowOnScreen, True)
        mw.show()
    wh = mw.windowHandle() if mw is not None else None
    return {"visible": False, "onScreen": bool(wh.isVisible()) if wh else False, "dockIconDropped": dock}


def _module_names():
    """Loaded module names (what this server can serve). Scripted + loadable; CLIs included."""
    mm = slicer.app.moduleManager()
    try:
        return sorted(str(n) for n in mm.modulesNames())
    except Exception:  # noqa: BLE001
        return []


def _start_mrson():
    livestory = os.path.join(ROOT, "LiveStory")
    if livestory not in sys.path:
        sys.path.insert(0, livestory)
    from LiveStoryLib import mrson_server, mrson_live  # noqa: E402
    slicer.moduleServerHttp = mrson_server.startMrsonServer(HTTP_PORT)
    slicer.moduleServerLive = mrson_live.startMrsonLive(WS_PORT)
    return {"http": slicer.moduleServerHttp.port, "ws": WS_PORT}


def _start_gui():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import gui_stream  # noqa: E402
    slicer.moduleServerGui = gui_stream.startGuiStream(GUI_PORT)
    return GUI_PORT


def _start_mcp():
    if MCP_PORT == 0 or not MCP_SERVER:
        return None
    if not os.path.exists(MCP_SERVER):
        _emit({"warn": "MCP server script not found; MCP disabled", "path": MCP_SERVER})
        return None
    namespace = {"__file__": MCP_SERVER, "__name__": "slicer_mcp_server"}
    with open(MCP_SERVER) as f:
        exec(compile(f.read(), MCP_SERVER, "exec"), namespace)
    # autoAllow: this instance was launched by the ModuleServer launcher for automation; it holds
    # no user data of its own (LiveScene is the source of truth). Never set this on a user's Slicer.
    slicer.moduleServerMcp = namespace["startMcpServer"](port=MCP_PORT, autoAllow=True)
    return slicer.moduleServerMcp.port


def main():
    invisible = _make_invisible()
    ports = _start_mrson()
    mcp = _start_mcp()
    if mcp is not None:
        ports["mcp"] = mcp
    ports["gui"] = _start_gui()
    state = {
        "ready": True,
        "pid": os.getpid(),
        "ports": ports,
        "slicer": {"version": slicer.app.applicationVersion, "path": slicer.app.slicerHome,
                   "platform": str(getattr(qt.QGuiApplication, "platformName", "") or "")},
        "modules": _module_names(),
        "invisible": invisible,
        "role": "moduleserver",
        "roles": ROLES,                    # app = streams main-window chrome + menus; module = module panels
        "qpa": PLATFORM,
        "authority": "replica",     # LiveScene owns the scene; this server proposes ops
    }
    if STATE_PATH:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w") as f:
            json.dump(state, f)
    _emit({"READY": state})


try:
    main()
except Exception:  # noqa: BLE001
    _emit({"ERROR": traceback.format_exc()})
    qt.QTimer.singleShot(0, slicer.app.quit)
