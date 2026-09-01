// T3 (browser, network-gated): the SDF-text "label cards" demo end-to-end on a real KiTS case from IDC.
// Verifies the whole pipeline — load → segmentation scene → per-segment centroid anchors → cards with
// name + coded terminology + stats, and the expand→button interaction (hit-testing). The pixel rendering
// (SDF text / ground-glass / leader lines) is verified visually via screenshots during development; this
// guards the data + interaction paths. Needs headed Chrome :9222 + static server; SL_NET=1 hits IDC.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const net = Deno.env.get("SL_NET") === "1";

Deno.test({ name: "label cards: KiTS case → Kidney+Mass cards, terminology, stats, expand+isolate", ignore: !chrome || !net, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}cards.html`);
  try {
    const status = await cdp.waitForValue<string>(`document.getElementById('status')?.textContent || ''`, (t) => /details|error|no segmentation/.test(t), 120000);
    assert(/details/.test(status), `demo reached ready state (got: ${status})`);
    const info = await cdp.evalJson<{ count: number; titles: string[]; bodies: (string | null)[]; stats: ({ voxels: number; volumeCc: number; hu?: { mean: number; std: number } } | undefined)[] }>(`window.__cards`);
    assertEquals(info.count, 2, "two segments → two cards");
    assert(info.titles.includes("Kidney") && info.titles.includes("Mass"), `names present (${JSON.stringify(info.titles)})`);
    assert(info.bodies.every((b) => typeof b === "string" && b.length > 0), `coded terminology present (${JSON.stringify(info.bodies)})`);
    assert(info.stats.every((s) => s && s.voxels > 0 && s.volumeCc > 0 && s.hu && Number.isFinite(s.hu.mean)), "per-segment voxels/volume/HU computed");
    // expand card 0, then the Isolate button must be hit-testable and dispatch "isolate"
    await cdp.eval<void>(`(() => { const c = window.__cards.cardCenter(0); return window.__cards.click(c.x, c.y); })()`);
    await new Promise((r) => setTimeout(r, 200));
    const iso = await cdp.evalJson<{ index: number; action: string } | null>(`(() => { const b = window.__cards.buttonCenter(0, "isolate"); return b ? window.__cards.click(b.x, b.y) : null; })()`);
    assertEquals(iso?.action, "isolate", "Isolate button hit-tests + dispatches after expand");
  } finally { await cdp.closeTab(); }
} });
