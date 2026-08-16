import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 20000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// pre-degrade voxel count of the target (largest) for reference
const before = await ev(cdp, "return await globalThis.seged.state();");
const target = (before as any).segments.slice().sort((a:any,b:any)=>b.voxels-a.voxels)[0];
console.log("target (largest) segment:", JSON.stringify(target));
// apply the BLINDED flaw (I do not read how it was chosen)
const deg = await ev(cdp, "return await globalThis.seged.degrade();");
console.log("degrade ->", JSON.stringify(deg));
const after = await ev(cdp, "return await globalThis.seged.state();");
const t2 = (after as any).segments.find((s:any)=>s.num===(deg as any).label);
console.log("target after degrade:", JSON.stringify(t2), " (was", target.voxels, "vox)");
const base = await ev(cdp, "return await globalThis.seged.score();");
console.log("baseline score (degraded vs hidden GT):", JSON.stringify(base));
await cdp.screenshot("scratchpad/seged-degraded.png");
console.log("screenshot -> scratchpad/seged-degraded.png");
cdp.close();
