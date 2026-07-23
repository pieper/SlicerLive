// Harness smoke test: prove the CDP driver works end-to-end against the real gallery.
//   deno run -A harness/verify-harness.ts [url]
// Verifies (with NUMBERS, not eyeballing): WebGPU adapter present, the SlicerLive page
// initializes, synthetic input reaches it, and we can read state back + capture pixels.
import { CDP } from "./cdp.ts";

const URL_ = Deno.args[0] ?? "https://pieper.github.io/live/webgpu/real.html";
const OUT = new URL("./shots/", import.meta.url).pathname;
await Deno.mkdir(OUT, { recursive: true });

const c = await CDP.attachToPage();
await c.send("Runtime.enable");

// surface page console + errors so we can see what the demo is doing
c.on("Runtime.consoleAPICalled", (p) => {
  const e = p as { type: string; args: { value?: unknown; description?: string }[] };
  console.log(`  [page.${e.type}]`, e.args.map((a) => a.value ?? a.description).join(" "));
});
c.on("Runtime.exceptionThrown", (p) => {
  const e = p as { exceptionDetails: { exception?: { description?: string }; text: string } };
  console.log("  [page.error]", e.exceptionDetails.exception?.description ?? e.exceptionDetails.text);
});

// 1) WebGPU actually available in THIS browser (the thing QtWebEngine could not do)
const gpu = await c.eval<Record<string, unknown>>(`
  const r = { hasGPU: !!navigator.gpu };
  if (navigator.gpu) {
    const a = await navigator.gpu.requestAdapter();
    r.adapter = !!a;
    if (a) { r.features = Array.from(a.features).slice(0, 40); r.info = a.info ? {vendor:a.info.vendor, arch:a.info.architecture} : null; }
  }
  return r;
`);
console.log("WebGPU:", JSON.stringify(gpu));

// 2) Load the SlicerLive page and wait for it to finish initializing
console.log(`navigating -> ${URL_}`);
await c.goto(URL_);
const ready = await c.waitFor(
  `document.querySelector('#status') && !/loading|initializing|streaming/i.test(document.querySelector('#status').textContent)`,
  120000,
);
const status = await c.eval<string>(`return (document.querySelector('#status')||{}).textContent || '(no #status)';`);
console.log(`page ready=${ready} · status="${status}"`);

// 3) Is the automation hook present? (added next; harmless if absent)
const hook = await c.eval<unknown>(`return typeof window.__slicerlive === 'undefined' ? null : Object.keys(window.__slicerlive);`);
console.log("window.__slicerlive:", hook ?? "(not present yet)");

// 4) Canvas geometry — needed to aim synthetic input at the right view
const canvases = await c.eval<{ id: string; x: number; y: number; w: number; h: number }[]>(`
  return Array.from(document.querySelectorAll('canvas')).map(c => {
    const r = c.getBoundingClientRect();
    return { id: c.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
`);
console.log("canvases:", JSON.stringify(canvases));

// 5) Synthetic drag on the 3D view — proves browser-level input reaches the page
const three = canvases.find((c) => /three|3d/i.test(c.id)) ?? canvases[0];
if (three) {
  const cx = three.x + three.w / 2, cy = three.y + three.h / 2;
  console.log(`dragging in #${three.id} from (${cx},${cy}) by +120px in x …`);
  await c.drag(cx, cy, cx + 120, cy, { steps: 15 });
  await new Promise((r) => setTimeout(r, 400));
}

await c.screenshot(OUT + "harness-smoke.png");
console.log("screenshot ->", OUT + "harness-smoke.png");
c.close();
