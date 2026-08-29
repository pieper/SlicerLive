// Markups curve interpolation (W4) — a faithful port of Slicer's default curve (vtkMRMLMarkupsCurveNode:
// Cardinal spline via vtkCurveGenerator + vtkParametricSpline + vtkCardinalSpline, 10 points per interpolating
// segment). This produces the interpolated world polyline (`linePoints`) that the display and the
// length/area measurements use — Slicer's curves are smooth splines, not straight polylines. Pure math over
// RAS control points; matches GetCurvePointsWorld to ~1e-3 mm (validated by parity).
//
//   deno test -A --no-check logic/markups/curve.test.ts
import type { Vec3 } from "../../render/mat4.ts";

const POINTS_PER_SEGMENT = 10;

type Cubic = [number, number, number, number]; // a + b*dt + c*dt^2 + d*dt^3

// vtkCardinalSpline::Fit1D — open spline, default constraints (LeftConstraint=RightConstraint=1, values 0:
// clamped zero end-slopes, the vtkSpline defaults the cardinal spline inherits).
function fitOpen(x: number[], y: number[]): Cubic[] {
  const size = x.length;
  const c: number[][] = Array.from({ length: size }, () => [0, 0, 0, 0]);
  const w = new Array(size).fill(0);
  c[0][1] = 1; c[0][2] = 0; w[0] = 0;                                   // left constraint 1, value 0
  for (let k = 1; k < size - 1; k++) {
    const xlk = x[k] - x[k - 1], xlkp = x[k + 1] - x[k];
    c[k][0] = xlkp; c[k][1] = 2 * (xlkp + xlk); c[k][2] = xlk;
    w[k] = 3 * ((xlkp * (y[k] - y[k - 1])) / xlk + (xlk * (y[k + 1] - y[k])) / xlkp);
  }
  c[size - 1][0] = 0; c[size - 1][1] = 1; w[size - 1] = 0;              // right constraint 1, value 0
  c[0][2] = c[0][2] / c[0][1]; w[0] = w[0] / c[0][1]; c[size - 1][2] = 0;
  for (let k = 1; k < size; k++) {
    c[k][1] = c[k][1] - c[k][0] * c[k - 1][2];
    c[k][2] = c[k][2] / c[k][1];
    w[k] = (w[k] - c[k][0] * w[k - 1]) / c[k][1];
  }
  for (let k = size - 2; k >= 0; k--) w[k] = w[k] - c[k][2] * w[k + 1];
  let b = 0;
  for (let k = 0; k < size - 1; k++) {
    b = x[k + 1] - x[k];
    c[k][0] = y[k]; c[k][1] = w[k];
    c[k][2] = (3 * (y[k + 1] - y[k])) / (b * b) - (w[k + 1] + 2 * w[k]) / b;
    c[k][3] = (2 * (y[k] - y[k + 1])) / (b * b * b) + (w[k + 1] + w[k]) / (b * b);
  }
  c[size - 1][0] = y[size - 1]; c[size - 1][1] = w[size - 1];
  c[size - 1][2] = c[size - 2][2] + 3 * c[size - 2][3] * b; c[size - 1][3] = c[size - 2][3];
  return c as Cubic[];
}

// vtkCardinalSpline::FitClosed1D — x has size N+1 (fictitious wrap knot), y[N] == y[0].
function fitClosed(x: number[], y: number[]): Cubic[] {
  const size = x.length, N = size - 1;
  const c: number[][] = Array.from({ length: size }, () => [0, 0, 0, 0]);
  const w = new Array(size).fill(0);
  for (let k = 1; k < N; k++) {
    const xlk = x[k] - x[k - 1], xlkp = x[k + 1] - x[k];
    c[k][0] = xlkp; c[k][1] = 2 * (xlkp + xlk); c[k][2] = xlk;
    w[k] = 3 * ((xlkp * (y[k] - y[k - 1])) / xlk + (xlk * (y[k + 1] - y[k])) / xlkp);
  }
  const xlk = x[N] - x[N - 1], xlkp = x[1] - x[0];
  const aN = (c[N][0] = xlkp), bN = (c[N][1] = 2 * (xlkp + xlk)), cN = (c[N][2] = xlk);
  const dN = (w[N] = 3 * ((xlkp * (y[N] - y[N - 1])) / xlk + (xlk * (y[1] - y[0])) / xlkp));
  c[0][2] = 0; w[0] = 0; c[0][3] = 1;
  for (let k = 1; k <= N; k++) {
    c[k][1] = c[k][1] - c[k][0] * c[k - 1][2];
    c[k][2] = c[k][2] / c[k][1];
    w[k] = (w[k] - c[k][0] * w[k - 1]) / c[k][1];
    c[k][3] = (-1 * c[k][0] * c[k - 1][3]) / c[k][1];
  }
  c[N][0] = 1; c[N][1] = 0;
  for (let k = N - 1; k > 0; k--) {
    c[k][0] = c[k][3] - c[k][2] * c[k + 1][0];
    c[k][1] = w[k] - c[k][2] * c[k + 1][1];
  }
  w[0] = w[N] = (dN - cN * c[1][1] - aN * c[N - 1][1]) / (bN + cN * c[1][0] + aN * c[N - 1][0]);
  for (let k = 1; k < N; k++) w[k] = c[k][0] * w[N] + c[k][1];
  let b = 0;
  for (let k = 0; k < N; k++) {
    b = x[k + 1] - x[k];
    c[k][0] = y[k]; c[k][1] = w[k];
    c[k][2] = (3 * (y[k + 1] - y[k])) / (b * b) - (w[k + 1] + 2 * w[k]) / b;
    c[k][3] = (2 * (y[k] - y[k + 1])) / (b * b * b) + (w[k + 1] + w[k]) / (b * b);
  }
  c[N][0] = y[N]; c[N][1] = w[N]; c[N][2] = c[0][2]; c[N][3] = c[0][3];
  return c as Cubic[];
}

function findIndex(intervals: number[], size: number, t: number): number {
  // vtkSpline::FindIndex — largest index i in [0,size-2] with intervals[i] <= t (bisection in VTK; linear is fine)
  let i = 0;
  while (i < size - 2 && intervals[i + 1] <= t) i++;
  return i;
}
function evalAxis(coeffs: Cubic[], intervals: number[], size: number, t: number): number {
  const lo = intervals[0], hi = intervals[size - 1];
  t = t < lo ? lo : t > hi ? hi : t;
  const i = findIndex(intervals, size, t);
  const dt = t - intervals[i];
  const k = coeffs[i];
  return ((k[3] * dt + k[2]) * dt + k[1]) * dt + k[0];
}

/** Slicer's interpolated curve points (world) for control points; `closed` wraps (ClosedCurve). */
export function interpolateCurve(controlPoints: Vec3[], closed: boolean, pointsPerSegment = POINTS_PER_SEGMENT): Vec3[] {
  const n = controlPoints.length;
  if (n < 2) return controlPoints.map((p) => [...p] as Vec3);

  const segments = closed ? n : n - 1;
  const total = pointsPerSegment * segments + 1;
  const L = closed ? n : n - 1;                                          // vtkParametricSpline Length/ClosedLength

  // per-axis coefficients
  const axisCoeffs: Cubic[][] = [], axisIntervals: number[][] = [], axisSize: number[] = [];
  for (let a = 0; a < 3; a++) {
    const y = controlPoints.map((p) => p[a]);
    if (closed) {
      const x = []; for (let i = 0; i < n; i++) x.push(i); x.push(n);   // fictitious wrap knot at n (=ClosedLength)
      const yy = [...y, y[0]];
      axisCoeffs[a] = fitClosed(x, yy); axisIntervals[a] = x; axisSize[a] = n + 1;
    } else {
      const x = []; for (let i = 0; i < n; i++) x.push(i);
      axisCoeffs[a] = fitOpen(x, y); axisIntervals[a] = x; axisSize[a] = n;
    }
  }

  const out: Vec3[] = [];
  for (let i = 0; i < total; i++) {
    const u = i / (total - 1);                                          // [0,1]
    const t = u * L;
    out.push([
      evalAxis(axisCoeffs[0], axisIntervals[0], axisSize[0], t),
      evalAxis(axisCoeffs[1], axisIntervals[1], axisSize[1], t),
      evalAxis(axisCoeffs[2], axisIntervals[2], axisSize[2], t),
    ]);
  }
  return out;
}
