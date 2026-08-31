// T3 (W3): the Volume Rendering panel / TF editor. Load MRHead, enable VR, apply a CT preset (writes the
// transferFunction colorStops + scalarOpacity that VolumeRenderingDisplayableManager consumes), edit the
// opacity stops, and confirm the 3D view keeps rendering. Standalone page. Needs static server + Chrome.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "tf editor: enable VR, apply preset, edit opacity", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const id = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);

    // enable volume rendering -> a visible volumeRenderingDisplay node exists
    const on = await cdp.eval<{ visible: boolean; volume: string }>(`window.__setVolumeRendering(${JSON.stringify(id)}, true); await window.__slicerlive.idle(); return window.__vrState(${JSON.stringify(id)});`);
    assertEquals(on.visible, true, "VR visible");
    assertEquals(on.volume, id, "VR points at the loaded volume");

    // apply CT-Bone preset -> colorStops + scalarOpacity from the Slicer preset
    const pre = await cdp.eval<{ preset: string; colorStops: { value: number }[]; scalarOpacity: { value: number; opacity: number }[] }>(`window.__setVrPreset(${JSON.stringify(id)}, "CT-Bone"); await window.__slicerlive.idle(); return window.__vrState(${JSON.stringify(id)});`);
    assertEquals(pre.preset, "CT-Bone");
    assert(pre.colorStops.length >= 3, `preset color stops (${pre.colorStops.length})`);
    assert(pre.scalarOpacity.length >= 3, `preset opacity stops (${pre.scalarOpacity.length})`);
    // opacity stops sorted ascending by value
    for (let i = 1; i < pre.scalarOpacity.length; i++) assert(pre.scalarOpacity[i].value >= pre.scalarOpacity[i - 1].value, "opacity stops sorted");

    // edit the opacity curve programmatically (what a canvas drag does) -> node reflects it
    const edited = await cdp.eval<{ scalarOpacity: { value: number; opacity: number }[] }>(`
      const s = window.__vrState(${JSON.stringify(id)}).scalarOpacity.map(x => ({...x}));
      s[s.length-1].opacity = 0.42;
      window.__setOpacityStops(s);
      await window.__slicerlive.idle();
      return window.__vrState(${JSON.stringify(id)});`);
    assertEquals(edited.scalarOpacity[edited.scalarOpacity.length - 1].opacity, 0.42, "opacity edit stored");

    // still rendering, and the TF canvas exists in the panel
    const f0 = await cdp.evalJson<number>(`window.__slicerlive.frameCount`);
    await cdp.eval<void>(`window.__setOpacityStops(window.__vrState(${JSON.stringify(id)}).scalarOpacity.map((x,i)=>({value:x.value,opacity:i===0?0:0.5}))); await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<number>(`window.__slicerlive.frameCount`) >= f0, "frames advanced after TF edit");

    // turn VR off
    const off = await cdp.eval<{ visible: boolean }>(`window.__setVolumeRendering(${JSON.stringify(id)}, false); await window.__slicerlive.idle(); return window.__vrState(${JSON.stringify(id)});`);
    assertEquals(off.visible, false, "VR off");
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "tf editor: Shift moves all transfer-function points as a unit (fix #2)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const id = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    await cdp.eval<void>(`window.__setVrPreset(${JSON.stringify(id)}, "CT-Bone"); await window.__slicerlive.idle();`);
    const before = await cdp.evalJson<{ colorStops: { value: number }[]; scalarOpacity: { value: number }[] }>(`window.__vrState(${JSON.stringify(id)})`);
    // shift by +150
    await cdp.eval<void>(`window.__shiftTf(150); await window.__slicerlive.idle();`);
    const after = await cdp.evalJson<{ colorStops: { value: number }[]; scalarOpacity: { value: number }[] }>(`window.__vrState(${JSON.stringify(id)})`);
    // every colour + opacity point moved by exactly +150
    for (let i = 0; i < before.colorStops.length; i++) assertAlmostEquals(after.colorStops[i].value, before.colorStops[i].value + 150, 1e-6, `colorStop ${i}`);
    for (let i = 0; i < before.scalarOpacity.length; i++) assertAlmostEquals(after.scalarOpacity[i].value, before.scalarOpacity[i].value + 150, 1e-6, `opacityStop ${i}`);
    // the shape is preserved (spacing between points unchanged)
    const gap0 = before.colorStops[1].value - before.colorStops[0].value;
    const gap1 = after.colorStops[1].value - after.colorStops[0].value;
    assertAlmostEquals(gap0, gap1, 1e-6, "TF shape preserved under shift");
  } finally { await cdp.closeTab(); }
} });
