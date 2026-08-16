import { CDP } from "../harness/cdp.ts";
async function evalT<T>(cdp: CDP, expr: string, ms = 12000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(expr), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
const status = await evalT<string>(cdp, "return document.getElementById('status')?.textContent || '(none)';");
console.log("STATUS:", status);
const hasSeged = await evalT<boolean>(cdp, "return !!(globalThis.seged && globalThis.seged.state);");
console.log("window.seged:", hasSeged);
if (hasSeged) {
  const s = await evalT(cdp, "try { return await globalThis.seged.state(); } catch(e){ return {err:String(e)}; }");
  console.log("STATE:", JSON.stringify(s));
}
const chat = await evalT<string>(cdp, "return [...document.querySelectorAll('#chat-log .msg')].map(m=>m.textContent).join(' || ');");
console.log("CHAT:", chat);
await cdp.screenshot("scratchpad/seged-peek.png");
console.log("screenshot -> scratchpad/seged-peek.png");
cdp.close();
