// T4 (W4): markups measurements match Slicer's vtkMRMLMeasurement*. Line length and angle are compared on the
// same control points (exact — no interpolation). Slicer's ClosedCurve is a smooth SPLINE (area/length run over
// interpolated curve points, not the polygon), so to validate the area/length FORMULAS independently of the
// spline port (logic/markups/curve.ts, later), we pull Slicer's own interpolated world points and run
// polygonArea/polylineLength on THOSE — they must match Slicer's measurement to 0.5%. Needs Slicer MCP.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { pyJson, slicerAvailable } from "../slicer.ts";
import { angleDeg, distance, polygonArea, polylineLength } from "../../logic/markups/measurements.ts";

const available = await slicerAvailable();

const ORACLE = `
import slicer, json
def mk(kind, pts):
  n = slicer.mrmlScene.AddNewNodeByClass(kind)
  for p in pts: n.AddControlPointWorld(p[0], p[1], p[2])
  for i in range(n.GetNumberOfMeasurements()): n.GetNthMeasurement(i).SetEnabled(True)
  n.UpdateAllMeasurements()
  return n
line = mk('vtkMRMLMarkupsLineNode', [(0,0,0),(3,4,0)])
ang = mk('vtkMRMLMarkupsAngleNode', [(1,0,0),(0,0,0),(0,1,0)])
cc = mk('vtkMRMLMarkupsClosedCurveNode', [(0,0,0),(4,0,0),(4,3,0),(0,3,0)])
def meas(n, name):
  m = n.GetMeasurement(name)
  return m.GetValue() if (m and m.GetEnabled()) else None
# Slicer's interpolated closed-curve world points (what its area/length actually measure)
pts = cc.GetCurvePointsWorld()
ccPoints = [[pts.GetPoint(i)[0], pts.GetPoint(i)[1], pts.GetPoint(i)[2]] for i in range(pts.GetNumberOfPoints())]
result = {
  'lineLength': meas(line, 'length'),
  'angle': meas(ang, 'angle'),
  'ccArea': meas(cc, 'area'),
  'ccLength': meas(cc, 'length'),
  'ccPoints': ccPoints,
}
for nn in (line, ang, cc): slicer.mrmlScene.RemoveNode(nn)
`;

Deno.test({ name: "parity: markups measurements == vtkMRMLMeasurement (length/angle/area)", ignore: !available, sanitizeResources: false, sanitizeOps: false, async fn() {
  const o = await pyJson<{ lineLength: number | null; angle: number | null; ccArea: number | null; ccLength: number | null; ccPoints: [number, number, number][] }>("result", "import slicer, json\n" + ORACLE);
  console.log(`  Slicer: line ${o.lineLength} angle ${o.angle} ccArea ${o.ccArea} ccLength ${o.ccLength} (${o.ccPoints.length} curve pts)`);
  if (o.lineLength != null) assertAlmostEquals(distance([0, 0, 0], [3, 4, 0]), o.lineLength, 1e-4, "line length");
  if (o.angle != null) assertAlmostEquals(angleDeg([1, 0, 0], [0, 0, 0], [0, 1, 0]), o.angle, 1e-3, "angle");
  // area/length formulas on Slicer's OWN interpolated points must match Slicer's measurement (0.5%)
  if (o.ccArea != null && o.ccPoints.length > 3) assertAlmostEquals(polygonArea(o.ccPoints), o.ccArea, o.ccArea * 0.005, "closed-curve area formula on Slicer curve points");
  if (o.ccLength != null && o.ccPoints.length > 3) assertAlmostEquals(polylineLength(o.ccPoints, true), o.ccLength, o.ccLength * 0.005, "closed-curve length formula on Slicer curve points");
  assert(o.lineLength != null && o.angle != null, "Slicer returned line + angle measurements");
} });
