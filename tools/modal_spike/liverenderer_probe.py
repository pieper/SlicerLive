"""
LiveRenderer / LiveModules feasibility probe on Modal.

Answers three empirical questions the design doc (docs/LIVE-ARCHITECTURE.md) leaves open:

  1. HARDWARE GL  -- does headless Chromium on a Modal GPU actually render WebGL2 on the
     NVIDIA GPU (UNMASKED_RENDERER reports the GPU), or does it silently fall back to
     SwiftShader (software)? If it falls back, LiveRenderer-on-Modal is not a story yet.
  2. COLD START   -- wall-clock time from invoking a scaled-to-zero function to a rendered
     frame, cold vs warm. This is the "few seconds or just an idea?" number. NOTE: GPU
     memory snapshots do NOT help here (Modal docs: "incompatible with non-CUDA GPU code
     (graphics operations)"), so this is honest container-boot + chromium-launch time.
  3. S3 THROUGHPUT -- download MB/s from a public AWS S3 object (default: an AWS Open Data
     bucket) into a Modal worker, to gauge AWS->Modal transfer for big studies (e.g. the
     Visible Human cryosection set). IDC open-data is AWS Open Data => free egress.

Run:
    modal setup                       # one-time, free tier; opens a browser to auth
    modal run liverenderer_probe.py                       # all three probes
    modal run liverenderer_probe.py --url <https-s3-url>  # custom throughput target

Everything prints to your terminal; no resources are left running (scaledown_window=60).
"""

import json
import os
import time

import modal

# Timestamp at module import INSIDE the container image (helps distinguish cold boot work).
_IMPORT_TS = time.time()

app = modal.App("liverenderer-spike")

# --- Image: CUDA base (so Modal injects the NVIDIA driver + GL libs) + Xvfb + Chromium ----
# We run Chromium *headed under Xvfb* rather than --headless, because the surfaceless/headless
# GL path most often falls back to SwiftShader; a virtual display + EGL is the proven way to
# get hardware GL on a server GPU (this is what the LiveDesktop/vast stack already does).
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-base-ubuntu22.04", add_python="3.11"
    )
    .apt_install(
        "xvfb",
        "libglvnd0", "libgl1", "libglx0", "libegl1", "libgles2", "libgbm1",
        "ca-certificates", "curl",
    )
    .pip_install("playwright==1.48.0", "requests")
    .run_commands(
        "playwright install-deps chromium",
        "playwright install chromium",
        # Make the glvnd EGL loader find the (runtime-injected) NVIDIA EGL vendor library,
        # in case the driver injection doesn't drop the vendor JSON itself.
        "mkdir -p /usr/share/glvnd/egl_vendor.d",
        "printf '{\"file_format_version\":\"1.0.0\",\"ICD\":{\"library_path\":\"libEGL_nvidia.so.0\"}}'"
        " > /usr/share/glvnd/egl_vendor.d/10_nvidia.json",
    )
    .env({"NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all"})
)

# A minimal WebGL2 page: reports the unmasked renderer and clears to a color so the
# screenshot is non-trivial. (Phase B would load the real SlicerLive viewer.html + a volume
# scene to also judge volume-rendering fidelity; this Phase A settles hardware-GL + cold start.)
_PROBE_HTML = """<!doctype html><html><body style="margin:0">
<canvas id=c width=640 height=480></canvas>
<script>
  const c = document.getElementById('c');
  const gl = c.getContext('webgl2');
  let info = {webgl2: !!gl};
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    info.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(no debug ext)';
    info.vendor   = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : '(no debug ext)';
    info.version  = gl.getParameter(gl.VERSION);
    info.maxTex3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);  // the SlicerLive router's key number
    gl.clearColor(0.1, 0.5, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  window.__probe = info;
</script></body></html>"""


@app.cls(gpu="L4", image=image, scaledown_window=60, timeout=300)
class Renderer:
    @modal.enter()
    def start(self):
        """Container warmup: bring up a virtual display once per container."""
        import subprocess
        self._enter_ts = time.time()
        os.environ["DISPLAY"] = ":99"
        subprocess.Popen(
            ["Xvfb", ":99", "-screen", "0", "1280x1024x24", "-ac", "+extension", "GLX"]
        )
        time.sleep(1.5)  # let Xvfb come up
        self._cold = True  # first .render() on this container is a cold-container render

    @modal.method()
    def render(self):
        from playwright.sync_api import sync_playwright

        t_call = time.time()
        cold = self._cold
        self._cold = False

        gpu_args = [
            "--no-sandbox", "--disable-dev-shm-usage",
            "--ignore-gpu-blocklist", "--enable-gpu",
            "--use-gl=egl",  # native GL via EGL on the NVIDIA driver
        ]
        results = {}
        t_launch = time.time()
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False, args=gpu_args)
            page = browser.new_page()
            t_page = time.time()
            page.set_content(_PROBE_HTML)
            page.wait_for_function("window.__probe !== undefined", timeout=15000)
            probe = page.evaluate("window.__probe")
            t_render = time.time()
            png = page.screenshot()
            browser.close()

        # GPU/driver sanity from the host side.
        import subprocess
        try:
            smi = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,driver_version,memory.total",
                 "--format=csv,noheader"],
                capture_output=True, text=True, timeout=20,
            ).stdout.strip()
        except Exception as e:
            smi = f"(nvidia-smi failed: {e})"

        sw = ("swiftshader" in (probe.get("renderer", "") or "").lower()
              or "llvmpipe" in (probe.get("renderer", "") or "").lower())
        results.update(
            cold_container=cold,
            nvidia_smi=smi,
            webgl=probe,
            hardware_gl=(not sw and probe.get("webgl2")),
            screenshot_bytes=len(png),
            timings_s={
                "import_to_enter": round(self._enter_ts - _IMPORT_TS, 3),
                "enter_to_call":   round(t_call - self._enter_ts, 3),
                "browser_launch":  round(t_page - t_launch, 3),
                "page_to_frame":   round(t_render - t_page, 3),
            },
        )
        return results


@app.function(image=image, region=["us-east"], scaledown_window=60, timeout=600)
def s3_throughput(url: str, max_mb: float = 2000.0):
    """Stream-download a public S3/HTTPS object and report MB/s (capped at max_mb)."""
    import requests

    where = {}
    try:
        where["egress_ip"] = requests.get("https://checkip.amazonaws.com", timeout=10).text.strip()
    except Exception as e:
        where["egress_ip"] = f"(failed: {e})"
    where["modal_region_requested"] = "us-east"

    t0 = time.time()
    total = 0
    cap = int(max_mb * 1024 * 1024)
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        ttfb = time.time() - t0
        for chunk in r.iter_content(chunk_size=1 << 20):  # 1 MiB
            total += len(chunk)
            if total >= cap:
                break
    dt = time.time() - t0
    mb = total / (1024 * 1024)
    return {
        "url": url,
        "downloaded_mb": round(mb, 1),
        "seconds": round(dt, 2),
        "ttfb_s": round(ttfb, 3),
        "throughput_MBps": round(mb / dt, 1) if dt > 0 else None,
        "throughput_Gbps": round((mb * 8 / 1000) / dt, 2) if dt > 0 else None,
        "placement": where,
    }


# A guaranteed-working public AWS Open Data default (NYC TLC, us-east-1, ~50 MB).
# For the real number, point --url at a multi-GB IDC object (idc-index gives aws_url) or the
# Visible Human cryosection set wherever it is hosted on S3.
_DEFAULT_URL = (
    "https://nyc-tlc.s3.amazonaws.com/trip+data/yellow_tripdata_2023-01.parquet"
)


@app.local_entrypoint()
def main(url: str = _DEFAULT_URL):
    r = Renderer()

    print("\n=== COLD render (scaled-to-zero -> first frame) ===")
    t0 = time.time(); res_cold = r.render.remote(); wall_cold = time.time() - t0
    print(f"  wall clock (client-observed): {wall_cold:.2f} s")
    print(json.dumps(res_cold, indent=2))

    print("\n=== WARM render (container already up) ===")
    t0 = time.time(); res_warm = r.render.remote(); wall_warm = time.time() - t0
    print(f"  wall clock (client-observed): {wall_warm:.2f} s")
    print(f"  cold-start overhead ~= {wall_cold - wall_warm:.2f} s")

    print("\n=== S3 -> Modal throughput ===")
    print(json.dumps(s3_throughput.remote(url), indent=2))

    print("\n=== VERDICT ===")
    hw = res_cold.get("hardware_gl")
    print(f"  hardware GL in headless Chromium: {'YES' if hw else 'NO (software fallback!)'}")
    print(f"  renderer string: {res_cold.get('webgl', {}).get('renderer')}")
    print(f"  cold first-frame wall time: {wall_cold:.2f} s")
