import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 25000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cases = ["KiTS-00111","KiTS-00010","KiTS-00057","KiTS-00081","KiTS-00013"];
const shots = new Set(["KiTS-00111","KiTS-00010"]);   // deep screenshot exploration for these
const summary: any[] = [];
for (const pid of cases) {
  const URL = `http://127.0.0.1:8140/render/demos/seged-app.html?pid=${pid}`;
  const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: URL }); nav.close();
  await new Promise(r=>setTimeout(r,3000));
  const cdp = await CDP.attachToPage(9222, "seged-app.html");
  let loaded=false;
  for (let i=0;i<70 && !loaded;i++){ const s=await ev<{segments:any[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
  if(!loaded){ console.log(pid,"LOAD FAILED"); summary.push({pid, error:true}); cdp.close(); continue; }
  const st = await ev<{dims:number[],segments:any[]}>(cdp,"return await globalThis.seged.state();");
  const segs:any[]=[];
  for (const s of st!.segments) {
    const h = await ev<any>(cdp, `return await globalThis.seged.histogram(${s.num});`);
    segs.push({ num:s.num, name:s.name, count:h.count, p10:h.p10, p50:h.p50, p90:h.p90, mean:Math.round(h.mean), counts:h.counts });
  }
  summary.push({ pid, dims:st!.dims, segs });
  console.log(`${pid} dims=${JSON.stringify(st!.dims)} :: ` + segs.map(s=>`${s.name}[L${s.num}] n=${s.count} HU p10/p50/p90=${s.p10}/${s.p50}/${s.p90}`).join("  |  "));
  if (shots.has(pid)) {
    // center MPR on the tumor (Mass) if present else kidney; screenshot slices + a 3D orbit
    const massLabel = st!.segments.find(s=>/mass|tumor/i.test(s.name))?.num ?? st!.segments[0].num;
    await ev(cdp, `return await globalThis.seged.focus(${massLabel});`);
    await ev(cdp, `return globalThis.seged.orbit(0,0,false);`);
    await cdp.screenshot(`scratchpad/kits/${pid}-focus.png`);
    await ev(cdp, `return globalThis.seged.orbit(90,10,true);`);
    await cdp.screenshot(`scratchpad/kits/${pid}-3d-az90.png`);
    console.log(`  screenshots -> ${pid}-focus.png, ${pid}-3d-az90.png`);
  }
  cdp.close();
}
await Deno.writeTextFile("scratchpad/kits/summary.json", JSON.stringify(summary,null,2));
console.log("summary -> scratchpad/kits/summary.json");
