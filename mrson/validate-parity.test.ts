// T1 cross-language parity: mrson/validate.py must produce the SAME issue list as mrson/validate.ts
// for the same document — same codes, same paths, same messages, same severities, same order.
//
// WHY this is a test and not a comment: there are two validators because there are two producers
// (TypeScript in logic/, Python in LiveStory/), and the schema is only a single source of truth if
// both read it the same way. Without this test the Python side could quietly accept something the
// TypeScript side rejects, which is exactly the drift mrson/ exists to end.
//
// Modelled on render/test/commits-conformance.test.ts, which pins the TS and Python *canonical
// hashers* to each other for the same reason. Needs python3 on PATH; validate.py is stdlib only.
//
//   deno test -A --no-check mrson/validate-parity.test.ts

import { assert, assertEquals } from "./assert.ts";
import { type Issue, validateMrcomManifest, validateScene } from "./validate.ts";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = new URL("../", import.meta.url).pathname;

async function pythonIssues(doc: unknown): Promise<Issue[]> {
  const tmp = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(doc));
    const { code, stdout, stderr } = await new Deno.Command("python3", {
      args: [HERE + "validate.py", "--json", tmp],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(stderr);
    if (code !== 0) throw new Error(`validate.py exited ${code}: ${err}`);
    return JSON.parse(new TextDecoder().decode(stdout)) as Issue[];
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

const isManifest = (d: unknown) => !!d && typeof d === "object" && "mrcom" in (d as Record<string, unknown>);

async function assertParity(label: string, doc: unknown): Promise<void> {
  const ts = isManifest(doc) ? validateMrcomManifest(doc) : validateScene(doc);
  const py = await pythonIssues(doc);
  // Compare the whole list, in order, field for field — not just the error count.
  assertEquals(
    py,
    ts,
    `validate.py disagrees with validate.ts on ${label}\n` +
      `  ts: ${JSON.stringify(ts, null, 1)}\n  py: ${JSON.stringify(py, null, 1)}`,
  );
}

// Documents chosen to exercise every branch where the two languages could plausibly diverge:
// JSON.stringify vs json.dumps formatting, bool-is-an-int in Python, typeof naming, ceil arithmetic.
const HASH = "sha256-" + "a".repeat(64);
const ZARR = { shape: [5, 3, 4], chunks: [5, 3, 4], chunkGrid: [1, 1, 1], dtype: "<i2", chunkHashes: { "0.0.0": HASH } };

const CASES: Record<string, unknown> = {
  "a clean scene": { mrson: 0, blobBase: "blobs/", nodes: { i1: { id: "i1", type: "image", dims: [4, 3, 5], ijkToRAS: new Array(16).fill(0), zarr: ZARR, comps: 1 } } },
  "a legacy class-keyed bare map": { n1: { id: "n1", class: "vtkMRMLScalarVolumeNode", attrs: { window: 1.0, level: 2.5 } } },
  // bool-is-an-int in Python: `true` must fail an int field in BOTH languages
  "a boolean where an int belongs": { mrson: 0, nodes: { v1: { id: "v1", type: "layout", arrangement: true } } },
  // integral floats: JSON.stringify(3.0) is "3", json.dumps(3.0) is "3.0" — the message must match
  "an integral float in a message": { mrson: 0, nodes: { c1: { id: "c1", type: "crosshair", mode: 3.5 } } },
  // typeof naming: null, array and object must all be described identically
  "a null, an array and an object in wrong places": { mrson: 0, nodes: { i1: { id: "i1", type: "image", dims: null, comps: [1], zarr: "not-an-object" } } },
  "wrong-length matrices and arrays": { mrson: 0, nodes: { i1: { id: "i1", type: "image", ijkToRAS: [1, 2, 3], dims: [4, 3] } } },
  "the chunkGrid ceil arithmetic": { mrson: 0, nodes: { i1: { id: "i1", type: "image", zarr: { ...ZARR, chunks: [2, 2, 3], chunkGrid: [1, 1, 1] } } } },
  "every legacy form at once": { mrson: 0, nodes: { m1: { id: "m1", class: "vtkMRMLModelNode", attrs: { x: 1 }, blobs: { points: { hash: "b".repeat(32), dtype: "float32", count: 12, comps: 3, size: 48 } }, zarr: { ...ZARR, bytes: "9999", dir: "v.zarr", dataset: "0", chunkHashes: undefined } } } },
  "a dicom descriptor with a leaked credential": { mrson: 0, nodes: { i1: { id: "i1", type: "image", dicom: { kind: "dicom-series", instances: ["1.2.3"], retrieve: [{ scheme: "s3", bucket: "b", secretKey: "AKIA" }, { noScheme: true }] } } } },
  "an unknown type and unknown fields": { mrson: 0, nodes: { x1: { id: "x1", type: "somethingNew", whatever: { deep: [1, 2] } } } },
  "a blobs array (the divergence-2 error)": { mrson: 0, nodes: { m1: { id: "m1", type: "mesh", blobs: [] } } },
  "an id/key mismatch and a dangling ref": { mrson: 0, nodes: { a: { id: "b", type: "image", refs: { display: ["gone"], single: "notAnArray" } } } },
  "a not-a-document": "nope",
  "an mrcom manifest, clean": { mrcom: 1, mode: "hybrid", scene: { length: 10, encoding: "deflate", digest: "c".repeat(64), nodes: 1 }, bulk: { embedded: { count: 1, bytes: 2 }, required: [{ hash: HASH }] } },
  "an mrcom manifest violating its mode": { mrcom: 1, mode: "embed", scene: { length: 10, encoding: "none", digest: "c".repeat(64) }, bulk: { required: [{ hash: HASH }] } },
  "an mrcom manifest with a bad enum and digest": { mrcom: 1, mode: "zip", scene: { length: 10, encoding: "gzip", digest: "sha256-" + "c".repeat(64) } },
};

for (const [label, doc] of Object.entries(CASES)) {
  Deno.test(`parity: ${label}`, async () => { await assertParity(label, doc); });
}

Deno.test("parity: the committed fixtures", async () => {
  let n = 0;
  for await (const e of Deno.readDir(HERE + "fixtures")) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const doc = JSON.parse(await Deno.readTextFile(HERE + "fixtures/" + e.name));
    await assertParity(`fixtures/${e.name}`, doc);
    n++;
  }
  assert(n > 0, "no fixtures to check parity against");
});

Deno.test("parity: the published gallery scenes", async () => {
  const roots = [Deno.env.get("SLICERLIVE_GALLERY"), REPO + "../live/scenes", REPO + "../live/legacy/scenes"]
    .filter((p): p is string => !!p);
  const files: string[] = [];
  for (const root of roots) {
    try {
      for await (const e of Deno.readDir(root)) {
        if (!e.isFile || !e.name.endsWith(".json") || e.name === "index.json" || e.name.endsWith(".story.json")) continue;
        files.push(root + "/" + e.name);
      }
    } catch { /* checkout not present */ }
  }
  if (!files.length) {
    console.log("  (skipped: no gallery checkout)");
    return;
  }
  for (const f of files) await assertParity(f, JSON.parse(await Deno.readTextFile(f)));
  console.log(`  parity over ${files.length} published scene(s)`);
});
