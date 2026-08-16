import { CDP } from "../harness/cdp.ts";
const cdp = await CDP.attachToPage(9222, "seged-app.html");
const r = await Promise.race([
  cdp.eval(`
    const url = 'https://idc-open-data.s3.us-east-1.amazonaws.com/?list-type=2&prefix=075fa3e5-cbd1-41f9-bfa4-e334cc03992d%2F&max-keys=3';
    const t0 = performance.now();
    try {
      const resp = await fetch(url);
      const txt = await resp.text();
      return { status: resp.status, ms: Math.round(performance.now()-t0), sample: txt.slice(0, 300) };
    } catch(e) { return { err: String(e), ms: Math.round(performance.now()-t0) }; }
  `),
  new Promise((r)=>setTimeout(()=>r({timeout:true}),30000))
]);
console.log(JSON.stringify(r, null, 2));
cdp.close();
