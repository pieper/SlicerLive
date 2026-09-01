// T3 (browser, network-gated): the SDF-text "label cards" demo end-to-end on a real KiTS case from IDC.
// Verifies the whole pipeline — load → segmentation scene → per-segment centroid anchors → cards with
// name + coded terminology. The pixel rendering (SDF text/cards/leader lines) is verified visually via a
// screenshot during development; this guards the data path. Needs headed Chrome :9222 + static server;
// SL_NET=1 to hit the IDC bucket.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const net = Deno.env.get("SL_NET") === "1";

Deno.test({ name: "label cards: KiTS case loads with Kidney+Mass cards and coded terminology", ignore: !chrome || !net, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}cards.html`);
  try {
    const status = await cdp.waitForValue<string>(`document.getElementById('status')?.textContent || ''`, (t) => /drag to orbit|error|no segmentation/.test(t), 120000);
    assert(/drag to orbit/.test(status), `demo reached ready state (got: ${status})`);
    const info = await cdp.evalJson<{ count: number; titles: string[]; bodies: (string | null)[] }>(`window.__cards`);
    assertEquals(info.count, 2, "two segments → two cards");
    assert(info.titles.includes("Kidney") && info.titles.includes("Mass"), `names present (${JSON.stringify(info.titles)})`);
    assert(info.bodies.every((b) => typeof b === "string" && b.length > 0), `coded terminology present on every card (${JSON.stringify(info.bodies)})`);
  } finally { await cdp.closeTab(); }
} });
