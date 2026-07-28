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
import { loadSceneVolumeField } from "../render/scene-volume.ts";
import { BudgetController } from "../render/budget-controller.ts";
import type { Vec3 } from "../render/mat4.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8787);
// The REAL volume rendered remotely — the point of remote rendering is data too big for the browser.
const SCENE_URL = Deno.env.get("SCENE") ?? "https://pieper.github.io/live/scenes/CTACardio.json";
// Self-contained client (page + bundle) served by this server — kept out of the public gallery since
// it needs the local server running. Build with:
//   deno run -A npm:esbuild render/demos/remote-browser.ts --bundle --format=esm --outfile=server/client/remote.js
const CLIENT_DIR = Deno.env.get("CLIENT_DIR") ?? new URL("./client/", import.meta.url).pathname;
const IDLE_MS = 80;                          // after this long with no camera update, send one native frame
const COMPRESS = (Deno.env.get("COMPRESS") ?? "1") !== "0";   // gzip the rgba8 samples (M5 rung 1)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// gzip a byte buffer (CompressionStream). The premultiplied rgba8 trace is very compressible (large
// transparent background). M5 note: a delta-across-lattice/time codec or a small autoencoder tuned to
// this sparse-sample pattern would beat generic gzip — left as the next compression rung.
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---- one shared headless renderer + REAL scene (single-user localhost; per-session isolation is later) ----
const gpu = await initDevice();
const scene = new SceneRenderer(gpu, "rgba8unorm");
let mb = 0;
console.log(`[live-renderer] loading ${SCENE_URL} …`);
const sv = await loadSceneVolumeField(gpu.device, SCENE_URL, (n) => { mb += n; });
scene.build([sv.field]);
scene.setBackground(0.05, 0.06, 0.09);
const center = sv.center;
const radius = sv.radius;
const sceneName = sv.name;
console.log(`[live-renderer] scene "${sceneName}" ready — ${sv.dims.join("×")} · ${(mb / 1e6).toFixed(0)} MB · center ${center.map((v) => v.toFixed(0))} radius ${radius.toFixed(0)}`);

interface CamMsg { type: "cam"; w: number; h: number; p: Vec3; f: Vec3; u: Vec3; a: number }

function sendFrame(sock: WebSocket, sw: number, sh: number, vw: number, vh: number, settled: number, compressed: number, payload: Uint8Array) {
  const head = new Uint16Array([sw, sh, vw, vh, settled, compressed]);   // 12-byte header
  const frame = new Uint8Array(12 + payload.length);
  frame.set(new Uint8Array(head.buffer), 0);
  frame.set(payload, 12);
  sock.send(frame);
}

function handleWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  // Budget targets an END-TO-END frame period (render + transport), so on a constrained link the
  // bytes cost of a bigger frame shows up as a slower ack and the resolution shrinks. On localhost
  // transport ≈ 0 so it tracks render time. (M4: bandwidth+latency-driven, per the plan.)
  const budget = new BudgetController({ targetMs: 33, startPx: 3e6 });
  let latest: CamMsg | null = null;
  let gen = 0, sentGen = -1, lastMsg = 0, open = false, idleFull = false;

  // Ack-based credit: one frame in flight. The client acks each presented frame; send→ack is the
  // transport cost. This drop-to-latest paces the server to the link's real capacity (Python spike §3).
  let ackResolve: (() => void) | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const gotAck = () => { if (ackResolve) { clearTimeout(ackTimer); const r = ackResolve; ackResolve = null; r(); } };
  const waitAck = (ms: number) => new Promise<void>((res) => { ackResolve = res; ackTimer = setTimeout(() => { ackResolve = null; res(); }, ms); });

  socket.onopen = () => {
    open = true;
    socket.send(JSON.stringify({ type: "hello", center, radius, name: sceneName, sceneUrl: SCENE_URL }));
    loop();
  };
  socket.onclose = () => { open = false; gotAck(); };
  socket.onerror = () => { open = false; gotAck(); };
  socket.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data as string) as { type: string } & CamMsg;
      if (m.type === "cam") { latest = m; gen++; lastMsg = performance.now(); }
      else if (m.type === "ack") gotAck();
    } catch { /* ignore */ }
  };

  async function loop() {
    while (open) {
      if (!latest) { await sleep(10); continue; }
      const { w, h, p, f, u, a } = latest;
      let sw: number, sh: number, settled: number;
      if (gen !== sentGen) {
        const s = budget.scale(w, h);
        sw = Math.max(16, Math.round(w * s)); sh = Math.max(16, Math.round(h * s)); settled = 0;
      } else if (!idleFull && performance.now() - lastMsg > IDLE_MS) {
        sw = w; sh = h; settled = 1;
      } else { await sleep(8); continue; }

      scene.setCamera(p, f, u, a, sw, sh);
      const t0 = performance.now();
      const bytes = await scene.traceSamples(sw, sh);
      const payload = COMPRESS ? await gzip(bytes) : bytes;
      if (!open) break;
      sendFrame(socket, sw, sh, w, h, settled, COMPRESS ? 1 : 0, payload);
      await waitAck(500);                                  // transport: wait for the client to present
      if (!settled) budget.update(performance.now() - t0); // render + transport → the end-to-end cost
      if (settled) idleFull = true; else { sentGen = gen; idleFull = false; }
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
