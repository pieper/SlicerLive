// T3 (W5): native paint/erase brush. Load MRHead, create a segmentation, select Paint, and drag in the Red
// slice view — voxels get painted into the resident labelmap (committed on drop). Erase then removes some.
// Standalone. Needs static server + Chrome.
import { assert, assertEquals } from "jsr:@std/assert@1";
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

Deno.test({ name: "paint: fast drag in disk mode leaves a continuous stroke, not gaps (fix #5a)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    const seg = await cdp.eval<{ segId: string }>(`return await window.__createSegmentation(${JSON.stringify(img)});`);
    await cdp.eval<void>(`window.__setSegTool(${JSON.stringify(seg.segId)}, "paint", { diameterMm: 6, sphere: false, segment: 1 }); await window.__slicerlive.idle();`);
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="Red"]'); const r = c.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
    const cy = red.y + red.h * 0.5;
    // a deliberately COARSE drag (few interpolation steps -> sparse raw points)
    await cdp.drag(red.x + red.w * 0.25, cy, red.x + red.w * 0.75, cy, { button: "left", steps: 3 });
    await cdp.eval<void>(`await new Promise(r=>setTimeout(r,400)); await window.__slicerlive.idle();`);
    const painted = await cdp.eval<number>(segVoxels(seg.segId));
    console.log(`  continuous stroke: ${painted} voxels`);
    // interpolation fills the whole swept line -> far more than a handful of disks
    assert(painted > 1000, `stroke is continuous (${painted} voxels)`);
    // and it is ONE connected island (keep-largest keeps essentially all of it -> no gaps)
    await cdp.eval<void>(`await window.__applyEffect(${JSON.stringify(seg.segId)}, "islands", { segment: 1, islands: "keepLargest" });`);
    const largest = await cdp.eval<number>(segVoxels(seg.segId));
    console.log(`  largest island: ${largest} voxels`);
    assert(largest > painted * 0.9, `the stroke is a single connected island (${largest}/${painted})`);
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "segments: added segments get distinct Slicer default colours + paint targets the active one (fix #5b)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle(); return window.__volumeList()[0].imageId;`);
    await cdp.eval<void>(`await window.__shell.showPanel("segment");`);
    await cdp.eval<void>(`document.querySelector(".sl-seg-new").click(); await new Promise(r=>setTimeout(r,300));`);
    const segId = await cdp.eval<string>(`return window.__segmentations()[0].segId;`);
    // select paint, then add a second segment -> the paint target must follow to segment 2
    await cdp.eval<void>(`document.querySelector(".sl-eff-paint").click(); document.querySelector(".sl-seg-new").click(); await window.__slicerlive.idle();`);
    const tool = await cdp.evalJson<{ activeEffect: string }>(`(()=>{const n=window.__live.nodes.get("local-segmentEditor"); return {activeEffect:n.activeEffect, sel:n.selectedSegmentId};})()`);
    const sel = await cdp.evalJson<number>(`window.__live.nodes.get("local-segmentEditor").selectedSegmentId`);
    assertEquals(sel, 2, "paint target followed to the new segment");
    // distinct colours (Slicer default: segment 1 != segment 2)
    const cols = await cdp.evalJson<number[][]>(`window.__segmentations().find(s=>s.segId===${JSON.stringify(segId)}).segments.map(x=>x.color)`);
    assert(JSON.stringify(cols[0]) !== JSON.stringify(cols[1]), `segments have distinct colours (${JSON.stringify(cols)})`);
    // segment 1 default colour is Slicer's first GenericAnatomyColors entry
    assert(Math.abs(cols[0][0] - 0.502) < 0.01 && Math.abs(cols[0][1] - 0.6824) < 0.01, `Slicer default colour (${cols[0]})`);
  } finally { await cdp.closeTab(); }
} });
