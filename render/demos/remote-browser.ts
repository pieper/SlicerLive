// Remote-render client (M3/M4): the SAME scene rendered either LOCALLY (this browser's GPU) or
// REMOTELY (a Deno LiveRenderer over WebSocket) — a per-view RenderMode the user toggles. Remote
// sends the camera and RECONSTRUCTS the traced samples the server streams; local uses the shared
// mountAdaptive3d. Both share one camera, so switching modes is instant. Bundled to
// server/client/remote.js and served BY the Deno server (same origin as the /ws upgrade).
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { loadSceneVolumeField } from "../scene-volume.ts";
import { Reconstructor } from "../reconstructor.ts";
import { mountAdaptive3d, type Adaptive3d } from "./accum-loop.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import type { Vec3 } from "../mat4.ts";
import type { VtkCamera } from "../vtk-camera.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const modeBtn = document.getElementById("mode") as HTMLButtonElement | null;
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const gpu = await initDevice();
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  const recon = new Reconstructor(gpu, srgb);
  recon.setBackground(0.05, 0.06, 0.09);

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(720, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size; canvas.height = size;
  };
  globalThis.addEventListener("resize", () => { resize(); onCam(); });
  resize();

  let camera: VtkCamera | null = null;
  let sceneName = "scene", sceneUrl = "";
  let mode: "remote" | "local" = "remote";
  let frames = 0, bytes = 0, lastCamSentAt = 0;
  const rtt: number[] = [];

  // ---- LOCAL path (lazy): build the SAME scene on this GPU + the shared adaptive driver ----
  let localScene: SceneRenderer | null = null;
  let a3d: Adaptive3d | null = null;
  let loadingLocal = false;
  const ensureLocal = async (): Promise<boolean> => {
    if (a3d) return true;
    if (loadingLocal || !camera || !sceneUrl) return false;
    loadingLocal = true;
    status(`loading ${sceneName} locally…`);
    let mb = 0;
    const sv = await loadSceneVolumeField(gpu.device, sceneUrl, (n) => { mb += n; status(`loading ${sceneName} locally… ${(mb / 1e6).toFixed(0)} MB`); });
    localScene = new SceneRenderer(gpu, srgb);
    localScene.build([sv.field]);
    localScene.setBackground(0.05, 0.06, 0.09);
    a3d = mountAdaptive3d({
      scene: () => localScene,
      view: () => ctx.getCurrentTexture().createView({ format: srgb }),
      size: () => ({ w: canvas.width, h: canvas.height }),
      setCamera: (s, w, h) => s.setCamera(camera!.position, camera!.focalPoint, camera!.viewUp, camera!.viewAngle, w, h),
      gpu,
      onFrame: () => statusLine("local"),
    });
    loadingLocal = false;
    return true;
  };

  // ---- REMOTE path ----
  const ws = new WebSocket(`ws://${location.host}/`);
  ws.binaryType = "arraybuffer";
  let lastSent = -1e12;
  let trailing: ReturnType<typeof setTimeout> | 0 = 0;
  const sendCam = () => {
    trailing = 0;
    if (!camera || ws.readyState !== WebSocket.OPEN) return;
    lastSent = lastCamSentAt = performance.now();
    ws.send(JSON.stringify({ type: "cam", w: canvas.width, h: canvas.height, p: [...camera.position], f: [...camera.focalPoint], u: [...camera.viewUp], a: camera.viewAngle }));
  };
  const scheduleSend = () => {
    if (!camera || ws.readyState !== WebSocket.OPEN) return;
    const dt = performance.now() - lastSent;
    if (dt >= 15) sendCam();
    else if (!trailing) trailing = setTimeout(sendCam, 15 - dt);
  };

  const statusLine = (where: "remote" | "local", extra = "") =>
    status(`${sceneName} · ${where.toUpperCase()} · ${extra}${where === "remote" ? `~${[...rtt].sort((a, b) => a - b)[rtt.length >> 1] | 0} ms round-trip · ${(bytes / 1e6).toFixed(1)} MB` : "your GPU"}`);

  // Any camera/view change → drive the ACTIVE path.
  const onCam = () => { if (mode === "remote") scheduleSend(); else a3d?.draw(); };

  ws.onopen = () => status("connected — waiting for scene…");
  ws.onclose = () => { if (mode === "remote") status("render server disconnected — switch to Local, or restart server/live-renderer.ts", true); };
  ws.onerror = () => { if (mode === "remote") status("cannot reach render server — switch to Local, or start server/live-renderer.ts", true); };
  const gunzip = async (b: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await new Response(new Response(b).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

  ws.onmessage = async (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.type === "hello") {
        sceneName = m.name ?? "scene"; sceneUrl = m.sceneUrl ?? "";
        camera = framedCamera(m.center as Vec3, m.radius);
        attachCameraControls(canvas, camera, { onChange: onCam });
        sendCam();
        statusLine("remote", "drag to orbit · ");
      }
      return;
    }
    if (mode !== "remote") return;   // ignore stale remote frames while in Local mode
    const buf = e.data as ArrayBuffer;
    const head = new Uint16Array(buf, 0, 6);
    const sw = head[0], sh = head[1], settled = head[4], compressed = head[5];
    let samples = new Uint8Array(buf, 12);
    if (compressed) samples = await gunzip(samples);
    recon.present(ctx.getCurrentTexture().createView({ format: srgb }), samples, sw, sh, canvas.width, canvas.height);
    ws.send('{"type":"ack"}');       // ack-based credit: server sends the next frame once we present
    frames++; bytes += buf.byteLength;
    const dt = performance.now() - lastCamSentAt; rtt.push(dt); if (rtt.length > 30) rtt.shift();
    statusLine("remote", `${settled ? "native" : `${sw}×${sh}`} · ${compressed ? "gz " : ""}`);
  };

  // ---- RenderMode toggle ----
  const setMode = async (m: "remote" | "local") => {
    if (m === "local") { if (!await ensureLocal()) { status("cannot load local scene", true); return; } }
    mode = m;
    if (modeBtn) modeBtn.textContent = m === "remote" ? "Rendering: Remote (Deno)" : "Rendering: Local (your GPU)";
    if (m === "remote") sendCam(); else a3d?.draw();
  };
  modeBtn?.addEventListener("click", () => setMode(mode === "remote" ? "local" : "remote"));

  (globalThis as unknown as { __remoteDbg: unknown }).__remoteDbg = {
    frames: () => frames, connected: () => ws.readyState === WebSocket.OPEN, hasCam: () => !!camera,
    mode: () => mode, setMode: (m: "remote" | "local") => setMode(m),
  };
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
