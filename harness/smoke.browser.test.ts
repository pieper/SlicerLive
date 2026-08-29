// T3: the app page comes up, renders, and its in-page self-tests pass. Needs a headed Chrome on :9222 and the
// demos served (SL_PAGE_BASE, default http://localhost:8130/ = `python3 -m http.server 8130` in render/demos).
// Opens its own tab and closes it. Self-ignores when Chrome is not reachable.
//   deno run -A test/run.ts --browser
import { assert } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitIdle, waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }

Deno.test({ name: "smoke: slicer-app.html renders and self-tests pass", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);
  try {
    await waitReady(cdp, 60000);
    await waitIdle(cdp);
    const frames = await cdp.evalJson<number>("window.__slicerlive.frameCount");
    assert(frames > 0, "no frames rendered");
    const report = await cdp.eval<{ pass: number; fail: number; details: { name: string; ok: boolean; detail?: string }[] }>("return await window.__slicerlive.selfTest();");
    console.log(`  self-tests: ${report.pass} pass, ${report.fail} fail`);
    assert(report.fail === 0, report.details.filter((d) => !d.ok).map((d) => `${d.name}: ${d.detail}`).join("\n"));
  } finally { await cdp.closeTab(); }
} });
