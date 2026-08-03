// commit sealer — canonical serialization + content-addressed commits must be deterministic and
// tamper-evident, so a chain sealed by one party verifies for another and any altered delta is caught.
//   deno test -A --no-check render/test/commits.test.ts

import {
  branchPointAtIndex, branchPointAtTime, canonicalize, type Commit, hashCommit, sealStream, sha256Hex, verifyChain,
} from "../commits.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}
const eq = (a: unknown, b: unknown, m: string) => assert(a === b, `${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const FIXED = { isoFromMs: (ms: number) => String(ms) };   // deterministic, Date-independent

Deno.test("canonicalize: sorted keys, JCS number rule (1.0 → \"1\"), dropped undefined", () => {
  eq(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}', "keys sorted");
  eq(canonicalize(1.0), "1", "1.0 serializes as 1 (RFC 8785)");
  eq(canonicalize({ x: 1.0, y: 2.5 }), '{"x":1,"y":2.5}', "nested number rule");
  eq(canonicalize({ a: 1, b: undefined }), '{"a":1}', "undefined dropped");
  eq(canonicalize([3, { k: "v" }, "s"]), '[3,{"k":"v"},"s"]', "arrays preserve order");
});

Deno.test("sha256 primitive matches the standard (empty string vector)", async () => {
  eq(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA-256 of empty string");
});

Deno.test("hashCommit is deterministic and excludes the hash field", async () => {
  const base = { parents: [] as string[], t: "0", ops: [{ op: "patch", id: "n", path: "#/x", value: 1 }] };
  const h1 = await hashCommit(base);
  const h2 = await hashCommit({ ...base, hash: "sha256-deadbeef" } as unknown as Omit<Commit, "hash">);
  eq(h1, h2, "hash ignores the hash field");
  assert(h1.startsWith("sha256-") && h1.length === 71, "sha256-<64hex>");
});

Deno.test("sealStream bundles into ~interval windows, links parents, is deterministic", async () => {
  const deltas = [{ t: 0, k: "a" }, { t: 100, k: "b" }, { t: 1200, k: "c" }, { t: 1300, k: "d" }, { t: 2500, k: "e" }];
  const commits = await sealStream(deltas, { intervalMs: 1000, ...FIXED });
  eq(commits.length, 3, "3 windows: [0,100] [1200,1300] [2500]");
  eq(commits.map((c) => c.ops.length).join(","), "2,2,1", "op counts per window");
  eq(commits[0].parents.length, 0, "root has no parent");
  eq(commits[1].parents[0], commits[0].hash, "parent link 1");
  eq(commits[2].parents[0], commits[1].hash, "parent link 2");
  const again = await sealStream(deltas, { intervalMs: 1000, ...FIXED });
  eq(commits.map((c) => c.hash).join("|"), again.map((c) => c.hash).join("|"), "same input → same hashes (deterministic/content-addressed)");
});

Deno.test("first commit of a fork carries the base branch point", async () => {
  const commits = await sealStream([{ t: 0, k: "x" }], { intervalMs: 1000, base: { commit: "sha256-abc", offset: 7 }, ...FIXED });
  eq(JSON.stringify(commits[0].base), JSON.stringify({ commit: "sha256-abc", offset: 7 }), "base recorded on the fork's first commit");
});

Deno.test("branchPoint addressing: (commit, offset) at index and time", async () => {
  const deltas = [{ t: 0 }, { t: 100 }, { t: 1200 }, { t: 1300 }, { t: 2500 }];
  const commits = await sealStream(deltas, { intervalMs: 1000, ...FIXED });   // op counts 2,2,1
  eq(JSON.stringify(branchPointAtIndex(commits, 4)), JSON.stringify({ commit: commits[1].hash, offset: 0 }), "index 4 = end of commit1");
  eq(JSON.stringify(branchPointAtIndex(commits, 3)), JSON.stringify({ commit: commits[0].hash, offset: 1 }), "index 3 = commit0 + 1");
  eq(JSON.stringify(branchPointAtTime(commits, 1250)), JSON.stringify({ commit: commits[0].hash, offset: 1 }), "t=1250 → after 3 deltas");
  eq(branchPointAtIndex(commits, 1).commit, "", "index 1 (inside commit0) → root base with offset 1");
  eq(branchPointAtIndex(commits, 1).offset, 1, "offset into the first commit");
});

Deno.test("verifyChain: ok for a good chain, detects a tampered delta", async () => {
  const deltas = [{ t: 0, v: 1 }, { t: 500, v: 2 }, { t: 1600, v: 3 }];
  const commits = await sealStream(deltas, { intervalMs: 1000, ...FIXED });
  eq((await verifyChain(commits)).ok, true, "clean chain verifies");
  // tamper: alter an op inside commit0 without recomputing the hash
  const tampered = structuredClone(commits);
  (tampered[0].ops[0] as { v: number }).v = 999;
  const r = await verifyChain(tampered);
  eq(r.ok, false, "tamper detected");
  eq(r.badAt, 0, "flags the altered commit");
});
