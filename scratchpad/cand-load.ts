import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 25000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const PID = "KiTS-00048";
const URL = `http://127.0.0.1:8140/render/demos/seged-app.html?pid=${PID}&blind=1`;
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: URL }); nav.close();
await new Promise(r=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
console.log(`loading blind candidate ${PID}…`);
let loaded=false;
for (let i=0;i<80 && !loaded;i++){ const s=await ev<{segments:any[]}>(cdp,"try{return await globalThis.seged?.state?.();}catch(e){return null;}",8000); loaded=!!(s&&s.segments&&s.segments.length); if(!loaded) await new Promise(r=>setTimeout(r,1500)); }
if(!loaded){ console.log("FAILED:", await ev(cdp,"return document.getElementById('status')?.textContent;")); Deno.exit(1); }
const st = await ev<{dims:number[],segments:any[]}>(cdp,"return await globalThis.seged.state();");
console.log("dims:", JSON.stringify(st!.dims), " target classes:", st!.segments.map(s=>`${s.name}[L${s.num}] editableVox=${s.voxels}`).join(", "));
// Explore the CT (seg hidden). Coronal is best for kidneys; scroll a few posterior coronal levels + axial levels.
const shots: [string, any][] = [
  ["cor35", {coronal:0.35}], ["cor42", {coronal:0.42}], ["cor50", {coronal:0.50}],
  ["ax40", {axial:0.40}], ["ax50", {axial:0.50}], ["ax60", {axial:0.60}],
];
for (const [name, v] of shots) { await ev(cdp, `return globalThis.seged.view(${JSON.stringify(v)});`); await cdp.screenshot(`scratchpad/cand/${PID}-${name}.png`); }
console.log("exploration screenshots saved:", shots.map(s=>s[0]).join(", "));
cdp.close();
