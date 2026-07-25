"""LiveStory 'story' model — the SceneViews-equivalent narrative layer.

A story is a scene plus an ordered list of pages. Each page captures a viewpoint
(3D camera + the three slice planes + per-node visibility) together with authored
text and optional out-links (e.g. Wikipedia), so a scene can be turned into an
anatomy lesson: step through pages, each framing structures of interest with a
caption. Stored next to the scene as <name>.story.json and read by story.html.
"""
import json
import os

import slicer
import vtk


def _mat4(m):
    return [m.GetElement(r, c) for r in range(4) for c in range(4)]


def capture_page(title="", text="", links=None):
    """Snapshot the current 3D camera, slice planes and node visibilities into a page dict."""
    links = links or []

    cam = None
    camNode = slicer.util.getNodesByClass("vtkMRMLCameraNode")
    if camNode:
        c = camNode[0].GetCamera()
        cam = {
            "position": list(c.GetPosition()),
            "focalPoint": list(c.GetFocalPoint()),
            "viewUp": list(c.GetViewUp()),
            "viewAngle": c.GetViewAngle(),
        }

    slices = {}
    for sn in slicer.util.getNodesByClass("vtkMRMLSliceNode"):
        slices[sn.GetLayoutName()] = {
            "sliceToRAS": _mat4(sn.GetSliceToRAS()),
            "fieldOfView": list(sn.GetFieldOfView()),
            "orientation": sn.GetOrientation(),
        }

    visibility = {}
    for dn in slicer.util.getNodesByClass("vtkMRMLDisplayNode"):
        visibility[dn.GetID()] = int(dn.GetVisibility())

    return {
        "title": title,
        "text": text,
        "links": links,
        "camera": cam,
        "slices": slices,
        "visibility": visibility,
    }


def story_path(outdir, name):
    return os.path.join(outdir, f"{name}.story.json")


def load_story(outdir, name, scene_file, title=None):
    p = story_path(outdir, name)
    if os.path.exists(p):
        return json.load(open(p))
    return {"scene": scene_file, "title": title or name, "pages": []}


def save_story(outdir, name, story):
    p = story_path(outdir, name)
    with open(p, "w") as f:
        json.dump(story, f, indent=1)
    return p
