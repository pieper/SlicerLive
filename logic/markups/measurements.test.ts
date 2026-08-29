// T1 unit (W4): markups measurements vs known geometry (Slicer's vtkMRMLMeasurement* definitions).
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { angleDeg, boxVolume, distance, measurementsFor, polygonArea, polylineLength } from "./measurements.ts";

Deno.test("distance: 3-4-5 triangle hypotenuse", () => {
  assertAlmostEquals(distance([0, 0, 0], [3, 4, 0]), 5, 1e-9);
  assertAlmostEquals(distance([1, 2, 3], [1, 2, 3]), 0, 1e-9);
});

Deno.test("angleDeg: right angle and straight line", () => {
  assertAlmostEquals(angleDeg([1, 0, 0], [0, 0, 0], [0, 1, 0]), 90, 1e-9);
  assertAlmostEquals(angleDeg([1, 0, 0], [0, 0, 0], [-1, 0, 0]), 180, 1e-9);
  assertAlmostEquals(angleDeg([1, 0, 0], [0, 0, 0], [1, 1, 0]), 45, 1e-9);
});

Deno.test("polylineLength: open vs closed", () => {
  const sq: [number, number, number][] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];
  assertAlmostEquals(polylineLength(sq, false), 6, 1e-9);   // 2+2+2
  assertAlmostEquals(polylineLength(sq, true), 8, 1e-9);    // + closing edge 2
});

Deno.test("polygonArea: unit square, tilted square, triangle", () => {
  assertAlmostEquals(polygonArea([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), 1, 1e-9);
  // 3x3 square in a tilted plane (still area 9)
  assertAlmostEquals(polygonArea([[0, 0, 0], [3, 0, 0], [3, 0, 3], [0, 0, 3]]), 9, 1e-9);
  assertAlmostEquals(polygonArea([[0, 0, 0], [4, 0, 0], [0, 3, 0]]), 6, 1e-9);   // right triangle 1/2*4*3
});

Deno.test("boxVolume: ROI extent product", () => {
  assertAlmostEquals(boxVolume([10, 20, 30]), 6000, 1e-9);
});

Deno.test("measurementsFor: per-type outputs", () => {
  assertEquals(measurementsFor("line", [[0, 0, 0], [3, 4, 0]])[0].value, 5);
  assertEquals(measurementsFor("angle", [[1, 0, 0], [0, 0, 0], [0, 1, 0]])[0].value, 90);
  const cc = measurementsFor("closedCurve", [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
  assertEquals(cc.map((m) => m.name), ["length", "area"]);
  assertAlmostEquals(cc[1].value, 4, 1e-9);
  assertEquals(measurementsFor("roi", [], [2, 3, 4])[0].value, 24);
  assertEquals(measurementsFor("fiducial", [[0, 0, 0]]).length, 0);
});
