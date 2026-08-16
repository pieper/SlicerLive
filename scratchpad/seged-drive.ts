import { CDP } from "../harness/cdp.ts";
const URL = "http://localhost:8890/seged-app.html?pid=MED_LYMPH_073";
// eval with a hard timeout so a mid-navigation stall can never hang the driver
async function evalT<T>(cdp: CDP, expr: string, ms = 15000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(expr), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms)) ]);
}
// 1) navigate (separate connection), then close so no eval is in flight during navigation
const nav = await CDP.attachToPage(9222);
await nav.send("Page.navigate", { url: URL });
nav.close();
await new Promise((r) => setTimeout(r, 3000));
// 2) re-attach to the now-loaded app page
const cdp = await CDP.attachToPage(9222, "seged-app.html");
console.log("re-attached to app page");
// 3) wait for window.seged, then for the case to load
let ready = false;
for (let i = 0; i < 20 && !ready; i++) { ready = (await evalT<boolean>(cdp, "return !!(globalThis.seged && globalThis.seged.state)")) === true; if (!ready) await new Promise((r)=>setTimeout(r,500)); }
console.log("window.seged present:", ready);
let loaded = false;
for (let i = 0; i < 120 && !loaded; i++) {
  const s = await evalT<{segments:unknown[]}>(cdp, "try { return await globalThis.seged.state(); } catch(e){ return null; }", 8000);
  loaded = !!(s && s.segments && s.segments.length > 0);
  if (!loaded) await new Promise((r)=>setTimeout(r,1500));
}
console.log("case loaded:", loaded);
const state = await evalT(cdp, "return await globalThis.seged.state();");
console.log("STATE:", JSON.stringify(state, null, 2));
await cdp.screenshot("scratchpad/seged-01.png");
console.log("screenshot -> scratchpad/seged-01.png");
cdp.close();
