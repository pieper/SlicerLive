"""
Interactive LiveRenderer demo: open a URL -> the MorphoDepot juvenile alligator volume renders on a
Modal L4 -> drag with the mouse to rotate (wheel to zoom). Frames stream as JPEG over a WebSocket;
the GPU renders on demand (only while you interact), and the container scales to zero when idle.

Dev:   modal serve alligator_live.py     # prints a live URL; open it in a browser
"""

import io
import json
import time

import modal

app = modal.App("alligator-live")
cache = modal.Volume.from_name("alligator-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglx0", "libegl1", "libglvnd0", "libx11-6", "libxext6",
                 "mesa-utils-extra", "libxt6")
    .pip_install("vtk", "pynrrd", "numpy", "pillow", "requests", "fastapi")
    .run_commands(
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)

REPO = "dinonoto/AM112911-05_Juv_Alligator"
W, H = 1280, 720

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>SlicerLive — Alligator</title>
<style>html,body{margin:0;height:100%;background:#0b0b12;overflow:hidden;font:13px system-ui,sans-serif;color:#cdd}
#v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;cursor:grab;touch-action:none}
#v.drag{cursor:grabbing}#s{position:fixed;left:10px;top:8px;color:#9ad;text-shadow:0 1px 2px #000;z-index:2}</style></head>
<body><div id=s>connecting…</div><img id=v draggable=false>
<script>
const v=document.getElementById('v'),s=document.getElementById('s');
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
ws.binaryType='blob';
let url=null, waiting=false, pend=null, drag=false, px=0, py=0;
ws.onopen=()=>{s.textContent='starting renderer…';};
ws.onmessage=e=>{
  if(typeof e.data==='string'){s.textContent=e.data;return;}
  const u=URL.createObjectURL(e.data); v.src=u; if(url)URL.revokeObjectURL(url); url=u;
  s.textContent='drag to rotate • wheel to zoom'; waiting=false; flush();
};
ws.onclose=()=>{s.textContent='disconnected';};
function flush(){ if(pend&&!waiting&&ws.readyState===1){ ws.send(JSON.stringify(pend)); pend=null; waiting=true; } }
v.addEventListener('pointerdown',e=>{drag=true;px=e.clientX;py=e.clientY;v.classList.add('drag');v.setPointerCapture(e.pointerId);});
v.addEventListener('pointerup',e=>{drag=false;v.classList.remove('drag');});
v.addEventListener('pointermove',e=>{ if(!drag)return; const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;
  pend=pend||{dx:0,dy:0}; pend.dx+=dx; pend.dy+=dy; flush(); });
v.addEventListener('wheel',e=>{e.preventDefault(); pend=pend||{dx:0,dy:0}; pend.zoom=(pend.zoom||0)+(e.deltaY<0?0.08:-0.08); flush();},{passive:false});
</script></body></html>"""


@app.cls(gpu="L4", image=image, memory=24576, volumes={"/cache": cache},
         scaledown_window=300, timeout=3600)
class Renderer:
    @modal.enter()
    def setup(self):
        self.ready = False
        self._loading = False

    def _load(self):
        import numpy as np
        import requests
        import vtk
        from vtk.util import numpy_support
        path = "/cache/volume.nrrd"
        import os
        if not os.path.exists(path):
            rels = requests.get(f"https://api.github.com/repos/{REPO}/releases", timeout=30).json()
            asset = next(a for r in rels for a in r.get("assets", []) if a["name"].endswith(".nrrd"))
            with requests.get(asset["browser_download_url"], stream=True, timeout=600) as r, open(path, "wb") as f:
                for c in r.iter_content(1 << 20):
                    f.write(c)
            cache.commit()
        import nrrd
        data, hdr = nrrd.read(path)
        nx, ny, nz = (int(d) for d in data.shape[:3])
        sd = hdr.get("space directions")
        if sd is not None:
            sp = []
            for vv in sd:
                try:
                    sp.append(float(np.linalg.norm(np.asarray(vv, dtype=float))))
                except Exception:
                    sp.append(1.0)
            spacing = (sp + [1, 1, 1])[:3]
        else:
            spacing = (list(hdr.get("spacings", [1, 1, 1])) + [1, 1, 1])[:3]
        flat = np.asfortranarray(data).ravel(order="F")
        atype = vtk.VTK_UNSIGNED_CHAR if data.dtype == np.uint8 else vtk.VTK_SHORT
        arr = numpy_support.numpy_to_vtk(flat, deep=True, array_type=atype)
        self._keep = arr
        del data, flat
        img = vtk.vtkImageData(); img.SetDimensions(nx, ny, nz)
        img.SetSpacing(*[float(s) for s in spacing]); img.GetPointData().SetScalars(arr)
        lo, hi = img.GetScalarRange()
        mapper = vtk.vtkGPUVolumeRayCastMapper(); mapper.SetInputData(img)
        mapper.SetAutoAdjustSampleDistances(True); mapper.UseJitteringOn()
        color = vtk.vtkColorTransferFunction()
        color.AddRGBPoint(lo, 0, 0, 0); color.AddRGBPoint(lo + .25 * (hi - lo), .45, .28, .18)
        color.AddRGBPoint(lo + .55 * (hi - lo), .85, .68, .45); color.AddRGBPoint(hi, 1, .98, .92)
        op = vtk.vtkPiecewiseFunction()
        op.AddPoint(lo, 0); op.AddPoint(lo + .15 * (hi - lo), 0)
        op.AddPoint(lo + .35 * (hi - lo), .12); op.AddPoint(lo + .65 * (hi - lo), .55); op.AddPoint(hi, .9)
        prop = vtk.vtkVolumeProperty(); prop.SetColor(color); prop.SetScalarOpacity(op)
        prop.ShadeOn(); prop.SetInterpolationTypeToLinear()
        prop.SetAmbient(.3); prop.SetDiffuse(.7); prop.SetSpecular(.3); prop.SetSpecularPower(10)
        volume = vtk.vtkVolume(); volume.SetMapper(mapper); volume.SetProperty(prop)
        self.ren = vtk.vtkRenderer(); self.ren.AddVolume(volume); self.ren.SetBackground(0.04, 0.04, 0.08)
        self.rw = vtk.vtkEGLRenderWindow(); self.rw.SetOffScreenRendering(1); self.rw.SetSize(W, H)
        self.rw.AddRenderer(self.ren)
        self.ren.ResetCamera(); self.cam = self.ren.GetActiveCamera()
        self.cam.Elevation(-20); self.cam.OrthogonalizeViewUp(); self.ren.ResetCameraClippingRange()
        self.rw.Render()
        self._vtk = vtk
        self._np = np
        self._n2v = numpy_support
        self.ready = True

    def _jpeg(self):
        vtk = self._vtk
        self.rw.Render()
        arr = vtk.vtkUnsignedCharArray()
        self.rw.GetRGBACharPixelData(0, 0, W - 1, H - 1, 0, arr)
        a = self._n2v.vtk_to_numpy(arr).reshape(H, W, 4)[::-1, :, :3]
        from PIL import Image
        buf = io.BytesIO(); Image.fromarray(a).save(buf, "JPEG", quality=85)
        return buf.getvalue()

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, WebSocket
        from fastapi.responses import HTMLResponse
        from starlette.websockets import WebSocketDisconnect
        fapp = FastAPI()

        @fapp.get("/")
        def index():
            return HTMLResponse(PAGE)

        @fapp.websocket("/ws")
        async def ws(sock: WebSocket):
            await sock.accept()
            if not self.ready:
                await sock.send_text("cold start: loading 3.7 GB alligator volume onto the GPU (~40 s, first time only)…")
                self._load()
            await sock.send_bytes(self._jpeg())
            try:
                while True:
                    m = await sock.receive_json()
                    if "dx" in m:
                        self.cam.Azimuth(-m["dx"] * 0.4); self.cam.Elevation(m["dy"] * 0.4)
                        self.cam.OrthogonalizeViewUp()
                    if m.get("zoom"):
                        self.cam.Dolly(1.0 + m["zoom"])
                    self.ren.ResetCameraClippingRange()
                    await sock.send_bytes(self._jpeg())
            except WebSocketDisconnect:
                pass

        return fapp
