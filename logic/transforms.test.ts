// T1 unit (W6): transform hierarchy math.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import type { MrsonNode } from "../render/mrson.ts";
import { hardenImageIjkToRAS, hardenPoints, IDENTITY4, invertRowMajor, rowMul, worldForNode, worldMatrix, wouldCycle } from "./transforms.ts";

const T = (id: string, matrix: number[], parent?: string): MrsonNode => ({ type: "transform", id, matrix, refs: parent ? { transform: [parent] } : {} } as unknown as MrsonNode);
const trans = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];

Deno.test("rowMul: identity is neutral; translations add", () => {
  assertEquals(rowMul(IDENTITY4, trans(1, 2, 3)), trans(1, 2, 3));
  assertEquals(rowMul(trans(1, 0, 0), trans(0, 2, 0)), trans(1, 2, 0));
});

Deno.test("invertRowMajor undoes a matrix", () => {
  const m = [0, -1, 0, 5, 1, 0, 0, -2, 0, 0, 1, 3, 0, 0, 0, 1];   // 90° rot + translation
  const prod = rowMul(m, invertRowMajor(m));
  for (let i = 0; i < 16; i++) assertAlmostEquals(prod[i], IDENTITY4[i], 1e-9);
});

Deno.test("worldMatrix composes a parent chain (A->B->C)", () => {
  const nodes = new Map<string, MrsonNode>();
  nodes.set("A", T("A", trans(10, 0, 0)));
  nodes.set("B", T("B", trans(0, 20, 0), "A"));
  nodes.set("C", T("C", trans(0, 0, 30), "B"));
  // worldMatrix(C) = A·B·C = translate (10,20,30)
  assertEquals(worldMatrix("C", nodes), trans(10, 20, 30));
  assertEquals(worldMatrix("B", nodes), trans(10, 20, 0));
});

Deno.test("worldForNode uses the node's refs.transform", () => {
  const nodes = new Map<string, MrsonNode>();
  nodes.set("A", T("A", trans(5, 0, 0)));
  const img = { type: "image", id: "img", refs: { transform: ["A"] } } as unknown as MrsonNode;
  assertEquals(worldForNode(img, nodes), trans(5, 0, 0));
});

Deno.test("cycle detection: worldMatrix returns identity, wouldCycle catches it", () => {
  const nodes = new Map<string, MrsonNode>();
  nodes.set("A", T("A", trans(1, 0, 0), "B"));
  nodes.set("B", T("B", trans(0, 1, 0), "A"));   // A<->B cycle
  const m = worldMatrix("A", nodes);                   // guarded: terminates, never loops forever
  assertEquals(m.length, 16);
  assert(wouldCycle("A", "B", nodes) && wouldCycle("B", "A", nodes), "cycle detectable both ways");
});

Deno.test("harden linear moves ijkToRAS, not voxels", () => {
  const ijkToRAS = trans(0, 0, 0);           // identity origin
  const world = trans(10, -5, 2);
  const baked = hardenImageIjkToRAS(ijkToRAS, world);
  assertEquals([baked[3], baked[7], baked[11]], [10, -5, 2]);
});

Deno.test("harden markup points applies the world matrix", () => {
  const world = trans(1, 2, 3);
  assertEquals(hardenPoints([[0, 0, 0], [1, 1, 1]], world), [[1, 2, 3], [2, 3, 4]]);
});
