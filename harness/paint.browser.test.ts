// T3 (W5): native paint/erase brush. Load MRHead, create a segmentation, select Paint, and drag in the Red
// slice view — voxels get painted into the resident labelmap (committed on drop). Erase then removes some.
// Standalone. Needs static server + Chrome.
import { assert } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

const segVoxels = (segId: string) => `const s = await window.__segmentStats(${JSON.stringify(segId)}); return (s.find(x=>x.labelValue===1)||{voxels:0}).voxels;`;

Deno.test({ name: "paint: drag paints the active segment; erase removes voxels", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    const seg = await cdp.eval<{ segId: string }>(`return await window.__createSegmentation(${JSON.stringify(img)});`);
    // select Paint with a big brush
    await cdp.eval<void>(`window.__setSegTool(${JSON.stringify(seg.segId)}, "paint", { diameterMm: 20, segment: 1 }); await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<string>(`window.__segTool().activeEffect`) === "paint", "paint tool active");

    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="Red"]'); const r = c.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
    const cx = red.x + red.w * 0.5, cy = red.y + red.h * 0.5;
    // drag a stroke across the middle of the axial view
    await cdp.drag(cx - red.w * 0.15, cy, cx + red.w * 0.15, cy, { button: "left", steps: 16 });
    await cdp.eval<void>(`await new Promise(r=>setTimeout(r,300)); await window.__slicerlive.idle();`);
    const painted = await cdp.eval<number>(segVoxels(seg.segId));
    console.log(`  painted ${painted} voxels`);
    assert(painted > 0, `paint stroke filled voxels (${painted})`);

    // erase over the same area removes some
    await cdp.eval<void>(`window.__setSegTool(${JSON.stringify(seg.segId)}, "erase", { diameterMm: 20, segment: 1 });`);
    await cdp.drag(cx - red.w * 0.15, cy, cx + red.w * 0.15, cy, { button: "left", steps: 16 });
    await cdp.eval<void>(`await new Promise(r=>setTimeout(r,300)); await window.__slicerlive.idle();`);
    const afterErase = await cdp.eval<number>(segVoxels(seg.segId));
    console.log(`  after erase ${afterErase} voxels`);
    assert(afterErase < painted, `erase removed voxels (${afterErase} < ${painted})`);
  } finally { await cdp.closeTab(); }
} });
