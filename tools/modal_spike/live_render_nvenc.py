"""
LiveRenderer — progressive multiscale NVENC/H.264/WebCodecs volume rendering on a Modal L4.

Open URL -> coarsest pyramid level (/8) renders in a few seconds and streaming starts; finer levels
(/4, /2, /1) load from Zarr and swap in progressively. Drag to rotate, wheel to zoom. The overlay
shows per-level size + load time + which level is currently displayed + time-to-first-frame + fps.

Backend-pluggable: reads levels from the Modal Volume now; pointing the level paths at a JS2/S3 bucket
(parallel chunked GETs) is the one-line swap that takes the full level from ~36 s to ~9 s.

Deploy:  modal deploy live_render_nvenc.py
"""
import json
import time
import modal

_IMPORT_TS = time.time()
SPEC = "bumblebee"
REPO, LABEL = "muratmaga/Bumblebee_Stained", "diceCT bumblebee (Bombus) — Murat's data"
W, H = 1280, 720

app = modal.App("slicerlive")
cache = modal.Volume.from_name("slicerlive-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    # minimal GL: glvnd loaders + Xlib stubs (NVIDIA EGL is injected at runtime). No mesa-utils-extra
    # (it pulled mesa-dri + llvmpipe ~150MB, only used by the eglinfo diagnostic).
    .apt_install("libgl1", "libglx0", "libegl1", "libglvnd0", "libx11-6", "libxext6", "libxt6")
    # No cupy (pulled ~3 GB CUDA toolkit -> slow cold boot); no pynrrd (spacing is in the sidecar).
    .pip_install("vtk", "numpy", "requests", "fastapi", "PyNvVideoCodec", "zarr<3", "numcodecs")
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
#v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;cursor:grab;touch-action:none;user-select:none;background:#07070d}
#v.drag{cursor:grabbing}
#brand{position:fixed;left:12px;top:9px;z-index:3;font-weight:700;font-size:15px;color:#eaf;text-shadow:0 1px 4px #000}#brand small{font-weight:400;font-size:11px;color:#9ab}
#s{position:fixed;left:12px;top:32px;color:#9cf;text-shadow:0 1px 3px #000;z-index:2}
#stats{position:fixed;right:10px;top:8px;color:#9c9;font:11px ui-monospace,monospace;z-index:2;text-align:right;white-space:pre;line-height:1.5;text-shadow:0 1px 2px #000}
#cite{position:fixed;left:10px;right:10px;bottom:8px;color:#9ab;font:11px system-ui;text-shadow:0 1px 3px #000;z-index:2}#cite a{color:#9cf}</style></head>
<body><div id=brand>LiveRenderer <small>· SlicerLive · progressive NVENC/WebCodecs</small></div>
<div id=s>connecting…</div><div id=stats></div><div id=cite></div><canvas id=v></canvas>
<script>
const v=document.getElementById('v'),s=document.getElementById('s'),st=document.getElementById('stats'),cite=document.getElementById('cite');
const ctx=v.getContext('2d');
let ws,dec=null,started=false,tsv=0,drag=false,px=0,py=0,pend=null,frames=0,t0=performance.now(),fps=0,prog=null;
function draw(){ if(!prog){return;}
  let lines=['ttf '+(prog.ttf!=null?prog.ttf+'s':'…')+'   '+fps+' fps'];
  for(const L of prog.levels){ const sh=(L.ds===prog.shown_ds)?' ◀ shown':'';
    const status=L.applied?'✓':(L.loaded?'·':'⟳'); lines.push('L'+L.ds+'  '+L.MB+' MB  '+(L.load_s!=null?L.load_s+'s':'   ')+'  '+status+sh); }
  st.textContent=lines.join('\\n'); }
function setupDecoder(codec){
  if(!('VideoDecoder' in window)){s.textContent='this browser lacks WebCodecs (use Chrome/Edge)';return;}
  dec=new VideoDecoder({output:fr=>{ if(v.width!==fr.displayWidth){v.width=fr.displayWidth;v.height=fr.displayHeight;} ctx.drawImage(fr,0,0); fr.close();
    frames++; const dt=performance.now()-t0; if(dt>500){fps=(frames*1000/dt|0); frames=0; t0=performance.now(); draw();} },
    error:e=>{s.textContent='decode error: '+e.message}});
  dec.configure({codec:codec, optimizeForLatency:true, hardwareAcceleration:'prefer-hardware'});
  s.textContent='drag to rotate • wheel to zoom';
}
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
  ws.binaryType='arraybuffer';
  ws.onopen=()=>{s.textContent='starting renderer…';};
  ws.onmessage=e=>{
    if(typeof e.data==='string'){ try{const o=JSON.parse(e.data);
        if(o.config){setupDecoder(o.config);return;}
        if(o.prog){prog=o.prog;draw();return;}
        if(o.cite){cite.innerHTML=o.cite+(o.url?' · <a href="'+o.url+'" target=_blank rel=noopener>source ↗</a>':'');return;} }catch(_){}
      s.textContent=e.data; return; }
    if(!dec||dec.state!=='configured') return;
    const u=new Uint8Array(e.data); const key=u[0]===1; const data=u.subarray(1);
    if(!started){ if(!key) return; started=true; }
    try{ dec.decode(new EncodedVideoChunk({type:key?'key':'delta', timestamp:tsv, data})); tsv+=33333; }catch(err){}
  };
  ws.onclose=()=>{started=false;dec=null;s.textContent='disconnected — reconnecting…';setTimeout(connect,800);};
  ws.onerror=()=>{try{ws.close()}catch(e){}};
}
connect();
function step(){ if(pend&&ws&&ws.readyState===1){ ws.send(JSON.stringify(pend)); pend=null; } requestAnimationFrame(step); }
requestAnimationFrame(step);
v.addEventListener('pointerdown',e=>{drag=true;px=e.clientX;py=e.clientY;v.classList.add('drag');v.setPointerCapture(e.pointerId);});
v.addEventListener('pointerup',e=>{drag=false;v.classList.remove('drag');});
v.addEventListener('pointermove',e=>{ if(!drag)return; const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;
  pend=pend||{dx:0,dy:0,zoom:0}; pend.dx+=dx; pend.dy+=dy; });
v.addEventListener('wheel',e=>{e.preventDefault(); pend=pend||{dx:0,dy:0,zoom:0}; pend.zoom+=(e.deltaY<0?0.06:-0.06);},{passive:false});
</script></body></html>""".replace("__LABEL__", LABEL)


def _nal_types(data):
    types = set(); sps = None; n = len(data); j = 0; starts = []
    while j + 3 <= n:
        if data[j] == 0 and data[j+1] == 0 and data[j+2] == 1:
            starts.append(j + 3); j += 3
        elif j + 4 <= n and data[j] == 0 and data[j+1] == 0 and data[j+2] == 0 and data[j+3] == 1:
            starts.append(j + 4); j += 4
        else:
            j += 1
    for k, stt in enumerate(starts):
        en = (starts[k + 1] - 3) if k + 1 < len(starts) else n
        if en <= stt:
            continue
        t = data[stt] & 0x1F
        types.add(t)
        if t == 7:
            sps = bytes(data[stt:en])
    return types, sps


@app.cls(gpu="L4", image=image, memory=49152, volumes={"/cache": cache},
         scaledown_window=600, timeout=3600)
@modal.concurrent(max_inputs=8)  # one container serves many connections (GET + WS); default=1 hangs reloads
class Renderer:
    @modal.enter()
    def boot(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
        self.ready = False
        self._status = "starting GPU container…"
        self._next = None            # (ds, img, keep) finer level waiting to swap
        self._keeprefs = []
        self._levelstat = []
        self._cur_ds = None
        self._ttf = None
        self._prog_dirty = True

    def _mk_image(self, arr, spacing):
        vtk, np, n2v = self._vtk, self._np, self._n2v
        nx, ny, nz = (int(d) for d in arr.shape[:3])
        vt = {np.dtype("uint8"): vtk.VTK_UNSIGNED_CHAR, np.dtype("uint16"): vtk.VTK_UNSIGNED_SHORT,
              np.dtype("int16"): vtk.VTK_SHORT, np.dtype("float32"): vtk.VTK_FLOAT}.get(arr.dtype, vtk.VTK_FLOAT)
        flat = np.asfortranarray(arr).ravel(order="F")
        a = n2v.numpy_to_vtk(flat, deep=True, array_type=vt)
        img = vtk.vtkImageData(); img.SetDimensions(nx, ny, nz)
        img.SetSpacing(float(spacing[0]), float(spacing[1]), float(spacing[2]))
        img.GetPointData().SetScalars(a)
        return img, a

    def _read_level(self, path):
        import zarr
        return zarr.open(path, mode="r")[:]   # Volume: serial is fine (parallel doesn't help here)

    def _load_finer_bg(self):
        # load /4, /2, /1 in order; hand each to the render thread to swap in
        import numpy as np  # noqa
        for i, L in enumerate(self._levels[1:], start=1):
            try:
                t = time.time()
                arr = self._read_level(L["path"])
                img, keep = self._mk_image(arr, [s * L["ds"] for s in self._spacing])
                del arr
                with self.lock:
                    self._next = (L["ds"], img, keep)
                    self._levelstat[i]["loaded"] = True
                    self._levelstat[i]["load_s"] = round(time.time() - t, 1)
                    self._prog_dirty = True
            except Exception as e:
                self._status = f"level /{L['ds']} failed: {e!r}"

    def _ensure_loaded(self):
        if self.ready:
            return
        import json as _json
        import numpy as np
        import requests
        import vtk
        import PyNvVideoCodec as nvc
        from vtk.util import numpy_support
        self._vtk, self._np, self._n2v, self._nvc = vtk, np, numpy_support, nvc
        t0 = time.time()

        # citation
        try:
            acc = None
            for br in ("main", "master"):
                rr = requests.get(f"https://raw.githubusercontent.com/{REPO}/{br}/MorphoDepotAccession.json", timeout=12)
                if rr.ok:
                    acc = rr.json(); break
            owner = REPO.split("/")[0]
            try:
                nm = requests.get(f"https://api.github.com/users/{owner}", timeout=10).json().get("name") or owner
            except Exception:
                nm = owner

            def _g(k, d=""):
                vv = acc.get(k) if acc else None
                return (vv[1] if isinstance(vv, list) and len(vv) == 2 else vv) or d
            self.cite_str = f"{_g('species', 'specimen')} · {_g('modality', '')} · © {nm} · {_g('license', 'see source')} · MorphoDepot"
        except Exception:
            self.cite_str = f"MorphoDepot · {REPO}"
        self.cite_url = f"https://github.com/{REPO}"

        meta = _json.load(open(f"/cache/{SPEC}_pyramid.json"))
        self._spacing = meta["spacing"]
        self._levels = sorted(meta["levels"], key=lambda L: -L["ds"])  # coarsest first
        self._levelstat = [{"ds": L["ds"], "MB": L["MB"], "loaded": False, "applied": False, "load_s": None}
                           for L in self._levels]
        lo, hi = meta["tf_lo"], meta["tf_hi"]

        # coarsest level -> first render
        c = self._levels[0]
        self._status = f"loading coarse /{c['ds']} ({c['MB']} MB)…"
        tt = time.time()
        arr = self._read_level(c["path"])
        img, keep = self._mk_image(arr, [s * c["ds"] for s in self._spacing])
        self._keeprefs.append(keep); del arr
        self.mapper = vtk.vtkGPUVolumeRayCastMapper(); self.mapper.SetInputData(img)
        self.mapper.SetAutoAdjustSampleDistances(False)
        _avg = (sum(float(s) for s in self._spacing) / 3.0) or 1.0
        self.mapper.SetSampleDistance(_avg * 4.0)
        rg = (hi - lo) or 1.0
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
        vol = vtk.vtkVolume(); vol.SetMapper(self.mapper); vol.SetProperty(prop)
        self.ren = vtk.vtkRenderer(); self.ren.AddVolume(vol); self.ren.SetBackground(0.03, 0.03, 0.07)
        self.rw = vtk.vtkEGLRenderWindow(); self.rw.SetOffScreenRendering(1); self.rw.SetSize(W, H)
        self.rw.AddRenderer(self.ren)
        self.ren.ResetCamera(); self.cam = self.ren.GetActiveCamera()
        self.cam.Elevation(-20); self.cam.OrthogonalizeViewUp(); self.ren.ResetCameraClippingRange()
        self.rw.Render()
        self._cur_ds = c["ds"]
        self._levelstat[0]["loaded"] = True; self._levelstat[0]["applied"] = True
        self._levelstat[0]["load_s"] = round(time.time() - tt, 1)
        self._prog_dirty = True
        self.ready = True
        import threading
        threading.Thread(target=self._load_finer_bg, daemon=True).start()

    def make_encoder(self):
        # ABGR input -> NVENC does RGB->YUV on the GPU (no cupy, no CPU color math)
        return self._nvc.CreateEncoder(W, H, "ABGR", True, codec="h264", bitrate=6000000,
                                       tuning_info="ultra_low_latency", bf=0, gop=60, rc="cbr")

    def render_h264(self, enc):
        np = self._np
        # swap to a finer level if one is ready
        if self._next is not None and self._next[0] < (self._cur_ds or 999):
            with self.lock:
                ds, img, keep = self._next; self._next = None
            self.mapper.SetInputData(img); self._keeprefs.append(keep); self._cur_ds = ds
            for stt in self._levelstat:
                if stt["ds"] == ds:
                    stt["applied"] = True
            self._prog_dirty = True
        with self.lock:
            az, el, dz = self.pending["az"], self.pending["el"], self.pending["dz"]
            self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
        if az or el:
            self.cam.Azimuth(az); self.cam.Elevation(el); self.cam.OrthogonalizeViewUp()
        if dz:
            self.cam.Dolly(1.0 + max(-0.4, min(0.4, dz)))
        self.ren.ResetCameraClippingRange(); self.rw.Render()
        a = self._vtk.vtkUnsignedCharArray()
        self.rw.GetRGBACharPixelData(0, 0, W - 1, H - 1, 0, a)
        # NVENC converts RGB->YUV on the GPU; hand it ABGR (= RGBA reversed). No CPU color math.
        rgba = self._n2v.vtk_to_numpy(a).reshape(H, W, 4)[::-1]   # vertical flip, keep 4 channels
        abgr = np.ascontiguousarray(rgba[:, :, ::-1])            # RGBA -> ABGR
        bs = enc.Encode(abgr)
        return bytes(bs) if bs is not None else b""

    def _prog(self):
        return {"prog": {"shown_ds": self._cur_ds, "ttf": self._ttf,
                         "levels": [dict(x) for x in self._levelstat]}}

    @modal.asgi_app()
    def web(self):
        import asyncio
        from fastapi import FastAPI, WebSocket
        from fastapi.responses import HTMLResponse
        fapp = FastAPI()

        @fapp.get("/")
        def index():
            return HTMLResponse(PAGE)

        @fapp.websocket("/ws")
        async def ws(sock: WebSocket):
            await sock.accept()
            t_conn = time.time()
            loop = asyncio.get_event_loop()
            cold = not self.ready
            if cold:
                fut = loop.run_in_executor(self.pool, self._ensure_loaded)
                while not fut.done():
                    try:
                        await sock.send_text(self._status)
                    except Exception:
                        break
                    await asyncio.sleep(0.3)
                await fut
            else:
                await loop.run_in_executor(self.pool, self._ensure_loaded)

            enc = await loop.run_in_executor(self.pool, self.make_encoder)
            try:
                await sock.send_text(json.dumps({"cite": self.cite_str, "url": self.cite_url}))
            except Exception:
                pass
            data = b""
            for _ in range(15):  # NVENC buffers ~3 input frames; loop to the first real IDR (+SPS)
                data = await loop.run_in_executor(self.pool, lambda: self.render_h264(enc))
                if data:
                    break
            types, sps = _nal_types(data)
            codec = ("avc1." + bytes(sps[1:4]).hex()) if (sps and len(sps) >= 4) else "avc1.64001f"
            await sock.send_text(json.dumps({"config": codec}))
            key = (5 in types) or (7 in types)
            await sock.send_bytes(bytes([1 if key else 0]) + data)
            self._ttf = round(time.time() - t_conn, 1)
            self._prog_dirty = True
            try:
                await sock.send_text(json.dumps(self._prog()))
            except Exception:
                pass

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
                            motion = self.pending["az"] or self.pending["el"] or self.pending["dz"]
                        swap = self._next is not None and self._next[0] < (self._cur_ds or 999)
                        if motion or swap:
                            d = await loop.run_in_executor(self.pool, lambda: self.render_h264(enc))
                            if d:
                                t, _ = _nal_types(d)
                                await sock.send_bytes(bytes([1 if (5 in t or 7 in t) else 0]) + d)
                        if self._prog_dirty:
                            self._prog_dirty = False
                            try:
                                await sock.send_text(json.dumps(self._prog()))
                            except Exception:
                                pass
                        if not (motion or swap):
                            await asyncio.sleep(0.01)
                except Exception:
                    stop.set()

            rt = asyncio.create_task(receiver()); st = asyncio.create_task(sender())
            try:
                await stop.wait()
            finally:
                rt.cancel(); st.cancel()
                try:
                    enc.EndEncode()   # release the NVENC session so reloads don't leak encoders
                except Exception:
                    pass

        return fapp
