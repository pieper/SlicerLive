// T3 (W6): native transforms. Load MRHead, apply a linear transform, translate it (world matrix reflects it),
// then harden (bake into the volume's IJKToRAS and clear the ref). Standalone. Needs static server + Chrome.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "transforms: apply + translate + harden a volume", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    const ijk0 = await cdp.evalJson<number[]>(`window.__live.nodes.get(${JSON.stringify(img)}).ijkToRAS`);

    // create + apply a transform, then translate (10, 20, 30) mm
    const tid = await cdp.eval<string>(`const id = window.__createTransform(); window.__applyTransformTo(${JSON.stringify(img)}, id); return id;`);
    assertEquals(await cdp.evalJson<string>(`window.__nodeTransform(${JSON.stringify(img)})`), tid, "transform applied to the volume");
    await cdp.eval<void>(`window.__translateTransform(${JSON.stringify(tid)}, 10, 20, 30); await window.__slicerlive.idle();`);
    const world = await cdp.evalJson<number[]>(`window.__nodeWorldMatrix(${JSON.stringify(img)})`);
    assertEquals([world[3], world[7], world[11]], [10, 20, 30], "world matrix carries the translation");
    // base geometry is unchanged while transformed (not hardened yet)
    assertEquals(await cdp.evalJson<number[]>(`window.__live.nodes.get(${JSON.stringify(img)}).ijkToRAS`), ijk0, "base ijkToRAS untouched pre-harden");

    // harden: bake world into ijkToRAS (translation shifts by 10/20/30) and clear the ref
    await cdp.eval<void>(`window.__hardenTransform(${JSON.stringify(img)}); await window.__slicerlive.idle();`);
    const ijk1 = await cdp.evalJson<number[]>(`window.__live.nodes.get(${JSON.stringify(img)}).ijkToRAS`);
    assertAlmostEquals(ijk1[3], ijk0[3] + 10, 1e-6, "R origin shifted");
    assertAlmostEquals(ijk1[7], ijk0[7] + 20, 1e-6, "A origin shifted");
    assertAlmostEquals(ijk1[11], ijk0[11] + 30, 1e-6, "S origin shifted");
    assertEquals(await cdp.evalJson<string | null>(`window.__nodeTransform(${JSON.stringify(img)})`), null, "transform ref cleared after harden");

    // still rendering
    assert(await cdp.evalJson<number>(`window.__slicerlive.frameCount`) > 0, "frames rendered");
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "transforms: adjusting the transform moves the volume in the slice (live, not hardened)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle(); return window.__volumeList()[0].imageId;`);
    // sagittal (Yellow) normal is R, so an R-translation shifts its offset range by that amount
    await cdp.waitForValue<number | null>(`window.__views.sliceOffsetRange("Yellow") ? window.__views.sliceOffsetRange("Yellow").min : null`, (v) => v !== null, 20000);
    const before = await cdp.evalJson<number>(`window.__views.sliceOffsetRange("Yellow").min`);
    const tid = await cdp.eval<string>(`const id = window.__createTransform(); window.__applyTransformTo(${JSON.stringify(img)}, id); return id;`);
    await cdp.eval<void>(`window.__translateTransform(${JSON.stringify(tid)}, 40, 0, 0); await window.__slicerlive.idle();`);
    const after = await cdp.evalJson<number>(`window.__views.sliceOffsetRange("Yellow").min`);
    assertAlmostEquals(after - before, 40, 1e-2, `sagittal field shifted by the R-translation (${before} -> ${after})`);
    // and it tracks continuously as the transform changes
    await cdp.eval<void>(`window.__translateTransform(${JSON.stringify(tid)}, -30, 0, 0); await window.__slicerlive.idle();`);
    const after2 = await cdp.evalJson<number>(`window.__views.sliceOffsetRange("Yellow").min`);
    assertAlmostEquals(after2 - before, 10, 1e-2, "field tracks a second adjustment");
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "transforms: a real slider DRAG moves the volume the full amount (fix #1 mid-drag re-render)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle(); await window.__shell.showPanel("transforms");`);
    await cdp.eval<void>(`document.querySelector(".sl-tf-apply").click(); await window.__slicerlive.idle();`);
    // simulate a real drag: many input events on the SAME captured element (as pointer capture does),
    // bracketed by pointerdown/change. Before the fix, the panel re-rendered per event and detached the slider.
    const tx = await cdp.eval<number>(`
      const s = document.querySelector("input.sl-tf-x");
      s.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      for (let v = 10; v <= 80; v += 10) { s.value = String(v); s.dispatchEvent(new Event("input", { bubbles: true })); }
      s.dispatchEvent(new Event("change", { bubbles: true }));
      await window.__slicerlive.idle();
      return window.__transforms()[0].matrix[3];
    `);
    assertAlmostEquals(tx, 80, 1e-6, `drag accumulated to the final slider value (got ${tx}, not stuck at the first step)`);
  } finally { await cdp.closeTab(); }
} });
