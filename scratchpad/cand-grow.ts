import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 40000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
// set the two slices the seeds reference
await ev(cdp, `return globalThis.seged.view({axial:0.68, coronal:0.42});`);
// FG = kidney (label 1): both kidneys on the axial + vertical span on the coronal (right kidney)
// BG = label 5: liver, vessels, spine, bowel, fat, muscle, spleen
const seeds = [
  {o:"axial",u:0.34,v:0.60,label:1,d:8},{o:"axial",u:0.33,v:0.66,label:1,d:8},
  {o:"axial",u:0.47,v:0.56,label:1,d:8},{o:"axial",u:0.48,v:0.61,label:1,d:8},
  {o:"coronal",u:0.28,v:0.33,label:1,d:8},{o:"coronal",u:0.29,v:0.42,label:1,d:8},{o:"coronal",u:0.28,v:0.48,label:1,d:8},
  {o:"axial",u:0.20,v:0.35,label:5,d:12},{o:"axial",u:0.62,v:0.32,label:5,d:12},
  {o:"axial",u:0.42,v:0.55,label:5,d:8},{o:"axial",u:0.42,v:0.76,label:5,d:10},
  {o:"axial",u:0.28,v:0.42,label:5,d:10},{o:"axial",u:0.56,v:0.42,label:5,d:10},
  {o:"axial",u:0.10,v:0.55,label:5,d:12},{o:"axial",u:0.88,v:0.55,label:5,d:12},{o:"axial",u:0.40,v:0.86,label:5,d:10},
];
const r = await ev(cdp, `return await globalThis.seged.growFromViewSeeds(${JSON.stringify(seeds)}, {intensityRange:400, edgeLo:0.1, edgeHi:0.5});`, 60000);
console.log("growcut:", JSON.stringify(r));
const cleared = await ev(cdp, `return await globalThis.seged.clearLabel(5);`);
console.log("cleared bg(label5):", cleared, "voxels");
const score = await ev(cdp, `return await globalThis.seged.scoreCandidate();`);
console.log("SCORE vs hidden GT:", JSON.stringify(score));
await ev(cdp, `return globalThis.seged.view({axial:0.68});`);
await cdp.screenshot("scratchpad/cand/KiTS-00048-mine.png");
// now reveal GT for comparison
await ev(cdp, `return await globalThis.seged.showGroundTruth();`);
await ev(cdp, `return globalThis.seged.view({axial:0.68});`);
await cdp.screenshot("scratchpad/cand/KiTS-00048-gt.png");
console.log("screenshots: mine + gt saved");
cdp.close();
