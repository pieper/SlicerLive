// Build (idempotently) the Slicer scene the parity fixtures assume, over MCP: MRHead + a segmentation
// with one segment + a fiducial list with 3 points + GPU volume rendering enabled. Run before T4 when
// the ModuleServer scene is empty:   deno run -A harness/parity/setup.ts
import { executePython, pyJson } from "../slicer.ts";

const code = `
import slicer, json
scene = slicer.mrmlScene
vol = scene.GetFirstNodeByName("MRHead") or scene.GetFirstNodeByName("MRHead_1")
if vol is None:
    import SampleData
    vol = SampleData.SampleDataLogic().downloadMRHead()
slicer.util.setSliceViewerLayers(background=vol, fit=True)
seg = scene.GetFirstNodeByClass("vtkMRMLSegmentationNode")
if seg is None:
    seg = scene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Seg")
    seg.CreateDefaultDisplayNodes(); seg.SetReferenceImageGeometryParameterFromVolumeNode(vol)
    import vtk
    s = vtk.vtkSphereSource(); s.SetCenter(0, 0, 0); s.SetRadius(20); s.Update()
    seg.AddSegmentFromClosedSurfaceRepresentation(s.GetOutput(), "Sphere", [0.8, 0.3, 0.3])
    seg.CreateBinaryLabelmapRepresentation()
    seg.GetSegmentation().SetSourceRepresentationName("Binary labelmap")   # the mrson serializer streams labelmaps, not surfaces
if not seg.GetSegmentation().ContainsRepresentation("Binary labelmap"):
    seg.CreateBinaryLabelmapRepresentation(); seg.GetSegmentation().SetSourceRepresentationName("Binary labelmap")
fid = scene.GetFirstNodeByClass("vtkMRMLMarkupsFiducialNode")
if fid is None:
    fid = scene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "F")
    fid.CreateDefaultDisplayNodes()
    for p in ((10, 0, 0), (0, 20, 0), (0, 0, 30)): fid.AddControlPoint(*p)
vr = slicer.modules.volumerendering.logic()
vrd = vr.GetFirstVolumeRenderingDisplayNode(vol)
if vrd is None:
    vrd = vr.CreateDefaultVolumeRenderingNodes(vol)
vrd.SetVisibility(True)
tf = vrd.GetVolumePropertyNode()
lay = scene.GetFirstNodeByClass("vtkMRMLLayoutNode"); lay.SetViewArrangement(3)
__result = json.dumps({"volume": vol.GetID(), "display": vol.GetDisplayNode().GetID(), "seg": seg.GetID(), "fid": fid.GetID(), "vr": vrd.GetID(), "tf": tf.GetID(), "camera": scene.GetFirstNodeByClass("vtkMRMLCameraNode").GetID()})
`;
const ids = JSON.parse(await executePython(code, 300)) as Record<string, string>;
console.log("parity scene ready:", ids);
if (ids.tf !== "vtkMRMLVolumePropertyNode1") console.log(`  note: export PARITY_TF_ID=${ids.tf}`);
const n = await pyJson<number>("slicer.mrmlScene.GetNumberOfNodes()");
console.log("  scene nodes:", n);
