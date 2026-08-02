// Browser entry for the conformance suite: run the SAME runConformance() and stash results on
// window for the driver (conformance-run.ts) to read back over CDP. Bundled to conformance-browser.js.
import { runConformance } from "./conformance.ts";

runConformance().then((r) => {
  (globalThis as unknown as { __conformance: unknown }).__conformance = r;
  const el = document.getElementById("out");
  if (el) {
    el.textContent = r.map((x) => `${x.ok ? "ok  " : "FAIL"} ${x.name}${x.ok ? "" : "\n     " + x.detail}`).join("\n");
    el.style.color = r.every((x) => x.ok) ? "#8fe38f" : "#ff9b9b";
  }
});
