import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 20000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// clear the calibration seed first
await ev(cdp, "return await globalThis.seged.clearLabel(1);");
for (const off of [0.60, 0.68, 0.76]) {
  await ev(cdp, `return globalThis.seged.view({axial:${off}});`);
  await cdp.screenshot(`scratchpad/cand/KiTS-00048-ax${Math.round(off*100)}.png`);
}
console.log("axial screenshots at 0.60, 0.68, 0.76 saved");
cdp.close();
