// T3 (W1): a volume loaded from bytes in the page becomes an image node with the right geometry, the slice
// composites point at it, and the Data panel exists. Uses the page's programmatic entry (__loadVolumeBytes)
// with a synthetic NIfTI generated here — same bytes the unit tests use.
//   deno run -A test/run.ts --browser
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitIdle, waitReady } from "./ready.ts";
import { makeNifti, SYNTHETIC_DIMS } from "../logic/readers/synthetic.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }

Deno.test({ name: "load: bytes -> image node + composites (synthetic NIfTI, sform)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(`${BASE}slicer-app.html`);
  try {
    await waitReady(cdp, 60000);
    const sform = [0.5, 0, 0, -10, 0, 0.5, 0, -20, 0, 0, 2, 30];
    const b64 = btoa(String.fromCharCode(...makeNifti({ sform })));
    const r = await cdp.eval<{ dims: number[]; ijkToRAS: number[]; bg: string[]; panels: string[] }>(`
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
      await window.__loadVolumeBytes(bytes, "synthetic.nii");
      const img = [...window.__live.nodes.values()].find(n => n.type === "image" && n.name === "synthetic");
      const comps = [...window.__live.nodes.values()].filter(n => n.type === "sliceComposite");
      return { dims: img.dims, ijkToRAS: img.ijkToRAS, bg: comps.map(c => c.refs.background && c.refs.background[0] === img.id), panels: window.__shell.panels().map(p => p.id) };`);
    assertEquals(r.dims, SYNTHETIC_DIMS);
    assertEquals(r.ijkToRAS, [...sform, 0, 0, 0, 1]);
    assert(r.bg.length >= 3 && r.bg.every(Boolean), "composites should show the loaded volume");
    assert(r.panels.includes("data"), "Data panel registered");
    await waitIdle(cdp);
    const frames = await cdp.evalJson<number>("window.__slicerlive.frameCount");
    assert(frames > 0);
  } finally { await cdp.closeTab(); }
} });
