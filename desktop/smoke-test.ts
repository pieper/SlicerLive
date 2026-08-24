// End-to-end smoke test: open a real gallery demo in the native webview and
// verify it renders — counts non-background pixels by blitting the WebGPU
// canvas into a 2d canvas inside requestAnimationFrame. Numeric ground truth,
// no screenshot eyeballing.
//   deno run -A --unstable-ffi desktop/smoke-test.ts [--url /webgpu/cardiac.html] [--gallery <dir>]
import { Webview, SizeHint } from "jsr:@webview/webview@0.9.0";
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { dirname, join, fromFileUrl, resolve } from "jsr:@std/path@1";

const args = parseArgs(Deno.args, { string: ["url", "gallery"] });
const page = args.url ?? "/webgpu/cardiac.html";
const gallery = resolve(args.gallery ?? join(dirname(dirname(dirname(fromFileUrl(import.meta.url)))), "live"));

const worker = new Worker(new URL("./server-worker.ts", import.meta.url), { type: "module" });
const port = await new Promise<number>((resolve) => {
  worker.onmessage = (e) => resolve(e.data.port);
  worker.postMessage({ root: gallery, port: 4990 });
});

const webview = new Webview(false, { width: 1100, height: 800, hint: SizeHint.NONE });
webview.title = "SlicerLive smoke test";

let failTimer: number;
webview.bind("smokeReport", (json: string) => {
  console.log("SMOKE:", json);
  const r = JSON.parse(json);
  clearTimeout(failTimer);
  setTimeout(() => webview.destroy(), 300);
  Deno.exitCode = r.pass ? 0 : 1;
});

webview.init(`
(() => {
  if (location.pathname === "/__blank") return;
  const t0 = performance.now();
  const sample = () => new Promise((resolveSample) => requestAnimationFrame(() => {
    let best = { nonbg: 0, w: 0, h: 0 };
    for (const c of document.querySelectorAll("canvas")) {
      if (!c.width || !c.height) continue;
      const d = document.createElement("canvas");
      d.width = Math.min(c.width, 256); d.height = Math.min(c.height, 256);
      const ctx = d.getContext("2d");
      ctx.drawImage(c, 0, 0, d.width, d.height);
      const px = ctx.getImageData(0, 0, d.width, d.height).data;
      const bg = [px[0], px[1], px[2]];
      let nonbg = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i] - bg[0]) + Math.abs(px[i+1] - bg[1]) + Math.abs(px[i+2] - bg[2]) > 24) nonbg++;
      }
      if (nonbg > best.nonbg) best = { nonbg, w: c.width, h: c.height };
    }
    resolveSample(best);
  }));
  const poll = async () => {
    const s = await sample();
    const total = 256 * 256;
    if (s.nonbg > total * 0.02) {
      window.smokeReport(JSON.stringify({ pass: true, page: location.pathname,
        nonbgFrac: +(s.nonbg / total).toFixed(3), canvas: s.w + "x" + s.h,
        secs: +((performance.now() - t0) / 1000).toFixed(1),
        gpu: !!navigator.gpu }));
    } else if (performance.now() - t0 > 60000) {
      window.smokeReport(JSON.stringify({ pass: false, page: location.pathname,
        nonbgFrac: +(s.nonbg / total).toFixed(3), gpu: !!navigator.gpu, reason: "no pixels after 60s" }));
    } else setTimeout(poll, 2000);
  };
  addEventListener("load", () => setTimeout(poll, 1500));
})();
`);

failTimer = setTimeout(() => {
  console.log("SMOKE: timeout, no report after 75s");
  Deno.exitCode = 1;
  try { webview.destroy(); } catch { /* already gone */ }
}, 75000);

webview.navigate(`http://127.0.0.1:${port}${page}`);
webview.run();
Deno.exit();
