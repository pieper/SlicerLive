// End-to-end interaction parity: a real synthetic mouse drag was injected into Slicer's
// 3D view (running the actual vtkMRMLCameraWidget); reproduce it two ways and compare.
//   A) pure TS: CameraInteractor with the same dx/dy/viewport  -> tests bindings + constants
//   B) real browser: CDP drag on the live page through the DOM -> tests the whole path
// Deltas are scaled by viewport ratio so rxf/ryf are identical despite different view sizes.
//   deno run -A harness/verify-drag-parity.ts [url]
import { CDP } from "./cdp.ts";
import { VtkCamera } from "../render/vtk-camera.ts";
import { CameraInteractor } from "../render/vtk-interactor.ts";
import type { Vec3 } from "../render/mat4.ts";

const URL_ = Deno.args[0] ?? "http://127.0.0.1:8099/webgpu/real.html";
interface Truth {
  viewSize: [number, number];
  drag: { x0: number; y0: number; dx: number; dy: number };
  before: { position: number[]; focalPoint: number[]; viewUp: number[] };
  after: { position: number[]; focalPoint: number[]; viewUp: number[]; distance: number };
}
const t: Truth = JSON.parse(await Deno.readTextFile("/tmp/slicer-drag-truth.json"));
const [W, H] = t.viewSize;
const cmp = (label: string, a: number[], b: number[], tol: number) => {
  const d = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const ok = d <= tol;
  console.log(`  ${ok ? "OK " : "XX "} ${label.padEnd(12)} slicer=[${a.map((v) => v.toFixed(4)).join(", ")}]  got=[${b.map((v) => v.toFixed(4)).join(", ")}]  maxdiff=${d.toExponential(2)}`);
  return ok;
};

console.log(`\nSlicer 3D view ${W}x${H}, left-drag dx=${t.drag.dx} dy=${t.drag.dy} (VTK display coords)`);
console.log(`rxf = ${(t.drag.dx * (-20 / W) * 10).toFixed(6)} deg   ryf = ${(t.drag.dy * (-20 / H) * 10).toFixed(6)} deg\n`);

// ---------- A) pure TS math through CameraInteractor ----------
console.log("A) CameraInteractor (pure TS, same viewport):");
{
  const cam = new VtkCamera(t.before.position as Vec3, t.before.focalPoint as Vec3, t.before.viewUp as Vec3, 30);
  const it = new CameraInteractor(cam);
  // start at (x0, y0) then move by (dx, dy) — converting VTK y-up to browser y-down
  const cssY0 = H - t.drag.y0;
  it.start(0, t.drag.x0, cssY0, H, {});
  it.move(t.drag.x0 + t.drag.dx, cssY0 - t.drag.dy, W, H);
  let ok = true;
  ok = cmp("position", t.after.position, cam.position as unknown as number[], 1e-6) && ok;
  ok = cmp("viewUp", t.after.viewUp, cam.viewUp as unknown as number[], 1e-6) && ok;
  console.log(`  => ${ok ? "MATCH" : "MISMATCH"}\n`);
}

// ---------- B) real browser DOM path ----------
console.log("B) real browser via CDP (scaled deltas, same rxf/ryf):");
const c = await CDP.attachToPage();
await c.goto(URL_);
if (!await c.waitFor(`window.__slicerlive && window.__slicerlive.ready`, 120000)) {
  console.log("  hook missing:", await c.eval(`return (document.querySelector('#status')||{}).textContent;`));
  Deno.exit(1);
}
// put the browser camera in the identical start state
await c.eval(`window.__slicerlive.setCamera(${JSON.stringify({
  position: t.before.position, focalPoint: t.before.focalPoint, viewUp: t.before.viewUp, viewAngle: 30,
})}); return 1;`);

const rect = await c.eval<{ x: number; y: number; w: number; h: number }>(`
  const el = document.getElementById('c-threeD'); const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
`);
// scale so dx/W and dy/H match Slicer's => identical rxf/ryf
const dxb = t.drag.dx * (rect.w / W);
const dyb = -t.drag.dy * (rect.h / H);   // VTK y-up -> browser y-down
const sx = rect.x + rect.w / 2, sy = rect.y + rect.h / 2;
console.log(`  browser view ${rect.w.toFixed(0)}x${rect.h.toFixed(0)} · drag dx=${dxb.toFixed(2)} dy=${dyb.toFixed(2)} (css px)`);
await c.drag(sx, sy, sx + dxb, sy + dyb, { steps: 1 });
await new Promise((r) => setTimeout(r, 250));

const got = await c.eval<{ position: number[]; viewUp: number[]; distance: number }>(`return window.__slicerlive.getCamera();`);
let ok = true;
ok = cmp("position", t.after.position, got.position, 5e-2) && ok;   // tolerance: sub-pixel CSS rounding
ok = cmp("viewUp", t.after.viewUp, got.viewUp, 5e-4) && ok;
console.log(`  => ${ok ? "MATCH" : "MISMATCH"}`);
console.log("\n  event log:", JSON.stringify(await c.eval(`return window.__slicerlive.log.slice(-3);`)));
c.close();
