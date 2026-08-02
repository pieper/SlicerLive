// Phase 1 Step 3 — LiveSync: the transport layer. Over a mock transport, assert the replication
// contract: on connect it subscribes the peer to the managers' types; a LOCAL write is replicated
// out (coalesced); a REMOTE change is NOT echoed back; an inbound event drives the model.

import { type DisplayableManager, LiveScene } from "../livescene.ts";
import { LiveSync } from "../livesync.ts";
import type { Transport } from "../transport.ts";
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
  constructor(types: string[]) { this.interestedTypes = types; }
  onNodeAdded(node: MrsonNode) { this.added.push(node); }
}

class MockTransport implements Transport {
  sent: Record<string, unknown>[] = [];
  onMessage?: (m: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
  isOpen = false;
  connect() { this.isOpen = true; this.onOpen?.(); }
  close() { this.isOpen = false; this.onClose?.(); }
  send(m: unknown) { this.sent.push(m as Record<string, unknown>); }
  deliver(m: unknown) { this.onMessage?.(m); }               // test: simulate an inbound message
  applied() { return this.sent.filter((m) => m.op === "applyOps"); }
}

Deno.test("connect: subscribes the peer to the managers' union of types", async () => {
  const scene = new LiveScene("http://x/", [new FakeMgr(["image", "camera"])]);
  const t = new MockTransport();
  await new LiveSync(scene, t).connect();
  const sub = t.sent.find((m) => m.op === "subscribe") as { types: string[] } | undefined;
  assert(sub, "subscribe sent");
  eq(new Set(sub.types), new Set(["image", "camera"]), "subscribed types");
});

Deno.test("local write is replicated out; remote change is NOT echoed", async () => {
  const scene = new LiveScene("http://x/", [new FakeMgr(["image"])]);
  scene.nodes.set("vol1", { type: "image", id: "vol1", visible: true });
  const t = new MockTransport();
  const sync = new LiveSync(scene, t);
  await sync.connect();
  t.sent.length = 0;

  scene.write({ op: "patch", id: "vol1", path: "#/visible", value: false });
  sync.flush();                                              // force the outbound coalescer now
  eq(t.applied().length, 1, "one applyOps sent for the local write");
  eq((t.applied()[0].ops as { path: string }[])[0].path, "#/visible", "the local op went out");

  t.sent.length = 0;
  scene.applyRemote({ op: "patch", id: "vol1", path: "#/visible", value: true, origin: "peer" });
  sync.flush();
  eq(t.applied().length, 0, "remote change is NOT echoed back");
});

Deno.test("outbound coalesces latest-wins per key", async () => {
  const scene = new LiveScene("http://x/", [new FakeMgr(["image"])]);
  scene.nodes.set("vol1", { type: "image", id: "vol1", window: 0 });
  const t = new MockTransport();
  const sync = new LiveSync(scene, t);
  await sync.connect();
  t.sent.length = 0;
  scene.write({ op: "patch", id: "vol1", path: "#/window", value: 1 });
  scene.write({ op: "patch", id: "vol1", path: "#/window", value: 2 });
  scene.write({ op: "patch", id: "vol1", path: "#/window", value: 3 });
  sync.flush();
  eq(t.applied().length, 1, "three same-key writes collapse to one send");
  eq((t.applied()[0].ops as { value: number }[])[0].value, 3, "latest wins");
});

Deno.test("inbound event drives the model + displayers", async () => {
  const mgr = new FakeMgr(["image"]);
  const scene = new LiveScene("http://x/", [mgr]);
  const t = new MockTransport();
  await new LiveSync(scene, t).connect();
  t.deliver({ event: "NodeAdded", node: { type: "image", id: "vol9", visible: true } });
  await new Promise((r) => setTimeout(r, 0));               // let the inbound queue drain
  assert(scene.nodes.has("vol9"), "inbound node added to the model");
  eq(mgr.added.at(-1)?.id, "vol9", "displayer notified");
});
