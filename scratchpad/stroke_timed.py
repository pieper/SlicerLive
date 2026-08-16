import numpy as np, slicer, time
for nm in ("segTV","segTS"):
    for nd in list(slicer.util.getNodes(nm).values()): slicer.mrmlScene.RemoveNode(nd)
vol = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode","segTV")
slicer.util.updateVolumeFromArray(vol, np.zeros((40,80,80), np.float32)); vol.SetOrigin(-40,-40,-20)
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode","segTS")
seg.CreateDefaultDisplayNodes(); seg.SetReferenceImageGeometryParameterFromVolumeNode(vol)
sid = seg.GetSegmentation().AddEmptySegment("Segment_1")
slicer.util.setSliceViewerLayers(background=vol, fit=True)
w = slicer.qMRMLSegmentEditorWidget(); w.setMRMLScene(slicer.mrmlScene)
en = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentEditorNode"); w.setMRMLSegmentEditorNode(en)
w.setSegmentationNode(seg); w.setSourceVolumeNode(vol); w.setCurrentSegmentID(sid); w.setActiveEffectByName("Paint")
slicer.app.processEvents()
lm = slicer.app.layoutManager(); iren = lm.sliceWidget("Red").sliceView().interactor()
iren.SetEventPosition(200,200); iren.InvokeEvent("LeftButtonPressEvent")
for p in [(210,210),(220,220),(230,230)]:
    iren.SetEventPosition(*p); iren.InvokeEvent("MouseMoveEvent")
t = time.time()*1000
iren.InvokeEvent("LeftButtonReleaseEvent")
__execResult = "sent %.0f" % t
