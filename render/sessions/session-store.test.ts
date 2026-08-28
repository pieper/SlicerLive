import { assert, assertEquals } from "jsr:@std/assert@1";
import { LiveScene } from "../livescene.ts";
import { MemoryFS } from "./session-fs.ts";
import { blobRefs, SessionStore } from "./session-store.ts";

let clock = 1000;
const now = () => (clock += 1);

Deno.test("session: log + checkpoint round-trip (close/reopen → identical state)", async () => {
  const fs = new MemoryFS();
  const store = new SessionStore(fs, { now, flushMs: 0, keyEveryN: 3 });
  await store.open();
  const s = new LiveScene("http://x/", []);
  s.nodes.set("v", { type: "image", id: "v", window: 10, zarr: { chunkHashes: { "0.0.0": "sha256-aaa" } } });
  await store.attach(s);
  s.write({ op: "patch", id: "v", path: "#/window", value: 20 });
  s.write({ op: "put", id: "m", node: { type: "markup", id: "m", controlPoints: [] } });
  s.write({ op: "patch", id: "v", path: "#/window", value: 30 });     // 3rd delta → checkpoint
  s.write({ op: "del", id: "m" });
  await store.flush(); await store.checkpoint();
  const again = new SessionStore(fs, { now });
  const nodes = await again.open();
  assertEquals(nodes.get("v")!.window, 30); assert(!nodes.has("m"), "deleted node came back");
  assert((await fs.list("log")).length >= 1, "no log segment written");
});

Deno.test("session: undo/redo write inverse ops through LiveScene (and are not re-recorded as edits)", async () => {
  const fs = new MemoryFS();
  const store = new SessionStore(fs, { now, flushMs: 0 });
  await store.open();
  const s = new LiveScene("http://x/", []);
  s.nodes.set("v", { type: "image", id: "v", window: 10 });
  await store.attach(s);
  s.write({ op: "patch", id: "v", path: "#/window", value: 20 });
  clock += 1000;
  s.write({ op: "patch", id: "v", path: "#/level", value: 5 });
  assertEquals(store.undo.length, 2);
  store.undoLast(); assertEquals(s.nodes.get("v")!.level, undefined); assertEquals(s.nodes.get("v")!.window, 20);
  store.undoLast(); assertEquals(s.nodes.get("v")!.window, 10);
  assertEquals(store.undo.length, 0); assertEquals(store.redo.length, 2);
  store.redoLast(); assertEquals(s.nodes.get("v")!.window, 20);
  assertEquals(store.undo.length, 1);
});

Deno.test("session: export carries exactly the reachable blobs; bookmarks + branch", async () => {
  const fs = new MemoryFS();
  const store = new SessionStore(fs, { now, flushMs: 0 });
  await store.open();
  const s = new LiveScene("http://x/", []);
  s.nodes.set("v", { type: "image", id: "v", zarr: { chunkHashes: { "0.0.0": "sha256-a", "0.0.1": "sha256-b" } } });
  s.nodes.set("mesh", { type: "mesh", id: "mesh", points: "sha256-p", triangles: "sha256-t" });
  await store.attach(s);
  await store.cacheBlob("sha256-a", new Uint8Array([1])); await store.cacheBlob("sha256-stale", new Uint8Array([9]));
  const target = new MemoryFS();
  const r = await store.exportActiveSet(target, (h) => Promise.resolve(h === "sha256-b" || h === "sha256-p" ? new Uint8Array([2]) : null));
  assertEquals(r.nodes, 2); assertEquals(r.blobs, 3); assertEquals(r.missing, ["sha256-t"]);
  assert(!(await target.exists("blobs/sha256-stale")), "unreferenced blob exported");
  assertEquals([...blobRefs([...s.nodes.values()])].sort(), ["sha256-a", "sha256-b", "sha256-p", "sha256-t"]);
  const b = await store.bookmark("start"); assert(b.seq >= 0);
  s.write({ op: "patch", id: "v", path: "#/window", value: 1 }); await store.flush();
  const branchFs = new MemoryFS();
  await store.branch(branchFs, "alt", b.seq);
  const branched = JSON.parse((await branchFs.readText("scene.mrson.json"))!);
  assertEquals(branched.nodes.v.window, undefined, "branch from the bookmark must predate the edit");
});
