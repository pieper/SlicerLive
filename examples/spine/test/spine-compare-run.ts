// spine-compare DRIVER: serve the demo, open it in the harness Chrome (CDP :9222,
// headed — on-screen so a human can watch), wait for __cmpDbg, then verify the
// linked-view behaviour NUMERICALLY (no screenshot eyeballing):
//   • both methods report per-level geometry (labels, voxels, centroids)
//   • jumpLevel("T5") moves the crosshair to the SPINEPS T5 centroid and all
//     slice offsets track it
//   • method opacity tri-state round-trips
// Finishes with a screenshot to the scratchpad for the human, tab left open.
//   deno run -A examples/spine/test/spine-compare-run.ts [case] [coll]
const CDP = "http://localhost:9222";
const PORT = 8137;
const CASE = Deno.args[0] ?? "13800";
const COLL = Deno.args[1] ?? "mets";

// serve the repo root so render/demos/* resolves
const ac = new AbortController();
Deno.serve({ port: PORT, signal: ac.signal, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  try {
    const body = await Deno.readFile("." + path);
    const ct = path.endsWith(".js") ? "text/javascript" : path.endsWith(".html") ? "text/html" : "application/octet-stream";
    return new Response(body, { headers: { "content-type": ct } });
  } catch { return new Response("not found", { status: 404 }); }
});

const url = `http://localhost:${PORT}/examples/spine/spine-compare.html?case=${CASE}&coll=${COLL}`;
const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
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

let ready = false;
for (let i = 0; i < 600 && !ready; i++) {   // zarr fetch + 4 SDF bakes can take a while
  ready = (await evalJson("!!(globalThis.__cmpDbg && globalThis.__cmpDbg.ready())")) === true;
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); };

check("page ready (__cmpDbg present)", ready);
if (ready) {
  const dims = await evalJson("__cmpDbg.dims()") as number[];
  check("dims look like a med grid", Array.isArray(dims) && dims.length === 3 && dims.every((d) => d > 30 && d < 1200), JSON.stringify(dims));

  const spLevels = await evalJson("__cmpDbg.levels('spineps')") as { name: string; voxels: number; centroid: number[] }[];
  const refLevels = await evalJson("__cmpDbg.levels('ref')") as { name: string; voxels: number }[];
  check("SPINEPS levels present", spLevels.length >= 5, `${spLevels.length} levels`);
  check("reference levels present", refLevels.length >= 5, `${refLevels.length} levels`);

  const pick = spLevels.find((l) => l.name === "T5") ?? spLevels[Math.floor(spLevels.length / 2)];
  const jumped = await evalJson(`__cmpDbg.jumpLevel('${pick.name}')`) as number[] | null;
  check(`jumpLevel(${pick.name}) returns its centroid`, !!jumped && jumped.every((x, i) => Math.abs(x - pick.centroid[i]) < 0.01), JSON.stringify(jumped));
  const xh = await evalJson("__cmpDbg.crosshair()") as number[] | null;
  check("crosshair follows jump", !!xh && !!jumped && xh.every((x, i) => Math.abs(x - jumped[i]) < 0.01));
  const offs = await evalJson("__cmpDbg.offsets()") as Record<string, number>;
  check("slice offsets in (0,1) after jump", Object.values(offs).every((o) => o > 0 && o < 1), JSON.stringify(offs));

  // level select auto-focuses: extent drops to "1 vert" and the slices ZOOM in
  const ext0 = await evalJson("__cmpDbg.extent()") as number;
  check("level click switches extent to 1 vert", ext0 === 0, String(ext0));
  const z1 = await evalJson("__cmpDbg.zoom('axial')") as number;
  check("axial zoomed in after level click", z1 > 1.2, `zoom ${z1?.toFixed(2)}`);
  const cam1 = await evalJson("__cmpDbg.camera()") as { focalPoint: number[] };
  check("3D camera focal near level centroid", !!jumped && Math.hypot(
    cam1.focalPoint[0] - jumped[0], cam1.focalPoint[1] - jumped[1], cam1.focalPoint[2] - jumped[2]) < 40,
    JSON.stringify(cam1.focalPoint.map((x) => +x.toFixed(1))));

  // in limited modes the OTHER vertebrae go fully transparent in the 3D shells
  const vis1 = await evalJson("__cmpDbg.visibleLevels('spineps')") as number[];
  check("1 vert: only the selected level visible in 3D", vis1.length === 1, `${vis1.length} visible`);

  await evalJson("__cmpDbg.setExtent(3)");
  const z3 = await evalJson("__cmpDbg.zoom('sagittal')") as number;
  check("±3 zooms out vs 1 vert but stays zoomed", z3 > 1 && z3 <= z1 + 0.01, `zoom ${z3?.toFixed(2)}`);
  const vis3 = await evalJson("__cmpDbg.visibleLevels('spineps')") as number[];
  check("±3: up to 7 levels visible in 3D", vis3.length > vis1.length && vis3.length <= 7, `${vis3.length} visible`);

  await evalJson("__cmpDbg.setExtent(99)");
  const zf = await evalJson("__cmpDbg.zoom('axial')") as number;
  check("full spine resets slice zoom", Math.abs(zf - 1) < 1e-6, String(zf));
  const visF = await evalJson("__cmpDbg.visibleLevels('spineps')") as number[];
  const nAll = (await evalJson("__cmpDbg.levels('spineps')") as unknown[]).length;
  check("full spine restores all levels", visF.length === nAll, `${visF.length}/${nAll}`);

  await evalJson("__cmpDbg.setMethodOpacity('ref', 0.5)");
  const op = await evalJson("__cmpDbg.methodOpacity('ref')") as number;
  check("method opacity round-trips (0.5)", Math.abs(op - 0.5) < 1e-6, String(op));
}

// screenshot for the human
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const out = Deno.env.get("HOME") + "/../.." + "";   // unused; write to scratchpad below
  void out;
  await Deno.writeFile(
    "/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/0dc57828-631d-41c2-84da-ba5fb04fdd3a/scratchpad/spine-compare-shot.png",
    Uint8Array.from(atob(shot.result.data as unknown as string), (c) => c.charCodeAt(0)),
  );
}

console.log("\n  spine-compare verification — " + COLL + "/" + CASE);
console.log("  " + "-".repeat(64));
let fail = 0;
for (const [name, ok, detail] of results) {
  if (!ok) fail++;
  console.log("  " + name.padEnd(48) + (ok ? "ok " : "FAIL") + (detail ? "   " + detail : ""));
}
console.log(fail ? `\n  ❌ ${fail} FAILED` : "\n  ✅ ALL PASSED");
ws.close();
ac.abort();
Deno.exit(fail ? 1 : 0);
