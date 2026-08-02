// Conformance DRIVER: run the SAME scene-sync conformance suite in Deno AND in a real browser (over
// CDP), then diff — they must be identical (ARCHITECTURE-2026-08-02 §4: test-driven replicability
// across the Deno and browser instantiations). Requires headed Chrome on :9222 (the harness Chrome).
//
//   deno run -A render/test/conformance-run.ts        # from the SlicerLive repo root
//
// Exit 0 iff every scenario passes in BOTH runtimes and the two agree per-scenario.

import { type ConfResult, runConformance } from "./conformance.ts";

const CDP = "http://localhost:9222";
const PORT = 8131;
const ROOT = "render/test";

// 1) Deno run
const denoResults = await runConformance();

// 2) bundle the browser entry
const bundle = new Deno.Command("deno", {
  args: ["run", "-A", "npm:esbuild", `${ROOT}/conformance-browser.ts`, "--bundle", "--format=esm", `--outfile=${ROOT}/conformance-browser.js`],
}).outputSync();
if (!bundle.success) { console.error("esbuild bundling failed:\n" + new TextDecoder().decode(bundle.stderr)); Deno.exit(2); }

// 3) serve render/test (conformance.html + the bundle)
const ac = new AbortController();
const server = Deno.serve({ port: PORT, signal: ac.signal, onListen() {} }, async (req) => {
  const file = new URL(req.url).pathname === "/" ? "/conformance.html" : new URL(req.url).pathname;
  try {
    const body = await Deno.readFile(ROOT + file);
    const ct = file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : "text/plain";
    return new Response(body, { headers: { "content-type": ct } });
  } catch { return new Response("not found", { status: 404 }); }
});

// 4) drive Chrome: open a fresh tab, read window.__conformance
async function browserRun(): Promise<ConfResult[]> {
  const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`http://localhost:${PORT}/`)}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
  await new Promise((r) => ws.onopen = () => r(null));
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: { result?: { value?: string } } }>((res) => { const i = ++id; pending.set(i, res as (v: unknown) => void); ws.send(JSON.stringify({ id: i, method, params })); });
  let out: ConfResult[] | null = null;
  for (let i = 0; i < 60 && !out; i++) {
    const r = await call("Runtime.evaluate", { expression: "JSON.stringify(window.__conformance ?? null)", returnByValue: true });
    const v = r.result?.result?.value;
    if (v && v !== "null") out = JSON.parse(v);
    else await new Promise((r) => setTimeout(r, 100));
  }
  await call("Page.close").catch(() => {});
  ws.close();
  if (!out) throw new Error("browser did not report results within timeout");
  return out;
}

let browserResults: ConfResult[] = [];
let browserErr = "";
try { browserResults = await browserRun(); } catch (e) { browserErr = String(e); }
ac.abort();
await server.finished.catch(() => {});

// 5) diff + report
console.log("\n  " + "scenario".padEnd(62) + "deno   browser");
console.log("  " + "-".repeat(76));
let fail = 0;
for (const d of denoResults) {
  const b = browserResults.find((r) => r.name === d.name);
  const agree = b !== undefined && b.ok === d.ok;
  if (!d.ok || !b?.ok || !agree) fail++;
  const line = "  " + d.name.slice(0, 60).padEnd(62) +
    (d.ok ? "ok " : "FAIL") + "    " + (b ? (b.ok ? "ok " : "FAIL") : " — ") + (agree ? "" : "   <-- MISMATCH");
  console.log(line);
  if (!d.ok) console.log("       deno: " + d.detail);
  if (b && !b.ok) console.log("       browser: " + b.detail);
}
const dp = denoResults.filter((r) => r.ok).length, bp = browserResults.filter((r) => r.ok).length;
console.log("\n  Deno " + dp + "/" + denoResults.length + ", Browser " + bp + "/" + browserResults.length + (browserErr ? "   (browser error: " + browserErr + ")" : ""));
if (fail || browserErr) { console.log("  ❌ CONFORMANCE FAILED\n"); Deno.exit(1); }
console.log("  ✅ CONFORMANCE PASSED — identical across Deno and browser\n");
