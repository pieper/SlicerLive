// Capture the ground-truth fixtures in harness/fixtures/ from a LIVE Slicer over MCP (docs/HARNESS.md
// "Regenerating the fixtures"). Writes to $OUT (default /tmp) so you can validate before overwriting:
//   deno run -A harness/capture-fixtures.ts            # -> /tmp/slicer-startup.json, vtk-camera-truth.json, ...
//   SLICERLIVE_FIXTURES=/tmp deno run -A test/run.ts   # the pure checks against the fresh dumps
//   cp /tmp/{slicer-startup,vtk-camera-truth,slicer-drag-truth,slicer-actions-truth,slicer-slicestep-truth}.json harness/fixtures/
// Scene: clear -> MRHead -> volume rendering on, FourUp, cameras/slices reset (the state the fixtures assume).
// Numbers come from Slicer's OWN objects (vtkCamera ops, real interactor events), never re-derived here.
// NEEDS A GL-CAPABLE SLICER: sections 3-5 inject events into the real view interactors, which render; on the
// offscreen headless ModuleServer (no OpenGL context) that crashes the process (2026-08-29). Point SL_MCP at a
// normally launched Slicer running slicer-mcp-server.py (or a ModuleServer started with --platform cocoa).
import { executePython } from "./slicer.ts";

const OUT = Deno.env.get("OUT") ?? "/tmp";

const PY = String.raw`
import slicer, json, vtk
OUT = ${JSON.stringify(OUT)}
def dump(name, obj):
    with open(OUT + "/" + name, "w") as f: json.dump(obj, f, indent=1)

# ---- scene ----------------------------------------------------------------------------------
slicer.mrmlScene.Clear(0)
import SampleData
vol = SampleData.SampleDataLogic().downloadMRHead()
slicer.util.setSliceViewerLayers(background=vol, fit=True)
lm = slicer.app.layoutManager(); lm.setLayout(3)
vr = slicer.modules.volumerendering.logic(); d = vr.CreateDefaultVolumeRenderingNodes(vol); d.SetVisibility(True)
slicer.app.processEvents()
v3 = lm.threeDWidget(0).threeDView(); v3.resetFocalPoint(); v3.resetCamera(); slicer.app.processEvents()
camNode = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCameraNode"); cam = camNode.GetCamera()
def camstate(c):
    return {"position": list(c.GetPosition()), "focalPoint": list(c.GetFocalPoint()), "viewUp": list(c.GetViewUp()), "distance": c.GetDistance()}

# ---- 1. startup geometry ---------------------------------------------------------------------
m = vtk.vtkMatrix4x4(); vol.GetIJKToRASMatrix(m)
b = [0.0]*6; vol.GetRASBounds(b)
dn = vol.GetDisplayNode()
slices = {}
for name in ("Red", "Yellow", "Green"):
    sn = lm.sliceWidget(name).mrmlSliceNode()
    slices[name] = {"offset": sn.GetSliceOffset(), "fieldOfView": list(sn.GetFieldOfView()), "dimensions": list(sn.GetDimensions()),
                    "sliceToRAS": [sn.GetSliceToRAS().GetElement(r, c) for r in range(4) for c in range(4)]}
dump("slicer-startup.json", {
    "volume": {"dims": list(vol.GetImageData().GetDimensions()), "ijkToRAS": [m.GetElement(r, c) for r in range(4) for c in range(4)],
               "rasLo": [b[0], b[2], b[4]], "rasHi": [b[1], b[3], b[5]], "window": dn.GetWindow(), "level": dn.GetLevel()},
    "slices": slices,
    "camera": {**camstate(cam), "viewAngle": cam.GetViewAngle()},
})

# ---- 2. bare vtkCamera truth (the pure math the TS port must match) ------------------------------
W, H = 600, 600
def bare():
    c = vtk.vtkCamera(); c.SetPosition(0, 500, 0); c.SetFocalPoint(0, 0, 0); c.SetViewUp(0, 0, 1); return c
def rotate(c, dx, dy):
    # vtkMRMLCameraWidget::ProcessRotate: motion factor 10, delta = -20/size * factor * d
    rxf = dx * (-20.0 / W) * 10.0; ryf = dy * (20.0 / H) * 10.0
    c.Azimuth(rxf); c.Elevation(ryf); c.OrthogonalizeViewUp(); return rxf, ryf
cases = []
c = bare(); rxf, ryf = rotate(c, 120, -40); cases.append({"name": "rotate_single", "dx": 120, "dy": -40, "rxf": rxf, "ryf": ryf, "after": camstate(c)})
c = bare(); steps = [(30, -10)] * 6
for dx, dy in steps: rotate(c, dx, dy)
cases.append({"name": "rotate_accumulated_6", "steps": steps, "after": camstate(c)})
c = bare(); c.Dolly(1.1); cases.append({"name": "wheel_dolly_1.1", "factor": 1.1, "after": camstate(c)})
c = bare(); c.Dolly(pow(1.1, -40 / (H / 10.0) * 10.0 / 10.0)) if False else c.Dolly(1.5); cases.append({"name": "scale_1.5", "factor": 1.5, "after": camstate(c)})
c = bare(); c.Elevation(30); c.OrthogonalizeViewUp(); rxf, ryf = rotate(c, 60, 20); cases.append({"name": "rotate_from_tilted", "pre_elevation": 30, "dx": 60, "dy": 20, "rxf": rxf, "ryf": ryf, "after": camstate(c)})
dump("vtk-camera-truth.json", {"W": W, "H": H, "cases": cases})

# ---- 3./4. drags through the REAL 3D view interactor (vtkMRMLCameraWidget) --------------------------
def reset3d():
    v3.resetFocalPoint(); v3.resetCamera(); cam.SetPosition(0, 500, 0); cam.SetFocalPoint(0, 0, 0); cam.SetViewUp(0, 0, 1); cam.OrthogonalizeViewUp(); slicer.app.processEvents()
rw = v3.renderWindow(); iren = rw.GetInteractor(); size = list(rw.GetSize()); ox, oy = size[0] // 2, size[1] // 2
def press(x, y, button="Left", mods=None):
    iren.SetEventInformation(int(x), int(y), 0, 0, " ", 0, ""); getattr(iren, f"InvokeEvent")(getattr(vtk.vtkCommand, f"{button}ButtonPressEvent"))
def move(x, y): iren.SetEventInformation(int(x), int(y), 0, 0, " ", 0, ""); iren.InvokeEvent(vtk.vtkCommand.MouseMoveEvent)
def release(x, y, button="Left"): iren.SetEventInformation(int(x), int(y), 0, 0, " ", 0, ""); iren.InvokeEvent(getattr(vtk.vtkCommand, f"{button}ButtonReleaseEvent"))
def drag(dx, dy, button="Left", steps=1):
    press(ox, oy, button)
    for i in range(1, steps + 1): move(ox + dx * i / steps, oy + dy * i / steps)
    release(ox + dx, oy + dy, button); slicer.app.processEvents()
reset3d(); before = camstate(cam); drag(120, -40, "Left", 1)
dump("slicer-drag-truth.json", {"viewSize": size, "drag": {"x0": ox, "y0": oy, "dx": 120, "dy": -40, "steps": 1}, "before": before, "after": camstate(cam)})
acts = {}
for name, button, dx, dy in (("rotate_left", "Left", 120, -40), ("pan_middle", "Middle", 80, 30), ("scale_right", "Right", 0, -100)):
    reset3d(); b0 = camstate(cam); drag(dx, dy, button, 1); acts[name] = {"before": b0, "after": camstate(cam), "dx": dx, "dy": dy, "button": button}
reset3d(); b0 = camstate(cam); iren.SetEventInformation(ox, oy, 0, 0, " ", 0, ""); iren.InvokeEvent(vtk.vtkCommand.MouseWheelForwardEvent); slicer.app.processEvents()
acts["wheel_forward"] = {"before": b0, "after": camstate(cam)}
dump("slicer-actions-truth.json", {"viewSize": size, "origin": [ox, oy], "cases": acts})

# ---- 5. slice stepping through the REAL slice interactors --------------------------------------------
slicer.util.setSliceViewerLayers(background=vol, fit=True); slicer.app.processEvents()
steps = {}
for name in ("Red", "Yellow", "Green"):
    sw = lm.sliceWidget(name); sn = sw.mrmlSliceNode(); si = sw.sliceView().renderWindow().GetInteractor()
    sz = sw.sliceView().renderWindow().GetSize(); cx, cy = sz[0] // 2, sz[1] // 2
    def ev(kind, key=None):
        si.SetEventInformation(cx, cy, 0, 0, (key or " ")[:1], 0, key or ""); si.InvokeEvent(getattr(vtk.vtkCommand, kind)); slicer.app.processEvents()
    rec = {"start": sn.GetSliceOffset()}
    for _ in range(3): ev("MouseWheelForwardEvent")
    rec["after_wheelFwd_x3"] = sn.GetSliceOffset()
    for _ in range(5): ev("MouseWheelBackwardEvent")
    rec["after_wheelBack_x5"] = sn.GetSliceOffset()
    for k in ("f", "f", "b"): ev("KeyPressEvent", k)
    rec["after_keys_f_f_b"] = sn.GetSliceOffset()
    for k in ("Up", "Down", "Down", "Right", "Left"): ev("KeyPressEvent", k)
    rec["after_keys_arrows"] = sn.GetSliceOffset()
    lo, hi = [0.0]*2, None
    bounds = [0.0]*6; sw.sliceLogic().GetLowestVolumeSliceBounds(bounds)
    sn.SetSliceOffset(bounds[5] - 0.4); slicer.app.processEvents(); b1 = sn.GetSliceOffset(); ev("MouseWheelForwardEvent")
    rec["edge"] = {"bounds_hi": bounds[5], "before": b1, "after_wheelFwd": sn.GetSliceOffset()}
    steps[name] = rec
dump("slicer-slicestep-truth.json", steps)
__result = "captured to " + OUT
`;
console.log(await executePython(PY, 600));
