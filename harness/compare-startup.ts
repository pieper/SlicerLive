// Startup-parity check: compare SlicerLive's default geometry against native Slicer's,
// as NUMBERS. Slicer side is dumped to /tmp/slicer-startup.json by the MCP driver
// (clear scene -> load MRHead -> enable volume rendering); this reads the browser side
// via window.__slicerlive and prints a diff table.
//   deno run -A harness/compare-startup.ts [url]
import { CDP } from "./cdp.ts";
import { fixture } from "./fixtures.ts";

const URL_ = Deno.args[0] ?? "http://127.0.0.1:8099/webgpu/real.html";
const TOL = 1e-3;

interface SlicerDump {
  volume: { dims: number[]; ijkToRAS: number[]; rasLo: number[]; rasHi: number[]; window: number; level: number };
  slices: Record<string, { orientation: string; sliceOffsetMm: number; fieldOfView: number[]; dimensions: number[] }>;
  camera: { position: number[]; focalPoint: number[]; viewUp: number[]; viewAngle: number };
}
const slicer = await fixture<SlicerDump>("slicer-startup.json");

const c = await CDP.attachToPage();
await c.goto(URL_);
if (!await c.waitFor(`window.__slicerlive && window.__slicerlive.ready`, 120000)) {
  console.log("SlicerLive hook never appeared. status:", await c.eval(`return (document.querySelector('#status')||{}).textContent;`));
  Deno.exit(1);
}
const live = await c.eval<Record<string, any>>(`return window.__slicerlive.snapshot();`);

let fails = 0;
const row = (label: string, a: unknown, b: unknown, ok: boolean, note = "") => {
  if (!ok) fails++;
  const s = (v: unknown) => Array.isArray(v) ? "[" + v.map((x) => typeof x === "number" ? x.toFixed(4) : x).join(", ") + "]" : typeof v === "number" ? v.toFixed(4) : String(v);
  console.log(`${ok ? "  OK " : "  XX "} ${label.padEnd(26)} slicer=${s(a).padEnd(34)} live=${s(b).padEnd(34)} ${note}`);
};
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;
const nearArr = (a: number[], b: number[], tol = TOL) => a.length === b.length && a.every((v, i) => near(v, b[i], tol));

console.log("\n=== VOLUME GEOMETRY ===");
row("dims", slicer.volume.dims, live.volume.dims, JSON.stringify(slicer.volume.dims) === JSON.stringify(live.volume.dims));
row("ijkToRAS", slicer.volume.ijkToRAS.slice(0, 4), (live.volume.ijkToRAS as number[]).slice(0, 4), nearArr(slicer.volume.ijkToRAS, live.volume.ijkToRAS, 1e-4), "(row 0 shown)");
row("rasLo", slicer.volume.rasLo, live.volume.rasLo, nearArr(slicer.volume.rasLo, live.volume.rasLo, 1e-3));
row("rasHi", slicer.volume.rasHi, live.volume.rasHi, nearArr(slicer.volume.rasHi, live.volume.rasHi, 1e-3));
row("window", slicer.volume.window, live.volume.window, near(slicer.volume.window, live.volume.window, 1e-3));
row("level", slicer.volume.level, live.volume.level, near(slicer.volume.level, live.volume.level, 1e-3));

console.log("\n=== SLICE GEOMETRY (default position after load) ===");
for (const cell of ["axial", "coronal", "sagittal"]) {
  const s = slicer.slices[cell], l = live.planes[cell];
  // Both sides now report the offset in Slicer's SIGNED convention (measured along the
  // slice normal: +S axial, +A coronal, -R sagittal), so they compare directly. The hook
  // also exposes `rasMm` if you want the raw positive-RAS-axis coordinate instead.
  row(`${cell} offset (mm)`, s.sliceOffsetMm, l.offsetMm, near(s.sliceOffsetMm, l.offsetMm, 1e-3),
    cell === "sagittal" ? "(normal is -R)" : "");
}

console.log("\n=== SLICE FIELD OF VIEW (square viewport => Slicer's fit is the limiting extent) ===");
for (const cell of ["axial", "coronal", "sagittal"]) {
  const s = slicer.slices[cell];
  // Slicer's FOV is [x,y] for its own (non-square) viewport; the scale-invariant value is
  // the fitted extent = FOV[1] (it fits the vertical extent, x follows aspect).
  const fitted = s.fieldOfView[1];
  const liveSpan = live.planes[cell].spanMm;
  row(`${cell} fitted extent`, fitted, liveSpan ?? NaN, liveSpan !== undefined && near(fitted, liveSpan, 1e-2));
}

console.log("\n=== 3D CAMERA (default) ===");
row("position", slicer.camera.position, live.camera.position, nearArr(slicer.camera.position, live.camera.position, 1e-3));
row("focalPoint", slicer.camera.focalPoint, live.camera.focalPoint, nearArr(slicer.camera.focalPoint, live.camera.focalPoint, 1e-3));
row("viewUp", slicer.camera.viewUp, live.camera.viewUp, nearArr(slicer.camera.viewUp, live.camera.viewUp, 1e-3));
row("viewAngle", slicer.camera.viewAngle, live.camera.viewAngle, near(slicer.camera.viewAngle, live.camera.viewAngle, 1e-3));

console.log(`\n${fails === 0 ? "ALL MATCH" : fails + " MISMATCH(ES)"}\n`);
c.close();
