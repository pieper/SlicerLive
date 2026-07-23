// Verify window.__slicerlive gives us exact state, and that browser-level synthetic
// input changes it by the amount the binding math predicts — numeric ground truth,
// not eyeballing a screenshot.
//   deno run -A harness/check-hook.ts [url]
import { CDP } from "./cdp.ts";

const URL_ = Deno.args[0] ?? "http://127.0.0.1:8099/webgpu/real.html";
const c = await CDP.attachToPage();
await c.send("Runtime.enable");
c.on("Runtime.exceptionThrown", (p) => {
  const e = p as { exceptionDetails: { exception?: { description?: string }; text: string } };
  console.log("  [page.error]", e.exceptionDetails.exception?.description ?? e.exceptionDetails.text);
});

console.log(`-> ${URL_}`);
await c.goto(URL_);
const ok = await c.waitFor(`window.__slicerlive && window.__slicerlive.ready`, 120000);
console.log("hook installed:", ok);
if (!ok) { console.log("status:", await c.eval(`return (document.querySelector('#status')||{}).textContent;`)); Deno.exit(1); }

const vol = await c.eval<Record<string, unknown>>(`return window.__slicerlive.getVolume();`);
console.log("volume:", JSON.stringify(vol));
console.log("planes:", JSON.stringify(await c.eval(`return window.__slicerlive.getPlanes();`)));

const before = await c.eval<{ azimuth: number; elevation: number; distance: number; position: number[] }>(
  `return window.__slicerlive.getCamera();`);
console.log("camera BEFORE:", JSON.stringify(before));

// canvas rect for the 3D view
const r = await c.eval<{ x: number; y: number; w: number; h: number }>(`
  const el = document.getElementById('c-threeD'); const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
`);
const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
const DX = 120, DY = 0;
console.log(`synthetic drag in c-threeD: (${cx.toFixed(0)},${cy.toFixed(0)}) dx=${DX} dy=${DY}`);
await c.drag(cx, cy, cx + DX, cy + DY, { steps: 12 });
await new Promise((res) => setTimeout(res, 300));

const after = await c.eval<{ azimuth: number; elevation: number; distance: number; position: number[] }>(
  `return window.__slicerlive.getCamera();`);
console.log("camera AFTER :", JSON.stringify(after));

// The current (ad-hoc) binding is az += dx*0.008, elev -= dy*0.008
const predicted = before.azimuth + DX * 0.008;
const dAz = after.azimuth - before.azimuth;
console.log(`\nazimuth: before=${before.azimuth.toFixed(4)} after=${after.azimuth.toFixed(4)} delta=${dAz.toFixed(4)}`);
console.log(`predicted delta (current ad-hoc binding dx*0.008) = ${(DX * 0.008).toFixed(4)} · predicted azimuth = ${predicted.toFixed(4)}`);
console.log(`MATCH: ${Math.abs(after.azimuth - predicted) < 1e-6 ? "yes" : "NO"}`);
console.log("\nevent log:", JSON.stringify(await c.eval(`return window.__slicerlive.log;`)));
c.close();
