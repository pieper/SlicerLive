import { assert } from "jsr:@std/assert@1";
import { startMockServer } from "../mock/server.ts";
import { runProtocolConformance } from "./protocol.ts";

Deno.test("protocol conformance: mock (non-Slicer) ModuleServer", async () => {
  const s = startMockServer(2149);
  try {
    const res = await runProtocolConformance("ws://127.0.0.1:2149/");
    const failed = res.filter((r) => !r.ok);
    assert(failed.length === 0, "FAILED: " + failed.map((f) => `${f.name} — ${f.detail}`).join(" | "));
  } finally { s.close(); }
});

Deno.test({ name: "protocol conformance: Slicer ModuleServer peer (skipped if not running)", async fn() {
  try { const r = await fetch("http://localhost:2131/mrson/state.json", { signal: AbortSignal.timeout(1500) }); if (!r.ok) return; } catch { console.log("  (no Slicer peer on :2131 — skipped)"); return; }
  const res = await runProtocolConformance("ws://localhost:2132/");
  const failed = res.filter((r) => !r.ok);
  assert(failed.length === 0, "FAILED: " + failed.map((f) => `${f.name} — ${f.detail}`).join(" | "));
}, sanitizeResources: false, sanitizeOps: false });
