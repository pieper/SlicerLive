import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 20000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const URL = "http://127.0.0.1:8140/render/demos/seged-app.html?pid=MED_LYMPH_073";
await CDP.waitForChrome(9222);
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: URL }); nav.close();
await new Promise((r)=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
console.log("loading (DICOM from IDC, ~1 min)…");
let loaded = false;
for (let i=0;i<80 && !loaded;i++){ const s=await ev<{segments:unknown[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
console.log("loaded:", loaded);
if (!loaded) { console.log("status:", await ev(cdp,"return document.getElementById('status')?.textContent;")); Deno.exit(1); }
// apply the blinded flaw (I do not inspect which direction/params)
const deg = await ev(cdp, "return await globalThis.seged.degrade();");
console.log("blinded flaw applied ->", JSON.stringify(deg));
const label = (deg as any).label;
// focus the MPR + 3D on the affected node and read its CURRENT stats (diagnosis, not GT)
const st = await ev(cdp, `return await globalThis.seged.focus(${label});`);
console.log("focus stats (degraded node):", JSON.stringify(st, null, 2));
const base = await ev(cdp, "return await globalThis.seged.score();");
console.log("baseline Dice vs hidden GT:", JSON.stringify(base));
await cdp.screenshot("scratchpad/exp1-degraded-focus.png");
console.log("screenshot -> scratchpad/exp1-degraded-focus.png");
cdp.close();
