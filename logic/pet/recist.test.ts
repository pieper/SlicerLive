// T1: bidimensional sizing on the largest cross-section, and RECIST 1.1's nodal short-axis rule.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { bidimensionalAxes, recistDiameterMm, recistMeasurable } from "./recist.ts";

const dims: [number, number, number] = [32, 32, 16];
const blank = () => new Uint8Array(dims[0] * dims[1] * dims[2]);
const at = (i: number, j: number, k: number) => (k * dims[1] + j) * dims[0] + i;

/** An axis-aligned box of voxels. */
function box(m: Uint8Array, i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) {
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) m[at(i, j, k)] = 1;
}

Deno.test("an axis-aligned box reports its own in-plane extents", () => {
  const m = blank();
  // 10 voxels along i, 5 along j, at 1 mm -- so 9 mm x 4 mm between CENTRES.
  box(m, 10, 19, 10, 14, 8, 8);
  const a = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  assertEquals(a.sliceIndex, 8);
  assertEquals(a.sliceVoxels, 50);
  // Longest chord is the diagonal of the 9 x 4 mm rectangle.
  assertAlmostEquals(a.longAxisMm, Math.hypot(9, 4), 1e-9);
  // Greatest perpendicular CHORD through the rectangle, which for sides a > b is b*d/a = 4.38 mm.
  // The total spread perpendicular to the diagonal is 2ab/d = 7.31 mm -- a bounding extent, not a
  // diameter, and not what a reader measures. Pinned here so the two can never be confused again.
  assertAlmostEquals(a.shortAxisMm, (4 * Math.hypot(9, 4)) / 9, 0.6);
});

Deno.test("anisotropic voxels are honoured, in the right axes", () => {
  const m = blank();
  box(m, 10, 19, 10, 10, 8, 8);        // a 10-voxel line along i
  const a = bidimensionalAxes(m, dims, [2, 0.5, 5], "axial");
  assertAlmostEquals(a.longAxisMm, 9 * 2, 1e-9);     // 2 mm along i
  assertAlmostEquals(a.shortAxisMm, 0.5, 1e-9);      // one voxel thick along j
});

Deno.test("the measurement lands on the LARGEST cross-section, not the first or the middle", () => {
  const m = blank();
  box(m, 10, 12, 10, 12, 3, 3);        // small, early
  box(m, 10, 19, 10, 19, 11, 11);      // large, late
  box(m, 10, 13, 10, 13, 7, 7);        // medium, middle
  const a = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  assertEquals(a.sliceIndex, 11);
  assertEquals(a.sliceVoxels, 100);
});

Deno.test("a sphere's two axes agree, and match its diameter", () => {
  const m = blank();
  const r = 6;
  const c = [16, 16, 8];
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        if ((i - c[0]) ** 2 + (j - c[1]) ** 2 + (k - c[2]) ** 2 <= r * r) m[at(i, j, k)] = 1;
      }
    }
  }
  const a = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  assertEquals(a.sliceIndex, 8);
  // Equatorial slice: a discretised disc of radius 6 is 12 mm across between centres.
  assertAlmostEquals(a.longAxisMm, 12, 0.6);
  // Round, so the two axes should be close.
  assertAlmostEquals(a.shortAxisMm, a.longAxisMm, 1.2);
});

Deno.test("the plane argument changes which slice is scanned", () => {
  const m = blank();
  // A slab one voxel thick in j: the biggest CORONAL cross-section, trivial axially.
  box(m, 8, 23, 12, 12, 2, 13);
  const cor = bidimensionalAxes(m, dims, [1, 1, 1], "coronal");
  assertEquals(cor.sliceIndex, 12);
  assertEquals(cor.sliceVoxels, 16 * 12);
  assertAlmostEquals(cor.longAxisMm, Math.hypot(15, 11), 1e-9);
  // Axially the same mask is 16 x 1 on each of twelve slices.
  const ax = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  assertEquals(ax.sliceVoxels, 16);
  assertAlmostEquals(ax.longAxisMm, 15, 1e-9);
});

Deno.test("a single voxel measures one voxel across, not zero", () => {
  const m = blank();
  m[at(16, 16, 8)] = 1;
  const a = bidimensionalAxes(m, dims, [2, 3, 4], "axial");
  assertEquals(a.sliceVoxels, 1);
  assertAlmostEquals(a.longAxisMm, 2, 1e-9);
  assertAlmostEquals(a.shortAxisMm, 3, 1e-9);
});

Deno.test("an empty mask yields a storable record rather than throwing", () => {
  const a = bidimensionalAxes(blank(), dims, [1, 1, 1], "axial");
  assertEquals(a.sliceIndex, -1);
  assertEquals(a.longAxisMm, 0);
  assertEquals(a.longAxisEnds, null);
});

Deno.test("the long-axis endpoints are the two voxels that span it", () => {
  const m = blank();
  box(m, 10, 19, 14, 14, 8, 8);
  const a = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  const ends = a.longAxisEnds!;
  assertEquals(ends.map((e) => e[0]).sort((x, y) => x - y), [10, 19]);
  assertEquals(ends[0][2], 8);
});

Deno.test("RECIST follows the SHORT axis for a node and the long axis otherwise", () => {
  const m = blank();
  box(m, 10, 29, 10, 14, 8, 8);     // 19 mm x 4 mm
  const a = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  // Getting this backwards changes the response category, which is why it is a function.
  assertEquals(recistDiameterMm(a, true), a.shortAxisMm);
  assertEquals(recistDiameterMm(a, false), a.longAxisMm);
});

Deno.test("nodal thresholds: >=15 mm short axis is a target, 10-15 mm pathological but not", () => {
  // Sized by the resulting SHORT AXIS, not by the j extent: for a rectangle the perpendicular
  // chord is b*d/a, so a node has to be drawn rather than assumed.
  const mk = (jVoxels: number) => {
    const m = blank();
    box(m, 2, 29, 10, 10 + jVoxels - 1, 8, 8);
    return bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  };
  const big = mk(18);
  assertEquals(big.shortAxisMm >= 15, true, `short axis ${big.shortAxisMm}`);
  assertEquals(recistMeasurable(big, true, 2.5).target, true);

  const mid = mk(12);
  assertEquals(mid.shortAxisMm >= 10 && mid.shortAxisMm < 15, true, `short axis ${mid.shortAxisMm}`);
  const midV = recistMeasurable(mid, true, 2.5);
  assertEquals([midV.measurable, midV.target], [false, false]);
  assertEquals(midV.reason.includes("non-target"), true);

  const small = mk(6);
  assertEquals(small.shortAxisMm < 10, true, `short axis ${small.shortAxisMm}`);
  assertEquals(recistMeasurable(small, true, 2.5).reason.includes("normal-sized"), true);

  // The same big node read as a NON-nodal lesion follows its long axis instead, which is larger.
  assertEquals(recistDiameterMm(big, false) > recistDiameterMm(big, true), true);
});

Deno.test("a thick-slice acquisition raises the measurability floor", () => {
  const m = blank();
  box(m, 10, 21, 10, 21, 8, 8);     // 11 mm x 11 mm: measurable at 2.5 mm slices
  const a = bidimensionalAxes(m, dims, [1, 1, 1], "axial");
  assertEquals(recistMeasurable(a, false, 2.5).measurable, true);
  // RECIST 1.1 requires at least twice the slice thickness, so at 8 mm slices it is not.
  const thick = recistMeasurable(a, false, 8);
  assertEquals(thick.measurable, false);
  assertEquals(thick.reason.includes("16.0 mm"), true);
});
