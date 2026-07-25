"""LiveStory — author SlicerLive scenes and narrated "stories" from 3D Slicer.

Inspired by MinervaStory (Harvard LSP / CyCIF): capture the equivalent of
SceneViews — a 3D camera + slice planes + visibilities, plus authored text and
out-links — and export them to the SlicerLive WebGPU wire format, then preview
them in a local browser served straight out of Slicer's web server.

  * Export      — serialize the loaded MRML scene to SlicerLive JSON + zarr blobs.
  * Capture     — snapshot the current viewpoint + caption as a story page.
  * Preview     — start Slicer's web server on the workspace and open the browser.

The renderer source lives in ../render; the committed viewer bundle (real.html +
real.js) is copied into the workspace so previews need no external network.
"""
import os
import shutil
import webbrowser

import slicer
from slicer.ScriptedLoadableModule import (
    ScriptedLoadableModule,
    ScriptedLoadableModuleLogic,
    ScriptedLoadableModuleWidget,
)

try:
    import qt
    import ctk
except ImportError:  # allows importing the logic headlessly (e.g. via MCP)
    qt = ctk = None

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_ASSETS = os.path.join(MODULE_DIR, "web")       # canonical static viewer + story.html (committed)
WORKSPACE = os.path.join(MODULE_DIR, "workspace")  # generated docroot: web assets copied + scenes exported


class LiveStory(ScriptedLoadableModule):
    def __init__(self, parent):
        ScriptedLoadableModule.__init__(self, parent)
        parent.title = "LiveStory"
        parent.categories = ["SlicerLive"]
        parent.dependencies = []
        parent.contributors = ["SlicerLive"]
        parent.helpText = (
            "Author SlicerLive scenes and narrated stories (SceneViews-equivalent) "
            "and preview them in the browser via the SlicerLive WebGPU renderer."
        )
        parent.acknowledgementText = "Inspired by MinervaStory."


class LiveStoryLogic(ScriptedLoadableModuleLogic):
    """Export + host, independent of any GUI (usable directly from Python/MCP)."""

    def __init__(self):
        ScriptedLoadableModuleLogic.__init__(self)
        self._server = None       # WebServerLogic instance
        self._serverPort = None
        self.workspace = WORKSPACE

    # -- export -------------------------------------------------------------
    def scenesDir(self):
        d = os.path.join(self.workspace, "scenes")
        os.makedirs(d, exist_ok=True)
        return d

    def exportScene(self, name="scene"):
        """Serialize the live MRML scene -> workspace/scenes/<name>.json (+ blobs)."""
        from LiveStoryLib import serialize
        import importlib
        importlib.reload(serialize)
        return serialize.serialize_scene(self.scenesDir(), name)

    # -- story --------------------------------------------------------------
    def capturePage(self, name, scene_file, title="", text="", links=None):
        """Append a captured viewpoint (+caption) to <name>.story.json."""
        from LiveStoryLib import story
        import importlib
        importlib.reload(story)
        st = story.load_story(self.scenesDir(), name, scene_file, title=name)
        st["pages"].append(story.capture_page(title=title, text=text, links=links))
        story.save_story(self.scenesDir(), name, st)
        return len(st["pages"])

    # -- hosting ------------------------------------------------------------
    def ensureAssets(self):
        """Copy the committed web assets (viewer bundle + story.html) into the workspace docroot."""
        os.makedirs(self.workspace, exist_ok=True)
        for root, _dirs, files in os.walk(WEB_ASSETS):
            rel = os.path.relpath(root, WEB_ASSETS)
            dst = os.path.join(self.workspace, rel) if rel != "." else self.workspace
            os.makedirs(dst, exist_ok=True)
            for fn in files:
                shutil.copy2(os.path.join(root, fn), os.path.join(dst, fn))

    def startPreviewServer(self, port=None):
        """Serve the workspace over HTTP via a StaticPagesRequestHandler. Returns the port."""
        from WebServerLib import StaticPagesRequestHandler
        import WebServer

        self.ensureAssets()
        self.stopPreviewServer()
        # StaticPagesRequestHandler os.path.joins docroot with a *bytes* uri, so docroot
        # must be bytes too (matches WebServerLogic's own `moduleDirectory + b"/..."`).
        handler = StaticPagesRequestHandler(self.workspace.encode())
        # The static handler os.path.joins the raw URI, so a `?scene=…` query would make it
        # look for a file literally named "real.html?scene=…" (404). Strip the query for the
        # file lookup; the browser keeps location.search, so the viewer still reads ?scene=.
        handler.uriRewriteRules.append((r"([^?]*)\?.*", "{0}"))
        self._server = WebServer.WebServerLogic(
            port=port or 8788,
            requestHandlers=[handler],
            enableCORS=True,
        )
        self._server.start()
        self._serverPort = self._server.port
        return self._serverPort

    def stopPreviewServer(self):
        if self._server is not None:
            self._server.stop()
            self._server = None
            self._serverPort = None

    def previewUrl(self, name="scene", story=False):
        if self._serverPort is None:
            return None
        page = "story.html" if story else "viewer/real.html"
        return f"http://localhost:{self._serverPort}/{page}?scene=/scenes/{name}.json"


class LiveStoryWidget(ScriptedLoadableModuleWidget):
    def setup(self):
        ScriptedLoadableModuleWidget.setup(self)
        self.logic = LiveStoryLogic()

        box = ctk.ctkCollapsibleButton()
        box.text = "LiveStory"
        self.layout.addWidget(box)
        form = qt.QFormLayout(box)

        self.nameEdit = qt.QLineEdit("scene")
        form.addRow("Scene name:", self.nameEdit)

        self.exportButton = qt.QPushButton("Export scene → SlicerLive JSON")
        self.exportButton.connect("clicked()", self.onExport)
        form.addRow(self.exportButton)

        self.pageTitle = qt.QLineEdit()
        form.addRow("Page title:", self.pageTitle)
        self.pageText = qt.QPlainTextEdit()
        self.pageText.setPlaceholderText("Caption / lesson text (markdown). Add links as `label|url` per line below.")
        form.addRow("Page text:", self.pageText)
        self.pageLinks = qt.QPlainTextEdit()
        self.pageLinks.setPlaceholderText("label|https://en.wikipedia.org/...")
        self.pageLinks.setMaximumHeight(60)
        form.addRow("Links:", self.pageLinks)
        self.captureButton = qt.QPushButton("Capture current view as story page")
        self.captureButton.connect("clicked()", self.onCapture)
        form.addRow(self.captureButton)

        self.previewButton = qt.QPushButton("Start preview server + open browser")
        self.previewButton.connect("clicked()", self.onPreview)
        form.addRow(self.previewButton)

        self.status = qt.QLabel("")
        self.status.setWordWrap(True)
        form.addRow(self.status)
        self.layout.addStretch(1)

    def onExport(self):
        s = self.logic.exportScene(self.nameEdit.text)
        self.status.setText(f"Exported {s['nodes']} nodes ({s['volumes']} volume) → {s['scene']}")

    def onCapture(self):
        links = []
        for line in self.pageLinks.plainText.splitlines():
            if "|" in line:
                lab, url = line.split("|", 1)
                links.append({"label": lab.strip(), "url": url.strip()})
        n = self.logic.capturePage(
            self.nameEdit.text, f"{self.nameEdit.text}.json",
            title=self.pageTitle.text, text=self.pageText.plainText, links=links,
        )
        self.status.setText(f"Captured page {n}.")

    def onPreview(self):
        port = self.logic.startPreviewServer()
        url = self.logic.previewUrl(self.nameEdit.text, story=True)
        webbrowser.open(url)
        self.status.setText(f"Serving workspace on :{port}\n{url}")
