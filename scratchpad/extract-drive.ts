// Drives Chrome (port 9222) through the KiTS extractor page, one case at a time.
// Each case: navigate extract.html?pid=X, wait for globalThis.__done, log status.
// Prereqs: drop-server.ts on 8150, http.server on 8140 (repo root), headed Chrome on 9222.
import { CDP } from "../harness/cdp.ts";
const PIDS = Deno.args.length ? Deno.args
  : ["KiTS-00013", "KiTS-00057", "KiTS-00081", "KiTS-00111", "KiTS-00010", "KiTS-00012", "KiTS-00048"];
async function ev<T>(cdp: CDP, e: string, ms = 12000): Promise<T | undefined> {
  return await Promise.race([cdp.eval<T>(e), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}
for (const pid of PIDS) {
  const nav = await CDP.attachToPage(9222);
  await nav.send("Page.navigate", { url: `http://127.0.0.1:8140/render/demos/extract.html?pid=${pid}` });
  nav.close();
  await new Promise((r) => setTimeout(r, 2500));
  const cdp = await CDP.attachToPage(9222, "extract.html");
  let done: string | undefined;
  for (let i = 0; i < 150 && !done; i++) {
    done = await ev<string>(cdp, "return globalThis.__done;", 8000);
    if (!done) await new Promise((r) => setTimeout(r, 2000));
  }
  const status = await ev<string>(cdp, "return document.getElementById('s')?.textContent;");
  console.log(`${pid} -> ${done || "TIMEOUT"} | ${status}`);
  cdp.close();
}
console.log("== extraction complete ==");
