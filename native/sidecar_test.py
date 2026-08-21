"""
Build the sidecar on the L4, drive it over its Unix socket with a Deno client (the same runtime the
render server uses), and return the AV1 frames so the browser-decode seam can be checked locally.

    modal run native/sidecar_test.py --out-dir <local dir>
"""
import pathlib
import subprocess
import time

import modal

ROOT = pathlib.Path(__file__).resolve().parents[1] if modal.is_local() else pathlib.Path("/app")
app = modal.App("slicerlive-sidecar-test")
build_vol = modal.Volume.from_name("slicerlive-native-build", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "build-essential", "pkg-config", "libvulkan1", "unzip")
    .run_commands(
        "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
        "curl -fsSL https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip -o /tmp/d.zip",
        "unzip -o /tmp/d.zip -d /usr/local/bin && chmod +x /usr/local/bin/deno",
    )
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all", "NVIDIA_VISIBLE_DEVICES": "all",
        "PATH": "/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "CARGO_HOME": "/build/cargo", "DENO_DIR": "/tmp/deno",
    })
    .add_local_dir(ROOT / "native", "/app/native", ignore=["target", "**/target"])
)

# A tiny Deno driver: connect, send N patches of varying size, save each reply.
DRIVER = r'''
const sock = Deno.args[0], outDir = Deno.args[1];
const conn = await Deno.connect({ transport: "unix", path: sock });
function synth(w, h, seed) {
  const a = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const dx = x - w / 2, dy = y - h / 2, d = Math.hypot(dx, dy);
    const v = Math.max(0, Math.min(1, (w * 0.35 - d) / (w * 0.2)));
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    a[i] = 240 * v; a[i + 1] = 180 * v; a[i + 2] = 140 * v; a[i + 3] = 255;
  }
  return a;
}
const sizes = [[750, 435], [750, 435], [1500, 870], [3000, 1740], [750, 435]];
const enc = new TextEncoder();
for (let k = 0; k < sizes.length; k++) {
  const [w, h] = sizes[k];
  const rgba = synth(w, h, 100 + k);
  const hdr = new Uint8Array(13);
  const dv = new DataView(hdr.buffer);
  dv.setUint16(0, w, true); dv.setUint16(2, h, true); dv.setUint16(4, 28, true);
  hdr[6] = 13; hdr[7] = 15; hdr[8] = 23; dv.setUint32(9, rgba.length, true);
  const writeAll = async (b) => { let o = 0; while (o < b.length) o += await conn.write(b.subarray(o)); };
  const readAll = async (b) => { let o = 0; while (o < b.length) { const r = await conn.read(b.subarray(o)); if (r === null) throw new Error("eof"); o += r; } };
  const t0 = performance.now();
  await writeAll(hdr); await writeAll(rgba);
  const lenb = new Uint8Array(4);
  await readAll(lenb);
  const n = new DataView(lenb.buffer).getUint32(0, true);
  const av1 = new Uint8Array(n);
  await readAll(av1);
  const ms = (performance.now() - t0).toFixed(2);
  console.log(`patch ${w}x${h}: sent ${rgba.length} -> av1 ${n} bytes  round-trip ${ms} ms`);
  await Deno.writeFile(`${outDir}/patch-${k}-${w}x${h}.av1`, av1);
}
conn.close();
'''


@app.function(image=image, gpu="L4", timeout=900, volumes={"/build": build_vol}, cpu=8)
def run() -> dict:
    def sh(cmd, **kw): return subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, **kw)
    sh("cd /usr/lib/x86_64-linux-gnu && for l in nvidia-encode nvcuvid cuda; do [ -e lib$l.so ] || ln -s $(ls lib$l.so.* | head -1) lib$l.so; done")
    cpu_key = sh("lscpu | grep Flags | md5sum | cut -c1-12").stdout.strip()
    td = f"/build/target-{cpu_key}"
    sh("find /app/native -name '*.rs' -exec touch {} +")
    b = sh(f"cd /app/native && CARGO_TARGET_DIR={td} cargo build --release -p liverender-encode --bin liverender-sidecar 2>&1", timeout=1500)
    out = {"build": b.stdout[-3000:]}
    bin_path = f"{td}/release/liverender-sidecar"
    if not pathlib.Path(bin_path).exists():
        out["ready"] = False
        out["frames"] = {}
        return out
    pathlib.Path("/app/driver.ts").write_text(DRIVER)
    pathlib.Path("/tmp/frames").mkdir(exist_ok=True)
    # start the sidecar, wait for READY on its stdout
    errf = open("/tmp/sidecar.err", "w")
    proc = subprocess.Popen([bin_path, "/tmp/enc.sock"],
                            stdout=subprocess.PIPE, stderr=errf, text=True)
    ready = False
    for _ in range(200):
        line = proc.stdout.readline()
        if "READY" in line: ready = True; break
        if proc.poll() is not None: break
        time.sleep(0.05)
    out["ready"] = ready
    if ready:
        d = sh("deno run --allow-read --allow-write --allow-net --unstable-net /app/driver.ts /tmp/enc.sock /tmp/frames", timeout=120)
        out["driver"] = d.stdout + d.stderr
    proc.terminate()
    errf.flush()
    out["sidecar_err"] = pathlib.Path("/tmp/sidecar.err").read_text()[-2000:]
    frames = {}
    for f in sorted(pathlib.Path("/tmp/frames").glob("*.av1")):
        frames[f.name] = f.read_bytes()
    out["frames"] = frames
    return out


@app.local_entrypoint()
def main(out_dir: str = ""):
    res = run.remote()
    print(res["build"][-400:])
    print("ready:", res["ready"])
    print("--- sidecar stderr ---"); print(res.get("sidecar_err",""))
    print(res.get("driver", ""))
    if out_dir:
        d = pathlib.Path(out_dir); d.mkdir(parents=True, exist_ok=True)
        for name, data in res.get("frames", {}).items():
            (d / name).write_bytes(data)
        print(f"saved {len(res.get('frames', {}))} frames to {out_dir}")
