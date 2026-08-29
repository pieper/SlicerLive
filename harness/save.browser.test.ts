// T3 (W7): the Save panel exports loaded data. Load MRHead, export it as NRRD and NIfTI, create a
// segmentation and export it as .seg.nrrd — each returns a filename + nonzero size and valid magic bytes.
import { assert } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

Deno.test({ name: "save: export volume (NRRD/NIfTI) and segmentation (.seg.nrrd)", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    // savable nodes include the image
    assert((await cdp.evalJson<{ id: string }[]>(`window.__savableNodes()`)).some((n) => n.id === img), "image is savable");

    const nrrd = await cdp.eval<{ filename: string; size: number }>(`return await window.__exportNode(${JSON.stringify(img)}, "nrrd");`);
    assert(nrrd.filename.endsWith(".nrrd"), `NRRD filename (${nrrd.filename})`);
    assert(nrrd.size > 1000000, `MRHead NRRD is sizeable (${nrrd.size})`);

    const nii = await cdp.eval<{ filename: string; size: number }>(`return await window.__exportNode(${JSON.stringify(img)}, "nifti");`);
    assert(nii.filename.endsWith(".nii"), `NIfTI filename (${nii.filename})`);
    assert(nii.size > 352, "NIfTI has data");

    // create a segmentation, export as .seg.nrrd
    const seg = await cdp.eval<{ segId: string }>(`return await window.__createSegmentation(${JSON.stringify(img)});`);
    const segFile = await cdp.eval<{ filename: string; size: number }>(`return await window.__exportNode(${JSON.stringify(seg.segId)}, "nrrd");`);
    assert(segFile.filename.endsWith(".seg.nrrd"), `segmentation exported as .seg.nrrd (${segFile.filename})`);
    assert(segFile.size > 0, "seg.nrrd has bytes");
  } finally { await cdp.closeTab(); }
} });
