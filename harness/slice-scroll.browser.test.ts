// T3 (#2): wheel stack-scroll steps by the spacing along the slice normal and keeps the native slice node in
// sync (before: step() patched only #/offset, the DM re-pushed the stale sliceToRAS, and the plane snapped
// back -> jitter, worst on MRHead's 1.3mm sagittal axis). Standalone. Needs static server + Chrome.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "stack scroll: steps by the normal spacing and stays synced (no jitter, fix #2)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    // MRHead is a sagittal acquisition: sagittal (Yellow) steps 1.3mm, axial/coronal step 1.0mm
    for (const [cell, expectStep] of [["Yellow", 1.3], ["Red", 1.0], ["Green", 1.0]] as const) {
      const r = await cdp.evalJson<{ x: number; y: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="${cell}"]'); const b = c.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2}; })()`);
      const step = await cdp.evalJson<number>(`window.__views.sliceOffsetRange("${cell}").step`);
      assertAlmostEquals(step, expectStep, 0.05, `${cell} slice step`);
      const off0 = await cdp.evalJson<number>(`window.__cellPlanes()["${cell}"]`);
      for (let i = 0; i < 4; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: r.x, y: r.y, deltaX: 0, deltaY: -120, modifiers: 0 }); await new Promise((res) => setTimeout(res, 50)); }
      await cdp.eval<void>(`await window.__slicerlive.idle();`); await new Promise((res) => setTimeout(res, 250));
      const local = await cdp.evalJson<number>(`window.__cellPlanes()["${cell}"]`);
      const node = await cdp.evalJson<number>(`window.__sliceNode("${cell}").offset`);
      console.log(`  ${cell}: step ${step.toFixed(2)} moved ${(local - off0).toFixed(2)} (expect ${(-4 * step).toFixed(2)}); synced=${Math.abs(local - node) < 1e-6}`);
      assertAlmostEquals(local - off0, -4 * step, 0.05, `${cell} moved exactly 4 slices`);
      assertAlmostEquals(local, node, 1e-6, `${cell} local plane stays synced with the native node (no snap-back)`);
    }
  } finally { await cdp.closeTab(); }
} });
