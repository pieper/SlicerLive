# ModuleServer — legacy Slicer modules as sidecars of SlicerLive

Status: **M0 + GUI-stream POC done (2026-08-27)** — a stock 3D Slicer runs headless (Qt 6, `offscreen`
QPA, fully invisible) as an AppServer+ModuleServer; the 21-property parity harness passes; the stock
Slicer interface is hosted in the browser / in the Deno desktop app (see "Desktop POC"). M1 (authority
inversion, lazy bulk) pending.
Plan of record (v3, 2026-08-27, approved): the ordered steps S0-S15 and the view-area gap matrix live in
Steve's plan file; this document carries the architecture, the "whatabout" register, and the POC record,
and will become the third-party protocol reference.

## Why

SlicerLive is the application: `LiveScene` (mrson nodes + content-addressed blobs) is the source of
truth, stored in user-owned Sessions, rendered by the WebGPU renderers. Existing Slicer extensions
(258 repos; 71% pure Python, 740 files importing `vtk`, 317 pumping `processEvents()`) are **not
ported**. A 2026-08-26 evaluation of Qt-wasm / Pyodide / itk-wasm / vtk-wasm concluded that
cross-compiling or emulating Qt+PythonQt+VTK+MRML is a large diversion (three incompatible
Emscripten pins, no `QOpenGLWidget`, no nested event loops, no PythonQt-wasm, GPL-only Qt-wasm).
Instead, legacy code keeps running in a whole, unmodified Slicer — a **ModuleServer** — and the
*boundary* moves: the server is a replica that proposes ops, and its module GUIs are streamed as
pixels. This is lossless from day one and lets the server run anywhere (local process, Modal,
firewall-internal VM) inside whatever sandbox the platform offers.

## Shape

```
 Browser / desktop shell                        ModuleServer (headless stock Slicer)
 LiveScene (authoritative)   <-- WS A mrson --> MRML scene = partial replica (metadata-only
 WebGPU views, native Controls                  subscription; bulk pulled by hash when invoked)
 LegacyPanel <canvas>        <-- WS B gui  -->  gui_stream.py: widget grab -> frames,
   pointer/key -> synthetic events              synthetic QMouse/QKey events in
 ModuleRegistry: N servers, local or remote, each hosting some modules
```

Design requirements (from the plan):
- **Slicer-independent protocol.** Either end is replaceable (OHIF/MITK clients, non-Slicer module
  runtimes). Nothing Qt- or MRML-specific on the wire; `source.mrmlClass` is provenance only.
  Capabilities are declarative: `{modules, gpu, pip, phi-ok, bulk: lazy|eager, gui: stream|none}`.
- **Many servers, partial replicas.** Subscribe by node type, `metadataOnly`; bulk by content hash,
  cacheable and prefetchable.
- **Sessions on disk** (`SlicerLiveSessions/<id>/`: checkpoint + append-only op log + commits +
  `blobs/<hash>`) give autosave, undo/redo/branch/bookmarks; "save" = export the reachable set.
- **Conformance is the contract**: `render/test/conformance.ts` (Deno == browser) plus a
  protocol suite runnable against any server x client pair (M3).

## M0 — headless launch (done)

```
deno run --allow-run --allow-read --allow-write --allow-env ModuleServer/launch.ts [--slicer <app>] \
    [--http 2131] [--ws 2132] [--mcp 2126] [--show]
```
`launch.ts` spawns `Slicer --no-splash --ignore-slicerrc --python-script ModuleServer/python/bootstrap.py`,
tees the log to `~/.slicerlive/moduleserver/<ws>.log`, prints one `{"READY": {...}}` JSON line
(pid, ports, Slicer version, 173 module names on a 5.12 install with SlicerHeart), and writes the
same to `~/.slicerlive/moduleserver/moduleserver-<ws>.json`. `bootstrap.py` hides the main window,
starts the mrson HTTP (:2131) and live WebSocket (:2132) servers from `LiveStory/LiveStoryLib`
(imported, not copied — they migrate here in M1), and the MCP server (:2126, `autoAllow`) for
automation.

Verified: `render/test/parity-run.ts` → **21/21 properties round-trip both directions** with the
mirror page (`render/demos/mirror.html`) in a CDP Chrome. The harness gained `PARITY_TF_ID` because
`CreateDefaultVolumeRenderingNodes` numbers the transfer-function node after the VR presets.

### Invisible on macOS (measured; now in `bootstrap.py`)
Positional tricks fail: a window moved to (-20000,-20000) is **clamped** by macOS to x=-1224 (a 40 px
strip stays on screen), and a QComboBox popup from that parent is re-clamped **onto** the primary
screen. Spaces have no public create/assign API. Minimizing keeps a Dock tile. What works:
- `Qt::WA_DontShowOnScreen` on the main window before `show()` -> `isVisible()` true, QWindow never
  visible/exposed, `grab()` paints normally.
- A global `QApplication` event filter that sets the same attribute on every top-level widget at
  `QEvent::Show` (just before `show_sys`) -> popups (`QComboBoxPrivateContainer`), `QMessageBox`,
  non-native `QFileDialog` all "visible", never on screen, `grab()`-able for the GUI stream.
- Dock icon: `NSApp.setActivationPolicy(Accessory)` via `ctypes`/`objc_msgSend` at runtime ->
  `lsappinfo` type `Foreground` -> `UIElement`. `QT_MAC_DISABLE_FOREGROUND_APPLICATION_TRANSFORM`
  does nothing for a bundled app.
`--show` / `MODULESERVER_SHOW=1` disables all of it for debugging. Windows/Linux: see the platform
notes below (research in progress).

### Windows and Linux (researched 2026-08-27; mechanism verified in Qt 5.15 source, not yet run)
The recipe is portable because `WA_DontShowOnScreen` is implemented in QtWidgets, not the QPA
plugin: `show_sys()` returns before `QWindow::setVisible(true)` (no HWND shown, no X window mapped,
no wl_surface created), the repaint manager never flushes to the platform surface, and `grab()` /
`render()` paint the backing store regardless. `QEvent::Show` is sent before `show_sys()` on every
platform, so the show-time filter is in time everywhere. The attribute also forces `QFileDialog` /
`QMessageBox` to the in-process Qt widgets (native dialogs would ignore it), `QMenu` handles it
explicitly, `QOpenGLWidget` renders to its own `QOffscreenSurface` and only warns on context failure.
- **Official packages ship exactly one QPA plugin per OS** (`CMake/SlicerCPack.cmake:33-63`):
  `cocoa` / `xcb` / `windows`. No `offscreen` or `minimal` anywhere, so the attribute route is the
  only one that works against unmodified Slicer on all three platforms.
- **Windows**: no Dock-icon equivalent to drop; a never-shown HWND has no taskbar button or Alt-Tab
  entry. Open risk: a non-interactive session (service / session 0 / SSH without desktop) — Qt 5.15's
  `windows` QPA has no placeholder screen, so if `EnumDisplayMonitors` yields nothing
  `primaryScreen()` is null and Slicer crashes. Test; prefer a logged-in (locked/RDP-disconnected)
  session. RDP-disconnected only hurts GL views, which the ModuleServer does not use.
- **Linux server/container**: `xvfb-run -a Slicer ...` (the established Slicer pattern; `xcb` needs
  an X server) plus the same filter. Xvfb even gives Mesa GL. Desktop X11 session: unmapped window =
  no taskbar/pager entry. Wayland desktops run stock Slicer under XWayland, so the same applies;
  the attribute also sidesteps Wayland's no-positioning / popup-needs-parent rules.
- **Both**: `setQuitOnLastWindowClosed(False)` (invisible windows don't keep the app alive);
  `--no-splash` (the splash shows before the filter exists); a modal `exec()` still blocks the
  nested loop normally, so a module that pops a dialog will *hang waiting for a click* rather than
  crash — the GUI stream must surface it (or auto-dismiss it), never ignore it.

### Hard-won details
- **macOS bundles ship only the `cocoa` QPA plugin** — `QT_QPA_PLATFORM=offscreen` fails
  ("Available platform plugins are: cocoa"), and Homebrew's `libqoffscreen` can't be mixed in (two
  Qt copies). Headless on macOS = cocoa with a **hidden real main window**. Linux containers can use
  `offscreen`/xvfb.
- **Do not use `--no-main-window`**: `slicer.app.layoutManager()` becomes `None` and installed
  extensions crash in `onStartupCompleted` (SlicerHeart registers custom layouts). Legacy modules
  assume a main window; hiding it is free and lossless.
- `--python-script` needs an **absolute path**; `--python-code "exec(open(...).read())"` also works.
- PythonQt: `qt.QGuiApplication.platformName` is a **property**, not a method (calling it raises
  `'NoneType' object is not callable` — easy to misread as a broken exec namespace).
- `QWidget.grab()` works on a never-shown module widget (`slicer.modules.X.widgetRepresentation()`),
  800x1410 at DPR 2 for SampleData; activate the layout first or the header row is unlaid-out.
- Slicer stdout is block-buffered under a pipe — `print(..., flush=True)` for the READY line.
- The `slicer-mcp-server.py` bootstrap pattern (`exec` into a namespace, `startMcpServer(port,
  autoAllow=True)`) is from `~/slicer/slicer-skill/references/mcp.md`; keep the logic on the
  `slicer` module or it is garbage-collected.

## Next (M1)
Authority inversion + lazy bulk on WS A: `put` on the server side, `OpAck`/seq + reconnect
reconciliation (browser snapshot wins), `subscribe {types, metadataOnly}`, `GET blobs/<hash>` with
ranges + `blob_cache.py`; `mrson_peer.py` lifted from `LiveStoryLib/mrson_live.py`/`mrson_server.py`;
conformance scenarios for authority-on-reconnect, ack, put, metadata-only, bulk-on-first-access.

## The "whatabout" register — holes and exact mitigations

| # | Whatabout… | Reality | Mitigation (concrete) |
|---|---|---|---|
| 1 | **"It's just VNC/remote desktop"** | Only *panels* are pixels. The views — where twitch matters — are native WebGPU on the client, driven by state, not pixels. | Publish numbers: panel event→frame RTT (target ≤ 50 ms local, ≤ 150 ms remote), view interaction at 60 fps regardless of server distance. Dirty-rect + paint-event-driven capture (not polling), WebP/JPEG for photo-like regions, PNG for text; H.264/AV1 sidecar for remote (`native/`, `server/av1-sidecar.ts`). |
| 2 | **"You still need a Slicer install"** | Yes — that is the point of lossless compat. It just doesn't need to be on *your* machine. | Three tiers, one page: (a) bundled with SlicerLive.app (unprivileged child process); (b) browser + local helper (launcher app / browser-extension-like); (c) cloud/firewall ModuleServer (Modal, JS2, internal VM) with wss+token. Registry entries are the only difference. Static gallery keeps working without any server for native features. |
| 3 | **"Extensions can still own your machine"** | Extension code runs *in the ModuleServer process*, never in the browser. | Sandbox ladder per platform (OS guard → container → microVM), **hostile-mode default** for untrusted extensions: deny-run/deny-ffi, network egress limited to the data host + the client, per-session scratch wiped, warm pool. Malicious test module must fail at each rung (`docs/MODULESERVER-SANDBOXING.md`). The ModuleServer is disposable: it holds no truth (LiveScene does). |
| 4 | **"Bulk data over the wire / PHI leaves the building"** | Servers subscribe **metadata-only**; bulk moves by content hash only when a module is invoked; a PHI ModuleServer runs inside the firewall and the browser only ever receives what it renders. | `subscribe {types, metadataOnly}` + `GET blobs/<hash>` (ranges, LRU, prefetch hints); session `blobs/` as cache; per-server `phi-ok` capability gates which blobs a server may pull; audit = the op log. Measure: 512³ volume, no voxels cross until Apply. |
| 5 | **"Modal dialogs / `processEvents()` loops hang it"** | Already handled better than native: dialogs are invisible-but-grabbable and stream like any region; a blocking `exec()` blocks *that server*, nothing else. | Stream every top-level (done); **dialog watchdog**: server reports `{ev:"blocked", dialog}` when a modal is up > 1 s, client surfaces it front-and-center; known nuisance dialogs (pip-install consent, "restart Slicer?") get policy answers in hostile mode; MCP `execute_python` remains a back door for automation. |
| 6 | **"Popups, tooltips, cursors, DnD, clipboard, file dialogs"** | Each is a specific seam, none unsolvable. | Popups: done (z-ordered regions). Tooltips: forward hover dwell → Qt `QEvent::ToolTip` → stream as popup region. Cursor: `{ev:"cursor", shape}` from `QApplication::overrideCursor`/`widget.cursor` at pointer move. File dialogs: Qt non-native dialog streams and browses the *server's* sandboxed session dir; add a browser-side picker that uploads into `SlicerLiveSessions/<id>/blobs` by hash (File System Access → blob channel). DnD of files onto the page → same upload → `loadFile` cmd. Clipboard: text only via `{op:"clipboard"}` both ways. |
| 7 | **"Two servers disagree / who is the master?"** | LiveScene is authoritative by construction; servers propose ops tagged by role. | Op envelope `{origin, v, role}`; `human > agent > module > automated`; `OpAck`+seq with reconnect reconciliation (browser snapshot wins, server converges); per-entity coalesce policy; conformance scenarios for every rule (`render/test/conformance.ts`, runs in Deno *and* browser). |
| 8 | **"Modules that draw into the VTK renderers directly"** | ~30 files of 2952 bypass MRML (register in `docs/MODULESERVER.md`). | Explicit "unsupported in ModuleServer" notice, not a blank view; per-module port to a native SlicerLive DM when it matters; **compat-view fallback**: run that server with the *native* QPA (cocoa/xcb/windows, still `WA_DontShowOnScreen`) so QVTK views render to their own offscreen GL surface and the cell is streamed as pixels via `grabFramebuffer()`. |
| 9 | **"Extensions register custom layouts"** | `AddLayoutDescription` XML is the contract; we interpret the same XML. | Generic layout-XML → CSS-grid interpreter (§2.1) covering all built-ins and custom layouts, incl. plot/table view cells streamed as regions. Oracle: every built-in layout id compared numerically (cell rects) against Slicer. |
| 10 | **"The views won't be exactly Slicer's"** | The views are SlicerLive's own — by design; fidelity is measured, not asserted. | Parity harness (`render/test/parity-run.ts`) + numeric A/B harness (`harness/`) grow with every feature; the compat-view fallback (#8) gives an escape hatch for any cell while a feature is missing. |
| 11 | **"Screen readers can't read pixels" (a11y)** | True for streamed panels; the honest weakness. | AppServer exports the **accessibility tree** (`QAccessible` names/roles/values/bounds per region) as a semantic overlay (ARIA) positioned over the pixels; keyboard focus ring mirrored; new UI is native web. Same channel gives automation (click-by-name) and testing. |
| 12 | **"Retina / fonts / DPR"** | Offscreen screen is DPR 1 today. | Server-side `QT_SCALE_FACTOR` / offscreen config → DPR-2 grabs; region header carries `dpr`; client draws at CSS size. |
| 13 | **"Keyboard shortcuts, IME, international text"** | Forwarded as DOM key events; ⌘ shortcuts go to native menus. | Complete DOM→Qt key map + `text` for composed characters; `compositionend` forwarded as text; menu accelerators handled by the host (native on mac, in-page menubar region elsewhere). |
| 14 | **"Version skew between SlicerLive and Slicer versions"** | The protocol is versioned and Slicer-independent. | `moduleserver.struct.json` / `guistream.struct.json` in the mrson schema repo; capability negotiation; several Slicer versions side by side (differential debugging is a feature). |
| 15 | **"pip installs / extension manager inside a sandbox"** | They run inside the ModuleServer (streamed GUI works unchanged). | Per-session Python prefix + extension install path; egress allow-list includes PyPI/extension server only in trusted mode; image snapshots for cloud servers. |
| 16 | **"Why not just run Slicer?"** | Because the truth moves to LiveScene: sessions with autosave/undo/branch/bookmarks, collaboration, phone/browser clients, hosted compute, recorder. Slicer becomes a service. | Sessions (§3), recorder/commits already built, collab = LiveSync peers. |
| 17 | **"Crash isolation"** | A crashing extension kills only its ModuleServer. | Authority inversion + reconnect reconciliation: restart the server, it converges to LiveScene; GUI stream reconnects (already retries). |
| 18 | **"Testing"** | Slicer self-tests run unchanged *inside* the ModuleServer; SlicerLive features have oracles. | MCP-driven tests against the headless server; CDP-driven page tests (as in the POC); numeric harnesses; conformance in Deno+browser. |
| 19 | **"Licensing"** | Slicer BSD; Qt LGPL dynamically linked as today; no Qt-wasm. | Nothing new to license. |
| 20 | **"Offline / static hosting"** | Native features work statically today; legacy modules need a server somewhere. | Tiers (#2); the local helper is a one-click install; desktop app bundles it. |

## S1 status (2026-08-27): GUI stream hardening
Done and verified on the Qt6 `/opt/sr` server: **view cells from the app's own layout engine**
(`ev:"regions"` now carries `cells[{id,kind,name,rect,view}]`; slice/3D controller bars, plot views,
table views and splitter handles stream as regions — `FourUpPlot` verified: 3D cell hidden, plot region
streamed, slice cells moved to Slicer's rects); **paint-driven dirty-rect capture** (app-level
`QEvent.Paint` hook → per-region dirty rect → partial frames with `x,y` offsets; full re-grab every 2 s
as a safety net; hot path is integer math only — a repaint storm of ~3k paints/s was observed while the
QVTK views fail their GL contexts); **cursor** (`ev:"cursor"`), **tooltips** (client hover dwell →
`op:"hover"` → `QHelpEvent(ToolTip)` → the tip is a top-level and streams as a popup region),
**dialog watchdog** (`ev:"blocked"/"unblocked"` from `activeModalWidget()` after 1 s), multi-client,
`--dpr` on the launcher (`QT_SCALE_FACTOR`; needs a relaunch to verify).
Client: partial frames, DPR-aware canvases, cells placement (`live-views.setCells` — the `LAYOUTS` name
table is bypassed once cells arrive), cursor, hover, blocked banner.
Open in S1: measured bytes are contaminated when a human is driving the same server; WebP/JPEG for
photo-like regions; the Python console's caret blink is a legitimate 2 Hz repaint (exclude or accept).
PythonQt traps collected so far: `width`/`height`/`cursor`/`platformName`/`primaryScreen` are properties.

## S2 status (2026-08-27): MirrorView v2, first cut
Done: `SlicePlane.basis` (oblique/Reformat from the slice node's `sliceToRAS` columns → `SliceRenderer.setBasis`;
verified with a 30° X-rotation of Red), `SliceDisplayableManager` keyed by Slicer `layoutName` (any cell
set), `MirrorView.setOverlay` 2D channel (`OverlayItem`: point/polyline/text in RAS) with
`MarkupsDisplayableManager` emitting markups — **markups now appear in slice views** (in-plane filled,
off-plane hollow projections, labels), per-cell overlay canvases in `live-views.ts` (dynamic slice cells
from the app's view-cell rects; `SliceRenderer.offset01Along` for oblique scrub positions).
Remaining in S2: keyed multi-volume / multi-segmentation fields, a second 3D view (per-view
`SceneRenderer`), per-cell basis slots (cells beyond Red/Green/Yellow share the renderer's three
orientation slots round-robin), and migrating `mirror-browser.ts` onto `mountLiveViews`.

## Direction (2026-08-28, after dogfooding S0–S15)

Tried end to end, the ModuleServer works at a baseline level but has lots of issues to sort out — and that
is the point: it proves SlicerLive itself needs to be **fairly complete and take over most of the app**.
The ModuleServer is **backwards compatibility only** (legacy extensions, rare modules), not where behavior
should live. The real work from here is **porting**: transferring traditional Slicer behaviors (data
loading/DICOM, layouts and view controllers, volumes/W-L, markups, segment editor, transforms, models,
save/export, the core of module panels) into native SlicerLive — TS/WebGPU views, LiveScene +
DisplayableManagers, web UI — each with a numeric parity oracle against real Slicer. Choosing between
"make the ModuleServer handle X" and "implement X natively": pick native unless X is legacy-extension
territory. ModuleServer maintenance stays minimal (bug fixes, compat).

## S3 status (2026-08-27): interaction completeness (first cut)
New mrson node types `crosshair`, `interaction`, `selection` (serialize + observe; the interaction node
fires `InteractionModeChangedEvent`, observed explicitly). Server ops: `crosshair #/cursorRAS`,
`#/crosshairRAS`, `#/mode`; `interaction #/mode`, `#/placeModePersistence`; cmds `setCursor {ras, view}`
(uses `SetCursorPositionXYZ(xyz, sliceNode)` — the RAS-only form leaves DataProbe blank), `setSliceFrame
{center, fov}`, `viewContextMenu {ras, x, y}` (→ `vtkMRMLInteractionNode.ShowViewContextMenu(eventData)`
after `QCursor.setPos` to the click; the QMenu streams as a popup region and its `exec()` nested loop is
harmless because sockets keep being serviced — but never call it synchronously from an MCP handler).
W/L patches now switch `AutoWindowLevel` off first (otherwise Slicer silently overrides the value).
Client (`live-views.ts` + `view-cmds.ts`): `ViewStateDisplayableManager`; hover → `setCursor` →
**Slicer's real Data Probe follows the SlicerLive cursor**; shift-move → crosshair RAS + overlay lines;
W/L left-drag gated by the streamed interaction mode; ctrl/⌘-wheel zoom, right-drag zoom and pan write
back a `setSliceFrame` (local "branched" frame until written, 200 ms debounce); markup control-point
drag in slice cells (pick within 12 px of an in-plane glyph, optimistic move + `setControlPoint`,
echo-suppression by `touch`); right-click → Slicer's own view context menu (verified: picking "Adjust
window/level" flipped the interaction node to 5 and the menu closed).
Verified numerically over MCP: cursor RAS (39.5, −19.2, 5.1) → DataProbe value 82; W/L 151/75.5 →
263.2/19.4; FOV 449×256 → 261.6×149.2.
Open in S3: keys into views, drag-and-drop upload (needs the S4 blob endpoint), slice-intersection
lines, second 3D view.

## S4 status (2026-08-27): authority inversion + acks
`ModuleServer/python/mrson_peer.py` is now the WS A peer for ModuleServers (LiveStory keeps its own
`mrson_live.py`; the peer imports the serializer/applier/observers from LiveStoryLib rather than copying).
Wire additions (superset of the old channel): every event carries `seq`; `applyOps` → `OpAck {tag, seq,
applied, errors, created}`; **`put`** creates nodes (markups first-class, anything else by `mrmlClass`,
bulk types not yet) — MRML assigns the real id, `OpAck.created` + a `NodeAdded{clientId}` let clients
collapse their provisional id; **`reconcile {nodes}`** applies every differing patchable property of the
client's node map (LiveScene wins); `subscribe {metadataOnly}` strips `zarr` references (`getNode` fetches
the full node); `lastSeq` on subscribe. Blob `Range` is not possible through Slicer's WebServer (handlers
never see request headers) and not needed: zarr chunks are the pull unit.
Client: `LiveSync` tracks `pending` batches until acked and `lastSeq`; on reconnect it captures its node
map *before* the peer's re-snapshot (the snapshot would otherwise overwrite local state), sends it as a
reconcile after `SnapshotComplete`, then re-sends unacked batches; `LiveScene.aliasNode` rewrites a put's
provisional id. Conformance scenarios cover ack/pending/reconcile-on-reconnect and put aliasing (29 tests
green in Deno with `--no-check`; the 8 remaining type errors are the pre-existing `BufferSource` lib
strictness in the GPU files).
Verified live: page put → real MRML fiducial; peer stopped, Slicer W/L diverged to 999/500, peer
restarted → page's 180/90 reconciled back, pending 0.
Not done in S4: blob_cache.py / server-side lazy pull (only meaningful with a second server — S11),
seq-based resume (the peer re-snapshots; reconcile makes that correct, resume makes it cheaper).

## S5 status (2026-08-27): place mode
One server-authoritative cmd on the interaction node, `placeAt {ras, view, label?}`, mirrors what
`vtkMRMLMarkupsDisplayableManager` does on a click: resolve the selection node's active place class /
node (creating the node and setting it active if needed), add the control point, and
`SwitchToViewTransformMode()` unless place-mode persistence is on (or the node's maximum point count
isn't reached). The client (`live-views.ts`) sends it on a left click in a slice cell whenever the
streamed interaction mode is `place` (cursor: crosshair). Verified: Place via the interaction node →
click in Red → F gained a point at the clicked RAS and the mode returned to ViewTransform on both sides.
Slicer's own toolbar buttons (streamed) drive the same nodes, so "click the fiducial toolbar button, click
in a SlicerLive view" is the normal path.

## S6 status (2026-08-27): slice composite layers + colour tables
mrson: `sliceComposite` (per-view background/foreground/label refs, opacities, compositing 0-3, linked/
hot-linked; patchable incl. layer refs), `labelmap` flag on images, `labelMapDisplay`, `colorTable`
(only tables referenced by a display node; discrete tables keep integer indices, procedural nodes are
sampled to 256 and marked `continuous`), scalar display gains `refs.color`, `autoWindowLevel`,
`applyThreshold`, `threshold`.
Renderer: `SliceRenderer` gained a foreground layer (own RAS→texture matrix, W/L, opacity, Slicer's four
`vtkImageBlend` compositing modes), a label layer (integer labels through a colour table, nearest
sampling, label 0 transparent) and 256-entry colour LUTs over the W/L ramp for bg/fg (bindings 7-10).
Client: `VolumeLayersDisplayableManager` keys ImageFields by image id (fetched by hash on demand),
resolves display nodes + colour tables, and hands each slice cell its `SliceLayers`; `live-views` now
runs **one SliceRenderer per cell**, so views show different volumes (the singleton limit is gone).
Verified: Red = Tumor1 + Tumor2 @0.5 alpha + TumorLabel; Green/Yellow = Tumor2; Slicer's Data Probe
reports all three layers under the SlicerLive cursor.
Not yet: threshold/invert in the shader, blend-by-drag, slice linking semantics on the client, multiple
segmentations (still one overlay).

## S7a status (2026-08-27): transforms
mrson `transform` nodes (`transformType`, `toParent`, `toWorld` for linear, `refs.parent`), `refs.transform`
on images/markups/segmentations, `#/toParent` patch. World geometry stays **baked** on the wire
(`ijkToRAS` folds the linear parent chain; markup control points are world) so clients need no
composition; the peer now observes `vtkMRMLTransformableNode::TransformModifiedEvent` on every
transformable and re-serializes the image *metadata only* (zarr descriptor cached by image `MTime`),
and `ImageField.setIjkToRAS` re-places a loaded volume without re-uploading voxels. Verified: a 25/−10 mm
translation of a transform applied to MRHead moved the page's `ijkToRAS` by exactly that.
Not yet (S7b): mesh geometry blobs + `MeshField` raster/depth composite in `SceneRenderer`, model slice
intersections, nonlinear transforms as `TransformField` modifiers, the transform gizmo.
Caution: Slicer's slice widgets own hidden `Red/Green/Yellow Transform` linear transform nodes — never
attach data to them (I did, briefly; reset).

## S7b status (2026-08-27): models
mrson `mesh` nodes now carry geometry: triangulated, **world-space** float32 points + uint32 triangles
as two content-addressed blobs (`points`, `triangles` hashes) plus counts/bounds, cached by polydata +
transform MTime (display-only changes never re-write geometry); Slicer's internal slice-plane models
(display node class `vtkMRMLSliceDisplayNode`) stay off the wire.
Renderer: `SceneRenderer` gained a **mesh pass** — meshes are rasterised before every trace into a
premultiplied colour target + a ray-distance target (flat headlight shading from screen-space
derivatives, no normals on the wire); the ray march composites the nearest surface at its depth, so
volumes in front occlude it and it occludes what is behind — the depth-composite seam the optional
VTK-render mode will reuse. Bound as group 1 on the trace/stream/timing pipelines; empty passes are
free. `ModelDisplayableManager` fetches geometry by hash once and hands visible meshes with their
`modelDisplay` colour/opacity to the view; `rebuild3d` now renders a scene with meshes but no volume.
Verified: a sphere model (opacity 0.8) renders in the SlicerLive 3D view with fiducial glyphs
composited in front/behind.
Not yet: model slice intersections (contours in slice views), per-vertex normals/scalars, wireframe/
points representations, edge visibility, clipping of meshes by the ROI, mesh picking.

## S8 status (2026-08-27): view chrome
mrson `view` nodes carry the chrome (`boxVisible`, `axisLabelsVisible`, `backgroundColor[2]`,
`fiducialsVisible`, `orientationMarkerType/Size`, `rulerType`; slice nodes also `sliceVisible`,
`widgetVisible`, `useLabelOutline`) with patches. Client: `ThreeDViewDisplayableManager` → a 2D overlay
on the 3D cell draws the scene bounding box (volume ∪ meshes), R/A/S/L/P/I labels and the axes
orientation marker after every 3D frame, and the app's background colour is applied; slice cells draw
their orientation marker, a ruler (nice 1/2/5 mm steps from the frame's mm/px), and corner annotations
(B:/F:/L: layer names, slice offset, W/L); ROI markups render as a wireframe (`RoiBoxField`) and control
point glyphs honour `glyphScale`.
Not yet: colour legend, slice planes in 3D, the reformat widget, per-view visibility of markups
(`fiducialsVisible`), human/cube marker styles (all types draw the axes glyph).

## Known issues (to clean up after the steps)

Fixed 2026-08-28:
- **Event staging** (Steve's report): the root cause was that the server delivered synthetic input with
  `QApplication.sendEvent()` straight to the child widget, skipping everything a window system stages
  first — no focus-on-click (typing went to the previously focused widget), no Enter/Leave/hover, and an
  offscreen/hidden window never becomes *active* (so `focusWidget()` was `None` and keys fell to the main
  window). `gui_stream._stage_focus/_stage_hover` + `setActiveWindow` + key routing to the window's
  focus widget fix it; verified numerically: slider handle drag, popup item selection, click-then-type in
  the Python console. Also fixed the same day: the `grab()->paint->dirty->grab` self-feeding loop that kept
  the Qt loop ~100 % busy since S1 (RTT 1000 ms -> 1 ms), and a stale "waiting on a dialog" banner after
  a stream restart.
- **Quit interception**: a `QEvent.Close` on the headless main window is swallowed by the app-wide event
  filter (clients get `quitIntercepted`); `{"op":"shutdown"}` lets one through. The "save before exit?"
  dialog can no longer kill the server.

Still open:
- keys into the SlicerLive views (`v`, arrows, `f`/`b`), drag-and-drop file upload, slice intersection
  lines + drag, second 3D view, multiple segmentations per view, zoom re-centering, model slice
  intersections, colour legend, slice planes in 3D, desktop shell passing the sessions path, and
  hover->tooltip timing (700 ms dwell is a guess).
- Remote ModuleServer on Modal (gVisor) — see S13.

## S9 status (2026-08-27): segment-editor in-view feedback
Users paint in SlicerLive's cells, so the direction is the reverse of the old capture: mrson
`segmentEditor` node (active effect, selected segment, segmentation/source refs, brush params) streams
from Slicer's `vtkMRMLSegmentEditorNode`; the client draws the brush circle (diameter from
`BrushAbsoluteDiameter`, cursor hidden) and, while Paint/Erase is active, turns a left drag into
`segPaint {points, mode, diameterMm, sphere, normal}` batches (initial dab + ~60 ms increments +
final flush), drawing the in-progress stroke as a translucent tube until the labelmap echo lands.
Server: rasterises the polyline brush (disk in the view plane or sphere) into the active effect's
`defaultModifierLabelmap()` and calls `effect.modifySelectedSegmentByLabelmap(lm, Add|Remove)` with
`saveStateForUndo()` first — exactly what Paint/Erase do, so the result and undo history are Slicer's.
Verified: a drag in the Red cell grew the segment 261 → 554 voxels; Slicer's echoed labelmap overlay
appears in the SlicerLive views.
Learned: the effect API lives on `qSlicerSegmentEditorAbstractEffect` (`w.activeEffect()`), not the widget;
Slicer clears the active effect when the editor widget re-initialises; my CDP helper hung on
`location.reload()` evals (fixed: `Page.reload` helper + eval timeout) — several earlier "no-op" results
were that, not the feature. The view-state copy in `live-views` is gone: app-level state is read from
`live.nodes` (the model) directly.
Not yet: other effects' feedback (scissors polygon, level tracing), relative brush diameter (uses the
absolute value the effect keeps updated), 3D-view painting, Erase-in-all-segments modes.

## S10 status (2026-08-28): sessions store
`render/sessions/`: `SessionFS` (memory / Deno / File System Access — the same class serves OPFS) and
`SessionStore`: `session.json`, `scene.mrson.json` checkpoint, append-only `log/NNNN.ops.jsonl` (every
`_changes` entry with seq/t/kind/op/origin/role, write-behind 500 ms), checkpoints every N deltas / 15 s,
reopen = checkpoint + log tail, `bookmarks.json`, `branch(target, name, seq)` (new session dir seeded
from the state at a seq, blobs shared by hash), an **undo/redo** stack (local edits only; a single-property
edit undoes as an inverse `patch`, structural changes as `put`/`del`; drags coalesce within 300 ms) whose
inverse ops go through `LiveScene.write`, so the connected app follows, and `exportActiveSet` ("save" =
scene + exactly the reachable blobs). `render/moduleserver/session-ui.ts`: directory picker (handle
persisted in IndexedDB, re-permissioned) or OPFS fallback (`?session=opfs`), ⌘Z/⌘⇧Z/⌘S/⌘B, and a blob-fetch
hook (`zarr.setBlobFetch`) that serves content-addressed blobs from `blobs/` and tees fetches into it.
Server: `put` on an existing id now updates it in place (undo/redo/reconcile need that; before it
created a new node — the source of a "396" display node during testing).
Verified: 3 Deno tests (close/reopen, undo/redo, export reachability + bookmark + branch); in Chrome on
OPFS: session files + 12-entry log written, export of 31 nodes + 47 blobs (0 missing), W/L edit → undo →
redo → undo with Slicer following each step.
Not yet: desktop shell passing the absolute sessions path to a local ModuleServer, blob-cache warmup on
open (blobs are cached as fetched), a session picker UI (sessions are auto-named), reset-on-reopen
semantics when the app's scene differs from the session (today the app's snapshot is what loads).

## S11 status (2026-08-27): multi-server registry, protocol conformance, mock non-Slicer server

- **Several servers on one scene.** `?peers=ws://host:port/,…` opens extra `LiveSync`s onto the same
  `LiveScene` (`peers` option of `mountLiveViews`). Each `LiveSync` has a `peerId`; with `relay: true` a
  change that arrives from one peer is forwarded to the others as a put/patch/del — the browser is the hub,
  LiveScene the single truth, no server ever talks to another server.
- **Loop breaker.** Every relayed node is remembered by content (`relayed` map); an echo of what we just
  applied is dropped, only a *changed* node is forwarded again; `relayCount` cap (5000) as a fuse. The
  first live run had none of this and produced ~1000 duplicate fiducials and ~6000 orphan display/model
  nodes in Slicer within seconds (cleaned up by hand; see the `put` note below). Conformance scenario:
  "hub relay: … loop breaker".
- **Ids are global.** A node keeps the id it was created under everywhere; only provisional ids
  (`tmp-…`/`conf-…`) get renamed by the receiving server (`OpAck.created`), and the alias is relayed to
  the other peers as del+put. Verified: the mock's `mock1` → Slicer's `vtkMRMLMarkupsFiducialNode1327`
  on the page, in Slicer *and* in the mock.
- **Module registry.** `module` nodes (`{type:"module", name, server, gui:"stream"|"none"}`) are what a
  server offers; `ModuleRegistryDisplayableManager` collects the union across peers (`__modules()` on the
  page). Without a manager interested in `module` the type is never subscribed — that was the first
  live failure.
- **`put` creation is whitelisted** server-side (markups, transforms). Bulk types and display nodes are
  never created from the wire — a display node without its displayable is an orphan (the generic
  `AddNewNodeByClass` fallback is gone).
- **Mock server** `ModuleServer/mock/server.ts` (Deno, ~80 lines, no Slicer): Hello/subscribe/snapshot/
  applyOps/OpAck/reconcile/getNode + one module, `MarkCenter` (puts a fiducial at the centre of the
  referenced image). It is both the Slicer-independence proof and the conformance fixture.
- **Protocol conformance** `ModuleServer/conformance/protocol.ts` + `.test.ts`: the same scenarios run
  against the mock and against a live Slicer peer (`deno test -A`).
- Verified live: page + Slicer(2132) + mock(2142); Slicer node count steady over 12 s with both connected;
  `cmd markCenter` on the mock's module node → exactly one fiducial on all three ends at (-2.8, 6.4, -10.7).

Not done: `moduleserver.struct.json`/`guistream.struct.json` in the mrson schema repo; a torch module on
Modal (S13 first); capability negotiation beyond the `Hello` event.

## S12 status (2026-08-27): accessibility tree + click-by-name automation

The pixels are opaque to screen readers and to test automation, so the streamed GUI now carries a semantic
layer on the same WebSocket:

- **Server** (`gui_stream.py`): for every streamed region, the visible widgets underneath are walked
  (plain `QWidget` properties — `QAccessible` is not exposed to PythonQt; class checks must use
  `QObject.inherits()`, `isinstance` misses PythonQt subclass wrappers) and published as
  `{"ev":"a11y","nodes":[{id, region, role, name, value, x,y,w,h, enabled, focused, checked?}]}`
  (region-local px, ids from the C++ pointer so they are stable across rebuilds). Roles: button,
  checkbox, textbox, spinbutton, combobox, slider, tablist, group, label, grid; composite widgets
  (qMRML*/ctk* comboboxes, sliders, tables) hide their inner children. Refreshed every 0.5 s, sent only
  when it changed. Ops: `a11yClick` (buttons `click()`, anything else press+release at the centre),
  `a11yFocus`, `a11ySet` (text / number / checked / combobox item text / **node combobox by node id or
  name**), `a11yQuery`.
- **Client** (`legacy-gui.ts`): an ARIA overlay per region — positioned elements with role/aria-label/
  aria-valuetext/aria-checked/aria-disabled over the canvas, `pointer-events:none` so the pixels keep the
  mouse, tab-focusable; Enter/Space activates the real widget, focus is mirrored both ways. API:
  `gui.a11y`, `gui.find(name|RegExp, role?)`, `gui.click(...)`, `gui.set(name, value)`, `gui.focus(...)`,
  `gui.refreshA11y()`.
- **CLI** `ModuleServer/tools/a11y.ts` — `list [role] | click <name> | set <name> <value> | focus <name>`
  straight over the gui-stream socket (no browser, no CDP, no MCP).
- Verified (Segment Editor, page over CDP): tree = 118 nodes / 17 regions after composite de-dup;
  `set("SourceVolumeNodeComboBox","MRHead_1")` enabled the disabled Add button, `click("Add")` created
  `Segment_2` in Slicer (MCP oracle). An automation click on a *disabled* button is correctly a no-op.

Not done: VoiceOver/NVDA walkthrough by a person (I cannot drive a screen reader here); tree for
popups' inner widgets is included but menus (QMenu items) are still pixels — the `menus` event already
carries them as data for the native-menu host; `QAccessible` roles (tree items, table cells) beyond the
widget level.

## S13 status (2026-08-28): remote transport

**Local half (done, pushed a5bcb22):**
- Frame codec negotiation on the gui stream: `subscribe {codec, quality}` / `{"op":"quality"}`; PNG on a
  LAN, lossy WebP/JPEG on slow links; frame header carries `fmt`. `ping`/`pong` for RTT, `stats` events
  (bytes/s, frames/s) every 2 s while frames flow. The client adapts on its own (RTT > 120 ms or > 1.5 MB/s
  -> WebP at falling quality; climbs back when the link recovers); `gui.stats`, `?` readout bottom-left.
- `?token=` on both WebSockets (`--token` on the launcher, `MODULESERVER_TOKEN`), `wss`/`https` picked
  automatically on an https page or `?secure`; `?host=`, `?gui=`, `?ws=`, `?http=` for proxies/tunnels.
- Measured on localhost after the fix below: RTT 1 ms, idle 0 bytes/s, a module switch ~400 KB/s of PNG.
- **Perf bug found on the way** (present since S1): `grab()` raises a paint event, the paint hook marked the
  region dirty, the next tick grabbed it again — every region, every 33 ms, forever. The hash check hid it
  as "0 bytes" while the Qt loop ran ~100 % busy (RTT ~1000 ms). Fixed with a `grabbing` guard.
- AV1 for chrome is deliberately NOT used: dirty rects of text compress better as PNG/WebP; the existing
  AV1 sidecar (`server/av1-sidecar.ts`) belongs to the compat-view (VTK pixels) fallback.

**Remote half (NOT done): a Linux ModuleServer on Modal.** `ModuleServer/modal/moduleserver_modal.py`
builds an image (Slicer Linux nightly 5.13 + Qt5/xcb runtime + Xvfb/Mesa + Debian's Qt5 `offscreen`
plugin, fonts, gdb/strace) and runs `bootstrap.py` behind `modal.forward()` TLS tunnels with a token.
Everything up to Slicer's main window works, and the diagnosis is exact, but the server never reaches READY:

- Slicer's `qSlicerAppMainWindow` constructor deadlocks in `qSlicerViewersToolBarPrivate::init` ->
  `QIcon` -> `QImage::convertToFormat_helper` -> `QSemaphore::acquire` (gdb as parent process; attach is
  denied in the sandbox). Qt 5.15 converts images >= 128 KB in segments on the global `QThreadPool` and
  waits; in Modal's gVisor sandbox **no pool worker thread exists at that point** and the segments never run.
  It is timing-dependent (one run out of ~20 got through in 9 s); disabling pool expiry (`slicer/__init__.py`
  patch, `expiryTimeout=-1`), pinning to one CPU, xcb vs offscreen, software GL vs none, `--testing`,
  `--disable-settings`, no network, and every module family on/off make no difference. Bare core, or
  modules without a main window, complete in < 15 s.
- Separately, `SimpleFilters` (bundled in the nightly) never returns from its module `__init__` here unless
  it is ignored (`--modules-to-ignore SimpleFilters`).
- Slicer's stdout is block-buffered behind the launcher; `bootstrap.py` now also writes READY/ERROR/stage
  markers to `<state>.log` so a remote host can see them.

Conclusion: not a SlicerLive/ModuleServer protocol problem — a Qt-thread-pool interaction with gVisor.
**Confirmed the same day on a real runtime:** the identical recipe as a Docker image
(`ModuleServer/packaging/Dockerfile`, run on Colima with Rosetta for amd64) reaches READY in ~10 s with 100
modules (`app,module` roles, xcb on Xvfb + Mesa, invisible), passes the protocol conformance scenarios 6/6
against `ws://localhost:3132`, and the page (`?gui=ws://…:3133/&ws=ws://…:3132/&http=http://…:3131/mrson/`)
streams its Welcome/Segment Editor chrome: RTT 9 ms through the VM, ~15–50 KB/s during a module switch,
78 a11y nodes, click-by-name works. So the remote leg is a hosting question (any runc/VM host), not a
code question; Modal specifically needs a non-gVisor runtime. The `--probe` diag in `moduleserver_modal.py`
is a reusable harness (marker files + strace/gdb-as-parent) for the next sandbox.

## S14 status (2026-08-28): sandbox ladder

`docs/MODULESERVER-SANDBOXING.md` is the ladder (rung 0 process / 1 OS guard / 2 container-or-restricted
exec / 3 VM, per platform) with the contract every rung is measured against:
`ModuleServer/sandbox/MaliciousTest.py`, a hostile scripted module whose probes (write outside the session,
read `~/.ssh`/`~/.aws`, HTTPS and raw-TCP egress, spawn a shell, secret-looking env vars; controls: write the
session, reach the server's own port) are reported as JSON (`slicer.moduleServerSandboxProbe()` over MCP).

Rung 1 on macOS is built and verified: `launch.ts --sandbox seatbelt --session <dir> [--allow-host h:p]`
writes a Seatbelt profile (`ModuleServer/sandbox/moduleserver-seatbelt.sb`) and runs Slicer under
`sandbox-exec` with a cleared, allow-listed environment. Probe result on this machine (Qt6 /opt/sr, offscreen,
147 modules): `rung1: true` — write_home, read_secret, egress, egress_ip, env_leak all denied; write_session
and localhost succeed; spawn_shell allowed (rung 1 keeps subprocesses for CLI modules; rung 2 removes it).
Traps met: the CTK launcher opens its executables O_RDWR (profile allows `file-write-data` on exactly those
binaries); the first run leaked this shell's API tokens into Slicer (fixed: `clearEnv` + allow-list); a probe
that does an HTTP request to the server's own port from the Qt thread waits for itself (use a TCP connect).

Not done: Linux (bubblewrap/systemd-run) and Windows (AppContainer) rungs, rung 2 (read-only image,
no exec) — the launcher seam and the probe contract are in place for them.

## S15 status (2026-08-28): packaging

- **Slicer packaging change** (Steve submits): `ModuleServer/packaging/slicer-offscreen-qpa.patch` adds
  `platforms:offscreen` + `platforms:minimal` to `SlicerCPack.cmake` on all three platforms — one line per
  platform, ~1 MB — so `-platform offscreen` works with the stock package (today only custom builds like
  /opt/sr, or Debian's matching Qt5 plugin on Linux, have it).
- **Linux container image**: `ModuleServer/packaging/Dockerfile` + `entrypoint.sh` — Debian slim, Slicer
  nightly (or a pinned URL via `--build-arg SLICER_URL`), Xvfb + Mesa GLX, non-root user, read-only-friendly
  (`/session`, `/state`, `/tmp` are the only writable paths), health check on the READY state file, token
  via `MODULESERVER_TOKEN`. This is rung 2 of the sandbox ladder when run `--read-only --network` with a
  proxy. Needs a real runtime (runc); see S13 for the gVisor deadlock. **Verified 2026-08-28** on Colima
  (Rosetta, amd64): builds, READY in ~10 s, 100 modules, conformance 6/6, page streams the chrome.
- **Desktop bundle**: `desktop/slicer-demo.ts` already hosts the stock UI; bundling a ModuleServer into
  `SlicerLive.app` = ship `ModuleServer/` + `LiveStory/LiveStoryLib` under `Contents/Resources`, launch with
  `launch.ts --sandbox seatbelt --session <SlicerLiveSessions/id>` as an unprivileged child, and point it at
  a user-installed Slicer.app (or a bundled one, +1 GB). `desktop/make-app.ts` is being edited by another
  session, so this is left as the recipe, not applied.
- **Windows**: not verified in this pass (a Vultr VM is available for it); the launcher's `--sandbox`
  seam is where an AppContainer/restricted-token rung goes.

## Direct-renderer register (unsupported for now; revisit per module)
Modules that draw into Slicer's VTK renderers bypassing MRML (LiveScene cannot see them):
SlicerLayerDisplayableManager, SlicerMorph/MarkupEditor, SlicerHeart/VirtualCathLab, AnglePlanes,
CurveMaker, SlicerSandbox/Lights, SlicerNeuroSegmentation intersection DM, SlicerAstmPhantomTest,
SlicerAdaptiveBrush (2D feedback actor), SlicerCIP/VolumeProbe, Film/GelDosimetryAnalysis, CLIC,
HeadCTDeid, OpenAnatomyExport, TimelapsedHRpQCT. A ModuleServer should report "unsupported" for
these rather than show a blank view.

## Desktop POC (2026-08-27): the stock Slicer interface hosted by SlicerLive

```
deno run -A --unstable-ffi desktop/slicer-demo.ts            # launches /opt/sr (Qt 6.10) headless, opens the window
deno run -A --unstable-ffi desktop/slicer-demo.ts --no-launch # reuse a running ModuleServer
```
- **Server**: `ModuleServer/launch.ts --slicer /opt/sr --roles app,module` (Qt 6 build → `-platform offscreen`
  automatically; `WA_DontShowOnScreen` filter + Dock-icon drop still applied). Ports: mrson 2131/2132,
  MCP 2126, **GUI stream 2133** (`ModuleServer/python/gui_stream.py`, RFC6455 server in `mrson_ws.py`).
- **GUI stream protocol** (Slicer-independent): server → `regions` (main-window parts in window
  coordinates: menubar, toolbars, docks, statusbar, popups/dialogs with z) + `menus` (tree with
  action ids, shortcuts, enabled/checkable) + `title`; binary frames `<u32 hdrlen><json{region,seq,w,h}><png>`
  with per-region change detection (idle = 0 bytes). Client → `resize`, `pointer`, `wheel`, `key`,
  `triggerAction`, `selectModule`. Routing on the server: `region.childAt(p)` (QApplication.widgetAt
  is useless without native windows) + implicit grab to the pressed widget + popup-outside-click close.
- **Page** `render/demos/slicer-app.{html,ts}` (bundle: `deno run -A npm:esbuild render/demos/slicer-app.ts
  --bundle --format=esm --outfile=render/demos/slicer-app.js`): `render/moduleserver/legacy-gui.ts`
  positions one `<canvas>` per region at the reported geometry and forwards events;
  `render/moduleserver/live-views.ts` mounts the SlicerLive 4-up in the reported layout viewport,
  driven by the LiveScene displayable managers; local slice scroll / 3D orbit are written back as
  mrson ops (`#/offset` patch, `setCameraPose` cmd) so Slicer follows.
- **Desktop**: `desktop/slicer-demo.ts` (new entry point; `main.ts`/`macmenu.ts` untouched) + `desktop/qtmenu.ts`
  builds real `NSMenu`s from the AppServer menu tree (Qt `Ctrl+X` → ⌘X key equivalents), forwarding picks
  as `triggerAction`. Windows/Linux would draw the menubar region instead (`?nativeMenus=1` hides it).
- **Verified**: clicking "Download Sample Data" in the streamed Welcome panel switched the module;
  clicking the MRHead thumbnail loaded the volume in Slicer and it appeared in the WebGPU MPR views via
  mrson (screenshots in the session scratchpad); the same page runs in WKWebView with native menus.
- **Known POC limits**: DPR 1 grabs (offscreen screen is 1x; use `QT_SCALE_FACTOR=2` or a config file for
  retina); PNG at ≤15 Hz, no dirty rects (M4); no cursor/tooltip metadata; keyboard shortcuts with ⌘ go
  to native menus only; module panels that pop modal `exec()` dialogs stream fine but block Slicer until
  answered through the stream; PythonQt property-vs-method traps (`width`, `height`, `platformName`).
