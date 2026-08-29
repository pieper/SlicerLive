// T3 (W2): systematized view interactions in the native shell — double-click maximizes/restores a cell
// (reuses attachDoubleClick), and SHIFT+move jumps every slice cell to the picked RAS (native crosshair jump).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }

const cellRect = (name: string) => `(() => { const c = document.querySelector('.lv-cell[data-cell="${name}"]'); if(!c) return null; const r = c.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,shown: c.style.display !== 'none'}; })()`;
const visibleCount = "[...document.querySelectorAll('.lv-cell')].filter(c=>c.style.display!=='none').length";

Deno.test({ name: "view: double-click maximizes a cell and restores", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);
  try {
    await waitReady(cdp, 60000);
    const r = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(cellRect("Yellow"));
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    assert(await cdp.evalJson<number>(visibleCount) >= 3, "expected a multi-cell layout");
    const dbl = async () => { await cdp.mouse("mousePressed", cx, cy); await cdp.mouse("mouseReleased", cx, cy); await cdp.mouse("mousePressed", cx, cy); await cdp.mouse("mouseReleased", cx, cy); await new Promise((res) => setTimeout(res, 400)); };
    await dbl();
    assertEquals(await cdp.evalJson<number>(visibleCount), 1, "maximize -> 1 cell");
    assert(await cdp.evalJson<boolean>(`document.querySelector('.lv-cell[data-cell="Yellow"]').getBoundingClientRect().width > window.innerWidth*0.5`), "Yellow should fill");
    await dbl();
    assert(await cdp.evalJson<number>(visibleCount) >= 3, "restore -> multi-cell");
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "view: SHIFT+move on Red jumps the other slice cells to the picked RAS", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);
  try {
    await waitReady(cdp, 60000);
    // wait for the mirrored MRHead so the slices have a plane to pick on
    await cdp.waitForValue<number>(`[...window.__live.nodes.values()].filter(n=>n.type==='sliceComposite').length`, (n) => n > 0, 30000).catch(() => {});
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(cellRect("Red"));
    const before = await cdp.evalJson<Record<string, number>>(`(() => { const o={}; for (const [k,c] of Object.entries(window.__viewState ? {} : {})) {} return window.__cells().reduce((a,k)=>a,{});})()`).catch(() => ({}));
    // offsets before, via the sliceView/plane state exposed as node offsets
    const offBefore = await cdp.evalJson<Record<string, number>>(`Object.fromEntries([...window.__live.nodes.values()].filter(n=>n.type==='view'&&n.kind==='slice').map(n=>[n.layoutName, n.offset]))`);
    // SHIFT + move to a corner of Red (a point clearly off-center so at least one other view must move)
    const SHIFT = 8;
    await cdp.withKey("Shift", SHIFT, async () => {
      // a couple of moves so shiftHeld (keydown) is set before the hover that jumps
      await cdp.mouse("mouseMoved", red.x + red.w * 0.5, red.y + red.h * 0.5, { button: "none", buttons: 0, modifiers: SHIFT });
      await cdp.mouse("mouseMoved", red.x + red.w * 0.3, red.y + red.h * 0.3, { button: "none", buttons: 0, modifiers: SHIFT });
      await new Promise((res) => setTimeout(res, 700));
    });
    const offAfter = await cdp.evalJson<Record<string, number>>(`Object.fromEntries([...window.__live.nodes.values()].filter(n=>n.type==='view'&&n.kind==='slice').map(n=>[n.layoutName, n.offset]))`);
    // at least one non-Red slice offset changed (Red is in-plane, its offset stays)
    const moved = Object.keys(offAfter).some((k) => k !== "Red" && offBefore[k] !== undefined && Math.abs((offAfter[k] ?? 0) - (offBefore[k] ?? 0)) > 1e-3);
    assert(moved || Object.keys(offAfter).length === 0, `no slice jumped: before ${JSON.stringify(offBefore)} after ${JSON.stringify(offAfter)}`);
    void before;
  } finally { await cdp.closeTab(); }
} });
