// LEVEL-STEP EQUIVALENCE — stepping levels with the arrows must render the SAME segmentation as
// arriving at that level any other way.
//
// Per-label visibility takes a fast path: rewrite the changed labels' box in the labelmap and
// re-flood only that box (~14 ms, against ~390 ms for a full rebake — which is what makes holding
// an arrow key down feel live). Two things made that box lie:
//
//   1. The jump-flood schedule was sized to the BOX, so a voxel inside it whose nearest surface lay
//      outside found no seed at all, reported 1e3 mm, and the sphere-trace skip leapt straight
//      through the surface that was really there — the shell came back cut along a flat plane, which
//      reads as a clipping plane that moves when you rotate.
//   2. The re-init halo (8 voxels) was narrower than the gap to the next vertebra, so seeds just
//      outside the box still pointed at the surface deleted inside it, and the level you just hid
//      stayed on screen.
//
// Measured on myeloma/Myel_046 before the fix: one arrow step in "1 vert" rendered 3221 lit px where
// a full rebake of the same level rendered 4994; five steps left a whole extra vertebra drawn.
//
//   deno run -A examples/spine/test/level-step-equivalence.ts [case] [coll]
// Needs the harness Chrome on :9222. Serves the repo itself.
const CDP = "http://localhost:9222";
const PORT = 8141;
const CASE = Deno.args[0] ?? "Myel_046";
const COLL = Deno.args[1] ?? "myeloma";

const ac = new AbortController();
Deno.serve({ port: PORT, signal: ac.signal, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  try {
    const body = await Deno.readFile("." + path);
    const ct = path.endsWith(".js") ? "text/javascript" : path.endsWith(".html") ? "text/html" : "application/octet-stream";
    return new Response(body, { headers: { "content-type": ct, "cache-control": "no-store" } });
  } catch { return new Response("not found", { status: 404 }); }
});

const url = `http://localhost:${PORT}/examples/spine/spine-compare.html?case=${CASE}&coll=${COLL}`;
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
await new Promise((r) => ws.onopen = () => r(null));
const call = (m: string, p: Record<string, unknown> = {}) =>
  new Promise<{ result?: { result?: { value?: unknown }; data?: string } }>((res) => {
    const i = ++id; pending.set(i, res as (v: unknown) => void); ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
const ev = async (e: string) => (await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

let ready = false;
for (let i = 0; i < 600 && !ready; i++) {
  ready = (await ev("!!(globalThis.__cmpDbg && __cmpDbg.ready() && __cmpDbg.scenes)")) === true;
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) { console.log("FAIL — page never became ready"); ac.abort(); Deno.exit(1); }
await call("Page.bringToFront");
await ev("['axial','sagittal','coronal'].forEach(c => document.getElementById('col-'+c)?.click()), 1");
await new Promise((r) => setTimeout(r, 800));

/** Pin the camera before measuring. Stepping levels PRESERVES zoom (that is the point of it) while
 *  the full-rebake reference reframes, so without this the comparison reads a camera difference as a
 *  bake difference — it did, as a steady ~4%. */
const pinCamera = async (level: number) => {
  const all = JSON.parse(await ev("JSON.stringify(__cmpDbg.levels('ref').concat(__cmpDbg.levels('spineps')))") as string) as { label: number; centroid: number[] }[];
  const c = all.find((x) => x.label === level)?.centroid;
  if (!c) return;
  await ev(`__cmpDbg.setCamera([${c[0]}, ${c[1] - 260}, ${c[2] + 90}], [${c[0]}, ${c[1]}, ${c[2]}], [0,0,1])`);
  await new Promise((r) => setTimeout(r, 1500));
};

/** Lit pixels and the dominant hues of one method's 3D cell — hues catch a label that should be
 *  hidden but is still drawn; lit pixels catch a surface that was cut away. */
const look = async (which: string) => {
  const b = JSON.parse(await ev(`(() => { const c = document.getElementById('c-${which}-threeD'); const r = c.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`) as string);
  const s = await call("Page.captureScreenshot", { format: "png", clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
  return JSON.parse(await ev(`(async () => { const img = new Image(); img.src = ${JSON.stringify("data:image/png;base64," + s.result!.data)};
    await img.decode(); const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0,0,cv.width,cv.height).data;
    const hues = {}; let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i+1], bb = d[i+2];
      if (Math.max(r,gg,bb) < 60) continue; n++;
      const mx = Math.max(r,gg,bb), mn = Math.min(r,gg,bb);
      if (mx - mn < 25) { hues['w'] = (hues['w']||0)+1; continue; }
      let h = 0; if (mx===r) h = 60*(((gg-bb)/(mx-mn))%6); else if (mx===gg) h = 60*((bb-r)/(mx-mn)+2); else h = 60*((r-gg)/(mx-mn)+4);
      const k = String(Math.round(((h+360)%360)/30)*30);
      hues[k] = (hues[k]||0)+1;
    }
    return JSON.stringify({ lit: n, hues: Object.entries(hues).filter(([,v]) => v > n*0.06).map(([k]) => k).sort() }); })()`) as string);
};

const results: [string, boolean, string][] = [];
for (const steps of [1, 3, 5]) {
  await ev("__cmpDbg.jumpLevel('T4')");
  await ev("__cmpDbg.setExtent(0)");                       // "1 vert": exactly one level per row
  await new Promise((r) => setTimeout(r, 3500));
  for (let k = 0; k < steps; k++) { await ev("__cmpDbg.stepLevel(1)"); await new Promise((r) => setTimeout(r, 2200)); }
  const level = await ev("__cmpDbg.currentLevel()") as number;
  await pinCamera(level);
  const stepped: Record<string, { lit: number; hues: string[] }> = {};
  for (const row of ["spineps", "ref"]) stepped[row] = await look(row);
  // the same level, reached by a full rebake
  await ev("__cmpDbg.setExtent(99)"); await new Promise((r) => setTimeout(r, 2500));
  await ev("__cmpDbg.setExtent(0)"); await new Promise((r) => setTimeout(r, 3500));
  await pinCamera(level);
  for (const row of ["spineps", "ref"]) {
    const full = await look(row);
    const s = stepped[row];
    const dLit = Math.abs(s.lit - full.lit) / Math.max(full.lit, 1);
    const sameHues = JSON.stringify(s.hues) === JSON.stringify(full.hues);
    const ok = dLit < 0.03 && sameHues;
    results.push([`${steps} step(s) → level ${level}, ${row}`, ok,
      `stepped ${s.lit}px ${JSON.stringify(s.hues)} vs full ${full.lit}px ${JSON.stringify(full.hues)}`]);
  }
}
console.log("\n  level-step equivalence — " + COLL + "/" + CASE);
let pass = true;
for (const [name, ok, detail] of results) {
  if (!ok) pass = false;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}\n          ${detail}`);
}
console.log("\n  " + (pass ? "PASS — stepping levels renders what a full rebake renders" : "FAIL — the level-step fast path disagrees with a full rebake"));
ac.abort();
Deno.exit(pass ? 0 : 1);
