"""
LiveRenderer end-to-end demo on ONE real example: the MorphoDepot juvenile alligator microCT.

Pipeline (all on a Modal L4):
  fetch the 1.6 GB NRRD release asset (server-side, no CORS issue) -> vtkNrrdReader ->
  vtkGPUVolumeRayCastMapper (hardware EGL on the L4) -> rotate the camera N frames ->
  grab each frame -> RGBA->NV12 (cupy, GPU) -> NVENC H.264 -> mux to MP4.

Returns the MP4 + a preview PNG + timing/cost so we can SEE it and price it.

Run (short validation):  modal run alligator_demo.py --seconds 5
Run (full minute):       modal run alligator_demo.py --seconds 60
"""

import json
import subprocess
import time

import modal

app = modal.App("alligator-demo")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglx0", "libegl1", "libglvnd0", "libx11-6", "libxext6",
                 "mesa-utils-extra", "libxt6", "ffmpeg")
    .pip_install("vtk", "cupy-cuda12x[ctk]", "PyNvVideoCodec", "numpy", "requests", "pillow", "pynrrd")
    .run_commands(
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "python3 -c \"import json;open('/usr/share/glvnd/egl_vendor.d/10_nvidia.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libEGL_nvidia.so.0'}}))\"",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)

REPO = "dinonoto/AM112911-05_Juv_Alligator"
W, H, FPS = 1280, 720, 30
L4_PER_S = 0.000222


@app.function(gpu="L4", image=image, memory=24576, timeout=1200)
def render(seconds: int = 5):
    import numpy as np
    import requests
    import vtk
    from vtk.util import numpy_support
    import cupy as cp
    import PyNvVideoCodec as nvc

    t = {}
    wall0 = time.time()

    # 1) resolve + download the NRRD release asset (server-side; release assets aren't CORS-fetchable)
    t0 = time.time()
    rels = requests.get(f"https://api.github.com/repos/{REPO}/releases", timeout=30).json()
    asset = next(a for r in rels for a in r.get("assets", []) if a["name"].endswith(".nrrd"))
    url, size = asset["browser_download_url"], asset["size"]
    path = "/tmp/volume.nrrd"
    with requests.get(url, stream=True, timeout=600) as r, open(path, "wb") as f:
        for c in r.iter_content(1 << 20):
            f.write(c)
    t["download_s"] = round(time.time() - t0, 2)
    t["volume_file_MB"] = round(size / 1024**2, 1)

    # 2) load NRRD via pynrrd (vtkNrrdReader overflows on >2 GB gzip data) -> vtkImageData
    t0 = time.time()
    import nrrd
    data, hdr = nrrd.read(path)
    nx, ny, nz = (int(d) for d in data.shape[:3])
    sd = hdr.get("space directions")
    if sd is not None:
        spacing = []
        for v in sd:
            try:
                spacing.append(float(np.linalg.norm(np.asarray(v, dtype=float))))
            except Exception:
                spacing.append(1.0)
        spacing = (spacing + [1, 1, 1])[:3]
    else:
        spacing = (list(hdr.get("spacings", [1, 1, 1])) + [1, 1, 1])[:3]
    flat = np.asfortranarray(data).ravel(order="F")
    atype = vtk.VTK_UNSIGNED_CHAR if data.dtype == np.uint8 else vtk.VTK_SHORT
    vtk_arr = numpy_support.numpy_to_vtk(flat, deep=True, array_type=atype)
    del data, flat
    img = vtk.vtkImageData(); img.SetDimensions(nx, ny, nz)
    img.SetSpacing(float(spacing[0]), float(spacing[1]), float(spacing[2]))
    img.GetPointData().SetScalars(vtk_arr)
    t["volume_dims"] = [nx, ny, nz]
    t["spacing"] = [round(float(s), 4) for s in spacing]
    rng = img.GetScalarRange()
    t["scalar_range"] = [float(rng[0]), float(rng[1])]

    mapper = vtk.vtkGPUVolumeRayCastMapper(); mapper.SetInputData(img)
    mapper.SetAutoAdjustSampleDistances(True); mapper.UseJitteringOn()

    lo, hi = rng
    color = vtk.vtkColorTransferFunction()
    color.AddRGBPoint(lo, 0, 0, 0)
    color.AddRGBPoint(lo + 0.25 * (hi - lo), 0.45, 0.28, 0.18)
    color.AddRGBPoint(lo + 0.55 * (hi - lo), 0.85, 0.68, 0.45)
    color.AddRGBPoint(hi, 1.0, 0.98, 0.92)
    opac = vtk.vtkPiecewiseFunction()
    opac.AddPoint(lo, 0.0)
    opac.AddPoint(lo + 0.15 * (hi - lo), 0.0)
    opac.AddPoint(lo + 0.35 * (hi - lo), 0.12)
    opac.AddPoint(lo + 0.65 * (hi - lo), 0.55)
    opac.AddPoint(hi, 0.9)
    prop = vtk.vtkVolumeProperty()
    prop.SetColor(color); prop.SetScalarOpacity(opac)
    prop.ShadeOn(); prop.SetInterpolationTypeToLinear()
    prop.SetAmbient(0.3); prop.SetDiffuse(0.7); prop.SetSpecular(0.3); prop.SetSpecularPower(10)
    vol = vtk.vtkVolume(); vol.SetMapper(mapper); vol.SetProperty(prop)

    ren = vtk.vtkRenderer(); ren.AddVolume(vol); ren.SetBackground(0.0, 0.0, 0.04)
    rw = vtk.vtkEGLRenderWindow(); rw.SetOffScreenRendering(1); rw.SetSize(W, H); rw.AddRenderer(ren)
    ren.ResetCamera()
    cam = ren.GetActiveCamera(); cam.Elevation(-15); ren.ResetCameraClippingRange()
    rw.Render()  # first render = texture upload (warm)
    t["load_render_s"] = round(time.time() - t0, 2)
    t["gl_renderer"] = next((l.strip() for l in rw.ReportCapabilities().splitlines()
                             if "renderer string" in l.lower()), "?")

    # 3) NVENC encoder (CPU input, ultra-low-latency)
    enc = nvc.CreateEncoder(W, H, "NV12", True, codec="h264", bitrate=10_000_000,
                            tuning_info="ultra_low_latency")

    def grab_rgba():
        arr = vtk.vtkUnsignedCharArray()
        rw.GetRGBACharPixelData(0, 0, W - 1, H - 1, 0, arr)
        a = numpy_support.vtk_to_numpy(arr).reshape(H, W, 4)
        return a[::-1].copy()  # VTK is bottom-up

    def to_nv12(rgba):
        d = cp.asarray(rgba[:, :, :3]).astype(cp.float32)
        r, g, b = d[:, :, 0], d[:, :, 1], d[:, :, 2]
        y = cp.clip(0.257 * r + 0.504 * g + 0.098 * b + 16, 0, 255).astype(cp.uint8)
        u = cp.clip(-0.148 * r - 0.291 * g + 0.439 * b + 128, 0, 255).astype(cp.uint8)
        v = cp.clip(0.439 * r - 0.368 * g - 0.071 * b + 128, 0, 255).astype(cp.uint8)
        uv = cp.empty((H // 2, W), cp.uint8); uv[:, 0::2] = u[::2, ::2]; uv[:, 1::2] = v[::2, ::2]
        return cp.asnumpy(cp.ascontiguousarray(cp.concatenate([y, uv], 0)))

    # 4) render rotating frames -> encode
    nframes = seconds * FPS
    h264 = bytearray(); preview = None
    t0 = time.time(); t_r = t_e = 0.0
    for i in range(nframes):
        a0 = time.time()
        cam.Azimuth(360.0 / max(nframes, 1) * 2.0)  # two revolutions over the clip
        ren.ResetCameraClippingRange(); rw.Render()
        rgba = grab_rgba(); a1 = time.time()
        if i == 0:
            preview = rgba.copy()
        bs = enc.Encode(to_nv12(rgba))
        if bs is not None:
            h264 += bytes(bs)
        a2 = time.time(); t_r += a1 - a0; t_e += a2 - a1
    tail = enc.EndEncode()
    if tail is not None:
        h264 += bytes(tail)
    t["render_loop_s"] = round(time.time() - t0, 2)
    t["frames"] = nframes
    t["render_fps"] = round(nframes / t_r, 1) if t_r else None
    t["encode_fps"] = round(nframes / t_e, 1) if t_e else None

    # 5) mux raw H.264 -> MP4
    open("/tmp/out.h264", "wb").write(h264)
    subprocess.run(["ffmpeg", "-y", "-f", "h264", "-framerate", str(FPS), "-i", "/tmp/out.h264",
                    "-c", "copy", "/tmp/out.mp4"], capture_output=True)
    mp4 = open("/tmp/out.mp4", "rb").read()
    t["mp4_MB"] = round(len(mp4) / 1024**2, 2)
    t["h264_MB"] = round(len(h264) / 1024**2, 2)

    from PIL import Image
    import io
    pbuf = io.BytesIO(); Image.fromarray(preview[:, :, :3]).save(pbuf, "PNG")

    wall = time.time() - wall0
    t["total_wall_s"] = round(wall, 2)
    t["cost_this_run_usd"] = round(wall * L4_PER_S, 4)
    t["cost_per_60s_video_usd"] = round((t["render_loop_s"] / max(seconds, 1) * 60) * L4_PER_S, 4)
    return t, mp4, pbuf.getvalue()


@app.local_entrypoint()
def main(seconds: int = 5):
    stats, mp4, png = render.remote(seconds)
    open("/tmp/alligator.mp4", "wb").write(mp4)
    open("/tmp/alligator_preview.png", "wb").write(png)
    print(json.dumps(stats, indent=2))
    print("\nwrote /tmp/alligator.mp4 and /tmp/alligator_preview.png")
