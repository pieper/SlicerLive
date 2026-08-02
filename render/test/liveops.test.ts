// Unit tests for the shared mrson op-applier (render/liveops.ts). Runs in Deno (`deno test`) and,
// because it imports only pure TS, is the seed of the cross-runtime conformance suite (Phase 1 §4):
// the same applyOp() semantics must hold in the browser.

import { applyOp, applyOps, type Op, registerCmd } from "../liveops.ts";
import type { MrsonNode } from "../mrson.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function scene(): Map<string, MrsonNode> {
  return new Map<string, MrsonNode>([
    ["vol1", { type: "image", id: "vol1", visible: true, window: 100 }],
    ["F", { type: "markup", id: "F", markupType: "fiducial", controlPoints: [{ position: [0, 0, 0] }, { position: [1, 1, 1] }] }],
  ]);
}

Deno.test("patch: set a simple property", () => {
  const n = scene();
  const r = applyOp(n, { op: "patch", id: "vol1", path: "#/visible", value: false });
  eq(r, { changed: true, id: "vol1", kind: "patch", path: "#/visible" }, "result");
  eq(n.get("vol1")!.visible, false, "visible flipped");
});

Deno.test("patch: nested array path", () => {
  const n = scene();
  const r = applyOp(n, { op: "patch", id: "F", path: "#/controlPoints/0/position", value: [9, 8, 7] });
  assert(r.changed, "changed");
  eq((n.get("F")!.controlPoints as { position: number[] }[])[0].position, [9, 8, 7], "cp0 moved");
  eq((n.get("F")!.controlPoints as { position: number[] }[])[1].position, [1, 1, 1], "cp1 untouched");
});

Deno.test("patch: creates intermediate containers", () => {
  const n = scene();
  applyOp(n, { op: "patch", id: "vol1", path: "#/display/color/0", value: 0.5 });
  eq((n.get("vol1")!.display as { color: number[] }).color[0], 0.5, "intermediate created");
});

Deno.test("patch: missing node is a no-op, never a throw", () => {
  const n = scene();
  const r = applyOp(n, { op: "patch", id: "ghost", path: "#/x", value: 1 });
  eq(r, { changed: false, id: "ghost", kind: "noop", path: "#/x" }, "noop");
});

Deno.test("put: replaces the whole node, envelope id is authoritative", () => {
  const n = scene();
  applyOp(n, { op: "put", id: "seg1", node: { type: "segmentation", id: "IGNORED", name: "S" } as MrsonNode });
  eq(n.get("seg1")!.id, "seg1", "id from envelope, not body");
  eq(n.get("seg1")!.name, "S", "body applied");
});

Deno.test("del: removes; missing is changed:false", () => {
  const n = scene();
  eq(applyOp(n, { op: "del", id: "vol1" }).changed, true, "removed");
  assert(!n.has("vol1"), "gone");
  eq(applyOp(n, { op: "del", id: "vol1" }).changed, false, "second del noop");
});

Deno.test("cmd: setControlPoint moves one point", () => {
  const n = scene();
  const r = applyOp(n, { op: "cmd", id: "F", cmd: "setControlPoint", args: { index: 1, position: [5, 5, 5] } });
  eq(r.kind, "cmd", "kind");
  eq((n.get("F")!.controlPoints as { position: number[] }[])[1].position, [5, 5, 5], "cp1 moved");
});

Deno.test("cmd: unknown command is a no-op", () => {
  const n = scene();
  eq(applyOp(n, { op: "cmd", id: "F", cmd: "nope", args: {} }).changed, false, "noop");
});

Deno.test("registerCmd: a tool adds its own imperative op", () => {
  registerCmd("nudgeWindow", (node, args) => {
    node.window = (Number(node.window) || 0) + Number(args.by ?? 0);
    return true;
  });
  const n = scene();
  applyOp(n, { op: "cmd", id: "vol1", cmd: "nudgeWindow", args: { by: 25 } });
  eq(n.get("vol1")!.window, 125, "window nudged");
});

Deno.test("applyOps: batch applies in order", () => {
  const n = scene();
  const ops: Op[] = [
    { op: "patch", id: "vol1", path: "#/window", value: 200 },
    { op: "del", id: "F" },
    { op: "put", id: "cam", node: { type: "camera", id: "cam" } as MrsonNode },
  ];
  const rs = applyOps(n, ops);
  eq(rs.map((r) => r.kind), ["patch", "del", "put"], "kinds in order");
  eq(n.get("vol1")!.window, 200, "patched");
  assert(!n.has("F"), "deleted");
  assert(n.has("cam"), "put");
});
