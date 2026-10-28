// T1 conformance: THE SHIPPED OUTPUT MUST VALIDATE.
//
// This is the test that keeps the schema honest. It deliberately validates real producer output and
// real published documents rather than fixtures written to match the schema — a fixture that agrees
// with the schema proves nothing about the code. Every divergence recorded in mrson/README.md was
// found by this test's inputs, not by reading the spec.
//
// Inputs, in increasing order of how hard they are to obtain:
//   1. logic/ingest.ts volumeNodes()                    — in-process, always available
//   2. logic/segmentation-editor.ts createSegmentation() — in-process, always available
//   3. mrson/fixtures/*.json                             — captured output, incl. serialize_mrson.py
//                                                          (which needs a live Slicer, so it is captured
//                                                           once and committed rather than run in CI)
//   4. ../live/{scenes,legacy/scenes}/*.json             — the published gallery, when that sibling
//                                                          checkout is present; skipped otherwise

import { assert, assertEquals } from "./assert.ts";
import { errorsOnly, formatIssues, type Issue, validateScene } from "./validate.ts";
import { LocalBlobStore, volumeNodes } from "../logic/ingest.ts";
import { createSegmentation } from "../logic/segmentation-editor.ts";
import { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = new URL("../", import.meta.url).pathname;

function sceneOf(nodes: MrsonNode[] | Map<string, MrsonNode>): unknown {
  const out: Record<string, unknown> = {};
  const list = nodes instanceof Map ? [...nodes.values()] : nodes;
  for (const n of list) out[n.id] = n;
  return { mrson: 0, blobBase: "blobs/", nodes: out };
}

function mustBeClean(what: string, issues: Issue[]): void {
  const e = errorsOnly(issues);
  assertEquals(e.length, 0, `${what} does not satisfy mrson/schema:\n${formatIssues(e)}`);
}

function phantom(nx: number, ny: number, nz: number): Int16Array {
  const d = new Int16Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) d[(z * ny + y) * nx + x] = x * 3 - y * 2 + z * 100 - 400;
  }
  return d;
}

// The 4x3x5 fixture whose ijkToRAS is already asserted by harness/dicom.browser.test.ts, so the
// geometry oracle here is one that was validated independently of this schema.
const DIMS: [number, number, number] = [4, 3, 5];
const IJK_TO_RAS = [-0.5, 0, 0, 10, 0, -0.8, 0, 20, 0, 0, 2, 5, 0, 0, 0, 1];
const vol = () => ({ name: "conformance", dims: DIMS, dtype: "<i2", data: phantom(...DIMS), ijkToRAS: IJK_TO_RAS });

// --- 1 + 2: the in-process TypeScript producers ------------------------------------------------

Deno.test("conformance: logic/ingest.ts volumeNodes() output validates", async () => {
  const built = await volumeNodes(vol() as never, { name: "CT" });
  mustBeClean("volumeNodes()", validateScene(sceneOf(built.nodes)));
  // and the labelmap variant, which takes the other display-node branch
  const lm = await volumeNodes(vol() as never, { name: "Seg", labelmap: true });
  mustBeClean("volumeNodes({labelmap:true})", validateScene(sceneOf(lm.nodes)));
});

Deno.test("conformance: logic/segmentation-editor.ts createSegmentation() output validates", async () => {
  const live = new LiveScene("http://conformance.invalid/", []);  // no managers: we only want the node map
  const store = new LocalBlobStore();
  const built = await volumeNodes(vol() as never, { name: "CT" });
  store.add(built.blobs);
  for (const n of built.nodes) live.write({ op: "put", id: n.id, node: n });
  await createSegmentation(live, store, built.imageId, { name: "Seg" });
  mustBeClean("createSegmentation()", validateScene(sceneOf(live.nodes)));
});

Deno.test("conformance: every blob a validated scene names is reachable from blobRefs()", async () => {
  // The schema says where bulk may live (bulkFields in schema/bulk.schema.json); blobRefs() is what
  // actually walks it. If the two disagree, an export silently drops bulk — which is how the
  // `normals` bug (divergence 5) shipped.
  const { blobRefs } = await import("../render/sessions/session-store.ts");
  const built = await volumeNodes(vol() as never);
  const reached = blobRefs(built.nodes);
  for (const h of built.blobs.keys()) {
    assert(reached.has(h), `blobRefs() missed ${h}, which volumeNodes() produced — an export would lose it`);
  }
  // a mesh carrying all three geometry blobs, flat AND via a blobs map
  const h = (c: string) => "sha256-" + c.repeat(64);
  const mesh: MrsonNode = { id: "m1", type: "mesh", points: h("a"), triangles: h("b"), normals: h("c") } as never;
  const viaMap: MrsonNode = { id: "m2", type: "mesh", blobs: { points: h("d"), polys: h("e"), normals: h("f") } } as never;
  mustBeClean("flat mesh", validateScene(sceneOf([mesh])));
  mustBeClean("mesh with a blobs map", validateScene(sceneOf([viaMap])));
  const got = blobRefs([mesh, viaMap]);
  for (const c of ["a", "b", "c", "d", "e", "f"]) {
    assert(got.has(h(c)), `blobRefs() did not reach the ${c} blob; schema/bulk.schema.json bulkFields lists it`);
  }
});

Deno.test("conformance: bulkSources() splits the closure into embeddable and referenceable", async () => {
  // This is the classification the MRCOM writer's `auto` mode is built on: bulk with a DICOM origin
  // is REFERENCED (an archive already holds it), bulk without one is EMBEDDED (it exists nowhere
  // else). If bulkSources() lost the `dicom` tag, `auto` would silently embed a whole CT series.
  const { bulkSources } = await import("../render/sessions/session-store.ts");
  const h = (c: string) => "sha256-" + c.repeat(64);

  const fromDicom: MrsonNode = {
    id: "img1", type: "image", dims: DIMS, ijkToRAS: IJK_TO_RAS,
    zarr: { shape: [5, 3, 4], chunks: [5, 3, 4], chunkGrid: [1, 1, 1], dtype: "<i2", chunkHashes: { "0.0.0": h("a") } },
    dicom: {
      kind: "dicom-series", seriesInstanceUID: "1.2.3", instances: ["1.2.3.1"],
      recon: { reader: "mrcom/dicom-series/1", dims: DIMS, ijkToRAS: IJK_TO_RAS, voxelDigest: "e".repeat(64) },
      retrieve: [{ scheme: "s3", bucket: "idc-open-data", prefix: "p/" }, { scheme: "idc", seriesInstanceUID: "1.2.3" }],
    },
  } as never;
  const authored: MrsonNode = { id: "seg1", type: "segmentation", dims: DIMS, segments: [{ labelValue: 1, name: "S1" }], blobs: { labelmap: h("b") } } as never;

  mustBeClean("a dicom-referenced image", validateScene(sceneOf([fromDicom])));
  mustBeClean("an authored segmentation", validateScene(sceneOf([authored])));

  const srcs = bulkSources([fromDicom, authored]);
  const referenceable = srcs.filter((s) => s.dicom);
  const embeddable = srcs.filter((s) => !s.dicom);
  assertEquals(referenceable.map((s) => s.hash), [h("a")]);
  assertEquals(embeddable.map((s) => s.hash), [h("b")]);
  assertEquals(referenceable[0].grid, "0.0.0", "a zarr chunk must carry its grid coordinate");
  assertEquals(referenceable[0].field, "zarr");
  assertEquals(embeddable[0].field, "blobs/labelmap");

  // bulkSources() and blobRefs() must agree on reachability — two walkers, one closure.
  const { blobRefs } = await import("../render/sessions/session-store.ts");
  assertEquals(
    new Set(srcs.map((s) => s.hash)),
    blobRefs([fromDicom, authored]),
    "bulkSources() and blobRefs() disagree about which blobs a scene reaches",
  );
});

// --- 3: committed fixtures (including the Slicer serializer) -----------------------------------

Deno.test("conformance: committed fixtures validate", async () => {
  let n = 0;
  for await (const e of Deno.readDir(HERE + "fixtures")) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const doc = JSON.parse(await Deno.readTextFile(HERE + "fixtures/" + e.name));
    mustBeClean(`fixtures/${e.name}`, validateScene(doc));
    n++;
  }
  assert(n > 0, "mrson/fixtures/ is empty — capture at least one serialize_mrson.py scene (see mrson/README.md)");
});

// --- 4: the published gallery, when the sibling checkout is present ---------------------------

Deno.test("conformance: the published gallery scenes validate", async () => {
  const roots = [
    Deno.env.get("SLICERLIVE_GALLERY"),
    REPO + "../live/scenes",
    REPO + "../live/legacy/scenes",
  ].filter((p): p is string => !!p);

  const files: string[] = [];
  for (const root of roots) {
    try {
      for await (const e of Deno.readDir(root)) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        if (e.name === "index.json" || e.name.endsWith(".story.json")) continue;  // not scene documents
        files.push(root + "/" + e.name);
      }
    } catch { /* checkout not present — see the skip assertion below */ }
  }
  if (!files.length) {
    console.log("  (skipped: no gallery checkout; set SLICERLIVE_GALLERY or clone pieper/live beside this repo)");
    return;
  }
  for (const f of files) {
    const doc = JSON.parse(await Deno.readTextFile(f));
    mustBeClean(f, validateScene(doc));
  }
  console.log(`  validated ${files.length} published scene(s)`);
});
