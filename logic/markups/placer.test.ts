// T1 unit (W4): the markups placement state machine — click sequences, completion, persistence, delete.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { MrsonNode } from "../../render/mrson.ts";
import { placeClick, POINTS_NEEDED, removeControlPointOp } from "./placer.ts";
import type { Vec3 } from "../../render/mat4.ts";

// apply the emitted ops to a tiny node map to simulate the LiveScene
function apply(nodes: Map<string, MrsonNode>, ops: { op: string; id: string; node?: MrsonNode; path?: string; value?: unknown }[]) {
  for (const o of ops) {
    if (o.op === "put" && o.node) nodes.set(o.id, o.node);
    else if (o.op === "patch") { const n = nodes.get(o.id)!; (n as Record<string, unknown>).controlPoints = o.value; }
  }
}

Deno.test("fiducial completes on the first click", () => {
  const r = placeClick("fiducial", null, [1, 2, 3], "m1");
  assertEquals(r.complete, true);
  assertEquals(r.ops[0].op, "put");
});

Deno.test("line needs two clicks", () => {
  const nodes = new Map<string, MrsonNode>();
  const a = placeClick("line", null, [0, 0, 0], "m1"); apply(nodes, a.ops);
  assertEquals(a.complete, false);
  const b = placeClick("line", nodes.get("m1")!, [3, 0, 0], "m1"); apply(nodes, b.ops);
  assertEquals(b.complete, true);
  assertEquals((nodes.get("m1")!.controlPoints as { position: Vec3 }[]).length, 2);
});

Deno.test("angle needs three clicks", () => {
  const nodes = new Map<string, MrsonNode>();
  let done = false, node: MrsonNode | null = null;
  for (const p of [[0, 0, 0], [1, 0, 0], [1, 1, 0]] as Vec3[]) {
    const r = placeClick("angle", node, p, "m1"); apply(nodes, r.ops); done = r.complete; node = nodes.get("m1")!;
  }
  assertEquals(done, true);
  assertEquals((nodes.get("m1")!.controlPoints as unknown[]).length, 3);
});

Deno.test("curve never auto-completes (user ends it)", () => {
  assertEquals(POINTS_NEEDED.curve, Infinity);
  const nodes = new Map<string, MrsonNode>();
  let node: MrsonNode | null = null;
  for (let i = 0; i < 5; i++) { const r = placeClick("curve", node, [i, 0, 0], "m1"); apply(nodes, r.ops); assertEquals(r.complete, false); node = nodes.get("m1")!; }
  assertEquals((nodes.get("m1")!.controlPoints as unknown[]).length, 5);
});

Deno.test("removeControlPointOp removes a point but not the last one", () => {
  const node = { id: "m1", type: "markup", controlPoints: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] } as unknown as MrsonNode;
  const op = removeControlPointOp(node, 0)!;
  assertEquals((op.value as unknown[]).length, 1);
  const single = { id: "m2", type: "markup", controlPoints: [{ position: [0, 0, 0] }] } as unknown as MrsonNode;
  assertEquals(removeControlPointOp(single, 0), null, "won't drop the last point");
});

Deno.test("control points carry sequential labels", () => {
  const r = placeClick("fiducial", null, [0, 0, 0], "m1");
  const cp = (r.ops[0].node!.controlPoints as { label: string }[])[0];
  assert(cp.label.startsWith("F-"), `labeled ${cp.label}`);
});
