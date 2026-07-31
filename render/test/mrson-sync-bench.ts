// mrson sync bench — an instrumented test suite for the SlicerLive <-> Slicer event exchange.
//
// It drives the interactive sequences (control-point drag, camera move, window/level) the same
// way the browser does, and measures each hop so we can see WHERE latency lives and whether the
// two scenes actually stay in sync:
//
//   transport   = POST round-trip minus the server's self-reported work (the wire + HTTP cost)
//   applyMs     = time in the MRML apply loop        (server-reported)
//   eventsMs    = time in slicer.app.processEvents()  (server-reported: render + observer fan-out)
//   echoMs      = op send -> the matching change echoed back over the WebSocket (full round-trip)
//
// It also stress-tests the two failure modes the impedance-matching layer must handle:
//   - sustained throughput: how many ops/s the channel really sustains (sequential)
//   - backpressure: fire-and-forget at 60Hz -> does the echo fall behind (queue buildup)?
// and asserts FINAL CONSISTENCY (Slicer's actual value == the last value we sent) via MCP.
//
// Run:  deno run --allow-net render/test/mrson-sync-bench.ts
//        [--ws ws://localhost:2132/] [--http http://localhost:2131/mrson/] [--mcp http://localhost:2130/mcp]
//        [--only 1,2,3] [--transport http|ws]
//
// Transport 'ws' exercises the unified-channel path (ops over the live WebSocket); 'http' is the
// current per-op POST path. Defaults to http.

import { Coalescer } from "../rate-limiter.ts";

type Json = Record<string, unknown>;

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i++) {
  const a = Deno.args[i];
  if (a.startsWith("--")) args.set(a.slice(2), Deno.args[i + 1] ?? "");
}
const WS = args.get("ws") ?? "ws://localhost:2132/";
const HTTP = args.get("http") ?? "http://localhost:2131/mrson/";
const MCP = args.get("mcp") ?? "http://localhost:2130/mcp";
const TRANSPORT = (args.get("transport") ?? "http") as "http" | "ws";
const ONLY = (args.get("only") ?? "1,2,3,4,5,6").split(",").map((s) => s.trim());

// ── tiny stats ────────────────────────────────────────────────────────────────
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
function statLine(name: string, xs: number[]) {
  console.log(
    `  ${name.padEnd(22)} n=${String(xs.length).padStart(3)}  ` +
      `mean=${f(mean(xs)).padStart(7)}  p50=${f(pct(xs, 50)).padStart(7)}  ` +
      `p95=${f(pct(xs, 95)).padStart(7)}  max=${f(Math.max(...xs)).padStart(7)}  (ms)`,
  );
}

// ── MCP (drive / read Slicer directly) ──────────────────────────────────────────
// Shells out to `curl`: Deno's fetch sends POST bodies chunked (no Content-Length), which the
// Slicer WebServer body reader ignores — the very fragility that motivates moving ops off HTTP.
// curl sends Content-Length, so the MCP call actually runs.
async function mcp(code: string): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "execute_python", arguments: { code } },
  });
  const cmd = new Deno.Command("curl", { args: ["-s", "-m", "30", MCP, "-H", "Content-Type: application/json", "-d", body], stdout: "piped" });
  const { stdout } = await cmd.output();
  const j = JSON.parse(new TextDecoder().decode(stdout));
  return j?.result?.content?.[0]?.text ?? JSON.stringify(j);
}

// ── the live WebSocket: subscribe + timestamp every inbound event ────────────────
interface Rec { t: number; ev: Json }
class Live {
  ws!: WebSocket;
  recs: Rec[] = [];
  onEcho?: (ev: Json, t: number) => void;
  private opId = 0;
  private acks = new Map<number, (r: Json) => void>();

  connect(types: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS);
      this.ws.onopen = () => { this.ws.send(JSON.stringify({ op: "subscribe", types })); resolve(); };
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (m) => {
        const t = performance.now();
        const ev = JSON.parse(m.data as string) as Json;
        if (ev.event === "OpAck") { this.acks.get(ev.tag as number)?.(ev); return; }
        this.recs.push({ t, ev });
        this.onEcho?.(ev, t);
      };
    });
  }
  // send ops over the WS (unified channel path). Resolves on OpAck (server applied).
  sendWs(ops: Json[]): Promise<Json> {
    const tag = ++this.opId;
    for (const o of ops) o.tag = tag;
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.acks.set(tag, (r) => {
        const postMs = performance.now() - t0;
        r._postMs = postMs;
        r._transportMs = postMs - ((r.applyMs as number) ?? 0) - ((r.eventsMs as number) ?? 0);
        resolve(r);
      });
      this.ws.send(JSON.stringify({ op: "applyOps", ops, tag }));
    });
  }
  // fire ops over the WS without waiting for the ack (for coalescer flushes).
  fire(ops: Json[]) { this.ws.send(JSON.stringify({ op: "applyOps", ops })); }
  close() { this.ws.close(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── op senders (both transports share this shape) ───────────────────────────────
let seq = 0;
async function sendOp(live: Live, op: Json): Promise<Json> {
  const tag = ++seq;
  op.tag = tag;
  if (TRANSPORT === "ws") return await live.sendWs([op]);
  const t0 = performance.now();
  const r = await fetch(new URL("ops", HTTP).href, { method: "POST", body: JSON.stringify([op]) });
  const postMs = performance.now() - t0;
  const j = (await r.json()) as Json;
  j._postMs = postMs;
  j._transportMs = postMs - ((j.applyMs as number) ?? 0) - ((j.eventsMs as number) ?? 0);
  return j;
}

const cpOp = (id: string, index: number, pos: number[]): Json => ({ op: "cmd", id, cmd: "setControlPoint", args: { index, position: pos } });

// find a fiducial to drive (single control point)
async function fiducialId(): Promise<string> {
  const r = await fetch(new URL("scene.json", HTTP).href);
  const doc = (await r.json()) as { nodes: Record<string, Json> };
  for (const [nid, n] of Object.entries(doc.nodes ?? {})) {
    if (n.type === "markup" && n.markupType === "fiducial") return nid;
  }
  throw new Error("no fiducial in scene (create one named F)");
}

// ── main ────────────────────────────────────────────────────────────────────────
const live = new Live();
await live.connect(["markup", "camera"]);
await new Promise((r) => setTimeout(r, 300)); // drain snapshot
const fid = await fiducialId();
console.log(`\nmrson sync bench — transport=${TRANSPORT}  fiducial=${fid}\n`);

// helper: wait until the markup echo shows control-point x within tol of target (returns recv time)
function waitEchoX(targetX: number, tol = 0.5, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = (ev: Json, t: number): boolean => {
      if (ev.event !== "NodeAdded") return false;
      const node = ev.node as Json | undefined;
      if (!node || node.type !== "markup" || node.id !== fid) return false;
      const cps = node.controlPoints as { position: number[] }[] | undefined;
      const x = cps?.[0]?.position?.[0];
      // monotonic sequence: the coalesced echo carries the LATEST value, so x >= target means this
      // op's state reached the wire (possibly merged with a newer op) — a valid round-trip sample.
      if (x !== undefined && x >= targetX - tol) return true;
      return false;
    };
    // scan any already-buffered echoes first
    for (let i = live.recs.length - 1; i >= 0 && live.recs[i].t >= started - 5; i--) {
      if (check(live.recs[i].ev, live.recs[i].t)) return resolve(live.recs[i].t);
    }
    const prev = live.onEcho;
    let timer = 0;
    live.onEcho = (ev, t) => { prev?.(ev, t); if (check(ev, t)) { live.onEcho = prev; clearTimeout(timer); resolve(t); } };
    timer = setTimeout(() => { live.onEcho = prev; reject(new Error(`echo timeout x=${targetX}`)); }, timeoutMs) as unknown as number;
  });
}

async function slicerFiducialX(): Promise<number> {
  const t = await mcp(
    `import json\nn=slicer.mrmlScene.GetNodeByID("${fid}")\nq=[0,0,0]\nn.GetNthControlPointPositionWorld(0,q)\n__result=json.dumps(q[0])`,
  );
  return JSON.parse(t);
}

// ═══ Sequence 1: single-op round trip (spaced, no overlap) ═══════════════════════
if (ONLY.includes("1")) {
  console.log("[1] single control-point op — round trip, spaced 120ms\n");
  const N = 25;
  const transport: number[] = [], apply: number[] = [], events: number[] = [], round: number[] = [];
  for (let i = 0; i < N; i++) {
    const x = 400 + i * 3;
    const t0 = performance.now();
    const echoP = waitEchoX(x);
    const resp = await sendOp(live, cpOp(fid, 0, [x, 0, 200]));
    const echoT = await echoP;
    round.push(echoT - t0);
    if (resp._transportMs !== undefined) transport.push(resp._transportMs as number);
    if (resp.applyMs !== undefined) apply.push(resp.applyMs as number);
    if (resp.eventsMs !== undefined) events.push(resp.eventsMs as number);
    await new Promise((r) => setTimeout(r, 120));
  }
  if (transport.length) statLine("transport (wire)", transport);
  if (apply.length) statLine("applyMs (MRML)", apply);
  if (events.length) statLine("eventsMs (processEvents)", events);
  statLine("round-trip (echo)", round);
  console.log("");
}

// ═══ Sequence 2: sustained throughput — sequential drag (await each) ══════════════
if (ONLY.includes("2")) {
  console.log("[2] sustained drag — 120 ops sequential (await each), reports ops/s\n");
  const N = 120;
  const per: number[] = [];
  const start = performance.now();
  let lastX = 0;
  for (let i = 0; i < N; i++) {
    const x = 500 + i * 0.7;
    lastX = x;
    const t0 = performance.now();
    await sendOp(live, cpOp(fid, 0, [x, 0, 200]));
    per.push(performance.now() - t0);
  }
  const wall = performance.now() - start;
  statLine("per-op send", per);
  console.log(`  wall=${f(wall)}ms  ->  ${(N / (wall / 1000)).toFixed(0)} ops/s sustained`);
  // settle + consistency
  await new Promise((r) => setTimeout(r, 400));
  const sx = await slicerFiducialX();
  console.log(`  final: sent x=${f(lastX)}  slicer x=${f(sx)}  ${Math.abs(sx - lastX) < 0.6 ? "CONSISTENT" : "MISMATCH ***"}\n`);
}

// ═══ Sequence 3: backpressure — fire at 60Hz WITHOUT awaiting ═════════════════════
if (ONLY.includes("3")) {
  console.log("[3] backpressure — fire 90 ops at ~60Hz without awaiting; watch echo lag\n");
  const N = 90, dtMs = 16;
  const sendT = new Map<number, number>();   // seq -> send time
  const echoLag: number[] = [];
  let received = 0, rawEchoes = 0, lastX = 0;
  const prev = live.onEcho;
  live.onEcho = (ev, t) => {
    prev?.(ev, t);
    if (ev.event !== "NodeAdded") return;
    const node = ev.node as Json | undefined;
    if (node?.id !== fid) return;
    const x = (node?.controlPoints as { position: number[] }[] | undefined)?.[0]?.position?.[0];
    if (x === undefined) return;
    rawEchoes++;
    const k = Math.round((x - 700) / 0.5);   // decode seq from x
    const st = sendT.get(k);
    if (st !== undefined) { echoLag.push(t - st); received++; }
  };
  const start = performance.now();
  for (let i = 0; i < N; i++) {
    const x = 700 + i * 0.5;
    lastX = x;
    sendT.set(i, performance.now());
    // fire-and-forget (do not await) — the impedance mismatch shows up as growing echo lag
    sendOp(live, cpOp(fid, 0, [x, 0, 200])).catch(() => {});
    await new Promise((r) => setTimeout(r, dtMs));
  }
  await new Promise((r) => setTimeout(r, 1500)); // let echoes drain
  live.onEcho = prev;
  console.log(`  sent=${N}  rawMarkupEchoes=${rawEchoes}  matched=${received}  (${((rawEchoes / N) * 100).toFixed(0)}% echoed back)`);
  if (echoLag.length) {
    statLine("echo lag (send->echo)", echoLag);
    // lag GROWTH: first third vs last third — growth => queue buildup (bad)
    const third = Math.floor(echoLag.length / 3);
    if (third > 0) console.log(`  lag drift: first-third mean=${f(mean(echoLag.slice(0, third)))}  last-third mean=${f(mean(echoLag.slice(-third)))}  (rising = queue buildup)`);
  }
  await new Promise((r) => setTimeout(r, 400));
  const sx = await slicerFiducialX();
  console.log(`  final: sent x=${f(lastX)}  slicer x=${f(sx)}  ${Math.abs(sx - lastX) < 0.6 ? "CONSISTENT" : "MISMATCH ***"}\n`);
}

// ═══ Sequence 4: Slicer -> client flood (high-rate source, e.g. a sensor) ═════════
if (ONLY.includes("4")) {
  console.log("[4] Slicer->client flood — Slicer moves the point 100x rapidly; count echoes delivered\n");
  const before = live.recs.length;
  const t0 = performance.now();
  await mcp(
    `import time\nn=slicer.mrmlScene.GetNodeByID("${fid}")\n` +
      `for i in range(100):\n  n.SetNthControlPointPositionWorld(0, 300+i*0.5, 0, 200)\n  slicer.app.processEvents()\n__result="done"`,
  );
  await new Promise((r) => setTimeout(r, 600));
  const delivered = live.recs.filter((r) => r.t > t0 - 5 && (r.ev.node as Json | undefined)?.type === "markup").length;
  const wall = performance.now() - t0;
  console.log(`  Slicer emitted 100 modifies in ${f(wall)}ms; client received ${delivered} markup echoes`);
  console.log(`  -> ${delivered >= 90 ? "NO rate-limiting Slicer->client (floods the wire)" : "some coalescing"}  (before=${before})\n`);
}

// ═══ Sequence 5: end-to-end consistency across mixed ops ══════════════════════════
if (ONLY.includes("5")) {
  console.log("[5] consistency — random control-point moves, verify Slicer matches last-sent\n");
  let lastX = 0, ok = true;
  for (let i = 0; i < 10; i++) {
    const x = 350 + Math.floor(Math.abs(Math.sin(i * 1.3)) * 120);
    lastX = x;
    await sendOp(live, cpOp(fid, 0, [x, 0, 200]));
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 400));
  const sx = await slicerFiducialX();
  ok = Math.abs(sx - lastX) < 0.6;
  console.log(`  final: sent x=${f(lastX)}  slicer x=${f(sx)}  ${ok ? "CONSISTENT" : "MISMATCH ***"}\n`);
}

// ═══ Sequence 6: OUTBOUND coalescing — fast producer through the Coalescer ════════
if (ONLY.includes("6")) {
  console.log("[6] outbound impedance match — 120 producer updates @60Hz -> Coalescer(33ms) -> wire\n");
  const N = 120;
  let wireSends = 0, lastX = 0;
  const coal = new Coalescer<Json>(33, (batch) => { wireSends++; live.fire([...batch.values()]); });
  for (let i = 0; i < N; i++) {
    const x = 800 + i * 0.3; lastX = x;
    coal.update(`cp:${fid}:0`, cpOp(fid, 0, [x, 0, 200])); // producer rate (local feedback would be here)
    await sleep(16);
  }
  coal.flushNow();               // authoritative final
  await sleep(400);
  console.log(`  producer updates=${N}  wire sends=${wireSends}  -> coalesced ${(100 - (wireSends / N) * 100).toFixed(0)}% (target ~30Hz)`);
  const sx = await slicerFiducialX();
  console.log(`  final: sent x=${f(lastX)}  slicer x=${f(sx)}  ${Math.abs(sx - lastX) < 0.6 ? "CONSISTENT" : "MISMATCH ***"}\n`);
}

live.close();
console.log("done.\n");
Deno.exit(0);
