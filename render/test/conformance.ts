// Cross-runtime conformance scenarios for the scene-sync foundation (ARCHITECTURE-2026-08-02 §4).
// runConformance() is RUNTIME-AGNOSTIC — no Deno.test, no DOM, no WebGPU, no real transport — so the
// SAME function runs and must return the SAME pass/fail set in Deno AND in the browser. It exercises
// the model + transport contract that DisplayableManagers and Controls sit on top of.
//
//   Deno   : render/test/conformance.test.ts asserts every scenario passes.
//   Browser: render/test/conformance-browser.ts runs it and stashes results on window; the driver
//            (conformance-run.ts) reads them back and diffs Deno-vs-browser — they must be identical.

import { type Change, type DisplayableManager, LiveScene } from "../livescene.ts";
import { LiveSync } from "../livesync.ts";
import { applyOp } from "../liveops.ts";
import type { Transport } from "../transport.ts";
import type { MrsonNode } from "../mrson.ts";

export interface ConfResult { name: string; ok: boolean; detail: string }

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

class FakeMgr implements DisplayableManager {
  interestedTypes: string[];
  added: MrsonNode[] = [];
  removed: string[] = [];
  constructor(types: string[]) { this.interestedTypes = types; }
  onNodeAdded(node: MrsonNode) { this.added.push(node); }
  onNodeRemoved(id: string) { this.removed.push(id); }
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
  deliver(m: unknown) { this.onMessage?.(m); }
  applied() { return this.sent.filter((m) => m.op === "applyOps"); }
}

export async function runConformance(): Promise<ConfResult[]> {
  const results: ConfResult[] = [];
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); results.push({ name, ok: true, detail: "" }); }
    catch (e) { results.push({ name, ok: false, detail: String((e as Error)?.message ?? e) }); }
  };

  await check("applyOp: patch mutates the node document", () => {
    const n = new Map<string, MrsonNode>([["v", { type: "image", id: "v", visible: true }]]);
    const r = applyOp(n, { op: "patch", id: "v", path: "#/visible", value: false });
    assert(r.changed && n.get("v")!.visible === false, "patch did not apply");
  });

  await check("LiveScene.write: model + displayer + feed carries the op", () => {
    const mgr = new FakeMgr(["image"]);
    const s = new LiveScene("http://x/", [mgr]);
    s.nodes.set("v", { type: "image", id: "v", visible: true });
    const changes: Change[] = [];
    s.subscribe((c) => changes.push(c));
    s.write({ op: "patch", id: "v", path: "#/visible", value: false });
    assert(s.nodes.get("v")!.visible === false, "model not updated");
    assert(mgr.added.length === 1 && mgr.added[0].visible === false, "displayer not notified with updated node");
    assert(changes.length === 1 && changes[0].origin === "local" && !!changes[0].op, "feed missing local op");
  });

  await check("LiveScene.applyRemote: applies but feed carries no op (echo suppression)", () => {
    const s = new LiveScene("http://x/", [new FakeMgr(["image"])]);
    s.nodes.set("v", { type: "image", id: "v", visible: true });
    const changes: Change[] = [];
    s.subscribe((c) => changes.push(c));
    s.applyRemote({ op: "patch", id: "v", path: "#/visible", value: false, origin: "peer", v: 5 });
    assert(s.nodes.get("v")!.visible === false, "remote not applied");
    assert(changes[0].origin === "peer" && !changes[0].op, "remote change must not carry an op");
  });

  await check("LiveSync: local write replicated out; remote change not echoed", async () => {
    const s = new LiveScene("http://x/", [new FakeMgr(["image"])]);
    s.nodes.set("v", { type: "image", id: "v", visible: true });
    const t = new MockTransport();
    const sync = new LiveSync(s, t);
    await sync.connect();
    t.sent.length = 0;
    s.write({ op: "patch", id: "v", path: "#/visible", value: false });
    sync.flush();
    assert(t.applied().length === 1, "local write not sent");
    t.sent.length = 0;
    s.applyRemote({ op: "patch", id: "v", path: "#/visible", value: true, origin: "peer" });
    sync.flush();
    assert(t.applied().length === 0, "remote change was echoed back");
  });

  await check("LiveSync: outbound coalesces latest-wins per key", async () => {
    const s = new LiveScene("http://x/", [new FakeMgr(["image"])]);
    s.nodes.set("v", { type: "image", id: "v", window: 0 });
    const t = new MockTransport();
    const sync = new LiveSync(s, t);
    await sync.connect();
    t.sent.length = 0;
    s.write({ op: "patch", id: "v", path: "#/window", value: 1 });
    s.write({ op: "patch", id: "v", path: "#/window", value: 2 });
    s.write({ op: "patch", id: "v", path: "#/window", value: 3 });
    sync.flush();
    assert(t.applied().length === 1, "same-key writes did not collapse");
    assert((t.applied()[0].ops as { value: number }[])[0].value === 3, "latest did not win");
  });

  await check("LiveSync: inbound event drives the model + displayer", async () => {
    const mgr = new FakeMgr(["image"]);
    const s = new LiveScene("http://x/", [mgr]);
    const t = new MockTransport();
    await new LiveSync(s, t).connect();
    t.deliver({ event: "NodeAdded", node: { type: "image", id: "v9", visible: true } });
    await new Promise((r) => setTimeout(r, 0));
    assert(s.nodes.has("v9") && mgr.added.at(-1)?.id === "v9", "inbound node not applied");
  });

  await check("inbound SegmentationDisplayModified updates the MODEL + feed (not just the render)", async () => {
    const s = new LiveScene("http://x/", [new FakeMgr(["segmentation"])]);
    s.nodes.set("seg", { type: "segmentation", id: "seg", visible: true });
    const changes: Change[] = [];
    s.subscribe((c) => changes.push(c));
    await s.receiveEvent({ event: "SegmentationDisplayModified", sourceId: "seg", display: { visible: false } });
    assert(s.nodes.get("seg")!.visible === false, "model node not updated from seg display event");
    assert(changes.at(-1)!.type === "segmentation", "seg display change not emitted on the feed");
  });

  return results;
}
