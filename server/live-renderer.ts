// LiveRenderer (M3) — the SAME TS/WebGPU renderer, run headless under Deno, streaming traced
// SAMPLES to a browser client that reconstructs them (docs/UNIFIED-RENDERING-PLAN.md M3). This is
// the remote half of the DRY unification: local and remote run identical render code; only the
// transport between Producer (this server's SceneRenderer.traceSamples) and Reconstructor (the
// browser's Reconstructor) differs — an in-process GPU buffer locally, a WebSocket here.
//
//   deno run --unstable-webgpu --allow-net --allow-read --allow-env server/live-renderer.ts
//   (localhost only for now; per-session isolation + bandwidth/latency budget come in M4)
import { initDevice } from "../render/device.ts";
import { SceneRenderer } from "../render/scene-renderer.ts";
import { buildFourUpScene } from "../render/demos/fourup-scene.ts";
import { BudgetController } from "../render/budget-controller.ts";
import type { Vec3 } from "../render/mat4.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8787);
// Self-contained client (page + bundle) served by this server — kept out of the public gallery since
// it needs the local server running. Build with:
//   deno run -A npm:esbuild render/demos/remote-browser.ts --bundle --format=esm --outfile=server/client/remote.js
const CLIENT_DIR = Deno.env.get("CLIENT_DIR") ?? new URL("./client/", import.meta.url).pathname;
const IDLE_MS = 80;                          // after this long with no camera update, send one native frame

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- one shared headless renderer + scene (single-user localhost; per-session isolation is M4) ----
const gpu = await initDevice();
const scene = new SceneRenderer(gpu, "rgba8unorm");
const sc = buildFourUpScene(gpu.device);
scene.build([sc.field3d]);
scene.setBackground(0.05, 0.06, 0.09);
const center: Vec3 = [(sc.rasLo[0] + sc.rasHi[0]) / 2, (sc.rasLo[1] + sc.rasHi[1]) / 2, (sc.rasLo[2] + sc.rasHi[2]) / 2];
const radius = Math.hypot(sc.rasHi[0] - sc.rasLo[0], sc.rasHi[1] - sc.rasLo[1], sc.rasHi[2] - sc.rasLo[2]) / 2;
console.log(`[live-renderer] scene ready (center ${center.map((v) => v.toFixed(0))}, radius ${radius.toFixed(0)})`);

interface CamMsg { type: "cam"; w: number; h: number; p: Vec3; f: Vec3; u: Vec3; a: number }

function sendFrame(sock: WebSocket, sw: number, sh: number, vw: number, vh: number, settled: number, payload: Uint8Array) {
  const head = new Uint16Array([sw, sh, vw, vh, settled, 0]);           // 12-byte header
  const frame = new Uint8Array(12 + payload.length);
  frame.set(new Uint8Array(head.buffer), 0);
  frame.set(payload, 12);
  sock.send(frame);
}

function handleWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const budget = new BudgetController({ targetMs: 12 });
  let latest: CamMsg | null = null;
  let gen = 0, sentGen = -1, lastMsg = 0, open = false, idleFull = false;

  socket.onopen = () => {
    open = true;
    socket.send(JSON.stringify({ type: "hello", center, radius }));
    loop();
  };
  socket.onclose = () => { open = false; };
  socket.onerror = () => { open = false; };
  socket.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data as string) as CamMsg;
      if (m.type === "cam") { latest = m; gen++; lastMsg = performance.now(); }
    } catch { /* ignore */ }
  };

  async function loop() {
    while (open) {
      if (!latest) { await sleep(10); continue; }
      const { w, h, p, f, u, a } = latest;
      if (gen !== sentGen) {
        // MOVING: budget-scaled trace (traceSamples awaits GPU → naturally paced, no backlog)
        const s = budget.scale(w, h);
        const rw = Math.max(16, Math.round(w * s)), rh = Math.max(16, Math.round(h * s));
        scene.setCamera(p, f, u, a, rw, rh);
        const t0 = performance.now();
        const bytes = await scene.traceSamples(rw, rh);
        budget.update(performance.now() - t0);
        if (!open) break;
        sendFrame(socket, rw, rh, w, h, 0, bytes);
        sentGen = gen; idleFull = false;
      } else if (!idleFull && performance.now() - lastMsg > IDLE_MS) {
        // SETTLED: one native-resolution frame
        scene.setCamera(p, f, u, a, w, h);
        const bytes = await scene.traceSamples(w, h);
        if (!open) break;
        sendFrame(socket, w, h, w, h, 1, bytes);
        idleFull = true;
      } else {
        await sleep(8);
      }
    }
  }
  return response;
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname === "/" ? "/remote.html" : url.pathname;
  path = path.replace(/\.\.+/g, "");   // no traversal
  try {
    const body = await Deno.readFile(CLIENT_DIR + path.replace(/^\//, ""));
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(body, { headers: { "content-type": MIME[ext] ?? "application/octet-stream" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

Deno.serve({ port: PORT }, (req) => {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") return handleWs(req);
  return serveStatic(req);
});
console.log(`[live-renderer] http://localhost:${PORT}/  (serving ${CLIENT_DIR})`);
