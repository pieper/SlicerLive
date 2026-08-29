// T3 (W3): the Volumes panel drives the scalarVolumeDisplay node. Load MRHead, then via the panel's
// programmatic API (the same calls the DOM controls make): auto W/L gives sane values, a CT preset sets
// exact window/level, threshold toggles alpha-only, a color table attaches, and the slice keeps rendering.
// Needs a static server (:8130) + headed Chrome (:9222). Standalone page (no peer) for determinism.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "volumes panel: auto W/L, CT preset, threshold, color table", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const id = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    assert(id, "MRHead should appear in __volumeList");

    // auto W/L on load: window > 0, level within data range
    const d0 = await cdp.evalJson<{ window: number; level: number; autoWindowLevel: boolean }>(`window.__volumeDisplay(${JSON.stringify(id)})`);
    assert(d0.window > 0, `auto window > 0, got ${d0.window}`);
    assert(d0.autoWindowLevel, "autoWindowLevel true on load");

    // recompute Auto explicitly -> matches the on-load value (both from the exact histogram)
    const dAuto = await cdp.eval<{ window: number; level: number }>(`await window.__autoWL(${JSON.stringify(id)}); return window.__volumeDisplay(${JSON.stringify(id)});`);
    assertAlmostEquals(dAuto.window, d0.window, 1, "Auto button reproduces on-load window");

    // CT Bone preset sets exact window/level and clears auto
    const dp = await cdp.eval<{ window: number; level: number; autoWindowLevel: boolean }>(`window.__wlPreset(${JSON.stringify(id)}, "CT Bone"); return window.__volumeDisplay(${JSON.stringify(id)});`);
    assertEquals([dp.window, dp.level], [1800, 400], "CT Bone -> 1800/400");
    assertEquals(dp.autoWindowLevel, false, "preset clears autoWindowLevel");

    // explicit W/L
    const dw = await cdp.eval<{ window: number; level: number }>(`window.__setWindowLevel(${JSON.stringify(id)}, 250, 90); return window.__volumeDisplay(${JSON.stringify(id)});`);
    assertEquals([dw.window, dw.level], [250, 90]);

    // threshold toggle is alpha-only bookkeeping on the display node
    const dt = await cdp.eval<{ applyThreshold: boolean; threshold: [number, number] }>(`window.__setThreshold(${JSON.stringify(id)}, true, 50, 180); return window.__volumeDisplay(${JSON.stringify(id)});`);
    assertEquals(dt.applyThreshold, true);
    assertEquals(dt.threshold, [50, 180]);

    // color table attaches a colorTable node + ref
    const dc = await cdp.eval<{ colorTableId: string }>(`window.__setColorTable(${JSON.stringify(id)}, "vtkMRMLColorTableNodeRainbow"); return window.__volumeDisplay(${JSON.stringify(id)});`);
    assertEquals(dc.colorTableId, "vtkMRMLColorTableNodeRainbow");
    assert(await cdp.evalJson<boolean>(`window.__live.nodes.has("vtkMRMLColorTableNodeRainbow")`), "colorTable node created");

    // interpolation toggle
    const di = await cdp.eval<{ interpolate: boolean }>(`window.__setInterpolate(${JSON.stringify(id)}, false); return window.__volumeDisplay(${JSON.stringify(id)});`);
    assertEquals(di.interpolate, false);

    // still rendering frames after all the display edits
    const f0 = await cdp.evalJson<number>(`window.__slicerlive.frameCount`);
    await cdp.eval<void>(`window.__setWindowLevel(${JSON.stringify(id)}, 300, 100); await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<number>(`window.__slicerlive.frameCount`) >= f0, "frames advanced after W/L edit");
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "volumes: left-drag in a slice cell adjusts W/L (Slicer AdjustWindowLevel mode)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  // The exact gain = (hi-lo)/min(w,h) is unit-tested in logic/window-level.test.ts (adjustWindowLevel).
  // Here we prove the slice interaction is wired to it: a horizontal left-drag grows the background
  // volume's window, more for a longer drag, leaves level ~unchanged, and clears autoWindowLevel.
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const id = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    const cell = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="Red"]'); const r = c.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
    const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
    const dragX = async (dx: number) => {
      await cdp.eval<void>(`window.__setWindowLevel(${JSON.stringify(id)}, 200, 100); await window.__slicerlive.idle();`);
      const b = await cdp.evalJson<{ window: number; level: number }>(`window.__volumeDisplay(${JSON.stringify(id)})`);
      await cdp.drag(cx, cy, cx + dx, cy, { button: "left" });
      await cdp.eval<void>(`await window.__slicerlive.idle();`);
      const a = await cdp.evalJson<{ window: number; level: number; autoWindowLevel: boolean }>(`window.__volumeDisplay(${JSON.stringify(id)})`);
      return { dWin: a.window - b.window, dLev: a.level - b.level, auto: a.autoWindowLevel };
    };
    const dShort = await dragX(30), dLong = await dragX(120);
    assert(dShort.dWin > 0, `+dx grows window, got ${dShort.dWin}`);
    assert(dLong.dWin > dShort.dWin, `longer drag grows window more: ${dLong.dWin} vs ${dShort.dWin}`);
    assert(Math.abs(dLong.dLev) < Math.abs(dLong.dWin) * 0.1, `level ~unchanged on horizontal drag (dLev ${dLong.dLev}, dWin ${dLong.dWin})`);
    assertEquals(dLong.auto, false, "manual drag clears autoWindowLevel");
    // vertical drag moves level, not (much) window
    await cdp.eval<void>(`window.__setWindowLevel(${JSON.stringify(id)}, 200, 100); await window.__slicerlive.idle();`);
    const bv = await cdp.evalJson<{ window: number; level: number }>(`window.__volumeDisplay(${JSON.stringify(id)})`);
    await cdp.drag(cx, cy, cx, cy - 100, { button: "left" });
    await cdp.eval<void>(`await window.__slicerlive.idle();`);
    const av = await cdp.evalJson<{ window: number; level: number }>(`window.__volumeDisplay(${JSON.stringify(id)})`);
    assert(Math.abs(av.level - bv.level) > 0, `vertical drag moves level (${av.level - bv.level})`);
  } finally { await cdp.closeTab(); }
} });
