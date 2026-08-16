import { CDP } from "../harness/cdp.ts";
async function ev<T>(cdp: CDP, e: string, ms = 20000): Promise<T | undefined> {
  return await Promise.race([ cdp.eval<T>(e), new Promise<undefined>((r)=>setTimeout(()=>r(undefined),ms)) ]);
}
const cdp = await CDP.attachToPage(9222, "seged-app.html");
const rev = await ev(cdp, "return globalThis.seged.reveal();");
const finalScore = await ev(cdp, "return await globalThis.seged.score();");
const st = await ev(cdp, "return await globalThis.seged.stats(8);");
console.log("REVEAL (actual flaw):", JSON.stringify(rev));
console.log("FINAL Dice:", JSON.stringify(finalScore));
console.log("final node voxels:", (st as any)?.voxels, " HU:", JSON.stringify((st as any)?.hu));
// record the outcome to the session/chat
await ev(cdp, `return globalThis.seged.say("agent", "Reveal confirms a boundary LEAK (radius ${(rev as any).radiusVox}) on label 8: GT ${(rev as any).gtCount} vox, degraded ${(rev as any).degradedCount} vox. Intensity threshold recovered Dice ${(finalScore as any).baseline.toFixed(2)} -> ${(finalScore as any).diceVsGT.toFixed(2)}. Residual is iso-dense soft-tissue leak that intensity alone cannot separate.");`);
const sess = await ev(cdp, "return globalThis.seged.session();");
await Deno.writeTextFile("scratchpad/exp-session.json", JSON.stringify(sess, null, 2));
console.log("session ->", Array.isArray(sess)? sess.length : "?", "events saved");
cdp.close();
