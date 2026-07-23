// Slice-stepping parity: replay the exact wheel/key sequences that were injected into
// Slicer's real slice views and compare offsets in mm.
// Truth from /tmp/slicer-slicestep-truth.json (see docs/HARNESS.md).
//   deno run -A harness/verify-slice-step.ts [url]
import { CDP } from "./cdp.ts";
import { fixture } from "./fixtures.ts";

const URL_ = Deno.args[0] ?? "http://127.0.0.1:8099/webgpu/real.html";
const CELL: Record<string, string> = { Red: "axial", Green: "coronal", Yellow: "sagittal" };
const TOL = 1e-5;

interface Case {
  start: number; after_wheelFwd_x3: number; after_wheelBack_x5: number;
  after_keys_f_f_b: number; after_keys_arrows: number;
  edge: { bounds_hi: number; before: number; after_wheelFwd: number };
}
const truth = await fixture<Record<string, Case>>("slicer-slicestep-truth.json");

const c = await CDP.attachToPage();
await c.goto(URL_);
if (!await c.waitFor(`window.__slicerlive && window.__slicerlive.ready`, 120000)) {
  console.log("hook missing:", await c.eval(`return (document.querySelector('#status')||{}).textContent;`));
  Deno.exit(1);
}

let fails = 0;
const row = (label: string, want: number, got: number) => {
  const ok = Math.abs(want - got) <= TOL;
  if (!ok) fails++;
  console.log(`  ${ok ? "OK " : "XX "} ${label.padEnd(22)} slicer=${want.toFixed(9).padStart(15)}  live=${got.toFixed(9).padStart(15)}  d=${Math.abs(want - got).toExponential(1)}`);
};

for (const [color, t] of Object.entries(truth)) {
  const cell = CELL[color];
  console.log(`\n=== ${color} (${cell}) ===`);
  const info = await c.eval<{ spacing: number; bounds: number[]; offsetMm: number }>(
    `const p = window.__slicerlive.getPlanes()["${cell}"]; return { spacing: p.spacing, bounds: p.bounds, offsetMm: p.offsetMm };`);
  console.log(`  spacing=${info.spacing.toFixed(9)}  bounds=[${info.bounds.map((v) => v.toFixed(4)).join(", ")}]`);
  row("default offset", t.start, info.offsetMm);

  // wheel forward x3
  let mm = await c.eval<number>(`
    window.__slicerlive.setSliceOffsetMm("${cell}", ${t.start});
    let m; for (let i=0;i<3;i++) m = window.__slicerlive.stepSlice("${cell}", true); return m;`);
  row("wheel fwd x3", t.after_wheelFwd_x3, mm);

  // then wheel backward x5 (continues from the previous state, as in Slicer)
  mm = await c.eval<number>(`let m; for (let i=0;i<5;i++) m = window.__slicerlive.stepSlice("${cell}", false); return m;`);
  row("wheel back x5", t.after_wheelBack_x5, mm);

  // keys f,f,b from the default
  mm = await c.eval<number>(`
    window.__slicerlive.setSliceOffsetMm("${cell}", ${t.start});
    let m; for (const k of ["f","f","b"]) m = window.__slicerlive.keySlice("${cell}", k); return m;`);
  row("keys f,f,b", t.after_keys_f_f_b, mm);

  // arrow keys Up,Down,Down,Right,Left from the default
  mm = await c.eval<number>(`
    window.__slicerlive.setSliceOffsetMm("${cell}", ${t.start});
    let m; for (const k of ["ArrowUp","ArrowDown","ArrowDown","ArrowRight","ArrowLeft"]) m = window.__slicerlive.keySlice("${cell}", k); return m;`);
  row("keys arrows", t.after_keys_arrows, mm);

  // boundary: a step that would leave the bounds must be REJECTED (offset unchanged)
  mm = await c.eval<number>(`
    window.__slicerlive.setSliceOffsetMm("${cell}", ${t.edge.before});
    return window.__slicerlive.stepSlice("${cell}", true);`);
  row("edge (must reject)", t.edge.after_wheelFwd, mm);

  await c.eval<number>(`return window.__slicerlive.setSliceOffsetMm("${cell}", ${t.start});`);
}

console.log(`\n${fails === 0 ? "ALL SLICE STEPPING MATCHES" : fails + " MISMATCH(ES)"}\n`);
c.close();
