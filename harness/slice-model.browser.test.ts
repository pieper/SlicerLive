// T3: Slice Model / Drop-Slice — show a slice view as a plane at its RAS location in 3D, hot-updating as the
// slice offset changes. Toggled from the slice controller bar's "3D" button. Standalone (native). Needs static
// server + Chrome.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }

Deno.test({ name: "slice model: drop a slice into 3D, hot-update on scroll, toggle off", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);   // plain URL = standalone native
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    const tr = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="3D"]'); const b = c.getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}; })()`);
    const shot = async () => (await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: tr.x, y: tr.y, width: tr.w, height: tr.h, scale: 1 } })).data;
    const before = await shot();

    // click the "3D" button on the Red slice controller bar
    assertEquals(await cdp.evalJson<number>(`window.__sliceIn3D().length`), 0, "no dropped slices yet");
    await cdp.eval<void>(`document.querySelector('.sl-slice-bar[data-cell="Red"] .sl-slice-3d').click(); await window.__slicerlive.idle();`);
    assertEquals(await cdp.evalJson<string[]>(`window.__sliceIn3D()`), ["Red"], "Red dropped into 3D");
    await new Promise((r) => setTimeout(r, 400));
    const withSlice = await shot();
    assert(before !== withSlice, "3D view changed when the slice was dropped");

    // scroll Red -> the dropped plane hot-updates (3D changes again)
    const rr = await cdp.evalJson<{ x: number; y: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="Red"]'); const b = c.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2}; })()`);
    for (let i = 0; i < 8; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rr.x, y: rr.y, deltaX: 0, deltaY: -120, modifiers: 0 }); await new Promise((r) => setTimeout(r, 40)); }
    await cdp.eval<void>(`await window.__slicerlive.idle();`); await new Promise((r) => setTimeout(r, 400));
    const afterScroll = await shot();
    assert(withSlice !== afterScroll, "dropped slice hot-updated in 3D as the slice offset changed");

    // change window/level -> the dropped plane re-derives from the scalarVolumeDisplay node change on the
    // _changes feed (granular event flow, not a hand-placed refresh). Regression guard for the W/L-not-syncing bug.
    const imgId = await cdp.evalJson<string>(`(window.__savableNodes().find(n => n.type === "image") || {}).id`);
    assert(imgId, "found the loaded image node");
    await cdp.eval<void>(`window.__wlPreset(${JSON.stringify(imgId)}, "CT Bone"); await window.__slicerlive.idle();`);
    await new Promise((r) => setTimeout(r, 400));
    const afterWL = await shot();
    assert(afterScroll !== afterWL, "dropped slice hot-updated in 3D when window/level changed");

    // toggle off
    await cdp.eval<void>(`document.querySelector('.sl-slice-bar[data-cell="Red"] .sl-slice-3d').click(); await window.__slicerlive.idle();`);
    assertEquals(await cdp.evalJson<number>(`window.__sliceIn3D().length`), 0, "dropped slice removed");
  } finally { await cdp.closeTab(); }
} });
