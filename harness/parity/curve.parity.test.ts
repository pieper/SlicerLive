// T4 (W4): interpolateCurve (Cardinal spline port) matches Slicer's GetCurvePointsWorld to ~1e-3 mm, for an
// open curve and a closed curve; and polygonArea/polylineLength on our OWN interpolated points then match
// Slicer's ClosedCurve area/length measurements. Needs Slicer MCP.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { interpolateCurve } from "../../logic/markups/curve.ts";
import { polygonArea, polylineLength } from "../../logic/markups/measurements.ts";
import type { Vec3 } from "../../render/mat4.ts";

const available = await slicerAvailable();

const CTRL_OPEN: Vec3[] = [[0, 0, 0], [10, 20, 0], [30, 10, 5], [40, 40, -5], [60, 0, 0]];
const CTRL_CLOSED: Vec3[] = [[0, 0, 0], [40, 0, 10], [40, 30, 0], [0, 30, -10]];

const ORACLE = `
import slicer, json
def curve_pts(kind, pts):
  n = slicer.mrmlScene.AddNewNodeByClass(kind)
  for p in pts: n.AddControlPointWorld(p[0], p[1], p[2])
  for i in range(n.GetNumberOfMeasurements()): n.GetNthMeasurement(i).SetEnabled(True)
  n.UpdateAllMeasurements()
  cp = n.GetCurvePointsWorld()
  pts_out = [[cp.GetPoint(i)[0], cp.GetPoint(i)[1], cp.GetPoint(i)[2]] for i in range(cp.GetNumberOfPoints())]
  area = None; length = None
  for i in range(n.GetNumberOfMeasurements()):
    m = n.GetNthMeasurement(i)
    if m.GetName()=='area': area = m.GetValue()
    if m.GetName()=='length': length = m.GetValue()
  slicer.mrmlScene.RemoveNode(n)
  return pts_out, area, length
openPts, _, openLen = curve_pts('vtkMRMLMarkupsCurveNode', ${JSON.stringify(CTRL_OPEN)})
closedPts, closedArea, closedLen = curve_pts('vtkMRMLMarkupsClosedCurveNode', ${JSON.stringify(CTRL_CLOSED)})
result = {'openPts': openPts, 'openLen': openLen, 'closedPts': closedPts, 'closedArea': closedArea, 'closedLen': closedLen}
`;

const maxDist = (a: Vec3[], b: Vec3[]): number => {
  const n = Math.min(a.length, b.length); let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]));
  return m;
};

Deno.test({ name: "parity: interpolateCurve == vtkMRMLMarkupsCurveNode.GetCurvePointsWorld", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ openPts: Vec3[]; openLen: number; closedPts: Vec3[]; closedArea: number; closedLen: number }>("result", "import slicer, json\n" + ORACLE);

  const mineOpen = interpolateCurve(CTRL_OPEN, false);
  console.log(`  open: mine ${mineOpen.length} pts, Slicer ${o.openPts.length} pts`);
  assert(mineOpen.length === o.openPts.length, `open point count ${mineOpen.length} vs ${o.openPts.length}`);
  const dOpen = maxDist(mineOpen, o.openPts);
  console.log(`  open curve max|Δ| = ${dOpen.toExponential(2)} mm`);
  assert(dOpen <= 1e-2, `open curve within 1e-2 mm, got ${dOpen}`);

  const mineClosed = interpolateCurve(CTRL_CLOSED, true);
  assert(mineClosed.length === o.closedPts.length, `closed point count ${mineClosed.length} vs ${o.closedPts.length}`);
  const dClosed = maxDist(mineClosed, o.closedPts);
  console.log(`  closed curve max|Δ| = ${dClosed.toExponential(2)} mm; area mine ${polygonArea(mineClosed).toFixed(3)} vs Slicer ${o.closedArea.toFixed(3)}`);
  assert(dClosed <= 1e-2, `closed curve within 1e-2 mm, got ${dClosed}`);

  // measurements on our interpolated points match Slicer's
  assertAlmostEquals(polygonArea(mineClosed), o.closedArea, o.closedArea * 0.005, "closed-curve area");
  assertAlmostEquals(polylineLength(mineClosed, false), o.closedLen, o.closedLen * 0.005, "closed-curve length");
} });
