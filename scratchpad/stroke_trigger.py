import numpy as np, slicer, vtk
# clean any prior test nodes
for nm in ("segedTestVol","segedTestSeg"):
    for nd in list(slicer.util.getNodes(nm).values()): slicer.mrmlScene.RemoveNode(nd)
# a small volume + one empty segment
vol = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode","segedTestVol")
slicer.util.updateVolumeFromArray(vol, np.zeros((40,80,80), np.float32))
vol.SetSpacing(1,1,1); vol.SetOrigin(-40,-40,-20)
segNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode","segedTestSeg")
segNode.CreateDefaultDisplayNodes(); segNode.SetReferenceImageGeometryParameterFromVolumeNode(vol)
sid = segNode.GetSegmentation().AddEmptySegment("Segment_1")
slicer.util.setSliceViewerLayers(background=vol, fit=True)
# segment editor → Paint
segEd = slicer.qMRMLSegmentEditorWidget(); segEd.setMRMLScene(slicer.mrmlScene)
segEdNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentEditorNode")
segEd.setMRMLSegmentEditorNode(segEdNode)
segEd.setSegmentationNode(segNode); segEd.setSourceVolumeNode(vol)
segEd.setCurrentSegmentID(sid)
segEd.setActiveEffectByName("Paint")
slicer.app.processEvents()
# simulate a stroke on the Red slice interactor (the SegEditCapture watches these events)
lm = slicer.app.layoutManager(); sw = lm.sliceWidget("Red"); iren = sw.sliceView().interactor()
pts = [(180,180),(200,200),(220,220),(240,240)]
iren.SetEventPosition(*pts[0]); iren.InvokeEvent("LeftButtonPressEvent")
for p in pts[1:]:
    iren.SetEventPosition(*p); iren.InvokeEvent("MouseMoveEvent")
iren.InvokeEvent("LeftButtonReleaseEvent")
slicer.app.processEvents()
__execResult = "stroke simulated (%d moves), effect=%s seg=%s" % (len(pts), segEd.activeEffect().name if segEd.activeEffect() else None, sid)
