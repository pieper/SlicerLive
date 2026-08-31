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

Deno.test({ name: "markups: closed curve interpolates a smooth spline + area measurement", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(cellRect("Red"));
    const click = async (fx: number, fy: number) => { const x = red.x + red.w * fx, y = red.y + red.h * fy; await cdp.mouse("mousePressed", x, y, { button: "left", buttons: 1 }); await cdp.mouse("mouseReleased", x, y, { button: "left", buttons: 0 }); await new Promise((r) => setTimeout(r, 120)); };
    await cdp.eval<void>(`window.__startPlace("closedCurve", false);`);
    await click(0.35, 0.35); await click(0.65, 0.35); await click(0.65, 0.65); await click(0.35, 0.65);
    await cdp.eval<void>(`window.__endPlace(); await window.__slicerlive.idle();`);
    const cc = (await cdp.evalJson<{ markupType: string; points: number; measurements: { name: string; value: number }[] }[]>(`window.__markups()`)).find((m) => m.markupType === "closedCurve")!;
    assertEquals(cc.points, 4, "4 control points");
    assert(cc.measurements.some((m) => m.name === "area" && m.value > 0), `closed curve has area, got ${JSON.stringify(cc.measurements)}`);
    // linePoints are the interpolated spline (many more than 4)
    const nLine = await cdp.evalJson<number>(`(() => { const n = [...window.__live.nodes.values()].find(n=>n.type==='markup'&&n.markupType==='closedCurve'); return (n.linePoints||[]).length; })()`);
    assert(nLine >= 40, `interpolated spline has many points, got ${nLine}`);
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "markups: visibility, lock, and glyph size apply to the node", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(cellRect("Red"));
    const click = async (fx: number, fy: number) => { const x = red.x + red.w * fx, y = red.y + red.h * fy; await cdp.mouse("mousePressed", x, y, { button: "left", buttons: 1 }); await cdp.mouse("mouseReleased", x, y, { button: "left", buttons: 0 }); await new Promise((r) => setTimeout(r, 120)); };
    // place two fiducials (persistent)
    await cdp.eval<void>(`window.__startPlace("fiducial", true);`);
    await click(0.4, 0.4); await click(0.6, 0.6);
    await cdp.eval<void>(`window.__endPlace(); await window.__slicerlive.idle();`);
    const id = await cdp.evalJson<string>(`window.__markups()[0].id`);

    // hide -> node.visible false, and it's no longer grabbable (locked-or-hidden not picked)
    await cdp.eval<void>(`window.__setMarkupProp(${JSON.stringify(id)}, "visible", false);`);
    assertEquals(await cdp.evalJson<boolean>(`window.__markups().find(m=>m.id===${JSON.stringify(id)}).visible`), false);
    await cdp.eval<void>(`window.__setMarkupProp(${JSON.stringify(id)}, "visible", true);`);

    // lock -> node.locked true
    await cdp.eval<void>(`window.__setMarkupProp(${JSON.stringify(id)}, "locked", true);`);
    assertEquals(await cdp.evalJson<boolean>(`window.__markups().find(m=>m.id===${JSON.stringify(id)}).locked`), true);

    // glyph size -> patches all markups' glyphScale
    await cdp.eval<void>(`window.__setGlyphScale(6);`);
    assertEquals(await cdp.evalJson<number>(`window.__glyphScale()`), 6);
    assertEquals(await cdp.evalJson<number>(`[...window.__live.nodes.values()].find(n=>n.type==='markup').glyphScale`), 6);
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "markups: glyph size changes the rendered 2D glyph radius (fix #4)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(cellRect("Red"));
    // place a fiducial
    await cdp.eval<void>(`window.__startPlace("fiducial", false);`);
    await cdp.mouse("mousePressed", red.x + red.w * 0.5, red.y + red.h * 0.5, { button: "left", buttons: 1 });
    await cdp.mouse("mouseReleased", red.x + red.w * 0.5, red.y + red.h * 0.5, { button: "left", buttons: 0 });
    await cdp.eval<void>(`await window.__slicerlive.idle();`);
    const radiusAt = `(() => { const ov = window.__overlays().markups || []; const pt = ov.find(i => i.kind === "point"); return pt ? pt.radiusPx : null; })()`;
    await cdp.eval<void>(`window.__setGlyphScale(3); await window.__slicerlive.idle();`);
    const r3 = await cdp.evalJson<number>(radiusAt);
    await cdp.eval<void>(`window.__setGlyphScale(8); await window.__slicerlive.idle();`);
    const r8 = await cdp.evalJson<number>(radiusAt);
    console.log(`  glyph radiusPx: scale3=${r3} scale8=${r8}`);
    assert(r3 !== null && r8 !== null, "glyph overlay item present");
    assert(r8 > r3, `larger glyph scale -> larger radius (${r8} > ${r3})`);
  } finally { await cdp.closeTab(); }
} });
