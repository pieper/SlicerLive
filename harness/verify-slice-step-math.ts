// Pure regression test for slice stepping — no Slicer, no browser, no GPU.
// Replays the wheel/key sequences captured from Slicer's real slice views against
// SliceInteractor directly, using the checked-in fixtures. This is the test that should
// run in CI; harness/verify-slice-step.ts additionally proves the browser DOM wiring.
//   deno run -A harness/verify-slice-step-math.ts
import { SliceInteractor, mmToOffset01, offset01ToMm } from "../render/slice-interactor.ts";
import type { Orientation } from "../render/slice-renderer.ts";
import type { Vec3 } from "../render/mat4.ts";
import { fixture } from "./fixtures.ts";

interface Startup { volume: { ijkToRAS: number[]; rasLo: number[]; rasHi: number[] } }
interface Case {
  start: number; after_wheelFwd_x3: number; after_wheelBack_x5: number;
  after_keys_f_f_b: number; after_keys_arrows: number;
  edge: { bounds_hi: number; before: number; after_wheelFwd: number };
}
const startup = await fixture<Startup>("slicer-startup.json");
const truth = await fixture<Record<string, Case>>("slicer-slicestep-truth.json");

const rasLo = startup.volume.rasLo as Vec3, rasHi = startup.volume.rasHi as Vec3;
const ix = new SliceInteractor({ ijkToRAS: startup.volume.ijkToRAS, rasLo, rasHi });
const CELL: Record<string, Orientation> = { Red: "axial", Green: "coronal", Yellow: "sagittal" };
const TOL = 1e-5;

let fails = 0;
const row = (label: string, want: number, got: number) => {
  const ok = Math.abs(want - got) <= TOL;
  if (!ok) fails++;
  console.log(`  ${ok ? "OK " : "XX "} ${label.padEnd(20)} slicer=${want.toFixed(9).padStart(15)}  ts=${got.toFixed(9).padStart(15)}`);
};

for (const [color, t] of Object.entries(truth)) {
  const o = CELL[color];
  console.log(`\n=== ${color} (${o}) — spacing ${ix.spacing(o).toFixed(9)}, bounds [${ix.bounds(o).map((v) => v.toFixed(4)).join(", ")}] ===`);

  const from = (mm: number) => mmToOffset01(o, mm, rasLo, rasHi);
  const mm = (off: number) => offset01ToMm(o, off, rasLo, rasHi);

  let off = from(t.start);
  for (let i = 0; i < 3; i++) off = ix.wheel(o, off, true);
  row("wheel fwd x3", t.after_wheelFwd_x3, mm(off));

  for (let i = 0; i < 5; i++) off = ix.wheel(o, off, false);
  row("wheel back x5", t.after_wheelBack_x5, mm(off));

  off = from(t.start);
  for (const k of ["f", "f", "b"]) off = ix.key(o, off, k);
  row("keys f,f,b", t.after_keys_f_f_b, mm(off));

  off = from(t.start);
  for (const k of ["ArrowUp", "ArrowDown", "ArrowDown", "ArrowRight", "ArrowLeft"]) off = ix.key(o, off, k);
  row("keys arrows", t.after_keys_arrows, mm(off));

  // out-of-bounds step must be REJECTED (offset unchanged), not clamped to the bound
  off = ix.wheel(o, from(t.edge.before), true);
  row("edge (reject)", t.edge.after_wheelFwd, mm(off));
}

console.log(`\n${fails === 0 ? "SLICE STEPPING MATH VERIFIED" : fails + " MISMATCH(ES)"}\n`);
if (fails) Deno.exit(1);
