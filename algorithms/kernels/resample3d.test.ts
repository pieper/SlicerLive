// T1 unit (W3): resample3d (data-path vtkImageReslice) — direction-aware, nearest + trilinear.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { isotropicGrid, resample3d, type Grid } from "./resample3d.ts";

// a 4x4x4 volume, value = i + 10*j + 100*k, identity ijkToRAS (RAS mm == ijk)
function ramp(nx = 4, ny = 4, nz = 4): Grid {
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[k * nx * ny + j * nx + i] = i + 10 * j + 100 * k;
  return { data, dims: [nx, ny, nz], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
}
const idxOf = (nx: number, ny: number) => (i: number, j: number, k: number) => k * nx * ny + j * nx + i;

Deno.test("identity resample reproduces the volume exactly (nearest and linear)", () => {
  const g = ramp();
  for (const interp of ["nearest", "linear"] as const) {
    const out = resample3d(g, { dims: g.dims, ijkToRAS: g.ijkToRAS }, { interp });
    assertEquals(Array.from(out as Float32Array), Array.from(g.data as Float32Array), `identity ${interp}`);
  }
});

Deno.test("translation by +1 voxel in RAS shifts the sampling (nearest)", () => {
  const g = ramp();
  // output grid translated +1 mm in R (== +1 i): out(i) samples input(i+1)
  const out = resample3d(g, { dims: [3, 4, 4], ijkToRAS: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { interp: "nearest", background: -1 }) as Float32Array;
  const oi = idxOf(3, 4);
  assertEquals(out[oi(0, 0, 0)], 1, "out(0) == in(1)");
  assertEquals(out[oi(2, 0, 0)], 3, "out(2) == in(3)");
  assertEquals(out[oi(0, 1, 2)], 1 + 10 + 200, "out(0,1,2) == in(1,1,2)");
});

Deno.test("out-of-extent output voxels get the background", () => {
  const g = ramp();
  // shift output far past the input extent
  const out = resample3d(g, { dims: [2, 2, 2], ijkToRAS: [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { interp: "linear", background: -7 }) as Float32Array;
  for (const v of out) assertEquals(v, -7, "all background");
});

Deno.test("trilinear midpoint averages the 8 neighbours", () => {
  const g = ramp();
  // sample at i=0.5 (between 0 and 1), j=0,k=0 -> average of value(0)=0 and value(1)=1 -> 0.5
  const out = resample3d(g, { dims: [1, 1, 1], ijkToRAS: [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { interp: "linear" }) as Float32Array;
  assertAlmostEquals(out[0], 0.5, 1e-6);
  // centre of the (0,0,0)-(1,1,1) cube -> mean of the 8 corner values
  const cube = resample3d(g, { dims: [1, 1, 1], ijkToRAS: [1, 0, 0, 0.5, 0, 1, 0, 0.5, 0, 0, 1, 0.5, 0, 0, 0, 1] }, { interp: "linear" }) as Float32Array;
  const mean = (0 + 1 + 10 + 11 + 100 + 101 + 110 + 111) / 8;
  assertAlmostEquals(cube[0], mean, 1e-6);
});

Deno.test("90-degree output rotation is an exact voxel permutation (nearest)", () => {
  const g = ramp();
  // output ijkToRAS rotates i->+R stays, but j maps to +S and k to -A ... use a simple axis swap:
  // out ijk (i,j,k) -> RAS = (i, k, j)  (swap j and k). nearest must pull exact voxels.
  const swap = [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1];   // row-major: R=i, A=k, S=j
  const out = resample3d(g, { dims: [4, 4, 4], ijkToRAS: swap }, { interp: "nearest" }) as Float32Array;
  const oi = idxOf(4, 4);
  // out(i,j,k) world=(i,k,j) -> input ijk=(i,k,j) -> value i + 10*k + 100*j
  for (const [i, j, k] of [[1, 2, 3], [3, 0, 1], [0, 3, 2]]) {
    assertEquals(out[oi(i, j, k)], i + 10 * k + 100 * j, `swap at ${i},${j},${k}`);
  }
});

Deno.test("integer input yields integer (rounded) output", () => {
  const g = ramp(); const gi: Grid = { ...g, data: Int16Array.from(g.data as Float32Array) };
  const out = resample3d(gi, { dims: [1, 1, 1], ijkToRAS: [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { interp: "linear" });
  assert(out instanceof Int16Array, "output keeps Int16 dtype");
  assertEquals((out as Int16Array)[0], 1, "0.5 rounds to 1");
});

Deno.test("isotropicGrid downsamples an anisotropic volume to cubic voxels", () => {
  // 4x4x2 with 1x1x3 mm spacing -> isotropic 3mm grid ~ [1,1,2]
  const g: Grid = { data: new Float32Array(4 * 4 * 2), dims: [4, 4, 2], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1] };
  const o = isotropicGrid(g, 3);
  assertEquals(o.dims, [1, 1, 2]);
  // new k axis spacing is 3mm along +S
  assertAlmostEquals(o.ijkToRAS[10], 3, 1e-6);
});
