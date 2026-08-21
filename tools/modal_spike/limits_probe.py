"""Report the L4's WebGPU limits (via Deno/wgpu) — esp. maxTextureDimension3D and maxBufferSize,
which gate how large a volume can be a 3D texture. modal run tools/modal_spike/limits_probe.py"""
import pathlib, subprocess, modal
ROOT = pathlib.Path(__file__).resolve().parents[2] if modal.is_local() else pathlib.Path("/app")
app = modal.App("slicerlive-limits-probe")
image = (modal.Image.debian_slim(python_version="3.11")
    .apt_install("libvulkan1","vulkan-tools","mesa-utils-extra","libglvnd0","libx11-6","libxext6","curl","unzip","ca-certificates")
    .run_commands("mkdir -p /usr/share/vulkan/icd.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w').write(json.dumps({'file_format_version':'1.0.0','ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
        "curl -fsSL -o /tmp/d.zip https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
        "unzip -o /tmp/d.zip -d /usr/local/bin && chmod +x /usr/local/bin/deno")
    .env({"NVIDIA_DRIVER_CAPABILITIES":"all","NVIDIA_VISIBLE_DEVICES":"all","DENO_DIR":"/tmp/deno"}))
PROBE = r'''
const a = await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
const L = a.limits;
console.log(JSON.stringify({info:a.info?.description, maxTextureDimension2D:L.maxTextureDimension2D, maxTextureDimension3D:L.maxTextureDimension3D, maxBufferSize:String(L.maxBufferSize), maxStorageBufferBindingSize:String(L.maxStorageBufferBindingSize)}));
'''
@app.function(image=image, gpu="L4", timeout=300)
def probe():
    pathlib.Path("/tmp/p.js").write_text(PROBE)
    r = subprocess.run(["bash","-lc","deno run --unstable-webgpu -A /tmp/p.js 2>&1"], capture_output=True, text=True, timeout=200)
    return r.stdout
@app.local_entrypoint()
def main(): print(probe.remote())
