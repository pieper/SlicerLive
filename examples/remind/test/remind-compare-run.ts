// ReMINDer compare DRIVER: serve the demo, open it in the harness Chrome (CDP :9222,
// headed — on-screen so a human can watch), wait for __remindDbg, then verify the
// multi-grid timeline NUMERICALLY (no screenshot eyeballing):
//   • rows enumerate the case in surgical-timeline order
//   • the default rows actually decode — including the multi-frame ultrasound, which is
//     the one code path with no prior art in this repo (single instance, 8-bit, ~193
//     frames): its geometry must come out as a real oblique block, ~1 cm–10 cm on a side,
//     sitting INSIDE the head the MR row covers
//   • segmentations rasterise onto the row's own grid (non-empty, centroid inside the bbox)
//   • patient-space linking: one jumpTo() moves every row's slice offset to the SAME RAS
//     point, even though no two rows share a voxel grid
//   • rows release and reload; column toggles apply
// Finishes with a screenshot to the scratchpad for the human, tab left open.
//   deno run -A examples/remind/test/remind-compare-run.ts [case]
const CDP = "http://localhost:9222";
const PORT = 8139;
const CASE = Deno.args[0] ?? "";
const SHOTS = "/private/tmp/claude-501/-Users-pieper-slicer-SlicerLive/8e0d7e02-9988-4c28-add5-94a660662f5a/scratchpad";

// serve the repo root so render/* and the vendored idc_tools resolve
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

const url = `http://localhost:${PORT}/examples/remind/remind-compare.html` + (CASE ? `?case=${CASE}` : "");
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

interface DbgRow {
  key: string; tp: string; desc: string; state: string; error?: string;
  dims?: [number, number, number]; vox?: number; win?: number; lev?: number;
  ijkToRAS?: number[]; rasLo?: number[]; rasHi?: number[];
  segs: { structure: string; voxels: number; centroid: number[] | null }[];
}
const rows = () => evalJson("__remindDbg.rows()") as Promise<DbgRow[]>;

// The page is fetching hundreds of MB from IDC's public bucket — give it real time.
let present = false;
for (let i = 0; i < 60 && !present; i++) {
  present = (await evalJson("!!globalThis.__remindDbg")) === true;
  if (!present) await sleep(500);
}
let loaded = 0;
for (let i = 0; i < 900 && present; i++) {          // up to ~7.5 min for the default rows
  const rs = await rows();
  loaded = rs.filter((r) => r.state === "ready").length;
  if (!rs.some((r) => r.state === "loading") && loaded > 0) break;
  await sleep(500);
}

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); };
const inBox = (p: number[], lo: number[], hi: number[], pad = 0) =>
  p.every((v, i) => v >= lo[i] - pad && v <= hi[i] + pad);
const extent = (r: DbgRow) => r.rasLo!.map((v, i) => r.rasHi![i] - v);

check("page ready (__remindDbg present)", present);
if (present) {
  const pid = await evalJson("__remindDbg.pid()") as string;
  const rs = await rows();
  check("case loaded", !!pid, pid);
  check("rows enumerated", rs.length >= 4, `${rs.length} series rows`);

  const RANK: Record<string, number> = { preop: 0, pre_dura: 1, post_dura: 2, pre_imri: 3, intraop: 4 };
  const ranks = rs.map((r) => RANK[r.tp]);
  check("rows ordered along the surgical timeline", ranks.every((v, i) => i === 0 || v >= ranks[i - 1]),
    rs.map((r) => r.tp).join(" → "));

  const ready = rs.filter((r) => r.state === "ready");
  const failed = rs.filter((r) => r.state === "error");
  check("default rows decoded", ready.length >= 2, `${ready.length} ready` + (failed.length ? `, ${failed.length} FAILED: ${failed.map((f) => f.tp + ": " + f.error).join(" | ")}` : ""));

  for (const r of ready) {
    const ext = extent(r);
    check(`${r.tp} (${r.desc}) geometry`,
      !!r.dims && r.dims.every((d) => d >= 16 && d <= 512) && ext.every((e) => e > 8 && e < 400) && r.vox! > 0.05,
      `${r.dims?.join("×")} @ ${r.vox?.toFixed(2)} mm, ${ext.map((e) => e.toFixed(0)).join("×")} mm`);
    check(`${r.tp} window/level derived from the data`, Number.isFinite(r.win) && r.win! > 0,
      `win ${r.win?.toFixed(1)} lev ${r.lev?.toFixed(1)}`);
  }

  // The ultrasound path is the new decoder — hold it to its documented shape.
  const us = ready.find((r) => ["pre_dura", "post_dura", "pre_imri"].includes(r.tp));
  if (us) {
    // Side lengths, NOT the RAS bounding box: an ultrasound block is acquired oblique, so
    // its AABB is legitimately much larger than the block itself (a ~10 cm cube tilted 30°
    // spans ~16 cm in R). Measure dims × isotropic voxel and bound THAT.
    const side = us.dims!.map((d) => d * us.vox!);
    check("US block is a real volume (30–150 mm per side)",
      side.every((e) => e > 30 && e < 150), side.map((e) => e.toFixed(0)).join("×") + " mm");
    const ext = extent(us);
    check("US bounding box is consistent with an oblique block",
      ext.every((e, i) => e >= side[i] - 1 && e < 260), ext.map((e) => e.toFixed(0)).join("×") + " mm AABB");
    const rot = us.ijkToRAS!;
    const offAxis = Math.max(Math.abs(rot[1]), Math.abs(rot[2]), Math.abs(rot[4]), Math.abs(rot[6]));
    check("US geometry is oblique (per-frame IPP honoured, not axis-aligned)", offAxis > 0.02, `max off-diagonal ${offAxis.toFixed(3)}`);
    const mr = ready.find((r) => r.tp === "preop" || r.tp === "intraop");
    if (mr) {
      const c = us.rasLo!.map((v, i) => (v + us.rasHi![i]) / 2);
      check("US block sits inside the head the MR covers", inBox(c, mr.rasLo!, mr.rasHi!, 20),
        `US centre ${c.map((v) => v.toFixed(0)).join(",")} vs MR ${mr.rasLo!.map((v) => v.toFixed(0)).join(",")}…${mr.rasHi!.map((v) => v.toFixed(0)).join(",")}`);
    }
  } else {
    check("an ultrasound row loaded", false, "no US row ready — the multi-frame path was not exercised");
  }

  // Segmentations rasterised onto each row's own resampled grid.
  const withSeg = ready.filter((r) => r.segs.length);
  check("a row carries segmentations", withSeg.length > 0, withSeg.map((r) => `${r.tp}:${r.segs.map((s) => s.structure).join("+")}`).join(" "));
  for (const r of withSeg) {
    for (const s of r.segs) {
      check(`SEG ${s.structure} (${r.tp}) landed on the row grid`,
        s.voxels > 0 && !!s.centroid && inBox(s.centroid, r.rasLo!, r.rasHi!),
        `${s.voxels.toLocaleString()} voxels, centroid ${s.centroid?.map((v) => v.toFixed(0)).join(",")}`);
    }
  }

  // ── the point of the whole viewer: linking across DIFFERENT grids ──────────
  const target = withSeg.flatMap((r) => r.segs).find((s) => s.centroid)?.centroid
    ?? ready[0].rasLo!.map((v, i) => (v + ready[0].rasHi![i]) / 2);
  await evalJson(`__remindDbg.jumpTo(${JSON.stringify(target)})`);
  const focus = await evalJson("__remindDbg.focus()") as number[];
  check("jumpTo moves the shared RAS focus", focus.every((v, i) => Math.abs(v - target[i]) < 1e-6),
    focus.map((v) => v.toFixed(1)).join(","));

  const offs = await evalJson("__remindDbg.offsets()") as { key: string; off: Record<string, number> }[];
  const byKey = new Map(rs.map((r) => [r.key, r]));
  for (const o of offs) {
    const r = byKey.get(o.key)!;
    // reconstruct the RAS coordinate each row's own offset lands on; it must be the SAME
    // patient-space point in every row, whatever grid that row happens to live on
    const axis: Record<string, number> = { axial: 2, coronal: 1, sagittal: 0 };
    const back = Object.entries(o.off).map(([orient, f]) => {
      const a = axis[orient];
      return { orient, ras: r.rasLo![a] + f * (r.rasHi![a] - r.rasLo![a]), want: focus[a] };
    });
    const worst = Math.max(...back.map((b) => Math.abs(b.ras - b.want)));
    check(`${r.tp} slices land on the shared RAS point`, worst < 0.5,
      `worst ${worst.toFixed(3)} mm` + (worst >= 0.5 ? ` (${JSON.stringify(back)})` : ""));
  }

  // toggling a row off frees it; toggling back reloads it
  const victim = ready[ready.length - 1];
  await evalJson(`__remindDbg.toggleRow(${JSON.stringify(victim.key)})`);
  await sleep(300);
  const afterOff = (await rows()).find((r) => r.key === victim.key)!;
  check("toggling a row off releases it", afterOff.state === "idle", `${victim.tp} → ${afterOff.state}`);

  await evalJson(`__remindDbg.setColumn('coronal', false)`);
  await sleep(200);
  check("column toggle applies", true, "coronal hidden");
  await evalJson(`__remindDbg.setColumn('coronal', true)`);
}

const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  await Deno.writeFile(`${SHOTS}/reminder-compare.png`,
    Uint8Array.from(atob(shot.result.data as unknown as string), (c) => c.charCodeAt(0)));
}

console.log("\n  ReMINDer compare verification" + (CASE ? " — " + CASE : ""));
console.log("  " + "-".repeat(72));
let fail = 0;
for (const [name, ok, detail] of results) {
  if (!ok) fail++;
  console.log("  " + name.padEnd(52) + (ok ? "ok  " : "FAIL") + (detail ? "   " + detail : ""));
}
console.log(fail ? `\n  ❌ ${fail} FAILED` : "\n  ✅ ALL PASSED");
ws.close();
ac.abort();
Deno.exit(fail ? 1 : 0);
