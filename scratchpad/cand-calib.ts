import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 25000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const PID="KiTS-00048";
const URL = `http://127.0.0.1:8140/render/demos/seged-app.html?pid=${PID}&blind=1`;
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: URL }); nav.close();
await new Promise(r=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
let loaded=false;
for (let i=0;i<80 && !loaded;i++){ const s=await ev<{segments:any[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
if(!loaded){ console.log("FAILED:", await ev(cdp,"return document.getElementById('status')?.textContent;")); Deno.exit(1); }
// two calibration seeds on the CORONAL view at off=0.42: TOP-CENTER (u.5,v.2) label 1, LEFT-CENTER (u.2,v.5) label 2
await ev(cdp, `return globalThis.seged.view({coronal:0.42});`);
const a = await ev(cdp, `return await globalThis.seged.placeSeed('coronal',0.5,0.2,0.42,1,{diameterMm:14});`);
const b = await ev(cdp, `return await globalThis.seged.placeSeed('coronal',0.2,0.5,0.42,2,{diameterMm:14});`);
console.log("seed TOP-CENTER(u.5,v.2) label1 RAS=", JSON.stringify(a));
console.log("seed LEFT-CENTER(u.2,v.5) label2 RAS=", JSON.stringify(b));
await ev(cdp, `return globalThis.seged.view({coronal:0.42});`);
await cdp.screenshot("scratchpad/cand/KiTS-00048-calib.png");
console.log("calibration screenshot saved");
cdp.close();
