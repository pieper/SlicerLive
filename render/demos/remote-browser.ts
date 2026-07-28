// Remote-render client (M3): the browser connects to the Deno LiveRenderer over WebSocket, sends its
// camera, and RECONSTRUCTS the traced samples the server streams back — the exact same Reconstructor
// the local path uses, just fed from the network instead of a local GPU trace. Orbiting round-trips
// to the server; a low-res moving frame streams while you drag, a native frame when you settle.
// Bundled to live/webgpu/remote.js and served BY the Deno server (same origin as the /ws upgrade).
import { initDevice } from "../device.ts";
import { Reconstructor } from "../reconstructor.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import type { Vec3 } from "../mat4.ts";
import type { VtkCamera } from "../vtk-camera.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};

async function main() {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
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
  globalThis.addEventListener("resize", () => { resize(); scheduleSend(); });
  resize();

  let camera: VtkCamera | null = null;
  let frames = 0, bytes = 0;
  let lastCamSentAt = 0;
  const rtt: number[] = [];

  const ws = new WebSocket(`ws://${location.host}/`);
  ws.binaryType = "arraybuffer";

  // Throttle camera sends to ~60/s with a timestamp (leading edge fires immediately + a trailing send
  // for the final position). Deliberately NOT rAF-gated — rAF pauses in a background tab, and the
  // server coalesces to the latest camera anyway.
  let lastSent = -1e12;
  let trailing: ReturnType<typeof setTimeout> | 0 = 0;
  const sendCam = () => {
    trailing = 0;
    if (!camera || ws.readyState !== WebSocket.OPEN) return;
    lastSent = lastCamSentAt = performance.now();
    ws.send(JSON.stringify({
      type: "cam", w: canvas.width, h: canvas.height,
      p: [...camera.position], f: [...camera.focalPoint], u: [...camera.viewUp], a: camera.viewAngle,
    }));
  };
  const scheduleSend = () => {
    if (!camera || ws.readyState !== WebSocket.OPEN) return;
    const dt = performance.now() - lastSent;
    if (dt >= 15) sendCam();
    else if (!trailing) trailing = setTimeout(sendCam, 15 - dt);
  };

  ws.onopen = () => status("connected — waiting for scene…");
  ws.onclose = () => status("disconnected from render server (is it running? deno run server/live-renderer.ts)", true);
  ws.onerror = () => status("cannot reach render server on this port — start server/live-renderer.ts", true);

  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.type === "hello") {
        camera = framedCamera(m.center as Vec3, m.radius);
        attachCameraControls(canvas, camera, { onChange: scheduleSend });
        sendCam();   // immediate initial frame request (not throttled/rAF-gated)
        status("streaming from the remote renderer — drag to orbit");
      }
      return;
    }
    const buf = e.data as ArrayBuffer;
    const head = new Uint16Array(buf, 0, 6);
    const sw = head[0], sh = head[1], vw = head[2], vh = head[3], settled = head[4];
    const samples = new Uint8Array(buf, 12);
    recon.present(ctx.getCurrentTexture().createView({ format: srgb }), samples, sw, sh, canvas.width, canvas.height);
    frames++; bytes += buf.byteLength;
    const dt = performance.now() - lastCamSentAt; rtt.push(dt); if (rtt.length > 30) rtt.shift();
    const med = [...rtt].sort((a, b) => a - b)[rtt.length >> 1] | 0;
    status(`remote render · ${settled ? "native" : `${sw}×${sh}`} → ${vw}×${vh} · ~${med} ms round-trip · ${(bytes / 1e6).toFixed(1)} MB`);
  };

  (globalThis as unknown as { __remoteDbg: unknown }).__remoteDbg = {
    frames: () => frames, connected: () => ws.readyState === WebSocket.OPEN, hasCam: () => !!camera,
  };
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
