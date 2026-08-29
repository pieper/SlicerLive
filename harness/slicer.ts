// The ONE Slicer client for tests (T4 parity, fixture capture): execute Python in the running Slicer over
// its MCP server and get the JSON `__result` back. Port from SL_MCP (default the ModuleServer's :2126 —
// docs/HARNESS.md). Uses curl rather than fetch: Deno's fetch POSTs a chunked body (no Content-Length)
// that Slicer's WebServer-based MCP handler reads as EMPTY (known trap, see mrson-sync-bench notes).

export const SL_MCP = Deno.env.get("SL_MCP") ?? "http://localhost:2126/mcp";

let mid = 1000;
/** Run `code` in Slicer's Python. Set `__result` to whatever you want back (JSON-serialisable or a repr'd string). */
export async function executePython(code: string, timeoutS = 60): Promise<string> {
  const req = JSON.stringify({ jsonrpc: "2.0", id: ++mid, method: "tools/call", params: { name: "execute_python", arguments: { code } } });
  const out = await new Deno.Command("curl", { args: ["-s", "-m", String(timeoutS), "-X", "POST", SL_MCP, "-H", "content-type: application/json", "-d", req], stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout);
  if (!text) throw new Error(`Slicer MCP at ${SL_MCP} did not answer (is a ModuleServer running?)`);
  const parsed = JSON.parse(text);
  if (parsed.error || !parsed.result) throw new Error("MCP error: " + JSON.stringify(parsed).slice(0, 300));
  const r = parsed.result.content?.[0]?.text ?? "";
  if (parsed.result.isError || /^Error:|Traceback \(most recent call last\)/.test(r)) throw new Error("Slicer python error: " + r.slice(0, 600));
  return r;
}

/** Evaluate a Python expression and parse it as JSON (wrap with json.dumps on the Python side). */
export async function pyJson<T = unknown>(expr: string, prelude = "import slicer, json"): Promise<T> {
  const text = await executePython(`${prelude}\n__result = json.dumps(${expr})`);
  return JSON.parse(text) as T;
}

/** Is a Slicer reachable? Tests use this to `ignore` themselves cleanly instead of failing. */
export async function slicerAvailable(): Promise<boolean> {
  try { return (await executePython("__result = 'ok'", 5)).includes("ok"); } catch { return false; }
}
