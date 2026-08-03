// SceneRecorder — the recorded session must reconstruct EXACTLY at every recorded timepoint
// (keyframe+delta replay is lossless), sessions segment on reset, blob refs are collected, and the
// lossy cull() still reconstructs exactly at keyframe times. Plus LiveScene.applySnapshot reconcile.
//   deno test -A --no-check render/test/recorder.test.ts

import { type Change, type DisplayableManager, LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { SceneRecorder } from "../recorder.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}
const j = (v: unknown) => JSON.stringify(v);
function eqMap(a: Map<string, MrsonNode>, b: Map<string, MrsonNode>, msg: string) {
  const ao = Object.fromEntries([...a].sort());
  const bo = Object.fromEntries([...b].sort());
  assert(j(ao) === j(bo), `${msg}\n  got  ${j(ao)}\n  want ${j(bo)}`);
}

/** A monotonic clock: each call returns the next integer, so every frame gets a distinct time. */
function tick() { let n = 0; return () => ++n; }

Deno.test("seek reconstructs EXACTLY at every recorded time (keyframe + delta, lossless)", () => {
  const scene = new LiveScene("http://x/mrson/", []);
  scene.nodes.set("vol1", { type: "image", id: "vol1", window: 100 });
  const rec = new SceneRecorder(scene, { now: tick(), keyEveryN: 3 });   // force interior keyframes
  rec.start();

  const expected: [number, Map<string, MrsonNode>][] = [];
  const snap = () => new Map([...scene.nodes].map(([k, v]) => [k, structuredClone(v)]));
  const step = (fn: () => void) => { fn(); expected.push([rec.head(), snap()]); };

  step(() => scene.write({ op: "patch", id: "vol1", path: "#/window", value: 110 }));
  step(() => scene.write({ op: "patch", id: "vol1", path: "#/window", value: 120 }));
  step(() => scene.write({ op: "put", id: "cam1", node: { type: "camera", id: "cam1", position: [0, 0, 500] } }));
  step(() => scene.write({ op: "patch", id: "cam1", path: "#/position", value: [1, 2, 3] }));
  step(() => scene.write({ op: "patch", id: "vol1", path: "#/window", value: 130 }));
  step(() => scene.write({ op: "put", id: "seg1", node: { type: "segmentation", id: "seg1", opacity: 0.5 } }));
  step(() => scene.write({ op: "del", id: "cam1" }));
  step(() => scene.write({ op: "patch", id: "seg1", path: "#/opacity", value: 0.8 }));

  // at least one interior keyframe must have been inserted (keyEveryN=3, 8 deltas)
  assert(rec.session.frames.filter((f) => f.k === "key").length >= 3, "interior keyframes inserted");

  for (const [t, want] of expected) eqMap(rec.seek(t), want, `seek(${t})`);
});

Deno.test("seek between frames returns the earlier committed state", () => {
  const scene = new LiveScene("http://x/mrson/", []);
  scene.nodes.set("n", { type: "image", id: "n", window: 1 });
  const rec = new SceneRecorder(scene, { now: tick() });
  rec.start();
  scene.write({ op: "patch", id: "n", path: "#/window", value: 2 });
  const t1 = rec.head();
  scene.write({ op: "patch", id: "n", path: "#/window", value: 3 });
  // t1 + 0.5 is strictly between the two writes → must still read window=2
  assert((rec.seek(t1 + 0.5).get("n") as MrsonNode).window === 2, "reads the state as of t1, not the later write");
});

Deno.test("reset segments the session: seek before has the old scene, after is cleared+rebuilt", async () => {
  const scene = new LiveScene("http://x/mrson/", []);
  scene.nodes.set("old", { type: "image", id: "old", window: 7 });
  const rec = new SceneRecorder(scene, { now: tick() });
  rec.start();
  scene.write({ op: "patch", id: "old", path: "#/window", value: 8 });
  const tBefore = rec.head();
  await scene.receiveEvent({ event: "SceneClosed" });           // mrmlScene.Clear()
  const tReset = rec.head();
  await scene.receiveEvent({ event: "NodeAdded", node: { type: "image", id: "new", window: 9 } });
  const tAfter = rec.head();

  assert(rec.seek(tBefore).has("old") && !rec.seek(tBefore).has("new"), "before reset: old scene");
  assert(rec.seek(tReset).size === 0, "at reset: empty");
  const after = rec.seek(tAfter);
  assert(after.has("new") && !after.has("old"), "after reset: fresh scene, old gone");
});

Deno.test("blobRefs collects content-addressed zarr hashes; unreferenced blobs are not retained", () => {
  const scene = new LiveScene("http://x/mrson/", []);
  scene.nodes.set("ct", { type: "image", id: "ct", zarr: { chunks: ["ab12cd34ef56", "9988aabbccdd"] } });
  const rec = new SceneRecorder(scene, { now: tick() });
  rec.start();
  scene.write({ op: "put", id: "ct2", node: { type: "image", id: "ct2", zarr: { chunks: ["deadbeef1234"] } } });
  const refs = rec.blobRefs();
  assert(refs.has("ab12cd34ef56") && refs.has("9988aabbccdd") && refs.has("deadbeef1234"), "all zarr hashes collected");
  assert(!refs.has("nonexistent"), "no phantom refs");
});

Deno.test("cull thins deltas but keyframe-time reconstruction stays exact", () => {
  const scene = new LiveScene("http://x/mrson/", []);
  scene.nodes.set("s", { type: "segmentation", id: "s", rev: 0 });
  const rec = new SceneRecorder(scene, { now: tick(), keyEveryN: 5 });
  rec.start();
  // many close revisions of one node (a segmentation being painted)
  const keyTimes: number[] = [];
  for (let i = 1; i <= 20; i++) {
    scene.write({ op: "patch", id: "s", path: "#/rev", value: i });
    const last = rec.session.frames.at(-1)!;
    if (last.k === "key") keyTimes.push(last.t);
  }
  const before = rec.session.frames.length;
  const expectAtKeys = keyTimes.map((t) => [t, (rec.seek(t).get("s") as MrsonNode).rev]);
  const dropped = rec.cull(1000);   // gap far larger than the 1-per-tick spacing → drop interior deltas
  assert(dropped > 0 && rec.session.frames.length < before, "cull dropped superseded deltas");
  // every keyframe time still reconstructs exactly (keyframes are never culled)
  for (const [t, rev] of expectAtKeys) assert((rec.seek(t as number).get("s") as MrsonNode).rev === rev, `keyframe seek(${t}) exact after cull`);
});

// ── LiveScene.applySnapshot reconcile (the replay view driver) ─────────────────

class CaptureMgr implements DisplayableManager {
  interestedTypes: string[];
  added: string[] = [];
  removed: string[] = [];
  constructor(types: string[]) { this.interestedTypes = types; }
  onNodeAdded(node: MrsonNode) { this.added.push(node.id); }
  onNodeRemoved(id: string) { this.removed.push(id); }
}

Deno.test("applySnapshot reconciles the view: removes gone, (re)adds new/changed, skips unchanged", async () => {
  const mgr = new CaptureMgr(["image"]);
  const scene = new LiveScene("http://x/mrson/", [mgr]);
  const from = new Map<string, MrsonNode>([
    ["a", { type: "image", id: "a", window: 1 }],
    ["b", { type: "image", id: "b", window: 2 }],   // will be removed
    ["c", { type: "image", id: "c", window: 3 }],   // unchanged
  ]);
  const target = new Map<string, MrsonNode>([
    ["a", { type: "image", id: "a", window: 9 }],   // changed
    ["c", { type: "image", id: "c", window: 3 }],   // unchanged
    ["d", { type: "image", id: "d", window: 4 }],   // new
  ]);
  await scene.applySnapshot(target, from);
  assert(mgr.removed.length === 1 && mgr.removed[0] === "b", "removed the gone node only");
  assert(mgr.added.sort().join(",") === "a,d", "re-added changed + new, skipped unchanged (c)");
});

Deno.test("applySnapshot does not mutate the model or emit on the _changes feed (no recording pollution)", async () => {
  const scene = new LiveScene("http://x/mrson/", [new CaptureMgr(["image"])]);
  scene.nodes.set("live", { type: "image", id: "live", window: 1 });
  const changes: Change[] = [];
  scene.subscribe((c) => changes.push(c));
  await scene.applySnapshot(new Map([["past", { type: "image", id: "past", window: 5 }]]), new Map());
  assert(scene.nodes.has("live") && !scene.nodes.has("past"), "model untouched by replay");
  assert(changes.length === 0, "replay emits nothing on the feed");
});
