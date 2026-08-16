import numpy as np, time, slicer, vtk
res = {}
try:
    n = 128; c = n/2.0; r = n*0.32
    zz,yy,xx = np.mgrid[0:n,0:n,0:n]
    inside = ((xx-c)**2+(yy-c)**2+(zz-c)**2) <= r*r
    img = np.where(inside, 0.75, 0.25).astype(np.float32)          # clean two-region sphere (deterministic)
    # source scalar volume
    vol = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode","gc_img")
    slicer.util.updateVolumeFromArray(vol, img)
    # seed labelmap: 1 = sphere centre, 2 = the 8 corners
    seedArr = np.zeros((n,n,n), np.uint8)
    ci=int(c); seedArr[ci-1:ci+2, ci-1:ci+2, ci-1:ci+2] = 1
    for (z,y,x) in [(3,3,3),(3,3,n-4),(3,n-4,3),(n-4,3,3),(3,n-4,n-4),(n-4,3,n-4),(n-4,n-4,3),(n-4,n-4,n-4)]:
        seedArr[z-1:z+2, y-1:y+2, x-1:x+2] = 2
    lm = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLabelMapVolumeNode","gc_seeds")
    slicer.util.updateVolumeFromArray(lm, seedArr)
    lm.SetOrigin(vol.GetOrigin()); lm.SetSpacing(vol.GetSpacing())
    seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode","gc_seg")
    seg.CreateDefaultDisplayNodes(); seg.SetReferenceImageGeometryParameterFromVolumeNode(vol)
    slicer.modules.segmentations.logic().ImportLabelmapToSegmentationNode(lm, seg)
    # segment editor + Grow from seeds
    segEdNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentEditorNode")
    w = slicer.qMRMLSegmentEditorWidget(); w.setMRMLScene(slicer.mrmlScene)
    w.setMRMLSegmentEditorNode(segEdNode); w.setSegmentationNode(seg); w.setSourceVolumeNode(vol)
    w.setActiveEffectByName("Grow from seeds")
    eff = w.activeEffect()
    t0 = time.time(); eff.self().onPreview(); slicer.app.processEvents(); t_prev = time.time()-t0
    t1 = time.time(); eff.self().onApply(); t_apply = time.time()-t1
    # read back segment 1 (the sphere seed) and Dice vs truth
    sid = seg.GetSegmentation().GetNthSegmentID(0)
    out = slicer.util.arrayFromSegmentBinaryLabelmap(seg, sid, vol)
    inter = int(np.sum((out>0) & inside)); a=int(np.sum(out>0)); b=int(np.sum(inside))
    res = {"n": n, "preview_s": round(t_prev,3), "apply_s": round(t_apply,3),
           "dice_seg0_vs_sphere": round(2*inter/(a+b),4), "seg0_vox": a, "sphere_vox": b}
    for node in (vol, lm, seg, segEdNode): slicer.mrmlScene.RemoveNode(node)
except Exception as e:
    import traceback; res = {"error": str(e), "tb": traceback.format_exc()[-500:]}
__execResult = res
