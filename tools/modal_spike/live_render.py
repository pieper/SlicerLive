"""
SlicerLive interactive demo — continuous-push remote volume rendering on a Modal L4.

Open the URL -> a MorphoDepot specimen (default: Murat's diceCT bumblebee) volume-renders on the GPU;
drag to rotate, wheel to zoom. Frames stream as JPEG over a WebSocket, PUSHED continuously at the GPU's
render rate (not request/response), so fps is render-bound (~30-60), not network-RTT-bound.

Design notes:
  - All VTK work runs on ONE dedicated thread (ThreadPoolExecutor(1)) so the asyncio event loop stays
    free (no hangs accepting new connections / reloads during a 40 s load or a 25 ms render) and the EGL
    GL context stays on a single consistent thread.
  - Input (camera deltas) is received concurrently and coalesced; the sender renders+pushes whenever
    there's pending motion, else idles (on-demand: no GPU burn when still).

Deploy (persistent shareable URL):  modal deploy live_render.py
"""

import io
import json

import modal

SPECIMEN = "bumblebee"
SPECIMENS = {
    "bumblebee": ("muratmaga/Bumblebee_Stained", "diceCT bumblebee (Bombus) — Murat's data"),
    "alligator": ("dinonoto/AM112911-05_Juv_Alligator", "juvenile alligator microCT"),
}
REPO, LABEL = SPECIMENS[SPECIMEN]
W, H = 1024, 576  # fewer rays -> higher interactive fps; browser upscales to fill

app = modal.App("slicerlive")
cache = modal.Volume.from_name("slicerlive-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglx0", "libegl1", "libglvnd0", "libx11-6", "libxext6",
                 "mesa-utils-extra", "libxt6")
    .pip_install("vtk", "pynrrd", "numpy", "opencv-python-headless", "requests", "fastapi")
    .run_commands(
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>LiveRenderer — __LABEL__</title>
<style>html,body{margin:0;height:100%;background:#07070d;overflow:hidden;font:13px system-ui,sans-serif;color:#cde}
#v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;cursor:grab;touch-action:none;user-select:none}
#v.drag{cursor:grabbing}
#brand{position:fixed;left:12px;top:9px;z-index:3;font-weight:700;font-size:15px;color:#eaf;text-shadow:0 1px 4px #000}#brand small{font-weight:400;font-size:11px;color:#9ab}
#s{position:fixed;left:12px;top:32px;color:#9cf;text-shadow:0 1px 3px #000;z-index:2}
#f{position:fixed;right:10px;top:8px;color:#7a8;font:11px monospace;z-index:2}
#cite{position:fixed;left:10px;right:10px;bottom:8px;color:#9ab;font:11px system-ui;text-shadow:0 1px 3px #000;z-index:2}
#cite a{color:#9cf}</style></head>
<body><div id=brand>LiveRenderer <small>· SlicerLive · GPU volume rendering</small></div><div id=s>connecting…</div><div id=f></div><div id=cite></div><img id=v draggable=false>
<script>
const v=document.getElementById('v'),s=document.getElementById('s'),f=document.getElementById('f'),cite=document.getElementById('cite');
let ws,url=null,drag=false,px=0,py=0,pend=null,frames=0,t0=performance.now();
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
  ws.binaryType='blob';
  ws.onopen=()=>{s.textContent='starting renderer…';};
  ws.onmessage=e=>{ if(typeof e.data==='string'){ try{const o=JSON.parse(e.data); if(o.cite){cite.innerHTML=o.cite+(o.url?' · <a href="'+o.url+'" target=_blank rel=noopener>source ↗</a>':''); return;}}catch(_){} s.textContent=e.data; return; }
    const u=URL.createObjectURL(e.data); v.src=u; if(url)URL.revokeObjectURL(url); url=u;
    s.textContent='drag to rotate • wheel to zoom';
    frames++; const dt=performance.now()-t0; if(dt>500){f.textContent=(frames*1000/dt|0)+' fps'; frames=0; t0=performance.now();} };
  ws.onclose=()=>{s.textContent='disconnected — reconnecting…'; setTimeout(connect,800);};
  ws.onerror=()=>{try{ws.close()}catch(e){}};
}
connect();
// send coalesced camera deltas once per animation frame; never block on a reply (continuous push)
function step(){ if(pend&&ws&&ws.readyState===1){ ws.send(JSON.stringify(pend)); pend=null; } requestAnimationFrame(step); }
requestAnimationFrame(step);
v.addEventListener('pointerdown',e=>{drag=true;px=e.clientX;py=e.clientY;v.classList.add('drag');v.setPointerCapture(e.pointerId);});
v.addEventListener('pointerup',e=>{drag=false;v.classList.remove('drag');});
v.addEventListener('pointermove',e=>{ if(!drag)return; const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;
  pend=pend||{dx:0,dy:0,zoom:0}; pend.dx+=dx; pend.dy+=dy; });
v.addEventListener('wheel',e=>{e.preventDefault(); pend=pend||{dx:0,dy:0,zoom:0}; pend.zoom+=(e.deltaY<0?0.06:-0.06);},{passive:false});
</script></body></html>""".replace("__LABEL__", LABEL)


@app.cls(gpu="L4", image=image, memory=32768, volumes={"/cache": cache},
         scaledown_window=600, timeout=3600)
class Renderer:
    @modal.enter()
    def boot(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        self.pool = ThreadPoolExecutor(max_workers=1)   # all VTK on one thread (EGL ctx affinity)
        self.lock = threading.Lock()
        self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
        self.ready = False
        self._status = "starting GPU container…"

    def _ensure_loaded(self):
        # runs on the single pool thread -> concurrent connects serialize here for free
        if self.ready:
            return
        import os
        import numpy as np
        import requests
        import vtk
        import cv2
        from vtk.util import numpy_support
        path = f"/cache/{SPECIMEN}.nrrd"
        if not os.path.exists(path):
            rels = requests.get(f"https://api.github.com/repos/{REPO}/releases", timeout=30).json()
            asset = next(a for r in rels for a in r.get("assets", []) if a["name"].endswith(".nrrd"))
            total = int(asset.get("size", 0)) or 1
            done = 0
            self._status = f"downloading {LABEL} from GitHub… 0/{total >> 20} MB"
            with requests.get(asset["browser_download_url"], stream=True, timeout=900) as r, open(path, "wb") as fh:
                for c in r.iter_content(1 << 20):
                    fh.write(c); done += len(c)
                    self._status = f"downloading {LABEL} from GitHub… {done >> 20}/{total >> 20} MB ({100 * done // total}%)"
            cache.commit()
        else:
            self._status = "loading cached volume from local SSD…"
        # CC attribution (license is per-specimen: can be CC BY or CC BY-NC) — pull from accession
        try:
            acc = None
            for br in ("main", "master"):
                rr = requests.get(f"https://raw.githubusercontent.com/{REPO}/{br}/MorphoDepotAccession.json", timeout=20)
                if rr.ok:
                    acc = rr.json(); break
            owner = REPO.split("/")[0]
            try:
                nm = requests.get(f"https://api.github.com/users/{owner}", timeout=15).json().get("name") or owner
            except Exception:
                nm = owner

            def _f(k, d=""):
                v = acc.get(k) if acc else None
                return (v[1] if isinstance(v, list) and len(v) == 2 else v) or d
            self.cite_str = f"{_f('species', 'specimen')} · {_f('modality', '')} · © {nm} · {_f('license', 'see source')} · MorphoDepot"
        except Exception:
            self.cite_str = f"MorphoDepot · {REPO}"
        self.cite_url = f"https://github.com/{REPO}"
        import nrrd
        self._status = "decompressing volume…"
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
        vtmap = {np.dtype("uint8"): vtk.VTK_UNSIGNED_CHAR, np.dtype("uint16"): vtk.VTK_UNSIGNED_SHORT,
                 np.dtype("int16"): vtk.VTK_SHORT, np.dtype("int8"): vtk.VTK_SIGNED_CHAR,
                 np.dtype("float32"): vtk.VTK_FLOAT, np.dtype("float64"): vtk.VTK_FLOAT}
        atype = vtmap.get(data.dtype, vtk.VTK_FLOAT)
        # auto-window the TF from signal percentiles (16-bit diceCT sits in a narrow band;
        # full min/max renders nearly transparent -> the dark bumblebee bug)
        sub = np.asarray(data[::4, ::4, ::4]).astype(np.float32).ravel()
        _mn = float(sub.min()); _nz = sub[sub > _mn]
        if _nz.size < 1000:
            _nz = sub
        # window to the TISSUE band: p30..p92 of non-background. (p99+ is a sparse dense tail
        # that, if used as the top, compresses all real tissue into a near-transparent sliver.)
        lo2 = float(np.percentile(_nz, 30)); hi2 = float(np.percentile(_nz, 92))
        if hi2 <= lo2:
            lo2, hi2 = float(sub.min()), (float(sub.max()) or 1.0)
        del sub, _nz
        self._status = "uploading volume to the GPU…"
        flat = np.asfortranarray(data).ravel(order="F")
        if data.dtype == np.float64:
            flat = flat.astype(np.float32)
        arr = numpy_support.numpy_to_vtk(flat, deep=True, array_type=atype)
        self._keep = arr
        del data, flat
        img = vtk.vtkImageData(); img.SetDimensions(nx, ny, nz)
        img.SetSpacing(*[float(s) for s in spacing]); img.GetPointData().SetScalars(arr)
        self._status = "tuning transfer function…"
        lo = lo2; rg = (hi2 - lo2) or 1.0

        mapper = vtk.vtkGPUVolumeRayCastMapper(); mapper.SetInputData(img)
        # offscreen has no interactor so AutoAdjust never triggers -> rays would take ~1000s of
        # tiny (0.01 mm) steps. Set a coarse fixed step (~4 voxels) for interactive fps.
        mapper.SetAutoAdjustSampleDistances(False)
        _avg_sp = (sum(float(s) for s in spacing) / 3.0) or 1.0
        mapper.SetSampleDistance(_avg_sp * 4.0)
        # vivid spectral color TF (purple->blue->green->yellow->orange->white)
        color = vtk.vtkColorTransferFunction()
        for fr, r, g, b in [(0.00, 0, 0, 0), (0.06, 0.35, 0.10, 0.10), (0.20, 0.85, 0.40, 0.16),
                            (0.42, 0.96, 0.80, 0.45), (0.65, 0.70, 0.92, 0.62), (1.00, 0.88, 0.97, 1.0)]:
            color.AddRGBPoint(lo + fr * rg, r, g, b)
        op = vtk.vtkPiecewiseFunction()
        for fr, a in [(0.00, 0.0), (0.04, 0.03), (0.13, 0.17), (0.32, 0.42), (0.60, 0.70), (1.00, 0.93)]:
            op.AddPoint(lo + fr * rg, a)
        prop = vtk.vtkVolumeProperty(); prop.SetColor(color); prop.SetScalarOpacity(op)
        prop.ShadeOn(); prop.SetInterpolationTypeToLinear()
        prop.SetAmbient(0.45); prop.SetDiffuse(0.65); prop.SetSpecular(0.25); prop.SetSpecularPower(10)
        volume = vtk.vtkVolume(); volume.SetMapper(mapper); volume.SetProperty(prop)

        self.ren = vtk.vtkRenderer(); self.ren.AddVolume(volume); self.ren.SetBackground(0.03, 0.03, 0.07)
        self.rw = vtk.vtkEGLRenderWindow(); self.rw.SetOffScreenRendering(1); self.rw.SetSize(W, H)
        self.rw.AddRenderer(self.ren)
        self.ren.ResetCamera(); self.cam = self.ren.GetActiveCamera()
        self.cam.Elevation(-20); self.cam.OrthogonalizeViewUp(); self.ren.ResetCameraClippingRange()
        self.rw.Render()
        self._vtk, self._n2v, self._cv2, self._np = vtk, numpy_support, cv2, np
        self.ready = True

    def _render(self):
        vtk = self._vtk
        with self.lock:
            az, el, dz = self.pending["az"], self.pending["el"], self.pending["dz"]
            self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
        if az or el:
            self.cam.Azimuth(az); self.cam.Elevation(el); self.cam.OrthogonalizeViewUp()
        if dz:
            self.cam.Dolly(1.0 + max(-0.4, min(0.4, dz)))
        self.ren.ResetCameraClippingRange(); self.rw.Render()
        arr = vtk.vtkUnsignedCharArray()
        self.rw.GetRGBACharPixelData(0, 0, W - 1, H - 1, 0, arr)
        # RGBA -> BGR (cv2 order), vertical flip (VTK bottom-up); libjpeg-turbo encode (fast)
        a = self._np.ascontiguousarray(self._n2v.vtk_to_numpy(arr).reshape(H, W, 4)[::-1, :, 2::-1])
        ok, enc = self._cv2.imencode(".jpg", a, [self._cv2.IMWRITE_JPEG_QUALITY, 80])
        return enc.tobytes()

    @modal.asgi_app()
    def web(self):
        import asyncio
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
            loop = asyncio.get_event_loop()
            if not self.ready:
                fut = loop.run_in_executor(self.pool, self._ensure_loaded)
                while not fut.done():
                    try:
                        await sock.send_text(self._status)
                    except Exception:
                        break
                    await asyncio.sleep(0.4)
                await fut
            else:
                await loop.run_in_executor(self.pool, self._ensure_loaded)
            try:
                await sock.send_text(json.dumps({"cite": self.cite_str, "url": self.cite_url}))
            except Exception:
                pass
            await sock.send_bytes(await loop.run_in_executor(self.pool, self._render))
            stop = asyncio.Event()

            async def receiver():
                try:
                    while True:
                        m = await sock.receive_json()
                        with self.lock:
                            self.pending["az"] += -float(m.get("dx", 0)) * 0.4
                            self.pending["el"] += float(m.get("dy", 0)) * 0.4
                            self.pending["dz"] += float(m.get("zoom", 0))
                except Exception:
                    stop.set()

            async def sender():
                try:
                    while not stop.is_set():
                        with self.lock:
                            has = self.pending["az"] or self.pending["el"] or self.pending["dz"]
                        if has:
                            await sock.send_bytes(await loop.run_in_executor(self.pool, self._render))
                        else:
                            await asyncio.sleep(0.008)
                except Exception:
                    stop.set()

            rt = asyncio.create_task(receiver()); st = asyncio.create_task(sender())
            try:
                await stop.wait()
            finally:
                rt.cancel(); st.cancel()

        return fapp
