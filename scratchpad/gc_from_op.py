# Slicer consumer of the SAME shared mrson SegEdit case (scratchpad/segedit_case.json). Reconstructs
# the synthetic sphere image, plants the op's seed scribbles into a seed labelmap, runs the TRADITIONAL
# "Grow from seeds" effect, and reports timing + Dice vs the analytic sphere. POST this to /slicer/exec;
# it sets __execResult so the endpoint returns the numbers. One op, two pipelines (see gc-from-op.ts).
import json, time
import numpy as np
import slicer, vtk
from slicer import vtkMRMLSegmentationNode
import vtkSegmentationCorePython as vsc

CASE = "/Users/pieper/slicer/SlicerLive/scratchpad/segedit_case.json"
with open(CASE) as f:
    cs = json.load(f)
dims = cs["grid"]["dims"]; ijk = cs["grid"]["ijkToRAS"]
nx, ny, nz = dims
cx, cy, cz = cs["image"]["centerRAS"]; r = cs["image"]["radiusMm"]

# reconstruct the sphere image + truth (axis-aligned 1mm grid: RAS = ijk*index + origin)
zz, yy, xx = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing="ij")
R = xx * ijk[0] + ijk[3]; A = yy * ijk[5] + ijk[7]; S = zz * ijk[10] + ijk[11]
inside = ((R - cx) ** 2 + (A - cy) ** 2 + (S - cz) ** 2) <= r * r
img = np.where(inside, cs["image"]["inside"], cs["image"]["outside"]).astype(np.float32)
truth = inside.astype(np.uint8)

def ras_to_ijk(p):  # inverse of the axis-aligned ijkToRAS
    return (int(round((p[0] - ijk[3]) / ijk[0])), int(round((p[1] - ijk[7]) / ijk[5])), int(round((p[2] - ijk[11]) / ijk[10])))

# plant the op's scribbles into a seed labelmap (spherical brush in voxels)
seedvol = np.zeros((nz, ny, nx), np.uint8)
for sc in cs["op"]["scribbles"]:
    lab = int(sc.get("label", 1)); rad = float(sc.get("brush", {}).get("diameterMm", 6)) / 2.0
    for p in sc["points"]:
        i0, j0, k0 = ras_to_ijk(p)
        ir = int(np.ceil(rad))
        for dk in range(-ir, ir + 1):
            for dj in range(-ir, ir + 1):
                for di in range(-ir, ir + 1):
                    if di * di + dj * dj + dk * dk <= rad * rad:
                        i, j, k = i0 + di, j0 + dj, k0 + dk
                        if 0 <= i < nx and 0 <= j < ny and 0 <= k < nz:
                            seedvol[k, j, i] = lab

# build the source scalar volume node
srcVol = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "gcSrc")
slicer.util.updateVolumeFromArray(srcVol, img)
srcVol.SetSpacing(ijk[0], ijk[5], ijk[10]); srcVol.SetOrigin(ijk[3], ijk[7], ijk[11])

# seed labelmap → segmentation (each label becomes a segment; label 1 = our foreground)
seedLM = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLabelMapVolumeNode", "gcSeeds")
slicer.util.updateVolumeFromArray(seedLM, seedvol)
seedLM.SetSpacing(ijk[0], ijk[5], ijk[10]); seedLM.SetOrigin(ijk[3], ijk[7], ijk[11])
segNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "gcSeg")
slicer.modules.segmentations.logic().ImportLabelmapToSegmentationNode(seedLM, segNode)
segNode.SetReferenceImageGeometryParameterFromVolumeNode(srcVol)

# run the traditional Grow-from-seeds effect
segEd = slicer.qMRMLSegmentEditorWidget(); segEd.setMRMLScene(slicer.mrmlScene)
segEdNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentEditorNode")
segEd.setMRMLSegmentEditorNode(segEdNode)
segEd.setSegmentationNode(segNode); segEd.setSourceVolumeNode(srcVol)
segEd.setActiveEffectByName("Grow from seeds")
eff = segEd.activeEffect()
t0 = time.time(); eff.self().onPreview(); slicer.app.processEvents(); preview_s = time.time() - t0
t1 = time.time(); eff.self().onApply(); apply_s = time.time() - t1

# Dice of the first segment (our foreground label 1) vs the analytic sphere
sid = segNode.GetSegmentation().GetNthSegmentID(0)
seg0 = slicer.util.arrayFromSegmentBinaryLabelmap(segNode, sid, srcVol).astype(np.uint8)
inter = int(np.sum((seg0 == 1) & (truth == 1))); a = int(np.sum(seg0 == 1)); b = int(np.sum(truth == 1))
__execResult = json.dumps({"engine": "slicer", "n": nx, "preview_s": round(preview_s, 3),
                           "apply_s": round(apply_s, 3), "dice": round(2 * inter / (a + b), 4),
                           "seg0_vox": a, "sphere_vox": b})
for n in ("gcSrc", "gcSeeds", "gcSeg"):
    for nd in slicer.util.getNodes(n).values():
        slicer.mrmlScene.RemoveNode(nd)
slicer.mrmlScene.RemoveNode(segEdNode)
