// T1 unit (W5): binary morphology + median on 3D phantoms. Uses a 7x7x3 volume with the 2D pattern
// replicated across all k-slices (a prism), so the 3D ball has real neighbours in k and the middle slice
// behaves like the intended 2D operation (erosion border_value=0, matching scipy).
import { assertEquals } from "jsr:@std/assert@1";
import { ballOffsets, binaryClose, binaryDilate, binaryErode, binaryOpen, median3d } from "./morph.ts";

const dims: [number, number, number] = [7, 7, 3];
const idx = (i: number, j: number, k: number) => k * 49 + j * 7 + i;
const sum = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
// fill a 2D (i,j) predicate across all 3 k-slices
function prism(on: (i: number, j: number) => boolean): Uint8Array {
  const m = new Uint8Array(147);
  for (let k = 0; k < 3; k++) for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) if (on(i, j)) m[idx(i, j, k)] = 1;
  return m;
}

Deno.test("ballOffsets: r=1 is the 3D 6-neighborhood + center (7)", () => {
  assertEquals(ballOffsets(1).length, 7);
});

Deno.test("dilate grows a single voxel to its full 3D plus-neighborhood (7)", () => {
  const m = new Uint8Array(147); m[idx(3, 3, 1)] = 1;
  assertEquals(sum(binaryDilate(m, dims, 1)), 7, "center + 6 face neighbours");
});

Deno.test("opening removes a small isolated blob, keeps a solid block core", () => {
  const m = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);   // 5x5x3 solid block
  m[idx(0, 0, 1)] = 1;                                                // an isolated speck away from the block
  const o = binaryOpen(m, dims, 1);
  assertEquals(o[idx(0, 0, 1)], 0, "isolated speck removed by opening");
  assertEquals(o[idx(3, 3, 1)], 1, "block core kept");
});

Deno.test("closing fills a small hole (middle slice)", () => {
  const m = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);   // 5x5x3 block
  for (let k = 0; k < 3; k++) m[idx(3, 3, k)] = 0;                    // hole column
  assertEquals(binaryClose(m, dims, 1)[idx(3, 3, 1)], 1, "hole filled");
});

Deno.test("median removes salt and keeps a solid core", () => {
  const salt = new Uint8Array(147); salt[idx(3, 3, 1)] = 1;
  assertEquals(median3d(salt, dims, 1)[idx(3, 3, 1)], 0, "isolated voxel removed");
  const solid = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);
  assertEquals(median3d(solid, dims, 1)[idx(3, 3, 1)], 1, "solid core kept");
});

Deno.test("erode then the block shrinks by one shell", () => {
  const m = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);
  const e = binaryErode(m, dims, 1);
  assertEquals(e[idx(1, 3, 1)], 0, "edge eroded");
  assertEquals(e[idx(3, 3, 1)], 1, "core kept");
});
