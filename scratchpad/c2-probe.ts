import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 20000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// probe: small dab in the RIGHT kidney at axial 0.66, read HU there
await ev(cdp, `return globalThis.seged.view({axial:0.66});`);
await ev(cdp, `return await globalThis.seged.placeSeed('axial',0.30,0.62,1,{diameterMm:6});`);
const s1 = await ev<any>(cdp, `return await globalThis.seged.stats(1);`);
console.log("right-kidney probe HU:", JSON.stringify(s1.hu), "voxels:", s1.voxels);
const h1 = await ev<any>(cdp, `return await globalThis.seged.histogram(1);`);
console.log("probe histogram p10/p50/p90:", h1.p10, h1.p50, h1.p90);
await ev(cdp, `return await globalThis.seged.clearLabel(1);`);   // clear the probe
// capture the levels I'll paint through
for (const off of [0.58, 0.66, 0.74]) { await ev(cdp,`return globalThis.seged.view({axial:${off}});`); await cdp.screenshot(`scratchpad/c2/KiTS-00012-ax${Math.round(off*100)}.png`); }
console.log("levels captured");
cdp.close();
