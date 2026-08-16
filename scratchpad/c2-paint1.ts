import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 30000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// paint level by level (paintDabs uses the current axial offset)
const levels = [0.56,0.60,0.64,0.68,0.72,0.76];
for (const L of levels) {
  await ev(cdp, `return globalThis.seged.view({axial:${L}});`);
  const dabs = [
    {o:"axial",u:0.27,v:0.58,label:1,d:22},   // right kidney
    {o:"axial",u:0.44,v:0.56,label:1,d:12},   // left kidney parenchyma (medial rim)
    {o:"axial",u:0.51,v:0.54,label:2,d:26},   // left tumor (bulk of the mass)
  ];
  await ev(cdp, `return await globalThis.seged.paintDabs(${JSON.stringify(dabs)});`, 40000);
}
// HU gate: kidney is soft tissue (>0, exclude fat/air); tumor can have necrosis (keep >-40)
await ev(cdp, `return await globalThis.seged.threshold(1, 0, 300);`, 40000);
await ev(cdp, `return await globalThis.seged.threshold(2, -40, 300);`, 40000);
const score = await ev(cdp, `return await globalThis.seged.scoreCandidate();`);
console.log("SCORE after pass 1:", JSON.stringify(score));
await ev(cdp, `return globalThis.seged.view({axial:0.70});`);
await cdp.screenshot("scratchpad/c2/KiTS-00012-pass1.png");
console.log("screenshot saved");
cdp.close();
