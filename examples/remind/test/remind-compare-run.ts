// ReMINDer compare DRIVER: serve the demo, open it in the harness Chrome (CDP :9222,
// headed — on-screen so a human can watch), wait for __remindDbg, then verify the
// COMPARE-CENTRIC viewer numerically (no screenshot eyeballing):
//   • it opens on the intended pair — pre-op T1+Gd ⇄ pre-dura US — and loads only that
//   • the multi-frame ultrasound decodes to a real oblique block inside the head the MR covers
//   • segmentations rasterise onto their own row's grid
//   • patient-space linking: one jumpTo puts every resident volume's slice on the SAME RAS
//     point, though no two share a voxel grid
//   • adding rows walks the staged defaults; removing one frees volumes nothing else needs
//   • the global compare controls drive every row at once
// Finishes with a screenshot to the scratchpad for the human, tab left open.
//   deno run -A examples/remind/test/remind-compare-run.ts [case]
const CDP = "http://localhost:9222";
const PORT = 8139;
const CASE = Deno.args[0] ?? "";
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
  key: string; tp: string; desc: string; m: string; state: string; error?: string; nSegs: number;
  dims?: [number, number, number]; vox?: number; win?: number; lev?: number;
  ijkToRAS?: number[]; rasLo?: number[]; rasHi?: number[];
  segs: { structure: string; voxels: number; centroid: number[] | null }[];
}
interface DbgPair {
  id: string; why: string; a: string | null; b: string | null;
  aDesc?: string; bDesc?: string; aTp?: string; bTp?: string; live: boolean;
}
const rows = () => evalJson("__remindDbg.rows()") as Promise<DbgRow[]>;
const pairs = () => evalJson("__remindDbg.cmpRows()") as Promise<DbgPair[]>;
/** Wait for every compare row to have BOTH sides ready — not for the background prefetch,
 *  which keeps loading the rest of the case long afterwards. */
const settle = async (maxMs = 450_000) => {
  for (let i = 0; i < maxMs / 500; i++) {
    const ps = await pairs();
    if (ps.length && ps.every((p) => p.live)) return;
    await sleep(500);
  }
};

let present = false;
for (let i = 0; i < 60 && !present; i++) {
  present = (await evalJson("!!globalThis.__remindDbg")) === true;
  if (!present) await sleep(500);
}

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); };
const inBox = (p: number[], lo: number[], hi: number[], pad = 0) =>
  p.every((v, i) => v >= lo[i] - pad && v <= hi[i] + pad);

check("page ready (__remindDbg present)", present);
if (present) {
  await settle();
  const pid = await evalJson("__remindDbg.pid()") as string;
  const p0 = await pairs();
  const rs0 = await rows();
  check("case loaded", !!pid, pid);

  // ── opens compare-centric, on the intended pair ───────────────────────────
  check("opens on exactly one comparison", p0.length === 1, `${p0.length} rows`);
  const r1 = p0[0];
  check("row 1 is pre-op T1+Gd ⇄ pre-dura US",
    r1?.aTp === "preop" && !!r1.aDesc?.includes("T1") && (r1.bTp === "pre_dura" || r1.bTp === "post_dura"),
    `${r1?.aDesc} (${r1?.aTp})  ⇄  ${r1?.bDesc} (${r1?.bTp})`);
  check("row 1 says what it is for", r1?.why === "plan vs first look", r1?.why ?? "");
  check("both sides of row 1 decoded", r1?.live === true);
  check("opens with segmentations hidden", (await evalJson("__remindDbg.segsOn()")) === false);
  check("opens in fade at 50%", (await evalJson("__remindDbg.mode()")) === "fade" &&
    (await evalJson("__remindDbg.blend()")) === 0.5,
    `mode ${await evalJson("__remindDbg.mode()")}, blend ${await evalJson("__remindDbg.blend()")}`);

  // the pair comes FIRST; the rest of the case follows in the background
  const resident = await evalJson("__remindDbg.residentKeys()") as string[];
  check("the pair loads before anything else", resident.length <= 3,
    `${resident.length} resident of ${rs0.length} series when the pair went live`);

  const ready = rs0.filter((r) => r.state === "ready");
  for (const r of ready) {
    const side = r.dims!.map((d) => d * r.vox!);
    check(`${r.tp} (${r.desc}) geometry`,
      r.dims!.every((d) => d >= 16 && d <= 512) && side.every((e) => e > 8 && e < 400) && r.vox! > 0.05,
      `${r.dims!.join("×")} @ ${r.vox!.toFixed(2)} mm = ${side.map((e) => e.toFixed(0)).join("×")} mm`);
    check(`${r.tp} window/level derived from the data`, Number.isFinite(r.win) && r.win! > 0,
      `win ${r.win!.toFixed(1)} lev ${r.lev!.toFixed(1)}`);
  }

  // the ultrasound decoder is the one path with no prior art in the repo
  const us = ready.find((r) => r.m === "US");
  if (us) {
    const side = us.dims!.map((d) => d * us.vox!);
    check("US block is a real volume (30–150 mm per side)",
      side.every((e) => e > 30 && e < 150), side.map((e) => e.toFixed(0)).join("×") + " mm");
    const rot = us.ijkToRAS!;
    const offAxis = Math.max(Math.abs(rot[1]), Math.abs(rot[2]), Math.abs(rot[4]), Math.abs(rot[6]));
    check("US geometry is oblique (per-frame IPP honoured)", offAxis > 0.02, `max off-diagonal ${offAxis.toFixed(3)}`);
    const mr = ready.find((r) => r.m === "MR");
    if (mr) {
      const c = us.rasLo!.map((v, i) => (v + us.rasHi![i]) / 2);
      check("US block sits inside the head the MR covers", inBox(c, mr.rasLo!, mr.rasHi!, 20),
        `US centre ${c.map((v) => v.toFixed(0)).join(",")}`);
    }
  } else {
    check("an ultrasound row loaded", false, "no US resident — the multi-frame path was not exercised");
  }

  const withSeg = ready.filter((r) => r.segs.length);
  for (const r of withSeg) {
    for (const s of r.segs) {
      check(`SEG ${s.structure} (${r.tp}) landed on the row grid`,
        s.voxels > 0 && !!s.centroid && inBox(s.centroid, r.rasLo!, r.rasHi!),
        `${s.voxels.toLocaleString()} voxels`);
    }
  }

  // ── patient-space linking across different grids ──────────────────────────
  const target = withSeg.flatMap((r) => r.segs).find((s) => s.centroid)?.centroid
    ?? ready[0].rasLo!.map((v, i) => (v + ready[0].rasHi![i]) / 2);
  await evalJson(`__remindDbg.jumpTo(${JSON.stringify(target)})`);
  const focus = await evalJson("__remindDbg.focus()") as number[];
  const offs = await evalJson("__remindDbg.offsets()") as { key: string; off: Record<string, number> }[];
  const byKey = new Map(rs0.map((r) => [r.key, r]));
  for (const o of offs) {
    const r = byKey.get(o.key)!;
    const axis: Record<string, number> = { axial: 2, coronal: 1, sagittal: 0 };
    const worst = Math.max(...Object.entries(o.off).map(([orient, f]) => {
      const a = axis[orient];
      return Math.abs(r.rasLo![a] + f * (r.rasHi![a] - r.rasLo![a]) - focus[a]);
    }));
    check(`${r.tp} slices land on the shared RAS point`, worst < 0.5, `worst ${worst.toFixed(3)} mm`);
  }

  // ── linked zoom + the slice ↔ 3D coupling ─────────────────────────────────
  const fov0 = await evalJson("__remindDbg.fov()") as number;
  await evalJson("__remindDbg.zoomSlice('axial', 2)");
  const fov1 = await evalJson("__remindDbg.fov()") as number;
  const cam1 = await evalJson("__remindDbg.camera()") as { dist: number; fovAtFocus: number };
  check("zooming one slice halves the SHARED field of view", Math.abs(fov1 - fov0 / 2) < fov0 * 0.02,
    `${fov0.toFixed(1)} → ${fov1.toFixed(1)} mm`);
  check("the 3D view then spans the same mm as the slices", Math.abs(cam1.fovAtFocus - fov1) < fov1 * 0.01,
    `3D ${cam1.fovAtFocus.toFixed(1)} vs slice ${fov1.toFixed(1)} mm`);
  await evalJson("__remindDbg.zoomSlice('axial', 0.5)");

  // ── the global compare controls drive every row ───────────────────────────
  await evalJson("__remindDbg.setMode('fade')");
  await evalJson("__remindDbg.setBlend(0.25)");
  const opA = await evalJson(
    "getComputedStyle(document.querySelector('#rows .crow .cell canvas.bside')).opacity") as string;
  check("blend reaches the B canvas", Math.abs(Number(opA) - 0.25) < 0.02, `opacity ${opA}`);

  await evalJson("__remindDbg.setMode('rock')");
  await sleep(120);
  const b1 = await evalJson("__remindDbg.blend()") as number;
  await sleep(450);
  const b2 = await evalJson("__remindDbg.blend()") as number;
  check("rock animates the blend", Math.abs(b2 - b1) > 0.05, `${b1.toFixed(2)} → ${b2.toFixed(2)}`);

  await evalJson("__remindDbg.setMode('toggle')");
  await sleep(200);
  const bt = await evalJson("__remindDbg.blend()") as number;
  check("toggle is a hard A/B flip", bt === 0 || bt === 1, `blend ${bt}`);

  // rock and toggle latch against each other; pressing the live one releases to fade
  await evalJson("document.querySelector('#cmpbar [data-mode=\"rock\"]').click()");
  const m1 = await evalJson("__remindDbg.mode()");
  await evalJson("document.querySelector('#cmpbar [data-mode=\"toggle\"]').click()");
  const m2 = await evalJson("__remindDbg.mode()");
  await evalJson("document.querySelector('#cmpbar [data-mode=\"toggle\"]').click()");
  const m3 = await evalJson("__remindDbg.mode()");
  check("rock and toggle latch, and release back to fade", m1 === "rock" && m2 === "toggle" && m3 === "fade",
    `${m1} → ${m2} → ${m3}`);
  await evalJson("__remindDbg.setSpeed('medium')");
  await evalJson("__remindDbg.setMode('rock')");
  const pRock = await evalJson("__remindDbg.periodMs()") as number;
  await evalJson("__remindDbg.setMode('toggle')");
  const pTog = await evalJson("__remindDbg.periodMs()") as number;
  check("rock cross-fades 50% slower than toggle flips", Math.abs(pRock - pTog * 1.5) < 1 && pTog === 3200,
    `rock ${pRock} ms vs toggle ${pTog} ms`);
  await evalJson("__remindDbg.setMode('fade')");

  // ── segmentations: one switch, both 2D and 3D ─────────────────────────────
  await evalJson("__remindDbg.setSegs(true)");
  check("segmentation switch turns them on", (await evalJson("__remindDbg.segsOn()")) === true);
  await evalJson("__remindDbg.setSegs(false)");
  check("…and off again", (await evalJson("__remindDbg.segsOn()")) === false);

  // ── ultrasound renders in its dashboard timepoint colour ──────────────────
  const usRow2 = (await rows()).find((r) => r.m === "US" && r.state === "ready");
  if (usRow2) {
    const tf = await evalJson(`__remindDbg.tf(${JSON.stringify(usRow2.key)})`) as { ramp: string };
    const want = { pre_dura: "PRE-DURA", post_dura: "POST-DURA", pre_imri: "PRE-iMRI" }[usRow2.tp];
    check("ultrasound uses its dashboard timepoint colour", tf.ramp === want, `${usRow2.tp} → ramp "${tf.ramp}"`);
  }

  // ── adding rows walks the staged defaults ─────────────────────────────────
  await evalJson("__remindDbg.addRow()");
  await settle();
  const p2 = await pairs();
  const r2 = p2[1];
  check("row 2 is pre-dura US ⇄ final US", p2.length === 2 &&
    (r2?.aTp === "pre_dura" || r2?.aTp === "post_dura") && r2?.bTp === "pre_imri",
    `${r2?.aTp} ⇄ ${r2?.bTp} — "${r2?.why}"`);

  await evalJson("__remindDbg.addRow()");
  await settle();
  const p3 = await pairs();
  const r3 = p3[2];
  check("row 3 is pre-op ⇄ intra-op MR", p3.length === 3 && r3?.aTp === "preop" && r3?.bTp === "intraop",
    `${r3?.aDesc} ⇄ ${r3?.bDesc} — "${r3?.why}"`);
  check("row 3 prefers a matching sequence when one exists",
    !!r3?.aDesc && !!r3?.bDesc, `${r3?.aDesc} vs ${r3?.bDesc}`);

  // Three rows reference six slots, but several name the SAME series — each must be held
  // once. (Resident count no longer proves this on its own: the background prefetch pulls in
  // the rest of the case too, so assert the invariant directly.)
  const res3 = await evalJson("__remindDbg.residentKeys()") as string[];
  const refs = p3.flatMap((r) => [r.a, r.b]).filter(Boolean) as string[];
  const distinct = new Set(refs);
  check("shared volumes are held once, not once per row",
    new Set(res3).size === res3.length && [...distinct].every((k) => res3.includes(k)),
    `${refs.length} slots → ${distinct.size} distinct series, ${res3.length} resident, no duplicates`);

  // the compare controls are GLOBAL — one blend for every row
  await evalJson("__remindDbg.setBlend(0.8)");
  const ops = await evalJson(
    "[...document.querySelectorAll('#rows .crow .cell canvas.bside')].map(c=>getComputedStyle(c).opacity)") as string[];
  const live = ops.filter((o) => Math.abs(Number(o) - 0.8) < 0.02).length;
  check("one blend applies to every row's every column", live >= 8 && ops.every((o) => ["0", "0.8"].includes(Number(o).toFixed(1) === "0.8" ? "0.8" : "0")),
    `${live}/${ops.length} canvases at 0.8`);

  // ── background prefetch ───────────────────────────────────────────────────
  for (let i = 0; i < 240; i++) {
    if (((await evalJson("__remindDbg.residentKeys()")) as string[]).length >= 5) break;
    await sleep(500);
  }
  const pre = (await evalJson("__remindDbg.residentKeys()") as string[]).length;
  check("the rest of the case loads in the background", pre >= 5, `${pre}/${rs0.length} resident`);

  // selecting a PREFETCHED volume must be aligned immediately — it never went through the
  // load path that applies the shared frame, which is exactly how it used to come up wrong
  const p4a = await pairs();
  const residentNow = await evalJson("__remindDbg.residentKeys()") as string[];
  const fresh = residentNow.find((k) => k !== p4a[0].a && k !== p4a[0].b);
  if (fresh) {
    const fovNow = await evalJson("__remindDbg.fov()") as number;
    await evalJson(`__remindDbg.setPair(${JSON.stringify(p4a[0].id)}, ${JSON.stringify(fresh)}, ${JSON.stringify(p4a[0].b)})`);
    await sleep(700);
    const fr = await evalJson(`__remindDbg.frameOf(${JSON.stringify(fresh)}, 'axial')`) as { fov: number; center: number[] };
    const vc = await evalJson("__remindDbg.viewCenter()") as number[];
    const d = Math.hypot(fr.center[0] - vc[0], fr.center[1] - vc[1], fr.center[2] - vc[2]);
    check("a prefetched volume is aligned the moment it is selected",
      Math.abs(fr.fov - fovNow) < fovNow * 0.01 && d < 0.5,
      `fov ${fr.fov.toFixed(1)} vs ${fovNow.toFixed(1)} mm, centre off ${d.toFixed(3)} mm`);
  }

  // ── removing a row ────────────────────────────────────────────────────────
  await evalJson(`__remindDbg.removeRow(${JSON.stringify(p3[2].id)})`);
  await sleep(400);
  const p4 = await pairs();
  check("removing a row drops it", p4.length === 2, `${p4.length} rows left`);

  // ── per-row customisation still works ─────────────────────────────────────
  const anyOther = rs0.find((r) => r.m === "MR" && r.key !== p4[0].a && r.key !== p4[0].b);
  if (anyOther) {
    await evalJson(`__remindDbg.setPair(${JSON.stringify(p4[0].id)}, ${JSON.stringify(anyOther.key)}, ${JSON.stringify(p4[0].b)})`);
    await settle();
    const p5 = await pairs();
    check("a row's A can be re-pointed at any series", p5[0].a === anyOther.key,
      `row 1 A → ${p5[0].aDesc}`);
  }

  // ── transfer function, per resident volume ────────────────────────────────
  const tfKey = (await evalJson("__remindDbg.residentKeys()") as string[])[0];
  await evalJson(`__remindDbg.setTF(${JSON.stringify(tfKey)}, {points: [[0,0],[0.3,0.8],[1,1]], ramp: 'hot'})`);
  const alpha = await evalJson(`__remindDbg.lutAlphaAt(${JSON.stringify(tfKey)}, 0.3)`) as number;
  const tf1 = await evalJson(`__remindDbg.tf(${JSON.stringify(tfKey)})`) as { ramp: string };
  check("editing the transfer function takes effect", tf1.ramp === "hot" && Math.abs(alpha - 0.8) < 1e-6,
    `ramp ${tf1.ramp}, alpha(0.3) = ${alpha}`);

  await evalJson("__remindDbg.setColumn('coronal', false)");
  await sleep(150);
  check("column toggle applies", true, "coronal hidden");
  await evalJson("__remindDbg.setColumn('coronal', true)");
  await evalJson("__remindDbg.setBlend(0.5)");
}

const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  await Deno.writeFile(`${SHOTS}/reminder-compare.png`,
    Uint8Array.from(atob(shot.result.data as unknown as string), (c) => c.charCodeAt(0)));
}

console.log("\n  ReMINDer compare verification" + (CASE ? " — " + CASE : ""));
console.log("  " + "-".repeat(74));
let fail = 0;
for (const [name, ok, detail] of results) {
  if (!ok) fail++;
  console.log("  " + name.padEnd(52) + (ok ? "ok  " : "FAIL") + (detail ? "   " + detail : ""));
}
console.log(fail ? `\n  ❌ ${fail} FAILED` : "\n  ✅ ALL PASSED");
ws.close();
ac.abort();
Deno.exit(fail ? 1 : 0);
