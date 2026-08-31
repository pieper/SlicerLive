// T3: the DEFAULT page (no ?ws) runs STANDALONE (native-first) — a stray ModuleServer must not hijack the
// session. Native interactions (load, transform, scroll) must work on the plain URL, not just the ?ws=dead one.
// This is the regression for "works with ?ws=dead in tests but not on the real URL". Needs static server + Chrome.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }

Deno.test({ name: "default page (no ?ws) is standalone-native and transforms/scroll work there", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);   // the plain URL a user opens
  try {
    await waitReady(cdp, 60000);
    // no peer connection => no streamed peer nodes before we load anything
    const peerViews = await cdp.evalJson<string[]>(`[...window.__live.nodes.values()].filter(n=>n.type==="view"&&n.kind==="slice").map(n=>n.id)`);
    assert(peerViews.length === 0, `no peer slice nodes on the plain URL (got ${JSON.stringify(peerViews)})`);

    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle(); return window.__volumeList()[0].imageId;`);
    // native slice nodes get created, and the volume drives the slice background
    const nat = await cdp.evalJson<string[]>(`[...window.__live.nodes.values()].filter(n=>n.id.startsWith("nativeSlice")).map(n=>n.id)`);
    assert(nat.length === 3, `native slice nodes created (${JSON.stringify(nat)})`);
    assert(await cdp.evalJson<boolean>(`window.__layers().Yellow.bg`), "volume shows as slice background");

    // transform moves the volume
    const tid = await cdp.eval<string>(`const id=window.__createTransform(); window.__applyTransformTo(${JSON.stringify(img)}, id); return id;`);
    const off0 = await cdp.evalJson<number>(`window.__views.sliceOffsetRange("Yellow").min`);
    await cdp.eval<void>(`window.__translateTransform(${JSON.stringify(tid)}, 40, 0, 0); await window.__slicerlive.idle();`);
    const off1 = await cdp.evalJson<number>(`window.__views.sliceOffsetRange("Yellow").min`);
    assertAlmostEquals(off1 - off0, 40, 1, "transform moves the sagittal field by 40mm on the plain URL");

    // scroll steps by the sagittal spacing and stays synced
    const r = await cdp.evalJson<{ x: number; y: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="Yellow"]'); const b = c.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2}; })()`);
    const so0 = await cdp.evalJson<number>(`window.__cellPlanes().Yellow`);
    for (let i = 0; i < 3; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: r.x, y: r.y, deltaX: 0, deltaY: -120, modifiers: 0 }); await new Promise((res) => setTimeout(res, 60)); }
    await cdp.eval<void>(`await window.__slicerlive.idle();`); await new Promise((res) => setTimeout(res, 250));
    const so1 = await cdp.evalJson<number>(`window.__cellPlanes().Yellow`);
    const node = await cdp.evalJson<number>(`window.__sliceNode("Yellow").offset`);
    assertAlmostEquals(so1 - so0, -3 * 1.3, 0.2, "scroll steps 1.3mm x3 on the plain URL");
    assertAlmostEquals(so1, node, 1e-6, "scroll stays synced (no jitter) on the plain URL");
  } finally { await cdp.closeTab(); }
} });
