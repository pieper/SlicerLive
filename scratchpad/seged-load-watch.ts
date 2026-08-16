import { CDP } from "../harness/cdp.ts";
async function evalT<T>(cdp: CDP, expr: string, ms = 10000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(expr), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const URL = "http://localhost:8890/seged-app.html?pid=MED_LYMPH_073";
const nav = await CDP.attachToPage(9222); await nav.send("Page.navigate", { url: URL }); nav.close();
await new Promise((r)=>setTimeout(r,3000));
const cdp = await CDP.attachToPage(9222, "seged-app.html");
let last = "";
for (let i = 0; i < 55; i++) {
  const st = await evalT<string>(cdp, "return document.getElementById('status')?.textContent || '';", 8000);
  const loaded = await evalT<boolean>(cdp, "try { const s = await globalThis.seged?.state?.(); return !!(s && s.segments.length); } catch(e){ return false; }", 8000);
  if (st !== last) { console.log(`[${i*5}s] ${st}`); last = st ?? ""; }
  if (loaded) { console.log("LOADED"); const s = await evalT(cdp,"return await globalThis.seged.state();"); console.log("STATE:", JSON.stringify(s)); break; }
  if ((st||"").startsWith("error")) { console.log("FAILED:", st); break; }
  await new Promise((r)=>setTimeout(r,5000));
}
await cdp.screenshot("scratchpad/seged-load.png");
cdp.close();
