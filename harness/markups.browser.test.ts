// T3 (W4): native markups placement + measurements. Load MRHead, place a line by clicking two points in the
// Red view, verify the markup node + length measurement; place an angle (3 clicks) -> angle measurement; a
// fiducial completes in one click; delete removes it. Standalone. Needs static server + Chrome.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

const cellRect = (name: string) => `(() => { const c = document.querySelector('.lv-cell[data-cell="${name}"]'); const r = c.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`;

Deno.test({ name: "markups: place a line + angle by clicking, measurements computed, delete works", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(cellRect("Red"));
    const at = (fx: number, fy: number) => ({ x: red.x + red.w * fx, y: red.y + red.h * fy });
    const click = async (fx: number, fy: number) => { const p = at(fx, fy); await cdp.mouse("mousePressed", p.x, p.y, { button: "left", buttons: 1 }); await cdp.mouse("mouseReleased", p.x, p.y, { button: "left", buttons: 0 }); await new Promise((r) => setTimeout(r, 120)); };

    // LINE: start place, two clicks
    await cdp.eval<void>(`window.__startPlace("line", false);`);
    assertEquals(await cdp.evalJson<string>(`window.__placeState().mode`), "place");
    await click(0.35, 0.4); await click(0.65, 0.6);
    await cdp.eval<void>(`await window.__slicerlive.idle();`);
    const afterLine = await cdp.evalJson<{ markupType: string; points: number; measurements: { name: string; value: number }[] }[]>(`window.__markups()`);
    assertEquals(afterLine.length, 1, "one markup");
    assertEquals(afterLine[0].markupType, "line");
    assertEquals(afterLine[0].points, 2, "line has 2 points");
    assert(afterLine[0].measurements.some((m) => m.name === "length" && m.value > 0), "line length measured > 0");
    // place mode ended (non-persistent)
    assertEquals(await cdp.evalJson<string>(`window.__placeState().mode`), "viewTransform", "place mode ended after line");

    // ANGLE: 3 clicks
    await cdp.eval<void>(`window.__startPlace("angle", false);`);
    await click(0.3, 0.7); await click(0.5, 0.5); await click(0.7, 0.7);
    await cdp.eval<void>(`await window.__slicerlive.idle();`);
    const list = await cdp.evalJson<{ id: string; markupType: string; points: number; measurements: { name: string; value: number }[] }[]>(`window.__markups()`);
    const angle = list.find((m) => m.markupType === "angle")!;
    assert(angle && angle.points === 3, "angle has 3 points");
    assert(angle.measurements.some((m) => m.name === "angle" && m.value > 0 && m.value < 180), `angle measured, got ${JSON.stringify(angle.measurements)}`);

    // FIDUCIAL completes in one click (persistent off)
    await cdp.eval<void>(`window.__startPlace("fiducial", false);`);
    await click(0.5, 0.3);
    await cdp.eval<void>(`await window.__slicerlive.idle();`);
    assert((await cdp.evalJson<unknown[]>(`window.__markups()`)).length === 3, "3 markups (line, angle, fiducial)");

    // delete the line
    await cdp.eval<void>(`const l = window.__markups().find(m=>m.markupType==='line'); window.__deleteMarkup(l.id);`);
    assert(!(await cdp.evalJson<{ markupType: string }[]>(`window.__markups()`)).some((m) => m.markupType === "line"), "line deleted");
  } finally { await cdp.closeTab(); }
} });
