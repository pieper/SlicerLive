"""
Build the native crates ON the GPU host and run the NVENC probe.

Why build there: the driver libraries the encoder links (libnvidia-encode, libnvcuvid, libcuda) are
injected into the container at runtime, not at image build — and the whole point is a binary tuned
for the exact CPU that runs it (`-C target-cpu=native`, see native/.cargo/config.toml). Cargo's
registry and target directory live in a Modal Volume so rebuilds are incremental.

    modal run native/modal_build.py                # build + run nvenc-probe
    modal run native/modal_build.py --bin <name>   # build + run another binary
"""

import pathlib
import subprocess
import time

import modal

ROOT = pathlib.Path(__file__).resolve().parents[1] if modal.is_local() else pathlib.Path("/app")

app = modal.App("slicerlive-native-build")
build_vol = modal.Volume.from_name("slicerlive-native-build", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "build-essential", "pkg-config", "libvulkan1",
                 "vulkan-tools", "mesa-utils-extra", "libglvnd0", "libx11-6", "libxext6")
    .run_commands(
        "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
        "mkdir -p /usr/share/vulkan/icd.d",
        "python3 -c \"import json;open('/usr/share/vulkan/icd.d/nvidia_icd.json','w')"
        ".write(json.dumps({'file_format_version':'1.0.0',"
        "'ICD':{'library_path':'libGLX_nvidia.so.0','api_version':'1.3.0'}}))\"",
    )
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all",
        "NVIDIA_VISIBLE_DEVICES": "all",
        "PATH": "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "CARGO_HOME": "/build/cargo",
    })
    .add_local_dir(ROOT / "native", "/app/native", ignore=["target", "**/target"])
)


@app.function(image=image, gpu="L4", timeout=60 * 30, volumes={"/build": build_vol}, cpu=8)
def build_and_run(bin_name: str) -> dict:
    def sh(cmd: str, **kw) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, **kw)

    # The crate's build script looks for the UNVERSIONED .so names; the driver injects only the
    # versioned ones. Symlink them where the linker looks.
    sh("cd /usr/lib/x86_64-linux-gnu && for l in nvidia-encode nvcuvid cuda; do "
       "[ -e lib$l.so ] || ln -s $(ls lib$l.so.* | head -1) lib$l.so; done")
    out = {"host_cpu": sh("lscpu | grep -E 'Model name|Flags' | sed 's/Flags:.*avx512f/has avx512f/' | cut -c1-120").stdout}
    # target-cpu=native bakes THIS host's ISA into the binary AND every dependency. A shared build
    # volume reused across Modal hosts with different CPUs would then SIGILL, and cargo's mtime
    # fingerprint does not notice mounted-source edits — so the target dir is keyed by a hash of the
    # CPU flags, and our own sources are touched to force a rebuild each run.
    cpu_key = sh("lscpu | grep Flags | md5sum | cut -c1-12").stdout.strip()
    target_dir = f"/build/target-{cpu_key}"
    sh(f"find /app/native -name '*.rs' -exec touch {{}} +")
    t0 = time.time()
    b = sh(f"cd /app/native && CARGO_TARGET_DIR={target_dir} cargo build --release -p liverender-encode 2>&1 | tail -6", timeout=60 * 25)
    out["target_dir"] = target_dir
    out["build_s"] = round(time.time() - t0, 1)
    out["build_log"] = b.stdout[-3000:]
    build_vol.commit()
    r = sh(f"RUST_BACKTRACE=1 {target_dir}/release/{bin_name} 2>&1", timeout=300)
    out["run"] = r.stdout[-6000:]
    out["rc"] = r.returncode
    return out


@app.local_entrypoint()
def main(bin: str = "nvenc-probe"):
    res = build_and_run.remote(bin)
    print(res["host_cpu"])
    print(f"build {res['build_s']}s · {res.get('target_dir')}")
    print(res["build_log"])
    print("---- run (rc", res["rc"], ") ----")
    print(res["run"])
