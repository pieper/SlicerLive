// Prove the TS VtkCamera port reproduces real VTK bit-for-bit (to 1e-6) for the exact
// operations Slicer's camera widget performs. Ground truth is dumped by the MCP driver
// from a live vtkCamera into /tmp/vtk-camera-truth.json.
//   deno run -A harness/verify-vtk-camera.ts
import { VtkCamera } from "../render/vtk-camera.ts";
import { CameraInteractor, MOTION_FACTOR } from "../render/vtk-interactor.ts";
import type { Vec3 } from "../render/mat4.ts";

interface Snap { position: number[]; focalPoint: number[]; viewUp: number[]; distance: number }
interface Case { name: string; after: Snap; dx?: number; dy?: number; rxf?: number; ryf?: number; factor?: number; dyf?: number }
const truth: { W: number; H: number; cases: Case[] } = JSON.parse(await Deno.readTextFile("/tmp/vtk-camera-truth.json"));
const { W, H } = truth;
const TOL = 1e-6;

const def = () => new VtkCamera([0, 500, 0], [0, 0, 0], [0, 0, 1], 30);
const rotate = (c: VtkCamera, rxf: number, ryf: number) => {
  c.azimuth(rxf);
  const up = c.elevation(ryf);
  c.orthogonalizeViewUp(up);
};

const mine: Record<string, VtkCamera> = {};

// case 1: single rotate step
{
  const c = def();
  const dx = 120, dy = -40;
  rotate(c, dx * (-20 / W) * MOTION_FACTOR, dy * (-20 / H) * MOTION_FACTOR);
  mine["rotate_single"] = c;
}
// case 2: 6 accumulated rotate steps
{
  const c = def();
  for (let i = 0; i < 6; i++) rotate(c, 20 * (-20 / W) * MOTION_FACTOR, -10 * (-20 / H) * MOTION_FACTOR);
  mine["rotate_6steps"] = c;
}
// case 3: wheel-forward dolly
{
  const c = def();
  c.dolly(Math.pow(1.1, 0.2 * MOTION_FACTOR * 1.0));
  mine["dolly_wheel_in"] = c;
}
// case 4: right-drag scale
{
  const c = def();
  const dy = -50, dyf = MOTION_FACTOR * dy / (H / 2);
  c.dolly(Math.pow(1.1, -dyf));
  mine["scale_drag"] = c;
}
// case 5: rotate from a tilted camera
{
  const c = new VtkCamera([120, 400, 220], [10, -5, 3], [0.1, 0.2, 0.97] as Vec3, 30);
  rotate(c, 37.5, -22.25);
  mine["rotate_tilted"] = c;
}

let fails = 0;
const fmt = (a: number[]) => "[" + a.map((v) => v.toFixed(6).padStart(13)).join(", ") + "]";
for (const cs of truth.cases) {
  const c = mine[cs.name];
  if (!c) { console.log(`  ?? ${cs.name}: no TS case`); fails++; continue; }
  const got = { position: c.position, focalPoint: c.focalPoint, viewUp: c.viewUp, distance: c.distance };
  let ok = true;
  const worst: string[] = [];
  for (const k of ["position", "focalPoint", "viewUp"] as const) {
    const a = cs.after[k], b = got[k] as unknown as number[];
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > TOL) { ok = false; worst.push(`${k}[${i}] d=${d.toExponential(2)}`); }
    }
  }
  if (Math.abs(cs.after.distance - got.distance) > 1e-5) { ok = false; worst.push("distance"); }
  if (!ok) fails++;
  console.log(`${ok ? "  OK " : "  XX "} ${cs.name}`);
  console.log(`        vtk  pos=${fmt(cs.after.position)} up=${fmt(cs.after.viewUp)}`);
  console.log(`        ts   pos=${fmt(got.position as unknown as number[])} up=${fmt(got.viewUp as unknown as number[])}`);
  if (!ok) console.log(`        DIFF ${worst.join(" ")}`);
}
console.log(`\n${fails === 0 ? "PORT VERIFIED — TS VtkCamera == VTK to 1e-6" : fails + " CASE(S) DIFFER"}\n`);
