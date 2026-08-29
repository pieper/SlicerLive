// T1 unit (W4): the Cardinal-spline curve interpolation (numeric parity vs Slicer is in harness/parity).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { interpolateCurve } from "./curve.ts";
import type { Vec3 } from "../../render/mat4.ts";

Deno.test("point count = pointsPerSegment*segments + 1", () => {
  const open: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 0, 0]];   // 3 segments
  assertEquals(interpolateCurve(open, false).length, 10 * 3 + 1);
  assertEquals(interpolateCurve(open, true).length, 10 * 4 + 1);        // closed: 4 segments
});

Deno.test("interpolated curve passes through the control points", () => {
  const cp: Vec3[] = [[0, 0, 0], [10, 5, 0], [20, -5, 0], [30, 0, 0]];
  const pts = interpolateCurve(cp, false);
  // control point i is at interpolated index i*pointsPerSegment
  for (let i = 0; i < cp.length; i++) {
    const p = pts[i * 10];
    assertAlmostEquals(p[0], cp[i][0], 1e-6); assertAlmostEquals(p[1], cp[i][1], 1e-6); assertAlmostEquals(p[2], cp[i][2], 1e-6);
  }
});

Deno.test("collinear control points -> straight line (spline stays on the line)", () => {
  const cp: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
  for (const p of interpolateCurve(cp, false)) { assertAlmostEquals(p[1], 0, 1e-9); assertAlmostEquals(p[2], 0, 1e-9); }
});

Deno.test("closed curve wraps: last interpolated point == first", () => {
  const cp: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]];
  const pts = interpolateCurve(cp, true);
  const a = pts[0], b = pts[pts.length - 1];
  assert(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6, "closed curve returns to start");
});

Deno.test("fewer than 2 points -> returned as-is", () => {
  assertEquals(interpolateCurve([[1, 2, 3]], false).length, 1);
  assertEquals(interpolateCurve([], false).length, 0);
});
