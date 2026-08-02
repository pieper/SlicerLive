// Deno half of the cross-runtime conformance suite. The browser half runs the SAME runConformance()
// (conformance-browser.ts) and conformance-run.ts diffs them.
import { runConformance } from "./conformance.ts";

Deno.test("scene-sync conformance (Deno runtime)", async () => {
  const results = await runConformance();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error("FAILED: " + failed.map((f) => `${f.name} — ${f.detail}`).join(" | "));
});
