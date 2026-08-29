// T3 (W5): the native Segment Editor. Load MRHead, create a segmentation, run Auto-threshold (Otsu) to fill
// a segment from the source, then Keep-largest Islands, Margin grow, and Median smoothing — each returns a
// voxel count and the segmentation node's labelmap zarr changes (re-baked by the DM). Standalone.
import { assert } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "segment editor: create, auto-threshold, islands, margin, smoothing", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const src = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    assert(src, "MRHead loaded");

    const seg = await cdp.eval<{ segId: string; segment: number }>(`return await window.__createSegmentation(${JSON.stringify(src)});`);
    assert(seg.segId, "segmentation created");
    const zarr0 = await cdp.evalJson<string>(`JSON.stringify(window.__live.nodes.get(${JSON.stringify(seg.segId)}).zarr)`);

    // Auto threshold (Otsu) fills the segment from the source; a real MR head has a clear foreground
    const auto = await cdp.eval<{ voxels: number; threshold: number }>(`return await window.__applyEffect(${JSON.stringify(seg.segId)}, "autoThreshold", { segment: 1, autoMethod: "otsu" });`);
    console.log(`  Otsu threshold ${auto.threshold?.toFixed(0)}, ${auto.voxels} voxels`);
    assert(auto.voxels > 1000, `auto-threshold filled the head (${auto.voxels} voxels)`);
    const zarr1 = await cdp.evalJson<string>(`JSON.stringify(window.__live.nodes.get(${JSON.stringify(seg.segId)}).zarr)`);
    assert(zarr1 !== zarr0, "labelmap zarr changed after the effect");

    // Keep largest island: <= the thresholded count, still substantial
    const isl = await cdp.eval<{ voxels: number }>(`return await window.__applyEffect(${JSON.stringify(seg.segId)}, "islands", { segment: 1, islands: "keepLargest" });`);
    console.log(`  keep-largest -> ${isl.voxels} voxels`);
    assert(isl.voxels > 0 && isl.voxels <= auto.voxels, "keep-largest keeps a subset");

    // Margin grow adds voxels
    const grow = await cdp.eval<{ voxels: number }>(`return await window.__applyEffect(${JSON.stringify(seg.segId)}, "margin", { segment: 1, marginMm: 2 });`);
    console.log(`  margin +2mm -> ${grow.voxels} voxels`);
    assert(grow.voxels > isl.voxels, "margin grow adds voxels");

    // Median smoothing runs and keeps a nonzero segment
    const sm = await cdp.eval<{ voxels: number }>(`return await window.__applyEffect(${JSON.stringify(seg.segId)}, "smoothing", { segment: 1, smooth: "median", radiusVoxels: 1 });`);
    assert(sm.voxels > 0, "smoothing keeps the segment");

    // still rendering
    await cdp.eval<void>(`await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<number>(`window.__slicerlive.frameCount`) > 0, "frames rendered");
  } finally { await cdp.closeTab(); }
} });
