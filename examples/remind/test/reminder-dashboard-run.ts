// ReMINDer dashboard DRIVER: serve the page, open it in the harness Chrome (CDP :9222,
// headed), and verify the collection summary against the index it claims to summarise —
// stat tiles, timeline coverage, the per-case grid, the filters, and the drilldown wiring.
// The numbers are recomputed here from remind-index.json rather than trusted from the page.
//   deno run -A examples/remind/test/reminder-dashboard-run.ts
const CDP = "http://localhost:9222";
const PORT = 8140;
const SHOTS = "/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/8e0d7e02-9988-4c28-add5-94a660662f5a/scratchpad";

const ac = new AbortController();
Deno.serve({ port: PORT, signal: ac.signal, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  try {
    const body = await Deno.readFile("." + path);
    const ct = path.endsWith(".js") ? "text/javascript" : path.endsWith(".html") ? "text/html"
      : path.endsWith(".json") ? "application/json" : "application/octet-stream";
    return new Response(body, { headers: { "content-type": ct } });
  } catch { return new Response("not found", { status: 404 }); }
});

const url = `http://localhost:${PORT}/examples/remind/reminder.html`;
const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
};
await new Promise((r) => ws.onopen = () => r(null));
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<{ result?: { result?: { value?: unknown }; data?: string } }>((res) => {
    const i = ++id; pending.set(i, res as (v: unknown) => void); ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJson = async (expr: string): Promise<unknown> => {
  const r = await call("Runtime.evaluate", { expression: `JSON.stringify(${expr})`, returnByValue: true, awaitPromise: true });
  const v = r.result?.result?.value as string | undefined;
  return v === undefined ? undefined : JSON.parse(v);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ground truth, recomputed from the index the page reads
const index = JSON.parse(await Deno.readTextFile("examples/remind/remind-index.json"));
const us3 = index.cases.filter((c: { series: { tp: string }[] }) =>
  new Set(c.series.filter((e) => e.tp.startsWith("pre_") || e.tp === "post_dura").map((e) => e.tp)).size === 3).length;
const residual = index.cases.filter((c: { series: { segs: { s: string }[] }[] }) =>
  c.series.some((e) => e.segs.some((g) => g.s === "tumor_residual"))).length;

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = (await evalJson("document.querySelectorAll('#cov tbody tr').length > 0")) === true;
  if (!ready) await sleep(250);
}

const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); };
const err = await evalJson("document.querySelector('#err').textContent") as string;

check("dashboard rendered", ready, err ? "page error: " + err : "");
if (ready) {
  const tiles = await evalJson("[...document.querySelectorAll('.stat .v')].map(e=>e.textContent)") as string[];
  check("stat tiles show the index totals", tiles[0] === String(index.stats.cases) && tiles[1] === index.stats.series.toLocaleString(),
    tiles.join(" · "));

  const stages = await evalJson("[...document.querySelectorAll('.stage .v')].map(e=>parseInt(e.textContent))") as number[];
  const want = index.stats.timeline.map((t: { cases: number }) => t.cases);
  check("timeline coverage matches the index", JSON.stringify(stages) === JSON.stringify(want),
    `${stages.join("/")} vs ${want.join("/")}`);

  const nRows = await evalJson("document.querySelectorAll('#cov tbody tr').length") as number;
  check("coverage grid has a row per case", nRows === index.stats.cases, `${nRows} rows`);

  const nCells = await evalJson("document.querySelectorAll('#cov tbody tr:first-child .cell').length") as number;
  check("grid has 5 stage + 6 structure columns", nCells === 11, `${nCells} cells in row 1`);

  // filters scope the grid — recomputed counts, not the page's own arithmetic
  await evalJson("document.querySelector('[data-f=\"us3\"]').click()");
  await sleep(120);
  const n3 = await evalJson("document.querySelectorAll('#cov tbody tr').length") as number;
  check("filter: all three ultrasound stages", n3 === us3, `${n3} cases (expected ${us3})`);

  await evalJson("document.querySelector('[data-f=\"residual\"]').click()");
  await sleep(120);
  const nr = await evalJson("document.querySelectorAll('#cov tbody tr').length") as number;
  check("filter: has residual-tumour label", nr === residual, `${nr} cases (expected ${residual})`);

  await evalJson("document.querySelector('[data-f=\"all\"]').click()");
  await sleep(120);

  // the grid is sorted least-covered first, so the gaps are what you see
  const firstPid = await evalJson("document.querySelector('#cov tbody tr').dataset.pid") as string;
  const covOf = (pid: string) => {
    const c = index.cases.find((x: { pid: string }) => x.pid === pid)!;
    return new Set(c.series.map((e: { tp: string }) => e.tp)).size;
  };
  const lastPid = await evalJson("document.querySelector('#cov tbody tr:last-child').dataset.pid") as string;
  check("incomplete cases sort to the top", covOf(firstPid) <= covOf(lastPid), `${firstPid} (${covOf(firstPid)}) … ${lastPid} (${covOf(lastPid)})`);

  // drilldown opens the viewer for the clicked case
  await evalJson("document.querySelector('#cov tbody tr').click()");
  await sleep(400);
  const src = await evalJson("document.querySelector('#drill-body iframe')?.src ?? ''") as string;
  check("row click opens the drilldown for that case", src.includes(`case=${firstPid}`), src.split("/").pop() ?? "");
  const hidden = await evalJson("document.querySelector('#drill').hidden") as boolean;
  check("drilldown modal is visible", hidden === false);
}

await sleep(2500);   // let the embedded viewer paint something before the shot
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  await Deno.writeFile(`${SHOTS}/reminder-drill.png`,
    Uint8Array.from(atob(shot.result.data as unknown as string), (c) => c.charCodeAt(0)));
}
await evalJson("document.querySelector('#drill-close').click()");
await sleep(300);
const shot2 = await call("Page.captureScreenshot", { format: "png" });
if (shot2.result?.data) {
  await Deno.writeFile(`${SHOTS}/reminder-dashboard.png`,
    Uint8Array.from(atob(shot2.result.data as unknown as string), (c) => c.charCodeAt(0)));
}

console.log("\n  ReMINDer dashboard verification");
console.log("  " + "-".repeat(72));
let fail = 0;
for (const [name, ok, detail] of results) {
  if (!ok) fail++;
  console.log("  " + name.padEnd(48) + (ok ? "ok  " : "FAIL") + (detail ? "   " + detail : ""));
}
console.log(fail ? `\n  ❌ ${fail} FAILED` : "\n  ✅ ALL PASSED");
ws.close();
ac.abort();
Deno.exit(fail ? 1 : 0);
