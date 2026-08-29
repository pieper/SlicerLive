// T4 (W3): native MRHead auto window/level (Slicer's percentile 0.1/99.9 histogram) matches Slicer's
// vtkMRMLScalarVolumeDisplayNode auto levels within tolerance. Needs Slicer + headed Chrome + net (Sample Data).
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { CDP } from "../cdp.ts";
import { waitReady } from "../ready.ts";
import { pyJson, slicerAvailable } from "../slicer.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
const available = await slicerAvailable();

Deno.test({ name: "parity: native MRHead auto W/L ~= Slicer's (window tol 2, level tol 1)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  // Slicer's auto W/L for MRHead
  const ref = await pyJson<{ w: number; l: number }>(`(lambda v: (v.GetDisplayNode().SetAutoWindowLevel(1), {"w": v.GetDisplayNode().GetWindow(), "l": v.GetDisplayNode().GetLevel()})[1])(slicer.mrmlScene.GetFirstNodeByName("MRHead") or slicer.mrmlScene.GetFirstNodeByName("MRHead_1"))`);
  const cdp = await CDP.openTab(`${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`);
  try {
    await waitReady(cdp, 60000);
    const live = await cdp.eval<{ window: number; level: number }>(`
      await window.__loadSample("MRHead");
      const d = [...window.__live.nodes.values()].find(n => n.type === "scalarVolumeDisplay" && n.origin && n.origin.local);
      return { window: d.window, level: d.level };`);
    console.log(`  MRHead auto W/L: native ${live.window.toFixed(1)}/${live.level.toFixed(1)} vs Slicer ${ref.w.toFixed(1)}/${ref.l.toFixed(1)}`);
    assertAlmostEquals(live.window, ref.w, 2, "window");
    assertAlmostEquals(live.level, ref.l, 1, "level");
  } finally { await cdp.closeTab(); }
} });
