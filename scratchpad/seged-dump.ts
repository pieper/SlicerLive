import { CDP } from "../harness/cdp.ts";
try {
  const cdp = await CDP.attachToPage(9222, "seged-app.html");
  const sess = await Promise.race([ cdp.eval("return (globalThis.seged?.session?.()) || [];"), new Promise((r)=>setTimeout(()=>r("timeout"),8000)) ]);
  await Deno.writeTextFile("scratchpad/seged-session.json", JSON.stringify(sess, null, 2));
  console.log("session saved -> scratchpad/seged-session.json (", Array.isArray(sess)? sess.length : sess, "events)");
  cdp.close();
} catch (e) { console.log("dump skipped:", (e as Error).message); }
