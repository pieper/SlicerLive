"""
local_render_ws.py — LiveRenderer end-to-end, LOCALLY, with no Vulkan and no NVENC.

Same seam as live_render_nvenc.py (render -> H.264 -> WebSocket -> browser WebCodecs),
but with the two GPU-vendor-specific pieces swapped for portable ones so it runs on a
laptop:

  * Render : slicer_wgpu.headless.HeadlessVolumeRenderer  (wgpu -> Metal on macOS /
             any wgpu adapter; NO Vulkan requirement)
  * Encode : SoftwareH264Encoder  (PyAV / libx264, Annex-B, zero-latency; NO NVENC)

Everything else — the browser page, the WebCodecs decode, the WebSocket protocol
(config message, 1-byte keyframe prefix + Annex-B NAL, camera dx/dy/zoom input) — is the
SAME as the Modal harness, so this is a faithful local rehearsal of the transport + client.

Run:
    pip install slicer-wgpu av fastapi "uvicorn[standard]"   # + a wgpu adapter
    python local_render_ws.py            # then open http://127.0.0.1:8788 in Chrome/Edge

The volume is synthetic (a shell + dense core) so no data download is needed. Point
set_volume() at a real numpy array to render anything else.
"""
import os
import json
import math
import time
import struct
import asyncio
import threading
from fractions import Fraction
from concurrent.futures import ThreadPoolExecutor

import numpy as np

W, H = 900, 640
FPS = 30
PORT = int(os.environ.get("PORT", "8788"))
DATA = os.environ.get("DATA", "synthetic").lower()   # "synthetic" | "bumblebee" | "multivol"
MULTIVOL_DIR = os.environ.get("MULTIVOL_DIR", "/root/data")
LEVEL = os.environ.get("LEVEL", "L4")                 # bumblebee pyramid level: L8/L4/L2/L1
# Fixed opacity-unit-distance (world mm) for ALL bumblebee levels so coarse/fine look the same
# (otherwise finer levels over-accumulate opacity). Tunable for overall density.
BEE_OUD = float(os.environ.get("OUD", "1.0"))
MOTION_SAMPLES = int(os.environ.get("MOTION_SAMPLES", "300"))  # ~ray-march samples while dragging
MOTION_LOD = os.environ.get("MOTION_LOD", "0").lower() in ("1", "true", "on", "yes")  # coarse-while-moving
MAX_DIM = int(os.environ.get("MAX_DIM", "8192"))  # framebuffer axis cap (allows 8K; GPU 2D limit ~16-32K)
MOTION_SCALE = float(os.environ.get("MOTION_SCALE", "0.5"))  # render at this fraction while dragging (upsampled client-side)
MOTION_RES = os.environ.get("MOTION_RES", "1").lower() in ("1", "true", "on", "yes")  # downscale while moving
# Adaptive geometry v0: while moving, render a DENSE reduced frame targeting this many on-GPU
# pixels (client upsamples). A big 4K/retina window drops to a fraction of its pixels (render
# cost ~pixels), a small window stays full-res. Hero (settled) frames always render full-res.
MOTION_TARGET_PX = int(os.environ.get("MOTION_TARGET_PX", "1200000"))  # initial pixel budget (~1.2 MP)
# v2 budget controller: during motion, steer the pixel budget so the MEASURED render time tracks
# this target — adapts to scene complexity (TF/zoom changes cost) and GPU speed, not just window px.
MOTION_TARGET_MS = float(os.environ.get("MOTION_TARGET_MS", "12"))
DBG_SEND = os.environ.get("DBG_SEND", "0").lower() in ("1", "true", "on", "yes")  # log settle sends
LABEL = "synthetic volume (local wgpu + libx264, no Vulkan/NVENC)"


# --------------------------------------------------------------------------
# Software H.264 encoder — mirrors the NVENC encoder's Encode()->bytes contract
# --------------------------------------------------------------------------

class SoftwareH264Encoder:
    """libx264 Annex-B encoder. encode(rgb) -> concatenated NAL bytes for that frame."""

    def __init__(self, width, height, fps=FPS, bitrate=6_000_000, gop=60):
        import av
        self.ctx = av.CodecContext.create("libx264", "w")
        self.ctx.width = width
        self.ctx.height = height
        self.ctx.pix_fmt = "yuv420p"
        self.ctx.time_base = Fraction(1, fps)
        self.ctx.framerate = Fraction(fps, 1)
        self.ctx.bit_rate = bitrate
        self.ctx.gop_size = gop
        # ultrafast + zerolatency => one packet out per frame in, no B-frames, SPS/PPS
        # repeated on each IDR (Annex-B) — exactly what WebCodecs wants with no description.
        self.ctx.options = {"preset": "ultrafast", "tune": "zerolatency"}
        self._av = av
        self._pts = 0

    def encode(self, rgba):
        rgb = np.ascontiguousarray(rgba[:, :, :3])
        frame = self._av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuv420p")
        frame.pts = self._pts
        self._pts += 1
        out = b""
        for pkt in self.ctx.encode(frame):
            out += bytes(pkt)
        return out

    def close(self):
        try:
            for _ in self.ctx.encode(None):
                pass
        except Exception:
            pass


class NvencH264Encoder:
    """Hardware H.264 via PyNvVideoCodec (NVENC). Same encode(rgba)->bytes contract.

    NVENC does RGB->YUV on the GPU; we hand it ABGR (= RGBA reversed, no CPU color math),
    exactly like the modal harness. NVENC buffers ~3 input frames, so the first few encode()
    calls return b"" until the first IDR emerges — callers loop for the first frame.
    """
    def __init__(self, width, height, fps=FPS, bitrate=6_000_000, gop=60):
        import PyNvVideoCodec as nvc
        self.enc = nvc.CreateEncoder(width, height, "ABGR", True, codec="h264",
                                     bitrate=bitrate, tuning_info="ultra_low_latency",
                                     bf=0, gop=gop, rc="cbr")

    def encode(self, rgba):
        # NVENC "ABGR" (NV_ENC_BUFFER_FORMAT_ABGR = A8B8G8R8, DWORD-packed) is little-endian
        # byte order R,G,B,A — i.e. exactly our wgpu RGBA readback. Feed it directly (no
        # channel reversal); NVENC does RGB->YUV on the GPU and ignores alpha.
        buf = np.ascontiguousarray(rgba)
        bs = self.enc.Encode(buf)
        return bytes(bs) if bs is not None else b""

    def close(self):
        try:
            self.enc.EndEncode()
        except Exception:
            pass


class MjpegEncoder:
    """Independent image per frame. Fast JPEG while moving; an AVIF 'hero' frame the instant the
    view settles (encode(rgba, hero=True)) — ~2.7x smaller and HDR-ready, at higher encode cost
    that doesn't matter when idle. Every frame stands alone (client keeps only the newest)."""
    def __init__(self, width, height, quality=80, avif_q=70, avif_speed=10, avif_threads=8,
                 hero_quality=92):
        from PIL import Image
        self._Image = Image
        self.quality = quality
        self.hero_quality = hero_quality
        self.avif_q, self.avif_speed, self.avif_threads = avif_q, avif_speed, avif_threads
        # The settled "hero" frame defaults to a HIGH-QUALITY JPEG: it always decodes (every browser
        # + PIL), stays the same codec as the progressive frames (no codec-transition risk), and is
        # crisp. AVIF (smaller, 10-bit/HDR-ready) is opt-in via HERO_AVIF=1 for later HDR work.
        self.hero_avif = os.environ.get("HERO_AVIF", "0").lower() in ("1", "true", "on", "yes")
        try:
            import pillow_avif  # noqa: F401  (registers the AVIF codec with Pillow)
            self._avif = True
        except Exception:
            self._avif = False

    def encode(self, rgba, hero=False):
        import io
        rgb = np.ascontiguousarray(rgba[:, :, :3])
        b = io.BytesIO()
        if hero and self.hero_avif and self._avif:
            self._Image.fromarray(rgb).save(b, "AVIF", quality=self.avif_q,
                                            speed=self.avif_speed, max_threads=self.avif_threads)
        elif hero:
            self._Image.fromarray(rgb).save(b, "JPEG", quality=self.hero_quality)
        else:
            self._Image.fromarray(rgb).save(b, "JPEG", quality=self.quality)
        return b.getvalue()

    def close(self):
        pass


def make_encoder(width, height):
    """Pick the encoder from $ENCODER (mjpeg|nvenc|software). Returns (enc, name, mode) where
    mode is 'image' (independent frames, fire-and-forget) or 'video' (H.264, ack-paced)."""
    which = os.environ.get("ENCODER", "software").lower()
    if which == "mjpeg":
        print("encoder: MJPEG (independent frames)")
        return MjpegEncoder(width, height, int(os.environ.get("JPEG_Q", "80"))), "mjpeg", "image"
    if which == "nvenc":
        try:
            enc = NvencH264Encoder(width, height)
            print("encoder: NVENC (hardware)")
            return enc, "NVENC", "video"
        except Exception as e:
            print(f"NVENC unavailable ({e!r}); falling back to libx264")
    print("encoder: libx264 (software)")
    return SoftwareH264Encoder(width, height), "libx264", "video"


# --------------------------------------------------------------------------
# NAL parsing (copied verbatim from live_render_nvenc.py for stream parity)
# --------------------------------------------------------------------------

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


# --------------------------------------------------------------------------
# Synthetic volume
# --------------------------------------------------------------------------

def make_synthetic_volume(n=112):
    z, y, x = np.mgrid[0:n, 0:n, 0:n].astype(np.float32)
    c = (n - 1) / 2.0
    r = np.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2)
    vol = np.zeros((n, n, n), dtype=np.float32)
    vol[r < n * 0.20] = 1000.0                                   # dense core
    shell = (r > n * 0.36) & (r < n * 0.44)
    vol[shell] = 450.0                                          # thin outer shell
    ring = (np.abs(z - c) < n * 0.05) & (r > n * 0.24) & (r < n * 0.34)
    vol[ring] = 700.0                                           # equatorial ring
    return vol


# --------------------------------------------------------------------------
# Bumblebee (diceCT) — multiscale Zarr pyramid on the public JS2 Swift bucket
# --------------------------------------------------------------------------

JS2_BASE = "https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive-data"


def _fetch_pyramid_meta():
    import requests
    return requests.get(JS2_BASE + "/bumblebee_pyramid.json", timeout=20).json()


def _parallel_get(url, nconn=32, progress=None):
    """Download one object with nconn concurrent HTTP Range requests to saturate the link
    (a single stream can't fill a fast pipe). Falls back to a single streamed GET if the
    server won't range. progress(frac) reports 0..1 across all ranges."""
    import math
    import requests
    sess = requests.Session()
    h = sess.head(url, timeout=30)
    total = int(h.headers.get("Content-Length", 0))
    if not total or "bytes" not in h.headers.get("Accept-Ranges", "").lower():
        r = sess.get(url, timeout=600, stream=True); buf = bytearray()
        for part in r.iter_content(1 << 20):
            buf += part
            if total and progress:
                progress(len(buf) / total)
        return bytes(buf)
    psize = math.ceil(total / nconn)
    ranges = [(i * psize, min((i + 1) * psize, total) - 1) for i in range(nconn) if i * psize < total]
    parts = [b""] * len(ranges)
    got = [0]
    lk = threading.Lock()

    def fetch(idx):
        a, b = ranges[idx]
        r = sess.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=600, stream=True)
        buf = bytearray()
        for part in r.iter_content(1 << 20):
            buf += part
            with lk:
                got[0] += len(part)
                if progress:
                    progress(got[0] / total)
        parts[idx] = bytes(buf)

    with ThreadPoolExecutor(len(ranges)) as ex:
        list(ex.map(fetch, range(len(ranges))))
    return b"".join(parts)


def load_bumblebee(level="L4", progress=None):
    """Return (float32 volume [K,J,I], spacing (mm), (tf_lo, tf_hi)) for a pyramid level.

    Downloads saturate the link: single-chunk levels use parallel Range requests; multi-chunk
    levels (L1) fetch chunks concurrently. progress(frac) reports 0..1."""
    import math
    import itertools
    import requests
    import numcodecs
    meta = _fetch_pyramid_meta()
    ds = int(level[1:])
    spacing = tuple(float(s) * ds for s in meta["spacing"])   # level covers ds full-res voxels
    lo, hi = float(meta["tf_lo"]), float(meta["tf_hi"])
    base = f"{JS2_BASE}/bumblebee_{level}.zarr"
    za = json.loads(requests.get(base + "/.zarray", timeout=30).text)
    shape, chunks, dtype = za["shape"], za["chunks"], np.dtype(za["dtype"])
    order = za.get("order", "C")
    comp = numcodecs.get_codec(za["compressor"]) if za.get("compressor") else None
    grid = [range(math.ceil(shape[i] / chunks[i])) for i in range(len(shape))]
    coords = list(itertools.product(*grid))
    nch = len(coords)
    out = np.empty(shape, dtype, order=order)

    def place(c, dec):
        arr = np.frombuffer(dec, dtype).reshape(chunks, order=order)
        sl = tuple(slice(c[i] * chunks[i], min((c[i] + 1) * chunks[i], shape[i])) for i in range(len(shape)))
        asl = tuple(slice(0, sl[i].stop - sl[i].start) for i in range(len(shape)))
        out[sl] = arr[asl]

    if nch == 1:
        raw = _parallel_get(f"{base}/{'.'.join(map(str, coords[0]))}", progress=progress)
        place(coords[0], comp.decode(raw) if comp else raw)
    else:
        done = [0]
        lk = threading.Lock()
        sess = requests.Session()

        def rd(c):
            raw = sess.get(f"{base}/{'.'.join(map(str, c))}", timeout=600).content
            place(c, comp.decode(raw) if comp else raw)
            with lk:
                done[0] += 1
                if progress:
                    progress(done[0] / nch)

        with ThreadPoolExecutor(min(nch, 32)) as ex:
            list(ex.map(rd, coords))
    return out.astype(np.float32), spacing, (lo, hi)


def bumblebee_catalog():
    """List pyramid levels (coarse->fine) with size + VRAM cost, from the pyramid sidecar."""
    meta = _fetch_pyramid_meta()
    cat = []
    for L in sorted(meta["levels"], key=lambda x: -x["ds"]):
        shape = L["shape"]
        vox = shape[0] * shape[1] * shape[2]
        cat.append({"name": f"L{L['ds']}", "ds": L["ds"], "shape": shape,
                    "disk_mb": round(L["MB"]), "vram_mb": round(vox * 4 / 1e6),
                    "maxdim": max(shape)})
    return cat


def bumblebee_tf(lo, hi):
    """diceCT color/opacity transfer function (fractions of [lo,hi]), from live_render_nvenc.py."""
    rg = (hi - lo) or 1.0
    cfr = [(0.00, 0, 0, 0), (0.06, 0.35, 0.10, 0.10), (0.20, 0.85, 0.40, 0.16),
           (0.42, 0.96, 0.80, 0.45), (0.65, 0.70, 0.92, 0.62), (1.00, 0.88, 0.97, 1.0)]
    ofr = [(0.00, 0.0), (0.04, 0.03), (0.13, 0.17), (0.32, 0.42), (0.60, 0.70), (1.00, 0.93)]
    color = [(lo + fr * rg, r, g, b) for fr, r, g, b in cfr]
    opacity = [(lo + fr * rg, a) for fr, a in ofr]
    return color, opacity


# --------------------------------------------------------------------------
# Multi-volume — replica of SceneRendering test_MultiVolume (2 CT volumes,
# each its own Slicer VR preset, both centered at origin so they composite)
# --------------------------------------------------------------------------

# Control points lifted verbatim from Slicer VolumeRendering Resources/presets.xml
# (leading integer is the value count; color = scalar,r,g,b ; opacity = scalar,alpha).
_PRESETS = {
    "CT-AAA": {
        "color": "24 -3024 0 0 0 143.556 0.615686 0.356863 0.184314 166.222 0.882353 0.603922 "
                 "0.290196 214.389 1 1 1 419.736 1 0.937033 0.954531 3071 0.827451 0.658824 1",
        "opacity": "12 -3024 0 143.556 0 166.222 0.686275 214.389 0.696078 419.736 0.833333 3071 0.803922",
    },
    "CT-Chest-Contrast-Enhanced": {
        "color": "20 -3024 0 0 0 67.0106 0.54902 0.25098 0.14902 251.105 0.882353 0.603922 0.290196 "
                 "439.291 1 0.937033 0.954531 3071 0.827451 0.658824 1",
        "opacity": "10 -3024 0 67.0106 0 251.105 0.446429 439.291 0.625 3071 0.616071",
    },
}


def _preset_points(name):
    def parse(s, k):
        t = s.split(); n = int(t[0]); v = list(map(float, t[1:1 + n]))
        return [tuple(v[i:i + k]) for i in range(0, len(v), k)]
    p = _PRESETS[name]
    return parse(p["color"], 4), parse(p["opacity"], 2)


_NRRD_CACHE = {}


def _load_nrrd(path):
    """Read an NRRD to (float32 [K,J,I], spacing (sI,sJ,sK) mm). Cached at module level so
    per-session renderers (one per ws connection) share the CPU arrays — a new session only
    pays for the GPU texture upload, not the disk read/transpose."""
    if path in _NRRD_CACHE:
        return _NRRD_CACHE[path]
    import nrrd
    d, h = nrrd.read(path)
    arr = np.ascontiguousarray(d.transpose(2, 1, 0)).astype(np.float32)   # nrrd [I,J,K] -> [K,J,I]
    sd = h.get("space directions")
    sp = [float(np.linalg.norm(np.asarray(v, float))) for v in sd if v is not None] if sd is not None else []
    out = (arr, (tuple(sp) if len(sp) == 3 else (1.0, 1.0, 1.0)))
    _NRRD_CACHE[path] = out
    return out


# --------------------------------------------------------------------------
# Renderer holder — created once, driven from a single worker thread
# --------------------------------------------------------------------------

class RenderState:
    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
        self.renderer = None
        self.adapter_info = None
        self.dataset = DATA
        self.fine_step = None      # ray-march step for a settled view (voxel spacing)
        self.coarse_step = None    # coarser step used while the camera is moving (fast)
        self.full_size = (W, H)    # client's requested full framebuffer size (device px)
        self.budget_px = float(MOTION_TARGET_PX)   # live motion pixel budget (v2 controller)
        # bumblebee level management
        self.catalog = []            # [{name, ds, shape, vram_mb, disk_mb, maxdim, feasible}]
        self.cache = {}              # name -> (arr, spacing, (lo,hi))  (loaded volumes, kept in RAM)
        self.lstate = {}             # name -> "idle" | "downloading" | "loaded"
        self.lprog = {}              # name -> 0..1 download fraction
        self.current = None          # level currently on the GPU / displayed
        self.target = None           # quality ceiling chosen by the user (finest allowed)
        self._wake = threading.Event()

    def ensure_renderer(self):
        if self.renderer is not None:
            return
        import wgpu
        from slicer_wgpu.headless import HeadlessVolumeRenderer
        ad = None
        try:
            ad = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
            self.adapter_info = f"{ad.info.get('adapter_type')} / {ad.info.get('backend_type')} / {ad.info.get('device')}"
        except Exception:
            self.adapter_info = "unknown"
        if DATA == "multivol":
            self._init_multivol()
            return
        self.renderer = HeadlessVolumeRenderer(W, H)
        if DATA == "bumblebee":
            self._init_bumblebee(ad)
        else:
            r = self.renderer
            vol = make_synthetic_volume()
            r.set_volume(vol, spacing=(1.0, 1.0, 1.0), scalar_range=(0.0, 1000.0))
            color = [(0, 0, 0, 0), (450, 0.85, 0.35, 0.20), (700, 0.95, 0.80, 0.45), (1000, 1.0, 1.0, 1.0)]
            opacity = [(0, 0.0), (300, 0.0), (450, 0.14), (700, 0.45), (1000, 0.92)]
            r.set_transfer_function(color, opacity, (0.0, 1000.0))
            self.dataset = "synthetic"
            r.frame_volume()
            r.set_camera(azimuth_deg=25, elevation_deg=-18)

    # -- bumblebee multiscale ------------------------------------------------

    def _ds(self, name):
        return int(name[1:])

    def _gpu_limits(self, ad):
        max3d = 2048
        try:
            max3d = int(ad.limits.get("max-texture-dimension-3d", 2048))
        except Exception:
            pass
        total_mb = 8192
        try:
            import subprocess
            total_mb = int(subprocess.check_output(
                ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                timeout=5).decode().strip().split("\n")[0])
        except Exception:
            pass
        return max3d, total_mb

    def _init_bumblebee(self, ad):
        max3d, total_mb = self._gpu_limits(ad)
        budget = max(1024, total_mb - 1500)               # leave headroom + room for the swap transient
        self.catalog = bumblebee_catalog()
        for L in self.catalog:
            L["feasible"] = (L["maxdim"] <= max3d) and (L["vram_mb"] <= budget)
            self.lstate[L["name"]] = "idle"
            self.lprog[L["name"]] = 0.0
        feas = [L for L in self.catalog if L["feasible"]]
        init = (feas[0] if feas else self.catalog[0])["name"]     # coarsest feasible -> instant first paint
        env_level = os.environ.get("LEVEL")
        self.target = env_level if (env_level and env_level in self.lstate) else (feas[-1]["name"] if feas else init)
        arr, spacing, rng = load_bumblebee(init)
        self.cache[init] = (arr, spacing, rng)
        self.lstate[init] = "loaded"
        self._apply(init)
        self.renderer.frame_volume()
        self.renderer.set_camera(azimuth_deg=25, elevation_deg=-18)
        threading.Thread(target=self._loader_loop, daemon=True).start()

    def _init_multivol(self):
        """Replica of SceneRendering test_MultiVolume: CTACardio (CT-Chest-Contrast-Enhanced) +
        Panoramix (CT-AAA), each centered at origin, composited by SceneRenderer."""
        from slicer_wgpu.headless import HeadlessSceneRenderer
        specs = [("CTA-cardio.nrrd", "CT-Chest-Contrast-Enhanced"),
                 ("Panoramix-cropped.nrrd", "CT-AAA")]
        sr = HeadlessSceneRenderer(W, H)
        min_sp = 1e9; max_extent = 0.0
        for fname, preset in specs:
            arr, sp = _load_nrrd(os.path.join(MULTIVOL_DIR, fname))
            col, op = _preset_points(preset)
            sr.add_volume(arr, spacing=sp, scalar_range=(-3024.0, 3071.0),
                          color_points=col, opacity_points=op,
                          opacity_unit_distance=sum(sp) / 3.0)   # ~VTK ScalarOpacityUnitDistance
            min_sp = min(min_sp, min(sp))
            max_extent = max(max_extent, max(d * s for d, s in zip(arr.shape[::-1], sp)))
        sr.build()
        sr.set_camera(azimuth_deg=30, elevation_deg=15)
        self.renderer = sr
        self.fine_step = min_sp
        self.coarse_step = max(min_sp, max_extent / MOTION_SAMPLES)
        self.dataset = "multivol: CTACardio + Panoramix"

    def _apply(self, name):
        """Swap the renderer onto a cached level (runs on the pool thread). Camera is preserved."""
        arr, spacing, (lo, hi) = self.cache[name]
        self.renderer.set_volume(arr, spacing=spacing, scalar_range=(lo, hi),
                                 opacity_unit_distance=BEE_OUD)
        c, o = bumblebee_tf(lo, hi)
        self.renderer.set_transfer_function(c, o, (lo, hi))
        self.current = name
        self.dataset = f"bumblebee {name} {tuple(arr.shape)}"
        # Motion-adaptive ray-march: fine = voxel spacing (crisp, settled); coarse ~= a fixed
        # ~MOTION_SAMPLES steps across the volume (fast, while dragging) on the SAME texture.
        extent = max(d * s for d, s in zip(arr.shape[::-1], spacing))
        self.fine_step = float(min(spacing))
        self.coarse_step = max(self.fine_step, extent / MOTION_SAMPLES)

    def _best_for_target(self):
        """Finest cached level that is not finer than the target ceiling."""
        tds = self._ds(self.target)
        cand = [L["name"] for L in self.catalog if L["name"] in self.cache and self._ds(L["name"]) >= tds]
        if not cand:
            cand = [L["name"] for L in self.catalog if L["name"] in self.cache]
        return min(cand, key=self._ds) if cand else None

    def _update_display(self):
        best = self._best_for_target()
        if best and best != self.current:
            self.pool.submit(lambda: self._apply(best))

    def set_target(self, name):
        L = next((x for x in self.catalog if x["name"] == name), None)
        if not L or not L.get("feasible"):
            return
        self.target = name
        self._update_display()      # drop to a coarser cached level immediately if needed
        self._wake.set()            # nudge the loader to fetch toward the target

    def _loader_loop(self):
        while True:
            self._wake.wait(timeout=30)
            self._wake.clear()
            if self.renderer is None or not self.catalog:
                continue
            tds = self._ds(self.target)
            todo = [L for L in self.catalog
                    if L["feasible"] and self._ds(L["name"]) >= tds and L["name"] not in self.cache]
            todo.sort(key=lambda L: -self._ds(L["name"]))     # coarsest uncached first
            if not todo:
                continue
            name = todo[0]["name"]
            self.lstate[name] = "downloading"
            self.lprog[name] = 0.0
            try:
                arr, spacing, rng = load_bumblebee(name, progress=lambda p, n=name: self.lprog.__setitem__(n, p))
                self.cache[name] = (arr, spacing, rng)
                self.lstate[name] = "loaded"
                self._update_display()
            except Exception as e:
                self.lstate[name] = "idle"
                print(f"download {name} failed: {e!r}")
            self._wake.set()          # keep climbing toward the target

    def catalog_message(self):
        levels = [{"name": L["name"], "vram_mb": L["vram_mb"], "disk_mb": L["disk_mb"],
                   "feasible": L["feasible"], "state": self.lstate.get(L["name"], "idle"),
                   "progress": round(self.lprog.get(L["name"], 0.0), 3)} for L in self.catalog]
        return {"catalog": {"active": self.current, "target": self.target, "levels": levels}}

    def render_latest(self, scale=1.0):
        """Drain accumulated input into the camera and render one RGBA frame (the GPU
        ray-march). Encoding is deliberately separate so the producer can render ahead
        speculatively while the consumer encodes only what it actually sends. scale<1 renders
        a dense reduced-resolution frame (adaptive geometry v0) — the client upsamples it."""
        with self.lock:
            az, el, dz = self.pending["az"], self.pending["el"], self.pending["dz"]
            self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
            moved = bool(az or el or dz)
        r = self.renderer
        if az or el:
            r.orbit(az, el)
        if dz:
            r.dolly(1.0 + max(-0.4, min(0.4, dz)))
        return r.render(scale), moved

    def render_quality(self, step, scale=1.0):
        """Set the ray-march step (coarse while moving / fine when settled) then render at the
        given resolution scale (1.0 = full-res hero; <1 = reduced while moving)."""
        if step is not None:
            self.renderer.set_sample_step(step)
        return self.render_latest(scale)

    def motion_scale(self):
        """Linear resolution fraction for motion frames: target the LIVE pixel budget so a big
        (4K/retina) window renders a fraction of its pixels while moving but a small window stays
        full-res. Snapped to 1/f by the renderer; hero (settled) frames always render 1.0."""
        fw, fh = self.full_size
        s = math.sqrt(self.budget_px / max(1, fw * fh))
        return max(0.25, min(1.0, s))

    def tune_budget(self, render_ms):
        """v2 budget controller: nudge the motion pixel budget so measured render time tracks
        MOTION_TARGET_MS. Multiplicative + clamped per step (stable, no oscillation), bounded to
        [0.3 MP, 16 MP]. Complexity spikes (dense TF, deep zoom) shrink the budget; simple views
        and fast GPUs let it grow back — the same knob v0 keyed off window size alone."""
        if render_ms <= 0:
            return
        adj = max(0.8, min(1.25, MOTION_TARGET_MS / render_ms))
        self.budget_px = max(3e5, min(16e6, self.budget_px * adj))

    def render_frame(self, enc):
        """Render + encode in one call (used only for the initial warmup handshake)."""
        rgba, _ = self.render_latest()
        return enc.encode(rgba)

    def reset_camera(self):
        """Re-frame the volume and clear pending input. The renderer is a process-global that
        persists across connections, so every new/refreshed browser resets to a known-good view."""
        with self.lock:
            self.pending = {"az": 0.0, "el": 0.0, "dz": 0.0}
        self.renderer.frame_volume()
        self.renderer.set_camera(azimuth_deg=25, elevation_deg=-18)

    # -- session lifecycle (per-connection renderers) -----------------------

    def get_cam(self):
        """Camera pose as a JSON-able dict — sent to the client, which saves it and replays it
        on reconnect so a brand-new per-session server resumes the exact view."""
        r = self.renderer
        return {"az": round(r._azimuth, 3), "el": round(r._elevation, 3),
                "dist": round(r._distance, 3)}

    def set_cam(self, cam):
        try:
            self.renderer.set_camera(azimuth_deg=float(cam["az"]),
                                     elevation_deg=float(cam["el"]),
                                     distance=float(cam["dist"]))
        except (KeyError, TypeError, ValueError):
            pass                                   # malformed hello -> keep the framed default

    def dispose(self):
        """Reap this session: drop the renderer (GPU targets/textures GC with it) and stop the
        pool thread. Called when the socket closes or the idle reaper fires."""
        self.renderer = None
        self.pool.shutdown(wait=False)


# Sessions are PER-PROCESS: the front process (default) serves the page and, for each /ws
# connection, spawns a CHILD of this same script (SESSION=1, localhost port, no TLS) and relays
# the websocket byte-for-byte. Process isolation is the reliable boundary — sharing one wgpu
# device across concurrent renderers deadlocks (Vulkan object destruction is not thread-safe
# against another session's render), and reap == kill(child). A warm spare child is kept ready
# so resume-after-reap and second users connect without the ~4s cold start.
SESSION_MODE = os.environ.get("SESSION") == "1"
_child_port = [int(os.environ.get("CHILD_PORT_BASE", "8800"))]
_spare = {"proc": None, "port": None}


def _spawn_child():
    import subprocess, sys
    port = _child_port[0]; _child_port[0] += 1
    env = dict(os.environ); env.update(PORT=str(port), HOST="127.0.0.1", SESSION="1")
    env.pop("TLS_CERT", None); env.pop("TLS_KEY", None)
    logdir = os.environ.get("CHILD_LOG_DIR", "/tmp")
    logf = open(os.path.join(logdir, f"child_{port}.log"), "ab")
    proc = subprocess.Popen([sys.executable, "-u", os.path.abspath(__file__)],
                            env=env, stdout=logf, stderr=subprocess.STDOUT)
    return proc, port


async def _wait_port(port, timeout=40.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            _r, w = await asyncio.open_connection("127.0.0.1", port)
            w.close()
            return
        except OSError:
            await asyncio.sleep(0.25)
    raise RuntimeError(f"child :{port} never came up")


async def _get_child():
    """Take the warm spare (or cold-spawn), then refill the spare in the background."""
    sp_proc, sp_port = _spare["proc"], _spare["port"]
    _spare.update(proc=None, port=None)
    if sp_proc is not None and sp_proc.poll() is None:
        proc, port = sp_proc, sp_port
    else:
        proc, port = _spawn_child()
    try:
        await _wait_port(port)
    except Exception:
        proc.kill()               # don't leak a child if it never comes up
        raise

    async def refill():
        p2, po2 = _spawn_child()
        try:
            await _wait_port(po2)
        except Exception:
            p2.kill(); return
        if _spare["proc"] is None and p2.poll() is None:
            _spare.update(proc=p2, port=po2)
        else:
            p2.kill()
    asyncio.ensure_future(refill())
    return proc, port


_shot_n = [0]


def _dump_hero(rgba, jpg):
    """Debug ground truth: the raw hero buffer + the exact JPEG bytes that went on the wire.
    Named by frame size so a follow-up settle at another size can't overwrite the evidence."""
    try:
        from PIL import Image
        a = np.asarray(rgba)
        tag = f"{a.shape[1]}x{a.shape[0]}"
        Image.fromarray(a[:, :, :3]).save(f"/root/dump_hero_{tag}.png")
        with open(f"/root/dump_hero_{tag}.jpg", "wb") as f:
            f.write(jpg)
    except Exception as e:
        print("dump_hero failed:", e, flush=True)


# --------------------------------------------------------------------------
# Browser page — same client contract as the Modal harness
# --------------------------------------------------------------------------

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>LiveRenderer (local) — __LABEL__</title>
<style>html,body{margin:0;height:100%;background:#07070d;overflow:hidden;font:13px system-ui,sans-serif;color:#cde}
#v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;cursor:grab;touch-action:none;user-select:none;background:#07070d}
#v.drag{cursor:grabbing}
#brand{position:fixed;left:12px;top:9px;z-index:3;font-weight:700;font-size:15px;color:#eaf;text-shadow:0 1px 4px #000}#brand small{font-weight:400;font-size:11px;color:#9ab}
#swrap{position:fixed;left:12px;top:32px;z-index:2;color:#9cf;text-shadow:0 1px 3px #000;display:flex;align-items:center;gap:5px}
#res{position:fixed;left:12px;top:52px;z-index:2;color:#7c9;font:11px ui-monospace,monospace;text-shadow:0 1px 2px #000}
#pie{position:fixed;left:14px;bottom:14px;width:38px;height:38px;border-radius:50%;z-index:5;
  pointer-events:none;opacity:0;transition:opacity .35s ease;border:1px solid rgba(255,255,255,.25)}
#pie.on{opacity:.45}
#stwrap{position:fixed;right:10px;top:8px;z-index:2;display:flex;align-items:flex-start;gap:5px;justify-content:flex-end}
#stats{color:#9c9;font:11px ui-monospace,monospace;text-align:right;white-space:pre;line-height:1.5;text-shadow:0 1px 2px #000}
.qh{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;min-width:15px;border:1px solid currentColor;border-radius:50%;font:11px system-ui;cursor:pointer;opacity:.55}
.qh:hover{opacity:1}
#pop{position:fixed;z-index:30;max-width:370px;background:rgba(13,13,22,.96);border:1px solid #557;border-radius:8px;padding:11px 13px;color:#cde;font:12px/1.55 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.7);display:none}
#pop.show{display:block}#pop b{color:#f0e6ff}
#dwrap{position:fixed;left:12px;bottom:10px;z-index:9;color:#ff5;display:flex;align-items:center;gap:5px}
#dbg{font:12px ui-monospace,monospace;white-space:pre;text-shadow:0 1px 2px #000}
#lvl{position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:5;background:#12121ce0;color:#cde;border:1px solid #557;border-radius:6px;font:12px system-ui;padding:4px 8px;cursor:pointer}
#lvl:disabled{opacity:.5}</style></head>
<body><div id=brand>LiveRenderer <small>· local · wgpu(Metal) + libx264 + WebCodecs</small></div>
<div id=swrap><span id=s>connecting…</span><span class=qh data-h=status>?</span></div>
<div id=res></div>
<div id=stwrap><span class=qh data-h=stats>?</span><span id=stats></span></div>
<div id=dwrap><span id=dbg></span><span class=qh data-h=debug>?</span></div><select id=lvl style=display:none title="resolution level"></select>
<div id=pop></div><canvas id=v></canvas><div id=pie></div>
<script>
const v=document.getElementById('v'),s=document.getElementById('s'),st=document.getElementById('stats'),dbg=document.getElementById('dbg'),lvl=document.getElementById('lvl'),res=document.getElementById('res');
function showRes(fw,fh){ const ww=Math.round(innerWidth*devicePixelRatio),wh=Math.round(innerHeight*devicePixelRatio);
  res.textContent = fw+'×'+fh+(fw!==ww||fh!==wh ? ' → '+ww+'×'+wh : '') ; }
// v4a superresolution upsample: draw frames through WebGL2 — Catmull-Rom (bicubic) resampling plus
// a light edge sharpen when upscaling reduced motion frames; exact passthrough at 1:1 (heroes).
// Browser drawImage bilinear made motion frames soft; this is the first rung of the superres ladder
// (next rungs: temporal reprojection of the last hero by camera delta, then a learned recurrent model).
let gl=null,ctx=null,glo=null;
(function(){
  try{ gl=v.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true}); }catch(_){ gl=null; }
  if(!gl){ ctx=v.getContext('2d'); return; }
  try{
    const vsrc=`#version 300 es
layout(location=0) in vec2 p; out vec2 uv;
void main(){ uv=p*0.5+0.5; gl_Position=vec4(p,0.,1.); }`;
    const fsrc=`#version 300 es
precision highp float;
uniform sampler2D uT; uniform vec2 uTS,uFit; uniform float uScale,uSharp;
in vec2 uv; out vec4 o;
vec3 cr(vec2 q){
  vec2 s=q*uTS-0.5, f=fract(s), b=floor(s)+0.5;
  vec2 f2=f*f, f3=f2*f;
  vec2 w0=-0.5*f3+f2-0.5*f, w1=1.5*f3-2.5*f2+1.0, w2=-1.5*f3+2.0*f2+0.5*f, w3=0.5*f3-0.5*f2;
  float wx[4]; float wy[4];
  wx[0]=w0.x; wx[1]=w1.x; wx[2]=w2.x; wx[3]=w3.x;
  wy[0]=w0.y; wy[1]=w1.y; wy[2]=w2.y; wy[3]=w3.y;
  vec3 c=vec3(0.);
  for(int j=0;j<4;j++) for(int i=0;i<4;i++)
    c+=texture(uT,(b+vec2(float(i-1),float(j-1)))/uTS).rgb*wx[i]*wy[j];
  return c;
}
void main(){
  vec2 q=(uv-0.5)/uFit+0.5;                       // aspect-fit (letterbox) in UV space
  if(q.x<0.||q.x>1.||q.y<0.||q.y>1.){ o=vec4(0.027,0.027,0.051,1.); return; }
  q.y=1.0-q.y;                                    // ImageBitmap rows are top-down
  vec3 c;
  if(uScale<=1.001){ c=texture(uT,q).rgb; }       // native frame -> exact 1:1
  else{
    c=cr(q);                                      // bicubic reconstruction
    vec2 px=1.0/uTS;
    vec3 n=(texture(uT,q+vec2(px.x,0.)).rgb+texture(uT,q-vec2(px.x,0.)).rgb
           +texture(uT,q+vec2(0.,px.y)).rgb+texture(uT,q-vec2(0.,px.y)).rgb)*0.25;
    c=clamp(c+(c-n)*uSharp,0.0,1.0);              // gentle unsharp, upscales only
  }
  o=vec4(c,1.0);
}`;
    const sh=(t,s)=>{const h=gl.createShader(t);gl.shaderSource(h,s);gl.compileShader(h);
      if(!gl.getShaderParameter(h,gl.COMPILE_STATUS))throw gl.getShaderInfoLog(h);return h;};
    const pr=gl.createProgram();
    gl.attachShader(pr,sh(gl.VERTEX_SHADER,vsrc)); gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,fsrc));
    gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw gl.getProgramInfoLog(pr);
    gl.useProgram(pr);
    const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 3,-1, -1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex);
    for(const [k,val] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],
                          [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D,k,val);
    glo={ts:gl.getUniformLocation(pr,'uTS'),fit:gl.getUniformLocation(pr,'uFit'),
         sc:gl.getUniformLocation(pr,'uScale'),shp:gl.getUniformLocation(pr,'uSharp')};
  }catch(err){ gl=null; ctx=v.getContext('2d'); }
})();
let pendingTarget=null;
function renderLevels(cat){ lvl.style.display='';
  if(document.activeElement===lvl) return;   // don't rebuild an open dropdown (it would close it)
  if(lvl.options.length!==cat.levels.length){ lvl.innerHTML=cat.levels.map(L=>'<option></option>').join(''); }
  cat.levels.forEach((L,i)=>{ const o=lvl.options[i]; o.value=L.name; o.disabled=!L.feasible;
    let s = !L.feasible ? 'too large for GPU'
          : L.name===cat.active ? 'showing'
          : L.state==='downloading' ? Math.round(L.progress*100)+'%'
          : L.state==='loaded' ? 'ready'
          : L.disk_mb+' MB';
    o.textContent=L.name+' · '+s; });
  if(pendingTarget && cat.target!==pendingTarget) lvl.value=pendingTarget;   // hold the pick until server confirms
  else { pendingTarget=null; lvl.value=cat.target; }
}
lvl.addEventListener('change',()=>{ pendingTarget=lvl.value; if(ws&&ws.readyState===1){try{ws.send(JSON.stringify({settarget:lvl.value}))}catch(e){}} });
let ws,dec=null,started=false,tsv=0,drag=false,px=0,py=0,pend=null,frames=0,t0=performance.now(),fps=0,info='';
let nbin=0,ndec=0,dstate='',tsq=[],lat={tot:0,net:0,wait:0,ren:0,enc:0,dec:0},mode='video',latestImg=null,imgResolve=null,imgStarted=false,lastW=0,lastH=0,rzTimer=null,shownBm=null,lastDrawnW=0,byed=false;
function sendResize(){   // match the server framebuffer to this window, pixel-for-pixel (device pixels)
  const w=Math.max(16,Math.round(innerWidth*devicePixelRatio)), h=Math.max(16,Math.round(innerHeight*devicePixelRatio));
  if(w===lastW&&h===lastH)return; lastW=w; lastH=h;
  if(ws&&ws.readyState===1){try{ws.send(JSON.stringify({resize:1,w:w,h:h}))}catch(e){}}
}
// Session state lives on the CLIENT: the server broadcasts its camera pose with each settled
// frame; we save it (survives reloads via localStorage) and replay it with the framebuffer size
// on every (re)connect — a brand-new per-session server resumes exactly where the old one left off.
let savedCam=null; try{ savedCam=JSON.parse(localStorage.getItem('lr_cam')||'null'); }catch(_){}
function sendHello(){
  const w=Math.max(16,Math.round(innerWidth*devicePixelRatio)), h=Math.max(16,Math.round(innerHeight*devicePixelRatio));
  lastW=w; lastH=h;
  if(ws&&ws.readyState===1){try{ws.send(JSON.stringify({hello:{w:w,h:h,cam:savedCam}}))}catch(e){}}
}
window.addEventListener('resize',()=>{clearTimeout(rzTimer);rzTimer=setTimeout(sendResize,150);});
function D(){dbg.textContent='ws:'+(ws?ws.readyState:'-')+' mode:'+mode+' dec:'+(dec?dec.state:'-')+' bytesMsgs:'+nbin+' drawn:'+ndec+(dstate?'  '+dstate:'');}
// Self-diagnosis: after a converged draw, measure 3x3 pixel-replication ON THE ACTUAL CANVAS and
// report it to the server log (ws {diag}), with frame/window/dpr facts. Lets the server see what
// the client really displays — no user copy-paste needed.
let lastDiag=0,lastShot=0,drawLog=[];
function shipShot(tag){ try{ const t=document.createElement('canvas'); t.width=400; t.height=400;
  t.getContext('2d').drawImage(v,(v.width-400)>>1,(v.height-400)>>1,400,400,0,0,400,400);
  t.toBlob(b=>{ if(!b)return; const fr=new FileReader();
    fr.onload=()=>{ if(ws&&ws.readyState===1){try{ws.send(JSON.stringify({shot:fr.result.split(',')[1],tag:tag}))}catch(_){}} };
    fr.readAsDataURL(b); },'image/png'); }catch(_){}}
function sampleRep(){ const S=300, x0=Math.max(0,(v.width-S)>>1), y0=Math.max(0,(v.height-S)>>1);
  // Read via a temp 2d canvas so this works for both the WebGL and 2d draw paths
  // (drawImage FROM a WebGL canvas needs preserveDrawingBuffer:true — set at init).
  const t=document.createElement('canvas'); t.width=S; t.height=S;
  const c2=t.getContext('2d'); c2.drawImage(v,x0,y0,S,S,0,0,S,S);
  const im=c2.getImageData(0,0,S,S).data; let n=0,c=0;
  for(let by=0;by<S-2;by+=3)for(let bx=0;bx<S-2;bx+=3){
    let mx=0,cn=1; const i0=(by*S+bx)*4, r0=im[i0],g0=im[i0+1],b0=im[i0+2];
    for(let y=0;y<3;y++)for(let x=0;x<3;x++){const i=((by+y)*S+bx+x)*4;
      const r=im[i],g=im[i+1],b=im[i+2]; if(r>mx)mx=r; if(g>mx)mx=g; if(b>mx)mx=b;
      if(r!==r0||g!==g0||b!==b0)cn=0;}
    if(mx>25){n++;c+=cn;}}
  return {rep:n?Math.round(100*c/n):-1,bright:n};}
function sendDiag(o){ if(ws&&ws.readyState===1){try{ws.send(JSON.stringify({diag:o}))}catch(_){}} }
function drawFrame(bm){
  const bmW=bm.width||bm.displayWidth, bmH=bm.height||bm.displayHeight;  // ImageBitmap | VideoFrame
  if(gl){
    // Superres path: canvas backing = window device px; the shader aspect-fits the frame into it,
    // Catmull-Rom + sharpen when the frame is smaller (motion), exact passthrough at 1:1 (hero).
    const bw=lastW||bmW, bh=lastH||bmH;
    if(v.width!==bw||v.height!==bh){ v.width=bw; v.height=bh; }
    gl.viewport(0,0,v.width,v.height);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bm);
    const fa=bmW/bmH, ca=v.width/v.height;
    const qx=fa>ca?1:fa/ca, qy=fa>ca?ca/fa:1;
    gl.uniform2f(glo.ts,bmW,bmH);
    gl.uniform2f(glo.fit,qx,qy);
    gl.uniform1f(glo.sc,(v.width*qx)/bmW);
    gl.uniform1f(glo.shp,0.22);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }else{
    // Fallback: size the canvas backing to the FRAME's own pixels and draw 1:1; CSS
    // (#v object-fit:contain) scales it into the window preserving aspect (browser bilinear).
    if(v.width!==bmW||v.height!==bmH){ v.width=bmW; v.height=bmH; ctx.imageSmoothingEnabled=true; }
    ctx.drawImage(bm,0,0);
  }
  drawLog.push(bmW+'x'+bmH); if(drawLog.length>14)drawLog.shift();
  showRes(bmW,bmH);
}
// Convergence indicator (v1): a small semi-transparent pie in the lower-left that fills as the
// settled view refines to native res, then fades — subtle enough to live in the periphery, and its
// fill time IS the render latency. Never appears when a view converges in one render (conv jumps
// straight to 1), so it only moves at 4K/remote where there is a real wait.
let convTimer=null;
function updateConv(c){ const pie=document.getElementById('pie');
  const draw=p=>{ pie.style.background='conic-gradient(rgba(150,210,255,.9) '+(p*100)+'%, rgba(255,255,255,.10) 0)'; };
  if(c<=0){ pie.classList.remove('on'); return; }
  if(c>=1){ if(pie.classList.contains('on')){ draw(1);
      clearTimeout(convTimer); convTimer=setTimeout(()=>pie.classList.remove('on'),450); }
    return; }                                   // instant converge (never partial) -> stay hidden
  draw(c); pie.classList.add('on'); clearTimeout(convTimer);
}
async function imageLoop(){   // MJPEG: decode ONLY the newest frame, drop stale -> true skip-to-latest
  while(true){
    if(latestImg){ const cur=latestImg; latestImg=null;
      try{ const d0=performance.now();
        const isJpeg=(cur.u8[0]===0xFF&&cur.u8[1]===0xD8);   // else AVIF (ISOBMFF ftyp)
        const bm=await createImageBitmap(new Blob([cur.u8],{type:isJpeg?'image/jpeg':'image/avif'}));
        drawFrame(bm); updateConv(cur.conv);
        if(cur.conv>=0.99 && performance.now()-lastDiag>500){ lastDiag=performance.now();
          const rp=sampleRep(); const rc=v.getBoundingClientRect();
          sendDiag({fw:bm.width,fh:bm.height,bytes:cur.u8.length,conv:+cur.conv.toFixed(2),
                    rep:rp.rep,bright:rp.bright,cw:v.width,ch:v.height,
                    iw:innerWidth,ih:innerHeight,dpr:+devicePixelRatio.toFixed(3),
                    rect:Math.round(rc.width)+'x'+Math.round(rc.height),
                    log:drawLog.join(',')});
          // Actual screenshots of the displayed canvas: one now, one 2.5s later (catches anything
          // that overdraws the hero after settle). Tagged by canvas size; server keeps them all.
          if(performance.now()-lastShot>3000){ lastShot=performance.now();
            const tag=v.width+'x'+v.height; shipShot(tag);
            setTimeout(()=>{ shipShot(v.width+'x'+v.height+'_late'); const rl=sampleRep();
              sendDiag({late:1,cw:v.width,ch:v.height,rep:rl.rep,log:drawLog.join(',')}); },2500); } }
        bm.close();
        const now=performance.now(), decms=now-d0;
        if(cur.cts>0){ const tot=now-cur.cts, net=Math.max(0,tot-cur.sms-decms), wait=Math.max(0,cur.sms-cur.rms-cur.ems); const a=0.85,b=0.15,L=lat;
          L.tot=L.tot?L.tot*a+tot*b:tot;L.net=L.net?L.net*a+net*b:net;L.wait=L.wait?L.wait*a+wait*b:wait;
          L.ren=L.ren?L.ren*a+cur.rms*b:cur.rms;L.enc=L.enc?L.enc*a+cur.ems*b:cur.ems;L.dec=L.dec?L.dec*a+decms*b:decms; }
        ndec++; if(ndec<=3||ndec%30===0)D();
        frames++; const dt=performance.now()-t0; if(dt>500){fps=(frames*1000/dt|0);frames=0;t0=performance.now();updateStats();}
      }catch(err){ dstate='IMG ERR '+err.message; D();
        sendDiag({err:err.message,bytes:cur.u8.length,head:Array.from(cur.u8.slice(0,4)).join(',')}); }
    } else { await new Promise(r=>{imgResolve=r; setTimeout(r,100);}); }
  }
}
function updateStats(){ const L=lat; const b=L.tot?('finger→photon '+Math.round(L.tot)+' ms\\n  net '+Math.round(L.net)+' · wait '+Math.round(L.wait)+' · render '+Math.round(L.ren)+' · enc '+Math.round(L.enc)+' · decode '+Math.round(L.dec)+' ms'):'finger→photon —';
  st.textContent=info+'\\n'+fps+' fps  ·  '+b; }
function setupDecoder(codec){
  if(!('VideoDecoder' in window)){dstate='NO WebCodecs';D();s.textContent='this browser lacks WebCodecs (use Chrome/Edge)';return;}
  dec=new VideoDecoder({output:fr=>{ try{ drawFrame(fr);}catch(dx){dstate='DRAW ERR: '+dx.message;} fr.close();
    if(ws&&ws.readyState===1){try{ws.send('{"ack":1}')}catch(e){}}   // pace the server: 1 credit back per drawn frame
    const q=tsq.shift(); if(q&&q.cts>0){ const now=performance.now(); const tot=now-q.cts, dec=now-q.d0;
      const net=Math.max(0,tot-q.sms-dec), wait=Math.max(0,q.sms-q.rms-q.ems); const a=0.85,b=0.15, L=lat;
      L.tot=L.tot?L.tot*a+tot*b:tot; L.net=L.net?L.net*a+net*b:net; L.wait=L.wait?L.wait*a+wait*b:wait;
      L.ren=L.ren?L.ren*a+q.rms*b:q.rms; L.enc=L.enc?L.enc*a+q.ems*b:q.ems; L.dec=L.dec?L.dec*a+dec*b:dec; }
    ndec++; if(ndec<=3||ndec%30===0)D();
    frames++; const dt=performance.now()-t0; if(dt>500){fps=(frames*1000/dt|0); frames=0; t0=performance.now(); updateStats();} },
    error:e=>{dstate='DECODE ERR: '+e.message; D(); s.textContent='decode error: '+e.message}});
  // prefer-software: Chrome's HW H.264 path silently emits no frames for this Annex-B/High
  // stream on some GPUs (accepts chunks, throws nothing, outputs nothing). SW decode is reliable
  // and trivially fast at this resolution.
  try{ dec.configure({codec:codec, optimizeForLatency:true, hardwareAcceleration:'prefer-software'}); dstate='cfg(sw) '+codec; }
  catch(ce){ dstate='CONFIG ERR: '+ce.message; }
  D();
  s.textContent='drag to rotate • wheel to zoom • double-click to reset';
}
function connect(){
  // Every (re)connect gets a FRESH server (esp. per-session servers) that starts at its default
  // framebuffer size, so the client must re-assert its state. Reset the resize dedupe so the
  // config-triggered sendResize() always re-sends this window's device pixels — otherwise a silent
  // reconnect leaves the new server at 900x640 and the client upscales it (blocky at 4K).
  lastW=0; lastH=0;
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
  ws.binaryType='arraybuffer';
  ws.onopen=()=>{s.textContent='starting renderer…'; D();};
  ws.onmessage=e=>{
    if(typeof e.data==='string'){ try{const o=JSON.parse(e.data);
        if(o.config){ if(o.config==='mjpeg'){mode='image';dstate='cfg mjpeg';D();s.textContent='drag to rotate • wheel to zoom • double-click to reset';if(!imgStarted){imgStarted=true;imageLoop();}} else {mode='video';setupDecoder(o.config);} sendHello(); return; }
        if(o.cam){ savedCam=o.cam; try{localStorage.setItem('lr_cam',JSON.stringify(o.cam));}catch(_){} return; }
        if(o.bye){ byed=true; s.textContent='session idle — drag to resume'; try{ws.close()}catch(_){} return; }
        if(o.catalog){renderLevels(o.catalog);return;}
        if(o.info){info=o.info;updateStats();return;} }catch(_){}
      s.textContent=e.data; return; }
    nbin++; if(nbin<=3)D();
    const u=new Uint8Array(e.data); const dv=new DataView(e.data);
    // header: [flag:1][client_ts:f64][render_ms:f32][encode_ms:f32][server_ms:f32][conv:u8][payload]
    const cts=dv.getFloat64(1,true), rms=dv.getFloat32(9,true), ems=dv.getFloat32(13,true), sms=dv.getFloat32(17,true), conv=u[21]/255;
    const data=u.subarray(22);
    if(mode==='image'){ latestImg={u8:data.slice(),cts,rms,ems,sms,conv}; if(imgResolve){imgResolve();imgResolve=null;} return; }
    if(!dec||dec.state!=='configured'){ dstate='drop: dec '+(dec?dec.state:'null'); D(); return; }
    const key=u[0]===1;
    if(!started){ if(!key) return; started=true; }
    try{ dec.decode(new EncodedVideoChunk({type:key?'key':'delta', timestamp:tsv, data})); tsq.push({cts,rms,ems,sms,d0:performance.now()}); tsv+=33333; }catch(err){ dstate='DECODE THROW: '+err.message; D(); }
  };
  ws.onclose=()=>{started=false;dec=null; D();
    // After an idle reap ({bye}) don't spin the reconnect timer — the last image stays up and the
    // next user input starts a fresh session (which restores our saved state via hello).
    if(byed){ return; }
    s.textContent='disconnected — reconnecting…'; setTimeout(connect,800);};
  ws.onerror=()=>{try{ws.close()}catch(e){}};
}
connect();
// Send input immediately (no rAF batching): the server coalesces deltas and renders only the
// latest, and the browser already throttles pointermove to ~display rate — so waiting for a
// frame tick would only add up to ~16 ms of finger->photon latency for no benefit.
function sendInput(o){ if(ws&&ws.readyState===1){ o.ts=performance.now(); try{ws.send(JSON.stringify(o))}catch(e){} } }
v.addEventListener('pointerdown',e=>{ if(byed){byed=false;connect();}   // resume a reaped session
  drag=true;px=e.clientX;py=e.clientY;v.classList.add('drag');v.setPointerCapture(e.pointerId);});
v.addEventListener('pointerup',e=>{drag=false;v.classList.remove('drag');});
v.addEventListener('pointermove',e=>{ if(!drag)return; const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;
  sendInput({dx:dx,dy:dy,zoom:0}); });
v.addEventListener('wheel',e=>{e.preventDefault(); sendInput({dx:0,dy:0,zoom:(e.deltaY<0?0.06:-0.06)});},{passive:false});
v.addEventListener('dblclick',e=>{e.preventDefault(); if(ws&&ws.readyState===1){try{ws.send('{"reset":1}')}catch(_){}}});
// ---- (?) help popups on the status and stats lines ----
const pop=document.getElementById('pop');
const HELP={
 status:'<b>Controls</b><br>Drag to rotate the camera around the volume · mouse-wheel to zoom (dolly) · double-click to reset the view. This line also shows connection status (connecting, starting renderer, disconnected).',
 stats:'<b>Live stats &amp; latency</b><br>'+
  '<b>wgpu …</b> — the GPU + backend doing the ray-march, and the loaded dataset / resolution level.<br>'+
  '<b>render / send / client fps</b> (server-measured) — <i>render</i>: frames/s the GPU produces · <i>send</i>: frames/s streamed to you · <i>client</i>: your browser\\'s estimated consumption rate.<br>'+
  '<b>NN fps</b> — frames/s your browser actually decodes &amp; paints.<br>'+
  '<b>finger→photon</b> — total latency from a mouse move to the matching pixels on screen (same clock both ends), split into:<br>'+
  '&nbsp;• <b>net</b> — network + input timing. In MJPEG mode this is one-way (no ack round-trip).<br>'+
  '&nbsp;• <b>wait</b> — server-side queue + input coalescing + pacing before the render.<br>'+
  '&nbsp;• <b>render</b> — GPU ray-march (coarse while dragging, fine when settled).<br>'+
  '&nbsp;• <b>enc</b> — frame encode (JPEG, or H.264 in video mode).<br>'+
  '&nbsp;• <b>decode</b> — the browser decoding the frame.',
 debug:'<b>Connection debug</b><br>'+
  '<b>ws</b> — WebSocket state (1 = open).<br>'+
  '<b>mode</b> — <i>image</i> (MJPEG: independent JPEG frames, drop-to-latest) or <i>video</i> (H.264).<br>'+
  '<b>dec</b> — H.264 decoder state (video mode only; “-” in image mode).<br>'+
  '<b>bytesMsgs</b> — binary frames received · <b>drawn</b> — frames painted to the canvas.<br>'+
  'Any decode / draw / config error is appended here.'
};
document.querySelectorAll('.qh').forEach(q=>{ q.addEventListener('click',ev=>{ ev.stopPropagation();
  if(pop.classList.contains('show')&&pop._k===q.getAttribute('data-h')){pop.classList.remove('show');pop.style.display='none';return;}
  pop._k=q.getAttribute('data-h'); pop.innerHTML=HELP[pop._k]; pop.style.display='block';
  const r=q.getBoundingClientRect();
  let left=Math.min(r.left, innerWidth-pop.offsetWidth-12); left=Math.max(10,left);
  let top=r.bottom+6; if(top+pop.offsetHeight>innerHeight-8) top=Math.max(8,r.top-pop.offsetHeight-6);
  pop.style.left=left+'px'; pop.style.top=top+'px'; pop.classList.add('show'); }); });
// popup persists during interaction; closes only when the same (?) is clicked again (toggle above)
</script></body></html>""".replace("__LABEL__", LABEL)


def build_app():
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
        loop = asyncio.get_event_loop()
        t_conn = time.time()

        if not SESSION_MODE:
            # FRONT: spawn (or take the warm spare) child session process and relay the socket.
            # The child does everything else; when either side closes, the child is reaped.
            await sock.send_text("starting session…")
            proc, port = await _get_child()
            import websockets as _wsc
            try:
                async with _wsc.connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as up:
                    async def c2s():
                        while True:
                            m = await sock.receive()
                            if m.get("type") == "websocket.disconnect":
                                break
                            if m.get("text") is not None:
                                await up.send(m["text"])
                            elif m.get("bytes") is not None:
                                await up.send(m["bytes"])
                    async def s2c():
                        async for m in up:
                            if isinstance(m, str):
                                await sock.send_text(m)
                            else:
                                await sock.send_bytes(m)
                    done, pend = await asyncio.wait(
                        [asyncio.create_task(c2s()), asyncio.create_task(s2c())],
                        return_when=asyncio.FIRST_COMPLETED)
                    for p in pend:
                        p.cancel()
            except Exception:
                pass
            finally:
                proc.kill()
            return

        # CHILD: this process IS one session — its own RenderState (renderer + camera +
        # progressive state + pool thread), reaped with the process. Volume arrays cache at
        # module level (only helps if this child serves reconnects, harmless otherwise).
        STATE = RenderState()

        await sock.send_text("starting renderer…")
        await loop.run_in_executor(STATE.pool, STATE.ensure_renderer)
        # Fresh camera so a new page starts framed; a reconnecting client immediately restores
        # its own pose via the {hello} replay below.
        await loop.run_in_executor(STATE.pool, STATE.reset_camera)
        # Create the encoder ON THE POOL THREAD: NVENC/CUDA contexts are thread-affine, so
        # the thread that calls Encode() must be the one that created the encoder (and it's
        # the same single worker thread that owns the wgpu device — max_workers=1).
        enc, enc_name, mode = await loop.run_in_executor(STATE.pool, lambda: make_encoder(W, H))

        # Prime the browser with a few startup frames of the initial view. Frame wire format is the
        # SAME for both modes: [flag:1][client_ts:f64][render_ms:f32][encode_ms:f32][server_ms:f32][conv:u8][payload]
        # (payload = H.264 Annex-B for 'video', JPEG for 'image'). flag = keyframe bit for video, 1 for image.
        # conv=255 (=1.0) means "settled/no bar". The conv byte is REQUIRED — the client slices payload
        # at offset 22; a 21-byte header shifts the JPEG by one byte and it fails to decode.
        if mode == "image":
            await sock.send_text(json.dumps({"config": "mjpeg"}))
            # The client replies to {config} with {hello:{w,h,cam}} immediately. Apply it BEFORE
            # the warmup frames so a resumed session never flashes the default pose/size — the
            # first pixels the client draws are already its own view ("pick up where it left off").
            try:
                m0 = await asyncio.wait_for(sock.receive_json(), timeout=0.8)
            except Exception:
                m0 = None
            hm = (m0 or {}).get("hello") or ({"w": m0.get("w"), "h": m0.get("h")} if m0 and "resize" in m0 else None)
            if hm:
                w0 = int(hm.get("w") or 0); h0 = int(hm.get("h") or 0)
                if w0 >= 16 and h0 >= 16:
                    STATE.full_size = (w0, h0)
                    await loop.run_in_executor(STATE.pool, lambda: STATE.renderer.resize(w0, h0, MAX_DIM))
                if hm.get("cam"):
                    await loop.run_in_executor(STATE.pool, lambda: STATE.set_cam(hm["cam"]))
            for _ in range(3):
                d = await loop.run_in_executor(STATE.pool, lambda: STATE.render_frame(enc))
                if d:
                    await sock.send_bytes(bytes([1]) + struct.pack("<dfff", 0.0, 0.0, 0.0, 0.0) + bytes([255]) + d)
        else:
            config_sent = False
            primed = 0
            for _ in range(25):
                d = await loop.run_in_executor(STATE.pool, lambda: STATE.render_frame(enc))
                if not d:
                    continue
                if not config_sent:
                    types, sps = _nal_types(d)
                    codec = ("avc1." + bytes(sps[1:4]).hex()) if (sps and len(sps) >= 4) else "avc1.42e01f"
                    await sock.send_text(json.dumps({"config": codec}))
                    config_sent = True
                t, _ = _nal_types(d)
                await sock.send_bytes(bytes([1 if (5 in t or 7 in t) else 0]) + struct.pack("<dfff", 0.0, 0.0, 0.0, 0.0) + bytes([255]) + d)
                primed += 1
                if primed >= 5:
                    break
        await sock.send_text(json.dumps(
            {"info": f"wgpu: {STATE.adapter_info}\\n{enc_name} · ttf {round(time.time()-t_conn,2)}s"}))
        if STATE.catalog:
            await sock.send_text(json.dumps(STATE.catalog_message()))

        stop = asyncio.Event()
        input_wake = asyncio.Event()   # producer wakes on new camera input
        send_wake = asyncio.Event()    # consumer wakes on ack (credit) or a freshly rendered frame

        # Three loops, render decoupled from send:
        #   receiver  — folds mouse input into STATE.pending (coalesced) and estimates the client's
        #               frame rate from ack intervals.
        #   producer  — speculatively renders the LATEST camera into a single-slot RGBA buffer,
        #               overwriting it (stale renders are dropped, never encoded). It self-paces to
        #               ~the client's rate so it renders just ahead of demand, not flat-out.
        #   consumer  — on an ack credit, encodes the freshest slot frame and sends it. Because the
        #               render already happened, only the (cheap) encode is in the ack->display path.
        # Only sent frames are ever encoded, so NVENC's P-frame chain stays intact; dropping happens
        # before the encoder. FLUSH extra encodes after motion push NVENC's ~3 buffered frames out.
        PIPELINE = int(os.environ.get("PIPELINE", "1"))   # max frames in flight; 1 = snappiest settle
        FLUSH_FRAMES = 4      # post-motion encodes to drain NVENC's internal delay
        IDLE_GAP = 0.12       # no input for this long => "motion stopped" (debounce)
        IDLE_REAP_S = float(os.environ.get("IDLE_REAP_S", "900"))  # reap this session after 15min idle
        conn_mono = time.monotonic()
        slot = {"rgba": None, "ver": 0, "sent": 0, "ts": 0.0, "input_rt": None, "render_ms": 0.0,
                "hero": False, "conv": 0.0}
        pace = {"credits": PIPELINE, "flush": 0, "force": False,
                "client_dt": 1.0 / 30, "last_ack": None, "last_input": None,
                "input_ts": 0.0, "input_rt": None, "rendered_epoch": STATE.renderer.epoch,
                "render_fps": 0.0, "send_fps": 0.0,
                "prog_active": False, "prog_total": 0, "prog_done": 0}

        async def receiver():
            nonlocal enc
            try:
                while True:
                    m = await sock.receive_json()
                    if "ack" in m:
                        now = time.monotonic()
                        if pace["last_ack"] is not None:
                            dt = now - pace["last_ack"]
                            if 0.001 < dt < 2.0:            # EMA of the client's inter-frame period
                                pace["client_dt"] = 0.8 * pace["client_dt"] + 0.2 * dt
                        pace["last_ack"] = now
                        pace["credits"] += 1
                        send_wake.set()
                    elif "resize" in m:
                        w = int(m.get("w", 0)); h = int(m.get("h", 0))
                        if w >= 16 and h >= 16:
                            if DBG_SEND:
                                print(f"RESIZE client asked {w}x{h}", flush=True)
                            STATE.full_size = (w, h)
                            await loop.run_in_executor(STATE.pool, lambda: STATE.renderer.resize(w, h, MAX_DIM))
                            if mode == "video":   # H.264 encoder is size-fixed -> rebuild + resend config
                                nw, nh = STATE.renderer.width, STATE.renderer.height
                                enc = (await loop.run_in_executor(STATE.pool, lambda: make_encoder(nw, nh)))[0]
                                d0 = b""
                                for _ in range(15):
                                    d0 = await loop.run_in_executor(STATE.pool, lambda: STATE.render_frame(enc))
                                    if d0:
                                        break
                                _ty, _sps = _nal_types(d0)
                                _codec = ("avc1." + bytes(_sps[1:4]).hex()) if (_sps and len(_sps) >= 4) else "avc1.42e01f"
                                await sock.send_text(json.dumps({"config": _codec}))
                            pace["force"] = True
                            input_wake.set()
                    elif "reset" in m:
                        await loop.run_in_executor(STATE.pool, STATE.reset_camera)
                        pace["force"] = True               # producer renders once even w/o input
                        pace["last_input"] = time.monotonic()
                        input_wake.set()
                    elif "hello" in m:
                        # Client state replay: on every (re)connect the client sends its saved
                        # framebuffer size + camera pose, so this brand-new per-session server
                        # picks up exactly where the previous one left off.
                        hm = m["hello"] or {}
                        w = int(hm.get("w", 0)); hh = int(hm.get("h", 0))
                        if w >= 16 and hh >= 16:
                            STATE.full_size = (w, hh)
                            await loop.run_in_executor(STATE.pool, lambda: STATE.renderer.resize(w, hh, MAX_DIM))
                        if hm.get("cam"):
                            await loop.run_in_executor(STATE.pool, lambda: STATE.set_cam(hm["cam"]))
                        pace["force"] = True
                        pace["last_input"] = time.monotonic()
                        input_wake.set()
                        if DBG_SEND:
                            print(f"HELLO {json.dumps(hm)}", flush=True)
                    elif "diag" in m:
                        # Client self-report: what it actually decoded + drew (see sendDiag in the page).
                        print(f"DIAG {json.dumps(m['diag'])}", flush=True)
                    elif "shot" in m:
                        # Client canvas screenshot (PNG, base64) — ground truth of the displayed pixels.
                        import base64
                        tag = str(m.get("tag", "x")).replace("/", "_")[:40]
                        _shot_n[0] += 1
                        fn = f"/root/client_shot_{_shot_n[0]:02d}_{tag}.png"
                        with open(fn, "wb") as f:
                            f.write(base64.b64decode(m["shot"]))
                        print(f"SHOT saved {fn} {len(m['shot'])//1024}KB(b64)", flush=True)
                    elif "settarget" in m:
                        STATE.set_target(str(m["settarget"]))
                        pace["force"] = True               # repaint at the new level promptly
                        input_wake.set()
                    else:
                        with STATE.lock:
                            STATE.pending["az"] += -float(m.get("dx", 0)) * 0.4
                            STATE.pending["el"] += float(m.get("dy", 0)) * 0.4
                            STATE.pending["dz"] += float(m.get("zoom", 0))
                        pace["last_input"] = time.monotonic()
                        pace["input_ts"] = float(m.get("ts", 0.0))  # client clock, echoed back w/ the frame
                        pace["input_rt"] = time.monotonic()         # server clock: start of server-side dwell
                        input_wake.set()
            except Exception:
                stop.set(); input_wake.set(); send_wake.set()

        async def producer():
            n = 0; t0 = time.monotonic(); last = 0.0; drained = True; dbg_last = 0.0
            try:
                while not stop.is_set():
                    with STATE.lock:
                        dirty = bool(STATE.pending["az"] or STATE.pending["el"] or STATE.pending["dz"])
                    now = time.monotonic()
                    # Invalidation epoch: any structural change (volume/TF/reset/resize/level swap)
                    # bumps renderer.epoch. Treat that like fresh input -> re-render + re-settle.
                    external = STATE.renderer.epoch != pace["rendered_epoch"]
                    if external:
                        pace["last_input"] = now
                    li = pace["last_input"]
                    idle = (li is None) or (now - li > IDLE_GAP)   # debounced "motion stopped"
                    if DBG_SEND and (now - dbg_last > 0.5):
                        print(f"PROD dirty={int(dirty)} force={int(pace['force'])} ext={int(external)} "
                              f"idle={int(idle)} drained={int(drained)} prog={int(pace['prog_active'])} "
                              f"ep={STATE.renderer.epoch} rend_ep={pace['rendered_epoch']} full={STATE.full_size} "
                              f"mscale={STATE.motion_scale():.2f}", flush=True)
                        dbg_last = now
                    # Render a bit ahead of the client's cadence, but never faster than ~120fps
                    # nor slower-checked than every 0.2s. This is the "don't over-render" governor.
                    interval = min(max(pace["client_dt"] * 0.75, 1.0 / 120), 0.2)
                    if (dirty or pace["force"] or external) and (now - last) >= interval:
                        forced = pace["force"]; pace["force"] = False
                        # Full-res by default; MOTION_LOD=1 renders coarse while dragging (fine when settled).
                        step = STATE.coarse_step if (dirty and MOTION_LOD) else STATE.fine_step
                        # Adaptive geometry: while actively moving, render a dense reduced frame
                        # (client upsamples). A forced repaint (level swap / reset / resize) renders
                        # full-res so the still image is crisp.
                        scale = STATE.motion_scale() if (dirty and not forced) else 1.0
                        r0 = time.monotonic()
                        rgba, _ = await loop.run_in_executor(STATE.pool, lambda s=step, sc=scale: STATE.render_quality(s, sc))
                        slot["render_ms"] = (time.monotonic() - r0) * 1000.0
                        if dirty and not forced:
                            STATE.tune_budget(slot["render_ms"])   # v2: track MOTION_TARGET_MS
                        slot["rgba"] = rgba; slot["ts"] = pace["input_ts"]; slot["input_rt"] = pace["input_rt"]
                        slot["hero"] = False           # moving -> fast JPEG
                        slot["conv"] = 0.0             # actively interacting -> convergence bar hidden
                        pace["prog_active"] = False    # any settle refinement is now stale; restart on next settle
                        pace["rendered_epoch"] = STATE.renderer.epoch
                        slot["ver"] += 1
                        last = now; drained = False
                        send_wake.set()
                        n += 1
                        if now - t0 > 0.5:
                            pace["render_fps"] = round(n / (now - t0), 1); n = 0; t0 = now
                    else:
                        if idle and not drained:
                            # Motion stopped for IDLE_GAP: converge to native full-res via interleaved
                            # progressive refinement (v1). Each pass fills a stride-f sub-lattice of a
                            # full-res buffer with EXACT ray samples; after prog_total passes the image
                            # equals a direct native render (pixel-for-pixel, dither aside) — so "sharp
                            # and bar full = done" is unambiguous. Passes run back-to-back; the client's
                            # skip-to-latest naturally coalesces however many it can display.
                            STATE.renderer.set_sample_step(STATE.fine_step)
                            if not pace["prog_active"]:
                                fac = max(1, int(round(1.0 / max(STATE.motion_scale(), 1e-3))))
                                if fac <= 1:
                                    # Small/simple view: already native in one render -> no visible wait.
                                    r0 = time.monotonic()
                                    rgba, _ = await loop.run_in_executor(STATE.pool, lambda: STATE.render_latest(1.0))
                                    slot["render_ms"] = (time.monotonic() - r0) * 1000.0
                                    slot["rgba"] = rgba; slot["ts"] = pace["input_ts"]; slot["input_rt"] = pace["input_rt"]
                                    slot["hero"] = True; slot["conv"] = 1.0
                                    pace["rendered_epoch"] = STATE.renderer.epoch
                                    slot["ver"] += 1; pace["flush"] = FLUSH_FRAMES; drained = True
                                    send_wake.set()
                                else:
                                    pace["prog_total"] = STATE.renderer.begin_progressive(fac)
                                    pace["prog_done"] = 0; pace["prog_active"] = True
                            if pace["prog_active"]:
                                r0 = time.monotonic()
                                rgba, converged = await loop.run_in_executor(
                                    STATE.pool, lambda: STATE.renderer.progressive_step())
                                slot["render_ms"] = (time.monotonic() - r0) * 1000.0
                                pace["prog_done"] += 1
                                slot["rgba"] = rgba; slot["ts"] = pace["input_ts"]; slot["input_rt"] = pace["input_rt"]
                                slot["conv"] = pace["prog_done"] / max(1, pace["prog_total"])
                                slot["hero"] = bool(converged)   # final converged frame -> AVIF hero
                                pace["rendered_epoch"] = STATE.renderer.epoch
                                slot["ver"] += 1
                                if converged:
                                    pace["prog_active"] = False; pace["flush"] = FLUSH_FRAMES; drained = True
                                send_wake.set()
                        if now - t0 > 0.5:
                            pace["render_fps"] = round(n / (now - t0), 1); n = 0; t0 = now
                        input_wake.clear()
                        # While converging, spin fast so passes run back-to-back; else idle until input.
                        wait = 0.001 if pace["prog_active"] else ((interval - (now - last)) if dirty else 0.2)
                        try:
                            await asyncio.wait_for(input_wake.wait(), timeout=max(0.001, wait))
                        except asyncio.TimeoutError:
                            pass
            except Exception:
                import traceback; print("PRODUCER ERR:"); traceback.print_exc()
                stop.set(); send_wake.set()

        async def consumer():
            n = 0; t0 = time.monotonic()
            try:
                while not stop.is_set():
                    fresh = slot["ver"] > slot["sent"]
                    need = fresh or pace["flush"] > 0
                    if not (pace["credits"] > 0 and need and slot["rgba"] is not None):
                        send_wake.clear()
                        fresh = slot["ver"] > slot["sent"]
                        need = fresh or pace["flush"] > 0
                        if not (pace["credits"] > 0 and need and slot["rgba"] is not None):
                            try:
                                await asyncio.wait_for(send_wake.wait(), timeout=0.1)
                            except asyncio.TimeoutError:
                                pass
                            continue
                    rgba = slot["rgba"]; v = slot["ver"]; fts = slot["ts"]
                    s_irt = slot["input_rt"]; s_rms = slot["render_ms"]
                    slot["sent"] = v
                    if not fresh:
                        pace["flush"] -= 1                 # a drain encode of the last view
                    e0 = time.monotonic()
                    d = await loop.run_in_executor(STATE.pool, lambda: enc.encode(rgba))
                    ems = (time.monotonic() - e0) * 1000.0
                    if d:
                        pace["credits"] -= 1
                        t, _ = _nal_types(d)
                        sms = ((time.monotonic() - s_irt) * 1000.0) if s_irt else 0.0  # server dwell
                        # header: [keyflag:1][client_ts:f64][render_ms:f32][encode_ms:f32][server_ms:f32][conv:u8]
                        hdr = bytes([1 if (5 in t or 7 in t) else 0]) + struct.pack("<dfff", fts, s_rms, ems, sms) + bytes([255])
                        await sock.send_bytes(hdr + d)
                        n += 1; now = time.monotonic()
                        if now - t0 > 0.5:
                            pace["send_fps"] = round(n / (now - t0), 1); n = 0; t0 = now
            except Exception:
                stop.set()

        async def image_sender():
            # Independent-frame (MJPEG) mode: no ack pacing. Send the LATEST rendered frame as fast
            # as encode + the socket allow; stale frames are dropped at the slot (never encoded).
            # `await send_bytes` gives TCP backpressure, so a slow link naturally coalesces to latest.
            last_ver = 0; n = 0; t0 = time.monotonic()
            try:
                while not stop.is_set():
                    if slot["ver"] > last_ver and slot["rgba"] is not None:
                        rgba = slot["rgba"]; last_ver = slot["ver"]; fts = slot["ts"]
                        s_irt = slot["input_rt"]; s_rms = slot["render_ms"]; hero = slot["hero"]
                        conv = slot["conv"]
                        e0 = time.monotonic()
                        d = await loop.run_in_executor(STATE.pool, lambda: enc.encode(rgba, hero=hero))
                        ems = (time.monotonic() - e0) * 1000.0
                        if DBG_SEND and (conv > 0.0 or hero):
                            print(f"SEND ver={last_ver} conv={conv:.2f} hero={hero} "
                                  f"frame={rgba.shape[1]}x{rgba.shape[0]} bytes={len(d) if d else 0}", flush=True)
                        if hero and d:
                            # Settled: tell the client the authoritative camera pose so it can
                            # save it (localStorage) and replay it via {hello} on reconnect.
                            await sock.send_text(json.dumps({"cam": STATE.get_cam()}))
                        if DBG_SEND and hero and d:
                            # Ground truth: dump the exact buffer + exact JPEG bytes of this hero.
                            await loop.run_in_executor(STATE.pool, lambda r=rgba, dd=d: _dump_hero(r, dd))
                        if d:
                            sms = ((time.monotonic() - s_irt) * 1000.0) if s_irt else 0.0
                            # header: [flag:1][client_ts:f64][render_ms:f32][enc_ms:f32][srv_ms:f32][conv:u8]
                            hdr = bytes([1]) + struct.pack("<dfff", fts, s_rms, ems, sms) + bytes([int(max(0, min(255, round(conv * 255))))])
                            await sock.send_bytes(hdr + d)
                            n += 1; now = time.monotonic()
                            if now - t0 > 0.5:
                                pace["send_fps"] = round(n / (now - t0), 1); n = 0; t0 = now
                    else:
                        send_wake.clear()
                        if not (slot["ver"] > last_ver):
                            try:
                                await asyncio.wait_for(send_wake.wait(), timeout=0.1)
                            except asyncio.TimeoutError:
                                pass
            except Exception:
                import traceback; print("SENDER ERR:"); traceback.print_exc()
                stop.set()

        async def statline():
            try:
                while not stop.is_set():
                    await asyncio.sleep(1.0)
                    # Idle reaper: this session's renderer is exclusively ours, so an abandoned
                    # tab holds GPU memory for nothing. Tell the client we're going ({bye}), then
                    # close; the client keeps the last image up and reconnects on the next input,
                    # replaying its saved state into a fresh session (hello) — seamless resume.
                    li = pace["last_input"] or conn_mono
                    if time.monotonic() - li > IDLE_REAP_S:
                        try:
                            await sock.send_text(json.dumps({"bye": 1}))
                            await sock.close()
                        except Exception:
                            pass
                        stop.set(); send_wake.set(); input_wake.set()
                        break
                    cfps = round(1.0 / pace["client_dt"], 1) if pace["client_dt"] > 0 else 0
                    await sock.send_text(json.dumps({"info":
                        f"wgpu: {STATE.adapter_info} · {STATE.dataset}\\n{enc_name} · "
                        f"render {pace['render_fps']} / send {pace['send_fps']} / client {cfps} fps"}))
                    if STATE.catalog:
                        await sock.send_text(json.dumps(STATE.catalog_message()))
            except Exception:
                stop.set()

        _send = image_sender if mode == "image" else consumer
        tasks = [asyncio.create_task(t()) for t in (receiver, producer, _send, statline)]
        try:
            await stop.wait()
        finally:
            for t in tasks:
                t.cancel()
            enc.close()
            STATE.dispose()      # reap this session's renderer + pool

    return fapp


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "127.0.0.1")
    cert, key = os.environ.get("TLS_CERT"), os.environ.get("TLS_KEY")
    tls = dict(ssl_certfile=cert, ssl_keyfile=key) if (cert and key) else {}
    scheme = "https" if tls else "http"
    print(f"LiveRenderer on {scheme}://{host}:{PORT}  (WebCodecs needs {scheme}== https or localhost)")
    uvicorn.run(build_app(), host=host, port=PORT, log_level="warning", **tls)
