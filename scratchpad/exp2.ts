import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 25000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// diagnosis on the record
await ev(cdp, `return globalThis.seged.say("agent", "Diagnosis: label 8 has 27% of voxels below 0 HU (min -974 = lung/air) and a 505 HU tail, but a mediastinal lymph node is soft tissue (~0-90 HU, web-confirmed). The mask leaked into adjacent fat/lung. Fix: trim to a soft-tissue HU window.");`);
// REFINE: keep soft-tissue HU, remove fat/air/lung leak (<0) and bone/vessel leak (>120)
const r1 = await ev(cdp, "return await globalThis.seged.threshold(8, 0, 120);");
console.log("threshold(8,0,120) ->", JSON.stringify(r1));
const s1 = await ev(cdp, "return await globalThis.seged.score();");
console.log("Dice after threshold:", JSON.stringify(s1));
const st = await ev(cdp, "return await globalThis.seged.stats(8);");
console.log("node stats after threshold:", JSON.stringify((st as any)?.hu), "voxels:", (st as any)?.voxels);
await ev(cdp, "return await globalThis.seged.focus(8);");
await cdp.screenshot("scratchpad/exp2-after-threshold.png");
console.log("screenshot -> scratchpad/exp2-after-threshold.png");
cdp.close();
