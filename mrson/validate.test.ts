// T1: the mrson validator. Unit-level checks of the strictness rule, the four bulk shapes, the
// invariants, and the MRCOM manifest constraints.
//
// The companion files are conformance.test.ts (real producer output must validate) and
// validate-parity.test.ts (validate.py must agree issue-for-issue).

import { assert, assertEquals } from "./assert.ts";
import {
  errorsOnly,
  hoistLegacyAttrs,
  type Issue,
  validateBulk,
  validateMrcomManifest,
  validateNode,
  validateScene,
} from "./validate.ts";

const codes = (issues: Issue[]) => issues.map((i) => i.code);
const errs = (issues: Issue[]) => codes(errorsOnly(issues));
const has = (issues: Issue[], code: string) => codes(issues).includes(code);

const ZARR = { shape: [5, 3, 4], chunks: [5, 3, 4], chunkGrid: [1, 1, 1], dtype: "<i2", chunkHashes: { "0.0.0": "sha256-" + "a".repeat(64) } };
const HASH = "sha256-" + "b".repeat(64);

// --- the strictness rule -----------------------------------------------------------------------

Deno.test("open model: an unknown field and an unknown type are info, never errors", () => {
  const i = validateNode({ id: "n1", type: "somethingNew", wildField: { anything: true } });
  assertEquals(errs(i), []);
  assert(has(i, "type.unknown"), "an unseen neutral type should be reported at info");
});

Deno.test("strict where it matters: a KNOWN field with the wrong shape is an error", () => {
  // window is a number on scalarVolumeDisplay; a string is a real producer bug, not an extension.
  const i = validateNode({ id: "d1", type: "scalarVolumeDisplay", window: "400" });
  assertEquals(errs(i), ["type"]);
});

Deno.test("a missing required field is an error; a missing optional one is not", () => {
  assertEquals(errs(validateNode({ type: "image" })), ["required"]);      // no id
  assertEquals(errs(validateNode({ id: "i1", type: "image" })), []);      // dims etc. are optional
});

// --- invariants --------------------------------------------------------------------------------

Deno.test("matrix16: ijkToRAS must be 16 numbers", () => {
  const short = validateNode({ id: "i1", type: "image", ijkToRAS: [1, 0, 0, 0] });
  assertEquals(errs(short), ["length"]);
  const ok = validateNode({ id: "i1", type: "image", ijkToRAS: new Array(16).fill(0) });
  assertEquals(errs(ok), []);
});

Deno.test("dimsOrder: node.dims is [nx,ny,nz], the reverse of C-order zarr.shape", () => {
  const good = validateNode({ id: "i1", type: "image", dims: [4, 3, 5], zarr: ZARR });
  assertEquals(errs(good), []);
  // the classic bug: dims copied straight from shape without reversing
  const bad = validateNode({ id: "i1", type: "image", dims: [5, 3, 4], zarr: ZARR });
  assert(errs(bad).includes("dimsOrder"), "reversed dims must be caught");
});

Deno.test("refsArrays: a single ref target still has to be an array", () => {
  const bad = validateNode({ id: "i1", type: "image", refs: { display: "d1" } });
  assert(errs(bad).includes("refs.notArray"));
  const good = validateNode({ id: "i1", type: "image", refs: { display: ["d1"] } });
  assertEquals(errs(good), []);
});

Deno.test("idMatches: node.id must equal the key it is stored under", () => {
  const i = validateScene({ mrson: 0, nodes: { a: { id: "b", type: "image" } } });
  assert(errs(i).includes("idMatches"));
});

// --- the four bulk shapes ----------------------------------------------------------------------

Deno.test("bulk shape 1: a bare content-addressed name", () => {
  assertEquals(errs(validateBulk(HASH)), []);
  assert(errs(validateBulk("sha256-nothex")).includes("bulk.hash"));
  assert(errs(validateBulk("8e35abe1d84cdd10989a8e418346f308")).includes("bulk.hash"), "a bare 32-hex string is not the string form");
});

Deno.test("bulk shape 2: the legacy BulkRef(hash) object warns but is accepted", () => {
  const legacy = { hash: "8e35abe1d84cdd10989a8e418346f308", dtype: "float32", count: 12, comps: 3, size: 48 };
  const i = validateBulk(legacy);
  assertEquals(errs(i), []);
  assert(has(i, "legacy.hashRef"));
  // its dtype vocabulary is the plain one, NOT zarr's NumPy-style strings
  assert(errs(validateBulk({ ...legacy, dtype: "<f4" })).includes("enum"));
});

Deno.test("bulk shape 3: zarr, including the chunkGrid arithmetic", () => {
  assertEquals(errs(validateBulk(ZARR)), []);
  const wrongGrid = { ...ZARR, chunks: [2, 3, 4], chunkGrid: [1, 1, 1] };   // ceil(5/2) = 3, not 1
  assert(errs(validateBulk(wrongGrid)).includes("zarr.gridMismatch"));
  const noLocator = { shape: [5, 3, 4], chunks: [5, 3, 4], chunkGrid: [1, 1, 1], dtype: "<i2" };
  assert(errs(validateBulk(noLocator)).includes("zarr.noChunkLocator"));
  const positional = { ...noLocator, dir: "v.zarr", dataset: "0" };
  const i = validateBulk(positional);
  assertEquals(errs(i), []);
  assert(has(i, "legacy.positionalZarr"));
});

Deno.test("bulk shape 4: the dicom descriptor, and credentials are never allowed in a hint", () => {
  const dicom = {
    kind: "dicom-series", seriesInstanceUID: "1.2.3", instances: ["1.2.3.1", "1.2.3.2"],
    recon: { reader: "mrcom/dicom-series/1", dims: [4, 3, 5], voxelDigest: "c".repeat(64) },
    retrieve: [{ scheme: "s3", bucket: "idc-open-data", prefix: "abc/" }],
  };
  assertEquals(errs(validateBulk(dicom)), []);
  assert(errs(validateBulk({ ...dicom, instances: [] })).includes("length"), "an empty instance list is useless");
  assert(errs(validateBulk({ ...dicom, retrieve: [{ bucket: "x" }] })).includes("retrieve.noScheme"));
  // docs/MRCOM-SCENE-BUNDLE.md 6.2: a hint names a location and a scheme; nothing else.
  const leaky = { ...dicom, retrieve: [{ scheme: "s3", bucket: "x", secretKey: "AKIA..." }] };
  assert(errs(validateBulk(leaky)).includes("retrieve.credential"), "a credential in a bundle must be an error");
});

Deno.test("zarr.bytes: both the number and the stringified form are accepted (divergence 3)", () => {
  assertEquals(errs(validateBulk({ ...ZARR, bytes: 1234 })), []);
  const str = validateBulk({ ...ZARR, bytes: "1234" });
  assertEquals(errs(str), []);
  assert(has(str, "legacy.numericString"));
  assert(errs(validateBulk({ ...ZARR, bytes: "huge" })).includes("type"));
});

// --- legacy forms ------------------------------------------------------------------------------

Deno.test("hoistLegacyAttrs lifts attrs onto the node, and flat fields win", () => {
  const hoisted = hoistLegacyAttrs({ id: "n1", type: "image", attrs: { window: 1, level: 2 } });
  assertEquals(hoisted.window, 1);
  assertEquals(hoisted.level, 2);
  assert(!("attrs" in hoisted));
  // an explicit flat field beats the same key inside a legacy attrs bag
  assertEquals(hoistLegacyAttrs({ id: "n1", type: "image", window: 9, attrs: { window: 1 } }).window, 9);
});

Deno.test("legacy class-keyed nodes and the bare node map warn, never error", () => {
  const i = validateScene({ n1: { id: "n1", class: "vtkMRMLScalarVolumeNode", attrs: { window: 1 } } });
  assertEquals(errs(i), []);
  assert(has(i, "legacy.bareMap"));
  assert(has(i, "legacy.class"));
  assert(has(i, "legacy.attrs"));
});

Deno.test("blobs: a map is fine, a bare [] is an error (divergence 2)", () => {
  assertEquals(errs(validateNode({ id: "m1", type: "mesh", blobs: { points: HASH } })), []);
  assertEquals(errs(validateNode({ id: "m1", type: "mesh", blobs: {} })), []);
  assert(errs(validateNode({ id: "m1", type: "mesh", blobs: [] })).includes("blobs.array"));
});

Deno.test("a dangling ref is a warning: a partial closure is legitimate", () => {
  const i = validateScene({ mrson: 0, nodes: { a: { id: "a", type: "image", refs: { display: ["gone"] } } } });
  assertEquals(errs(i), []);
  assert(has(i, "refs.dangling"));
});

Deno.test("a document with no nodes and nothing node-shaped is an error", () => {
  assert(errs(validateScene({ mrson: 0 })).includes("required"));
  assert(errs(validateScene({ mrson: 0, nodes: 7 })).includes("type"));
  assert(errs(validateScene("nope")).includes("type"));
});

// --- MRCOM manifest ----------------------------------------------------------------------------

const MANIFEST = {
  mrcom: 1,
  mode: "hybrid",
  scene: { length: 100, encoding: "deflate", digest: "d".repeat(64), nodes: 2, blobBase: "blobs/" },
  context: { studyInstanceUID: "1.2.3", primaryParentSeries: "1.2.3.4" },
  bulk: { embedded: { count: 1, bytes: 10 }, required: [{ hash: HASH, bytes: 10 }] },
  screenshot: { rows: 768, columns: 1024 },
};

Deno.test("MRCOM manifest: a well-formed hybrid manifest is clean", () => {
  assertEquals(errs(validateMrcomManifest(MANIFEST)), []);
});

Deno.test("MRCOM manifest: mode constraints are enforced both ways", () => {
  const embed = { ...MANIFEST, mode: "embed" };                       // still lists required hashes
  assert(errs(validateMrcomManifest(embed)).includes("mode.embed"));
  const ref = { ...MANIFEST, mode: "reference" };                     // still claims embedded blobs
  assert(errs(validateMrcomManifest(ref)).includes("mode.reference"));
  const refOk = { ...MANIFEST, mode: "reference", bulk: { embedded: { count: 0, bytes: 0 }, required: [{ hash: HASH }] } };
  assertEquals(errs(validateMrcomManifest(refOk)), []);
});

Deno.test("MRCOM manifest: required fields, enums and digest shape", () => {
  assert(errs(validateMrcomManifest({ mrcom: 1, mode: "hybrid" })).includes("required"), "scene is required");
  assert(errs(validateMrcomManifest({ ...MANIFEST, mode: "zip" })).includes("enum"));
  // a prefixed digest would overflow LO/64 in the DICOM element; the manifest keeps bare hex too
  assert(errs(validateMrcomManifest({ ...MANIFEST, scene: { ...MANIFEST.scene, digest: "sha256-" + "d".repeat(64) } })).includes("pattern"));
});
