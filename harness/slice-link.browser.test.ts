// T3 (W2): slice linking (vtkMRMLSliceLinkLogic). With linkedControl on, moving one slice view's offset
// follows in OTHER same-orientation views but not in differently-oriented ones. We reformat Green to Axial
// (matching Red) so there is a same-orientation pair, then drive Red's offset and check the node offsets.
// Standalone page. Needs static server + Chrome.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

const offOf = (cell: string) => `(() => { const n = window.__sliceNode(${JSON.stringify(cell)}); return n ? n.offset : null; })()`;

Deno.test({ name: "slice link: linked same-orientation views follow, others don't", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    // native slice nodes exist after load
    const haveNodes = await cdp.evalJson<boolean>(`!!window.__sliceNode("Red") && !!window.__sliceNode("Green") && !!window.__sliceNode("Yellow")`);
    assert(haveNodes, "native slice nodes present");

    // reformat Green -> Axial so Red and Green share orientation
    await cdp.eval<void>(`window.__reformatCell("Green", "axial"); await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<string>(`window.__sliceNode("Green").orientation`) === "Axial", "Green reformatted to Axial");

    // link ON, then set Red's offset
    await cdp.eval<void>(`window.__setLinked(true);`);
    assert(await cdp.evalJson<boolean>(`window.__isLinked()`), "link on");
    const yellowBefore = await cdp.evalJson<number>(offOf("Yellow"));
    await cdp.eval<void>(`window.__setSliceOffset("Red", 21); await window.__slicerlive.idle();`);
    const redOff = await cdp.evalJson<number>(offOf("Red"));
    const greenOff = await cdp.evalJson<number>(offOf("Green"));
    const yellowOff = await cdp.evalJson<number>(offOf("Yellow"));
    assertAlmostEquals(greenOff, redOff, 1e-6, `Green (axial, linked) follows Red: ${greenOff} vs ${redOff}`);
    assertAlmostEquals(yellowOff, yellowBefore, 1e-6, `Yellow (sagittal) unchanged: ${yellowOff} vs ${yellowBefore}`);

    // link OFF: moving Red no longer moves Green
    await cdp.eval<void>(`window.__setLinked(false);`);
    const greenBeforeOff = await cdp.evalJson<number>(offOf("Green"));
    await cdp.eval<void>(`window.__setSliceOffset("Red", -13); await window.__slicerlive.idle();`);
    const greenAfterOff = await cdp.evalJson<number>(offOf("Green"));
    assertAlmostEquals(greenAfterOff, greenBeforeOff, 1e-6, "Green stays put when link off");
  } finally { await cdp.closeTab(); }
} });

Deno.test({ name: "reformat combo: changing a slice bar's orientation reformats that view", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    await cdp.eval<void>(`await window.__loadSample("MRHead"); await window.__slicerlive.idle();`);
    // Green starts Coronal (normal +A = [0,1,0])
    assert(await cdp.evalJson<string>(`window.__sliceNode("Green").orientation`) === "Coronal", "Green starts Coronal");
    // drive the Green bar's orientation <select> to Sagittal like a user
    await cdp.eval<void>(`
      const bar = document.querySelector('.sl-slice-bar[data-cell="Green"]');
      const sel = bar.querySelector('.sl-slice-orient');
      sel.value = 'sagittal';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<string>(`window.__sliceNode("Green").orientation`) === "Sagittal", "Green reformatted to Sagittal via combo");
    // plane normal is now +R ([1,0,0]): sliceToRAS column 2 = (m[2],m[6],m[10])
    const nrm = await cdp.evalJson<number[]>(`(() => { const m = window.__sliceNode("Green").sliceToRAS; return [m[2], m[6], m[10]]; })()`);
    assertAlmostEquals(nrm[0], 1, 1e-6); assertAlmostEquals(nrm[1], 0, 1e-6); assertAlmostEquals(nrm[2], 0, 1e-6);
  } finally { await cdp.closeTab(); }
} });
