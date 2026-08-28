"""
A stock Linux 3D Slicer as a REMOTE ModuleServer on Modal (S13).

    modal run ModuleServer/modal/moduleserver_modal.py            # prints the three tunnel URLs + token, stays up
    modal run ModuleServer/modal/moduleserver_modal.py --minutes 120

Then open the page against it (TLS tunnels -> wss/https, token on both sockets):

    slicer-app.html?gui=wss://<gui-host>/&ws=wss://<ws-host>/&http=https://<http-host>/mrson/&token=<token>

What runs in the container: the Slicer Linux nightly under Xvfb (the Linux package ships only the xcb QPA;
the main window is still WA_DontShowOnScreen-hidden by bootstrap.py so nothing paints to the X server
except our grabs), `ModuleServer/python/bootstrap.py` unchanged, ports forwarded by modal.forward()
(public TLS endpoints with a random hostname; the token is the second factor). No GPU: a ModuleServer
never renders (SlicerLive's views are local WebGPU).
"""
import os
import pathlib
import secrets
import subprocess
import time

import modal

ROOT = pathlib.Path(__file__).resolve().parents[2] if modal.is_local() else pathlib.Path("/app")   # in the container the script sits at /root
SLICER_URL = "https://download.slicer.org/download?os=linux&stability=nightly"
GUI, WS, HTTP, MCP = 2133, 2132, 2131, 2126

app = modal.App("slicerlive-moduleserver")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "curl", "ca-certificates", "xvfb", "xauth",
        # Slicer's runtime needs (same list as the official docker images, minus GL acceleration)
        "libglu1-mesa", "libgl1", "libegl1", "libpulse0", "libpulse-mainloop-glib0", "libnss3", "libasound2",
        "libxcb-cursor0", "libxcb-icccm4", "libxcb-image0", "libxcb-keysyms1", "libxcb-randr0", "libxcb-render-util0",
        "libxcb-shape0", "libxcb-xinerama0", "libxcb-xkb1", "libxkbcommon-x11-0", "libxi6", "libxt6", "libxrender1",
        "libfontconfig1", "libdbus-1-3", "libsm6", "libice6", "libxcomposite1", "libxcursor1", "libxdamage1", "libxrandr2",
        "libxss1", "libxtst6", "libgomp1", "libgbm1", "libdrm2",
    )
    .run_commands(
        # 500 MB from download.slicer.org: resume on transfer cuts (curl exit 18 happened on the first try)
        "mkdir -p /opt/slicer && cd /opt/slicer && for i in 1 2 3 4 5 6; do curl -sSL --retry 5 --retry-all-errors -C - -o slicer.tgz '%s' && break; sleep 5; done"
        " && tar xzf slicer.tgz --strip-components=1 && rm slicer.tgz && ls /opt/slicer/Slicer" % SLICER_URL,
    )
    # a second apt layer (after the 500 MB download layer, so that one stays cached): Qt6 + xcb runtime bits
    .apt_install("libpcre2-16-0", "libopengl0", "libxcb-util1", "libxcb-xfixes0", "libxcb-shm0", "libxcb-render0",
                 "libxcb-sync1", "libxcb-glx0", "libx11-xcb1", "libxcb-xinput0", "libgl1-mesa-dri", "libxkbcommon0",
                 "libxfixes3", "libxinerama1", "libfreetype6", "libpng16-16", "libjpeg62-turbo", "libtiff6", "libwebp7")
    .apt_install("gdb", "procps", "x11-utils", "strace")     # diagnostics layer
    # fonts (Qt renders nothing without them) + Debian's Qt5 and Qt6 QPA plugins: their `offscreen` plugin may
    # load into Slicer's bundled Qt of the same major.minor -> true headless without Xvfb (the packaging fix
    # is to ship qoffscreen in Slicer itself; this is the stop-gap)
    .apt_install("fonts-dejavu-core", "fontconfig", "libqt5gui5", "qt6-qpa-plugins")
    # gVisor + Qt 5.15 QThreadPool: an EXPIRED worker QThread is never seen as finished here, so the pool's
    # next task (the icon conversions in the main-window constructor, gdb 2026-08-28) is handed to a thread
    # that never runs -> deadlock. Never expire workers. Earliest Python hook = the slicer package init.
    .run_commands(
        "printf '\\n# ModuleServer (Modal/gVisor): never expire QThreadPool workers, see ModuleServer/modal/moduleserver_modal.py\\n"
        "try:\\n    import qt as _qt\\n    _qt.QThreadPool.globalInstance().setExpiryTimeout(-1)\\n"
        "    open(\"/tmp/expiry.txt\", \"w\").write(\"expiry=%%d\" %% _qt.QThreadPool.globalInstance().expiryTimeout)\\n"
        "except Exception as _e:\\n    open(\"/tmp/expiry.txt\", \"w\").write(repr(_e))\\n' >> /opt/slicer/bin/Python/slicer/__init__.py",
        "tail -8 /opt/slicer/bin/Python/slicer/__init__.py")
)
if modal.is_local():
    image = (
        image.add_local_dir(str(ROOT / "ModuleServer" / "python"), remote_path="/app/ModuleServer/python")
        .add_local_dir(str(ROOT / "LiveStory" / "LiveStoryLib"), remote_path="/app/LiveStory/LiveStoryLib")
        .add_local_file(str(pathlib.Path.home() / "slicer" / "slicer-skill" / "slicer-mcp-server.py"), remote_path="/app/slicer-mcp-server.py")
    )


@app.function(image=image, timeout=6 * 3600, cpu=4, memory=8192)
def serve(minutes: int = 60, token: str = ""):
    token = token or secrets.token_urlsafe(18)
    xvfb = subprocess.Popen(["Xvfb", ":9", "-screen", "0", "2560x1600x24", "+extension", "GLX", "-nolisten", "tcp"])
    # xcb on Xvfb WITH Mesa's software GLX (llvmpipe): Slicer's main window + modules deadlock when there is
    # no OpenGL at all (Debian's qoffscreen has none; QT_XCB_GL_INTEGRATION=none reproduced it) -- the same
    # headless recipe Slicer's own CI uses (xvfb-run). The views stay hidden; SlicerLive renders locally.
    env = dict(os.environ,
               DISPLAY=":9", QT_QPA_PLATFORM="xcb", LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe",
               MODULESERVER_ROOT="/app", MODULESERVER_STATE="/tmp/moduleserver.json", MODULESERVER_PLATFORM="xcb",
               MODULESERVER_ROLES="app,module", MODULESERVER_HTTP_PORT=str(HTTP), MODULESERVER_WS_PORT=str(WS),
               MODULESERVER_MCP_PORT=str(MCP), MODULESERVER_GUI_PORT=str(GUI), MODULESERVER_MCP_SERVER="/app/slicer-mcp-server.py",
               MODULESERVER_SHOW="0", MODULESERVER_TOKEN=token, PYTHONUNBUFFERED="1", XDG_RUNTIME_DIR="/tmp/runtime-root")
    # Slicer through a pty: its stdio is block-buffered otherwise (a traceback can stay invisible for the
    # process lifetime); a tty makes it line-buffered, and a thread copies the pty into /tmp/slicer.log.
    import pty, threading
    master, slave = pty.openpty()
    # SimpleFilters' module __init__ never returns in this sandbox (diagnosed 2026-08-28 with strace: the last
    # files opened are SimpleFilters.pyc + its icon, then the process idles forever; every other module is fine)
    ignore = os.environ.get("MODULESERVER_IGNORE_MODULES", "SimpleFilters")
    # taskset -c 0: with >1 CPU visible Qt converts icon images on the global QThreadPool and waits on a
    # semaphore; in this sandbox, once modules are loaded, the pool never runs those segments and the main
    # window constructor deadlocks in qSlicerViewersToolBarPrivate::init (gdb, 2026-08-28). One CPU
    # visible -> QThread::idealThreadCount()==1 -> single-threaded conversion -> no deadlock.
    slicer = subprocess.Popen(["/usr/bin/taskset", "-c", "0", "/opt/slicer/Slicer", "--no-splash", "--ignore-slicerrc", "--modules-to-ignore", ignore, "--python-script", "/app/ModuleServer/python/bootstrap.py"],
                              env=env, stdout=slave, stderr=slave, stdin=slave, close_fds=True)
    os.close(slave)
    def pump():
        with open("/tmp/slicer.log", "ab") as log:
            while True:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return
                if not data:
                    return
                log.write(data); log.flush()
    threading.Thread(target=pump, daemon=True).start()
    with modal.forward(GUI) as gui, modal.forward(WS) as ws, modal.forward(HTTP) as http:
        t0 = time.time()
        while not os.path.exists("/tmp/moduleserver.json"):
            if os.path.exists("/tmp/moduleserver.json.log"):
                emitted = open("/tmp/moduleserver.json.log").read()
                if '"ERROR"' in emitted:
                    print("bootstrap ERROR:\n" + emitted[-4000:]); raise SystemExit("bootstrap failed")
            if slicer.poll() is not None:
                print(open("/tmp/slicer.log", "rb").read().decode(errors="replace")[-4000:])
                # the usual cause is a missing shared library: say which, for every Slicer/Qt binary
                for exe in ("/opt/slicer/bin/SlicerApp-real", "/opt/slicer/lib/Slicer-5.13/libqSlicerBaseQTGUI.so"):
                    r = subprocess.run("ldd %s 2>/dev/null | grep 'not found'" % exe, shell=True, capture_output=True, text=True)
                    print("ldd", exe, "->", r.stdout.strip() or "all resolved")
                raise SystemExit("Slicer exited before READY")
            if time.time() - t0 > 600:
                print(open("/tmp/slicer.log", "rb").read().decode(errors="replace")[-4000:])
                raise SystemExit("no READY within 10 min")
            time.sleep(2)
            if int(time.time() - t0) % 30 < 2:                       # progress every ~30 s: last non-GL-spam lines
                lines = [l for l in open("/tmp/slicer.log", "rb").read().decode(errors="replace").splitlines()
                         if l.strip() and "OpenGL context" not in l and "Failed to create context" not in l]
                stages = open("/tmp/moduleserver.json.log").read().strip().replace("\n", " ") if os.path.exists("/tmp/moduleserver.json.log") else "(no emit log)"
                wins = subprocess.run("DISPLAY=:9 xwininfo -root -tree 2>/dev/null | grep -c '^ *0x'", shell=True, capture_output=True, text=True).stdout.strip()
                stages += " | xwindows=" + wins
                print("... %3.0f s  %d lines; stages: %s; tail: %s" % (time.time() - t0, len(lines), stages[-300:], " | ".join(l[:140] for l in lines[-4:])), flush=True)
                if 58 <= time.time() - t0 < 62:
                    print("--- log head ---\n" + "\n".join(lines[:40]) + "\n--- end head ---", flush=True)
                    ps = subprocess.run("ps -eo pid,pcpu,rss,etime,args | cut -c1-150; ls -la /tmp", shell=True, capture_output=True, text=True)
                    print("--- ps/tmp ---\n" + ps.stdout + "--- end ---", flush=True)
        print("READY after %.0f s" % (time.time() - t0))
        wss = lambda u: u.replace("https://", "wss://")   # noqa: E731
        print("gui  =", wss(gui.url) + "/")
        print("ws   =", wss(ws.url) + "/")
        print("http =", http.url + "/mrson/")
        print("token=", token)
        print("page : slicer-app.html?gui=%s/&ws=%s/&http=%s/mrson/&token=%s" % (wss(gui.url), wss(ws.url), http.url, token))
        deadline = time.time() + minutes * 60
        while time.time() < deadline and slicer.poll() is None:
            time.sleep(5)
    slicer.terminate(); xvfb.terminate()


@app.function(image=image, timeout=1800, cpu=4, memory=8192)
def diag():
    """With QThreadPool expiry disabled: does a non-testing main-window startup run its --python-code?"""
    sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True).stdout   # noqa: E731
    off = dict(os.environ, PYTHONUNBUFFERED="1", XDG_RUNTIME_DIR="/tmp/runtime-root", HOME="/root",
               QT_QPA_PLATFORM="offscreen", QT_QPA_PLATFORM_PLUGIN_PATH="/usr/lib/x86_64-linux-gnu/qt5/plugins/platforms")
    code = "import qt, slicer; open('/tmp/marker-code','w').write('mw=%s' % (slicer.util.mainWindow() is not None)); qt.QTimer.singleShot(5000, lambda: open('/tmp/marker-alive','w').write('alive'))"
    def run(name, args, seconds=150):
        sh("rm -f /tmp/marker-* /tmp/expiry.txt"); t0 = time.time()
        p = subprocess.Popen(["/opt/slicer/Slicer", "--no-splash", "--ignore-slicerrc", "--python-code", code] + args, env=off, stdout=open("/tmp/o.txt", "wb"), stderr=subprocess.STDOUT)
        while time.time() - t0 < seconds and p.poll() is None and not os.path.exists("/tmp/marker-alive"):
            time.sleep(2)
        time.sleep(1)
        print("=== %s: rc=%s after %.0f s | markers: %s | %s | expiry: %s" % (name, p.poll(), time.time() - t0, sh("ls /tmp/marker-* 2>/dev/null | tr '\\n' ' '"), sh("cat /tmp/marker-code 2>/dev/null"), sh("cat /tmp/expiry.txt 2>/dev/null")), flush=True)
        if p.poll() is None: sh("pkill -9 -f SlicerApp-real"); time.sleep(1)
    run("E main window, all modules but SimpleFilters", ["--modules-to-ignore", "SimpleFilters"])
    run("F main window, everything", [])


@app.local_entrypoint()
def main(minutes: int = 60, token: str = "", probe: bool = False):
    if probe:
        diag.remote(); return
    serve.remote(minutes, token)
