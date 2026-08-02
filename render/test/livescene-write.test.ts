// Phase 1 Step 2 (revised for Step 3) — LiveScene is the pure MODEL. A local write applies to the
// model immediately, notifies displayers, and emits on the _changes feed CARRYING THE OP (so LiveSync
// can replicate it). An inbound remote op applies + notifies but the feed carries NO op (echo
// suppression happens by the op's absence). No transport in the model — no WebSocket needed.

import { type Change, type DisplayableManager, LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}
function eq(a: unknown, b: unknown, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

class FakeMgr implements DisplayableManager {
  interestedTypes: string[];
  added: MrsonNode[] = [];
  removed: string[] = [];
  constructor(types: string[]) { this.interestedTypes = types; }
  onNodeAdded(node: MrsonNode) { this.added.push(node); }
  onNodeRemoved(id: string) { this.removed.push(id); }
}

function fresh() {
  const mgr = new FakeMgr(["image"]);
  const scene = new LiveScene("http://x/mrson/", [mgr]);
  scene.nodes.set("vol1", { type: "image", id: "vol1", visible: true });
  const changes: Change[] = [];
  scene.subscribe((c) => changes.push(c));
  return { scene, mgr, changes };
}

Deno.test("write: applies locally, notifies displayer, feeds a LOCAL op", () => {
  const { scene, mgr, changes } = fresh();
  scene.write({ op: "patch", id: "vol1", path: "#/visible", value: false });
  eq(scene.nodes.get("vol1")!.visible, false, "model updated");
  eq(mgr.added.length, 1, "displayer notified once");
  eq(mgr.added[0].visible, false, "displayer got the UPDATED node");
  eq(changes.length, 1, "one change");
  eq([changes[0].kind, changes[0].origin], ["upsert", "local"], "local upsert");
  assert(changes[0].op, "feed carries the op → LiveSync replicates it");
  assert(typeof changes[0].v === "number", "sequence v");
});

Deno.test("applyRemote: applies + notifies, feed carries NO op (echo suppression)", () => {
  const { scene, mgr, changes } = fresh();
  scene.applyRemote({ op: "patch", id: "vol1", path: "#/visible", value: false, origin: "peer", v: 5 });
  eq(scene.nodes.get("vol1")!.visible, false, "remote applied to model");
  eq(mgr.added.length, 1, "displayer notified on remote change");
  eq(changes[0].origin, "peer", "feed carries the peer origin");
  assert(!changes[0].op, "no op on feed → LiveSync will not echo it back");
});

Deno.test("write del: removes, notifies removal, feeds op", () => {
  const { scene, mgr, changes } = fresh();
  scene.write({ op: "del", id: "vol1" });
  assert(!scene.nodes.has("vol1"), "node deleted");
  eq(mgr.removed, ["vol1"], "displayer removal");
  assert(changes[0].op, "del op on the feed");
});

Deno.test("write cmd: mutates via the applier and notifies", () => {
  const scene = new LiveScene("http://x/mrson/", [new FakeMgr(["markup"])]);
  scene.nodes.set("F", { type: "markup", id: "F", controlPoints: [{ position: [0, 0, 0] }] });
  scene.write({ op: "cmd", id: "F", cmd: "setControlPoint", args: { index: 0, position: [3, 3, 3] } });
  eq((scene.nodes.get("F")!.controlPoints as { position: number[] }[])[0].position, [3, 3, 3], "cmd applied");
});

Deno.test("sequence v increments per write", () => {
  const { scene, changes } = fresh();
  scene.write({ op: "patch", id: "vol1", path: "#/window", value: 100 });
  scene.write({ op: "patch", id: "vol1", path: "#/window", value: 200 });
  assert((changes[1].v) > (changes[0].v), "v is monotonic");
});

Deno.test("receiveEvent: inbound NodeAdded/NodeRemoved drive the model + feed as remote", async () => {
  const { scene, mgr, changes } = fresh();
  await scene.receiveEvent({ event: "NodeAdded", node: { type: "image", id: "vol9", visible: true } });
  assert(scene.nodes.has("vol9"), "inbound node added");
  eq(changes.at(-1)!.origin, "remote", "inbound change is remote-origin");
  await scene.receiveEvent({ event: "NodeRemoved", sourceId: "vol9" });
  assert(!scene.nodes.has("vol9"), "inbound remove applied");
  eq(mgr.removed.includes("vol9"), true, "displayer removal");
});
