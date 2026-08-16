import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 25000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const URL = "http://127.0.0.1:8140/render/demos/seged-app.html?pid=KiTS-00111";
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: URL }); nav.close();
await new Promise((r)=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
console.log("loading KiTS-00111…");
let loaded=false;
for (let i=0;i<80 && !loaded;i++){ const s=await ev<{segments:any[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
if(!loaded){ console.log("FAILED status:", await ev(cdp,"return document.getElementById('status')?.textContent;")); Deno.exit(1); }
const st = await ev<{dims:number[],segments:any[]}>(cdp,"return await globalThis.seged.state();");
console.log("dims:", JSON.stringify(st!.dims));
console.log("segments:", st!.segments.map(s=>`${s.name}[label ${s.num}, ${s.voxels}vox]`).join(" | "));
for (const s of st!.segments) {
  const ls = await ev<any>(cdp, `return await globalThis.seged.stats(${s.num});`);
  console.log(`  label ${s.num} "${s.name}": HU min=${ls.hu.min} median=${ls.hu.median} max=${ls.hu.max} fracBelow0=${ls.hu.fracBelow0.toFixed(2)}  bbox=${JSON.stringify(ls.bboxVox)}`);
}
cdp.close();
