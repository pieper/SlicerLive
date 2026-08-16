import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 20000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const PID="KiTS-00012";
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: `http://127.0.0.1:8140/render/demos/seged-app.html?pid=${PID}&blind=1` }); nav.close();
await new Promise(r=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
let loaded=false;
for (let i=0;i<80 && !loaded;i++){ const s=await ev<{segments:any[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
if(!loaded){ console.log("FAILED:", await ev(cdp,"return document.getElementById('status')?.textContent;")); Deno.exit(1); }
const st=await ev<{dims:number[],segments:any[]}>(cdp,"return await globalThis.seged.state();");
console.log(PID,"dims=",JSON.stringify(st!.dims),"classes:",st!.segments.map(s=>`${s.name}[L${s.num}]`).join(","));
for (const [tag,v] of [["cor38",{coronal:0.38}],["cor45",{coronal:0.45}],["ax55",{axial:0.55}],["ax65",{axial:0.65}],["ax72",{axial:0.72}]] as any) {
  await ev(cdp,`return globalThis.seged.view(${JSON.stringify(v)});`); await cdp.screenshot(`scratchpad/c2/${PID}-${tag}.png`);
}
console.log("exploration screenshots saved");
cdp.close();
