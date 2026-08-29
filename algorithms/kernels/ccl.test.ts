// T1 unit (W5): connected-components + islands on small 3D phantoms.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { connectedComponents, keepLargestIsland, removeSmallIslands } from "./ccl.ts";

const dims: [number, number, number] = [6, 6, 1];
// two separate 2D blobs in a 6x6 slice: a 2x2 at (0,0) and a single voxel at (5,5)
function twoBlobs(): Uint8Array {
  const m = new Uint8Array(36);
  const at = (i: number, j: number) => j * 6 + i;
  m[at(0, 0)] = m[at(1, 0)] = m[at(0, 1)] = m[at(1, 1)] = 1;   // 4-voxel blob
  m[at(5, 5)] = 1;                                              // 1-voxel blob
  return m;
}

Deno.test("labels two disconnected blobs as two components with right sizes", () => {
  const cc = connectedComponents(twoBlobs(), dims, 6);
  assertEquals(cc.count, 2);
  assertEquals(cc.sizes.slice().sort((a, b) => a - b), [1, 4]);
});

Deno.test("diagonal touch: 6-conn separates, 18/26-conn joins", () => {
  const m = new Uint8Array(36); const at = (i: number, j: number) => j * 6 + i;
  m[at(1, 1)] = 1; m[at(2, 2)] = 1;   // diagonal neighbors
  assertEquals(connectedComponents(m, dims, 6).count, 2, "6-conn: separate");
  assertEquals(connectedComponents(m, dims, 18).count, 1, "18-conn: joined");
  assertEquals(connectedComponents(m, dims, 26).count, 1, "26-conn: joined");
});

Deno.test("keepLargestIsland keeps the 4-voxel blob only", () => {
  const out = keepLargestIsland(twoBlobs(), dims, 6);
  let sum = 0; for (const v of out) sum += v;
  assertEquals(sum, 4);
  assertEquals(out[5 * 6 + 5], 0, "single-voxel blob removed");
});

Deno.test("removeSmallIslands drops blobs below the size threshold", () => {
  const out = removeSmallIslands(twoBlobs(), dims, 2, 6);   // remove <2
  let sum = 0; for (const v of out) sum += v;
  assertEquals(sum, 4, "only the 4-voxel blob survives");
});

Deno.test("3D connectivity across slices", () => {
  const d3: [number, number, number] = [3, 3, 3];
  const m = new Uint8Array(27);
  m[0] = 1;                 // (0,0,0)
  m[9] = 1;                 // (0,0,1) — face neighbor in k
  const cc = connectedComponents(m, d3, 6);
  assertEquals(cc.count, 1, "face-connected across slices = 1 component");
  assertEquals(cc.sizes[0], 2);
});

Deno.test("empty mask -> zero components", () => {
  assertEquals(connectedComponents(new Uint8Array(36), dims, 6).count, 0);
});
