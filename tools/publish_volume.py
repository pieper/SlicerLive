#!/usr/bin/env python3
"""Publish a Slicer volume to the SlicerLive gallery: Slicer -> zarr -> JS2 bucket.

    python3 tools/publish_volume.py CTACardio
    python3 tools/publish_volume.py CTAAbdomenPanoramix --node Panoramix-cropped

Why this exists
---------------
Porting a SlicerWGPU selftest means running it on THE SAME DATA the selftest loads
(CTACardio, MRHead, CTAAbdomenPanoramix, ...), not a synthetic stand-in. Those datasets
come from Slicer's SampleData, so the gallery needs them hosted somewhere CORS-enabled.

An older `live/publish.py` did this via a `mrml_sync` serializer that no longer exists on
this machine. This script is self-contained: it only produces what SlicerLive's loader
(`render/scene-volume.ts`) actually consumes —

  * chunked, DEFLATE-compressed zarr blobs  (zlib format == DecompressionStream('deflate'))
  * a {blobBase, nodes} wrapper carrying `zarr`, `dims`, `ijkToRAS`, window/level and the
    VR transfer functions (color / scalarOpacity / shade) read off the VolumePropertyNode

— which is exactly the structure of the existing MRHead.json.

Requirements
------------
* Slicer running with the slicer-mcp server (default http://localhost:2026/mcp).
* `openstack` configured with the project that OWNS the bucket. NOTE: the `slicerlive`
  container belongs to project **CIS230102_IU** (see live/publish.py). Other projects on
  this machine (BIO240357_IU, MED250016_IU) can READ it but get 403 on write.
* The container ACL already makes new objects public + CORS (`access-control-allow-origin: *`),
  so no per-object ACL work is needed.
"""
import argparse, json, os, subprocess, sys, urllib.request

MCP = os.environ.get("SLICER_MCP", "http://localhost:2026/mcp")
CLOUD = os.environ.get("OS_CLOUD", "CIS230102_IU")
CONTAINER = "slicerlive"
BUCKET_BASE = f"https://js2.jetstream-cloud.org:8001/swift/v1/{CONTAINER}"
LIVE = os.environ.get("SLICERLIVE_GALLERY", "/Users/pieper/slicer/live")


def mcp(code: str):
    """Call slicer-mcp execute_python and return the tool's text result."""
    req = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
           "params": {"name": "execute_python", "arguments": {"code": code}}}
    r = urllib.request.Request(MCP, data=json.dumps(req).encode(),
                               headers={"Content-Type": "application/json",
                                        "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(r, timeout=1800) as f:
        body = f.read().decode()
    for line in body.splitlines():                     # tolerate SSE framing
        line = line[6:] if line.startswith("data: ") else line
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "result" in d:
            c = d["result"].get("content", [])
            return c[0].get("text", "") if c else ""
    return body


# Runs INSIDE Slicer. Kept as a string so the whole publish is one command.
EXPORT_SRC = r'''
import slicer, vtk, numpy as np, os, json, zlib, shutil

def export_volume_scene(vol, outdir, node_id="vtkMRMLScalarVolumeNode1", chunks=(64,128,128)):
    if os.path.isdir(outdir): shutil.rmtree(outdir)
    arr = np.ascontiguousarray(slicer.util.arrayFromVolume(vol).astype(np.int16))  # (K,J,I)
    nz, ny, nx = arr.shape
    cz, cy, cx = chunks
    gz = (-(-nz//cz), -(-ny//cy), -(-nx//cx))
    zdir = os.path.join(outdir, node_id + ".zarr", "0"); os.makedirs(zdir, exist_ok=True)
    total = 0
    for kk in range(gz[0]):
        for jj in range(gz[1]):
            for ii in range(gz[2]):
                blk = np.zeros((cz,cy,cx), dtype=np.int16)      # zarr pads partial chunks
                sub = arr[kk*cz:kk*cz+cz, jj*cy:jj*cy+cy, ii*cx:ii*cx+cx]
                blk[:sub.shape[0], :sub.shape[1], :sub.shape[2]] = sub
                raw = zlib.compress(blk.tobytes(), 6)
                open(os.path.join(zdir, "%d.%d.%d" % (kk,jj,ii)), "wb").write(raw); total += len(raw)
    m = vtk.vtkMatrix4x4(); vol.GetIJKToRASMatrix(m)
    ijk = [m.GetElement(r,c) for r in range(4) for c in range(4)]   # row-major, as the loader expects
    disp = vol.GetDisplayNode()
    nodes = {"vtkMRMLScalarVolumeDisplayNode1": {
        "id":"vtkMRMLScalarVolumeDisplayNode1","class":"vtkMRMLScalarVolumeDisplayNode",
        "name":"VolumeDisplay","refs":{},"blobs":{},
        "attrs":{"visibility":1,"window":float(disp.GetWindow()),"level":float(disp.GetLevel())}}}
    refs_display = ["vtkMRMLScalarVolumeDisplayNode1"]
    vrDisp = None
    for i in range(vol.GetNumberOfDisplayNodes()):
        d = vol.GetNthDisplayNode(i)
        if d and d.IsA("vtkMRMLVolumeRenderingDisplayNode"): vrDisp = d
    if vrDisp is not None and vrDisp.GetVolumePropertyNode():
        vp = vrDisp.GetVolumePropertyNode(); prop = vp.GetVolumeProperty()
        cf, of = prop.GetRGBTransferFunction(), prop.GetScalarOpacity()
        color = []
        for i in range(cf.GetSize()):
            v=[0]*6; cf.GetNodeValue(i,v); color.append([v[0],v[1],v[2],v[3]])
        sop = []
        for i in range(of.GetSize()):
            v=[0]*4; of.GetNodeValue(i,v); sop.append([v[0],v[1]])
        nodes["vtkMRMLVolumePropertyNode1"] = {"id":"vtkMRMLVolumePropertyNode1",
            "class":"vtkMRMLVolumePropertyNode","name":vp.GetName(),"refs":{},"blobs":{},
            "attrs":{"shade":int(prop.GetShade()),"color":color,"scalarOpacity":sop}}
        nodes["vtkMRMLGPURayCastVolumeRenderingDisplayNode1"] = {
            "id":"vtkMRMLGPURayCastVolumeRenderingDisplayNode1",
            "class":"vtkMRMLGPURayCastVolumeRenderingDisplayNode","name":"VolumeRendering",
            "refs":{"volumeProperty":["vtkMRMLVolumePropertyNode1"]},"blobs":{},
            "attrs":{"visibility":1,"kind":"volumeRendering"}}
        refs_display.append("vtkMRMLGPURayCastVolumeRenderingDisplayNode1")
    nodes[node_id] = {"id":node_id,"class":"vtkMRMLScalarVolumeNode","name":vol.GetName(),
        "refs":{"display":refs_display},"blobs":{},
        "attrs":{"zarr":{"dir":node_id+".zarr","dataset":"0","shape":[nz,ny,nx],
                          "chunks":[cz,cy,cx],"chunkGrid":list(gz),"dtype":"<i2","bytes":total},
                 "dims":[nx,ny,nz],"comps":1,"ijkToRAS":ijk}}
    json.dump({"blobBase":"REPLACE_ME","nodes":nodes}, open(os.path.join(outdir,"scene.json"),"w"))
    return {"chunks": gz[0]*gz[1]*gz[2], "compressedMB": round(total/1e6,1), "dims":[nx,ny,nz]}
'''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sample", help="SampleData name, e.g. CTACardio / MRHead / CTAAbdomenPanoramix")
    ap.add_argument("--node", help="MRML node name if it differs from the sample name")
    ap.add_argument("--name", help="bucket/scene name (default: the sample name)")
    ap.add_argument("--stage", default="/tmp/publish", help="local staging dir")
    args = ap.parse_args()

    name = args.name or args.sample
    outdir = os.path.join(args.stage, name)

    print(f"[1/4] downloading + exporting {args.sample} in Slicer …")
    code = EXPORT_SRC + f'''
import SampleData, json
vol = slicer.util.getFirstNodeByName({(args.node or args.sample)!r})
if vol is None:
    vol = SampleData.SampleDataLogic().downloadSample({args.sample!r})
vrLogic = slicer.modules.volumerendering.logic()
d = vrLogic.CreateDefaultVolumeRenderingNodes(vol); d.SetVisibility(True)
__result = json.dumps(export_volume_scene(vol, {outdir!r}))
'''
    print("   ", mcp(code))

    print(f"[2/4] uploading -> {CLOUD}:{CONTAINER}/{name}/blobs/ …")
    files = [os.path.join(r, f) for r, _, fs in os.walk(outdir) for f in fs if f != "scene.json"]
    for i, f in enumerate(files, 1):
        rel = os.path.relpath(f, outdir).replace(os.sep, "/")
        subprocess.run(["openstack", "--os-cloud", CLOUD, "object", "create", CONTAINER, rel,
                        "--name", f"{name}/blobs/{rel}"], cwd=outdir, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if i % 16 == 0 or i == len(files):
            print(f"    {i}/{len(files)}")

    print("[3/4] writing the scene wrapper …")
    w = json.load(open(os.path.join(outdir, "scene.json")))
    w["blobBase"] = f"{BUCKET_BASE}/{name}/blobs/"
    dst = os.path.join(LIVE, "scenes", f"{name}.json")
    json.dump(w, open(dst, "w"))
    print("    ", dst)

    print("[4/4] verifying the bucket is readable + CORS …")
    url = f"{BUCKET_BASE}/{name}/blobs/vtkMRMLScalarVolumeNode1.zarr/0/0.0.0"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            print(f"     HTTP {r.status}  CORS={r.headers.get('access-control-allow-origin')}")
    except Exception as e:
        sys.exit(f"     FAILED: {e}")
    print(f"\ndone — load it with ?scene={BUCKET_BASE.rsplit('/',1)[0]}/... or "
          f"https://pieper.github.io/live/scenes/{name}.json")


if __name__ == "__main__":
    main()
