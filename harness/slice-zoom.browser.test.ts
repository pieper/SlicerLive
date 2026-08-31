// T3 (#3): zooming a reformatted (anisotropic) slice view must not snap to a different zoom when the
// interactive zoom is committed to the slice node and read back. MRHead is a sagittal acquisition (k=R at
// 1.3mm), so axial (Red) and coronal (Green) are anisotropic reformats where the old min/max FOV mismatch
// showed. Standalone. Needs static server + Chrome.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "slice zoom: interactive zoom survives the settle without snapping (fix #3)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    for (const cell of ["Red", "Green", "Yellow"]) {
      const r = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="${cell}"]'); const b = c.getBoundingClientRect(); return {x:b.left,y:b.top,w:b.width,h:b.height}; })()`);
      for (let i = 0; i < 6; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: r.x + r.w / 2, y: r.y + r.h / 2, deltaX: 0, deltaY: -120, modifiers: 2 }); await new Promise((res) => setTimeout(res, 20)); }
      await new Promise((res) => setTimeout(res, 60));
      const during = await cdp.evalJson<number>(`window.__sliceZoom("${cell}")`);
      assert(during > 1.2, `${cell} actually zoomed in (${during})`);
      await cdp.eval<void>(`await new Promise(r=>setTimeout(r,500)); await window.__slicerlive.idle();`);
      const after = await cdp.evalJson<number>(`window.__sliceZoom("${cell}")`);
      console.log(`  ${cell}: zoom during ${during?.toFixed(3)} -> after settle ${after?.toFixed(3)}`);
      assertAlmostEquals(after, during, during * 0.01 + 1e-3, `${cell} zoom must not snap`);
    }
  } finally { await cdp.closeTab(); }
} });
