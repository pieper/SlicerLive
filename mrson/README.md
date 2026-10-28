# `mrson/` — the schema, and the validators that enforce it

[`docs/MRSON-LIVESCENE.md`](../docs/MRSON-LIVESCENE.md) specified mrson in prose and cited schema
files in an external repo (`~/slicer/mrson`, `schema/mrson-core.struct.json`). **That repo was never
created.** For two and a half months the de-facto schema was
`LiveStory/LiveStoryLib/serialize_mrson.py` plus `render/mrson.ts` plus `render/liveops.ts`, and the
three had quietly drifted from the doc.

This directory ends that. It holds the machine-readable schema, a validator in each language the
format has a producer in, and a conformance test that runs the **real shipped output** through them.

## Why it lives here and not in its own repo

The conformance test is inherently cross-language — it has to check a TypeScript producer
(`logic/ingest.ts`) and a Python producer (`serialize_mrson.py`) against one schema, which only works
in one checkout. `render/test/commits-conformance.test.ts` already establishes that pattern by
shelling out to `mrson_commits.py`. A separate repo also starts skewing from the serializer the day it
is created, which is exactly what happened last time.

Nothing here imports from `render/` or `logic/`, so `git subtree split` can lift it to its own repo
once there is a non-Slicer adopter — with the validator as its first test.

## Why the schema is not JSON Schema

The files in `schema/` are **declarative field tables**, read by both validators at startup. They are
not JSON Schema, and `validate.ts` is not a JSON Schema engine.

The alternative was two hand-written JSON Schema engines, one per language, which is more code and a
larger surface for the two to disagree on than the thing they were meant to validate. A shared table
plus a ~300-line interpreter in each language keeps the *schema* as the single source of truth, which
is the property that actually matters. A JSON Schema projection can be generated from these tables if
an external consumer ever wants one.

```
schema/mrson-core.schema.json   envelope, node record, reserved keys, invariants, per-type fields
schema/bulk.schema.json         the three bulk descriptor shapes: hash, zarr, dicom
schema/mrcom.schema.json        the MRCOM private block element table + manifest (docs/MRCOM-SCENE-BUNDLE.md)
validate.ts                     the validator: validateScene / validateNode / validateBulk / validateMrcomManifest
validate.py                     stdlib-only mirror, importable by serialize_mrson.py for self-check
fixtures/                       captured real output, so CI can validate it with no Slicer and no network
```

## The strictness rule

mrson is an **open** model — `MRSON-LIVESCENE.md` §1a commits to arbitrary fields and new types. So:

- an **unknown field** or an unknown `type` is permitted, reported at `info`;
- a **known field with the wrong shape** is an `error`;
- a **legacy form** that still ships is a `warning`, never an error.

Strict where it matters, open where it has to be. A validator that rejected unknown fields would make
the format closed, which would defeat its stated purpose.

## Divergences this directory adjudicates

Writing the schema forced three decisions that the prose had left open. All three are recorded here
rather than in a commit message, because each one is a thing a future reader will otherwise re-litigate.

**1. Type-specific fields are FLAT on the node. `attrs` is a legacy input alias.**
The doc described nesting under `attrs`; nothing ever emitted it. Flat is normative for `mrson: 0`
because the delta layer depends on it: op `path`s are flat JSON Pointers (`#/window`, `#/refs/label`)
and `render/commits.ts canonicalize` hashes the flat record. Renesting would change **every commit
hash and every recorded op path in every session log**. `hoistLegacyAttrs()` lifts `attrs` onto the
node with a warning; nothing emits it. A future `mrson: 1` could renest, but only with an op-path and
commit-hash migration priced in.

**2. `blobs` is optional, and a bare `[]` is an error.**
The doc said "always a map, `{}` when empty", citing a serializer that emitted `[]`. Neither producer
emits either any more — bulk lives in the type-specific fields (`zarr`, `points`, `triangles`) or in
`dicom`. So `blobs` is optional when absent, a map when present, and `[]` is an error. Churning two
producers to write `{}` would have bought nothing.

**3. `zarr.bytes` may be a number or a numeric string.**
`serialize.py::_write_zarr` and `logic/ingest.ts` emit a number; `serialize_mrson.py::_zarr_desc`
stringifies it (`desc["bytes"] = str(...)`, commented "mrson int64-safe rule"); `render/zarr.ts` types
it as `number`. The field is **advisory** — a size report nothing load-bearing reads — and a byte
count above 2^53 would be nine petabytes, so the precision concern does not bite here. Both forms are
accepted and normalized to a number on read; the string form warns.

**4. There are FOUR bulk shapes, not two, and the legacy one has its own dtype vocabulary.**
`MRSON-LIVESCENE.md` §2 said "one of two shapes" and named `BulkRef(hash) = {hash, dtype, count,
comps, size}` and `BulkRef(zarr)`. In practice: the published scenes under `../live/legacy/scenes/`
carry `BulkRef(hash)` with a **32-hex** hash (not `sha256-`-prefixed, not a SHA-256 digest) and a
**plain** dtype vocabulary (`float32`, `uint32`) — while `serialize_mrson.py::_mesh_blob` writes a
**bare `"sha256-<64 hex>"` string** and zarr uses **NumPy-style** dtypes (`<f4`, `|u1`). Adding
`dicom` makes four. All four are accepted on read, with a normative dispatch order recorded in
`schema/bulk.schema.json` under `dispatch`; `BulkRef(hash)` warns, and nothing emits it any more.

**5. The legacy mesh blob role is `polys`; the current field is `triangles`.**
The legacy `blobs` map uses roles `points` / `polys` / `normals` / `labelmap`;
`serialize_mrson.py::_mesh_node` emits flat `points` / `triangles` fields. Both are accepted. This is
the kind of thing that silently loses data in a closure walk, so `bulkFields` in
`schema/bulk.schema.json` lists every role and field that can hold bulk, and `blobRefs()` in
`render/sessions/session-store.ts` must walk all of them.

**6. `origin` means two different things, and only one of them is a node field.**
`render/liveops.ts` `OpBase.origin` is the Lamport origin — a **string** on an op envelope and on a
change record. `logic/ingest.ts` writes `node.origin = { local: true, dtype, ... }` — an **object** of
provenance. They share a name and nothing else. The node field table declares `origin` as an object;
`v` was removed from it entirely, since nothing ever writes `v` onto a node. Both stay in
`reservedKeys` so no type claims them as field names.

**7. A segment's identity is `labelValue`, not `id`.**
`serialize_mrson.py` emits segments as `{ id, name, labelValue, color }`;
`logic/segmentation-editor.ts::createSegmentation` emits `{ labelValue, name, color, visible }` with no
`id`. `labelValue` is what indexes the labelmap, so it and `name` are required and `id` — the Slicer
segment ID — is carried forward when available.

**8. `mode` is neutralized on `interaction` and raw on `crosshair`.**
`serialize_mrson.py` maps `vtkMRMLInteractionNode`'s integer mode through `_INTERACTION_MODES` to a
**neutral string** (`place` / `viewTransform` / `select` / `user` / `adjustWindowLevel`) — which is
exactly what §1a asks for — while `crosshair.mode` is still the raw MRML integer. Both are correct as
shipped; the schema records which is which, because "mode" looking like an int in one node and a
string in another is otherwise indistinguishable from a bug.

> **How these were found.** 4 and 5 came from pointing the validator at the published gallery
> scenes; 3, 6 and 7 from pointing it at the live output of `logic/ingest.ts` and
> `logic/segmentation-editor.ts`. That is precisely the job the conformance test exists to do, and it
> is why the test validates *real producer output* rather than fixtures written to match the schema.
> Divergence 5 also exposed a live bug: `blobRefs()` walked `points` and `triangles` but neither
> `normals` nor any `blobs` map — so a mesh's normals were reachable in the scene and silently absent
> from an export.

## Running it

```
deno test -A mrson/                      # unit tests + conformance + TS/Python parity
deno run -A mrson/validate.ts <file>     # validate one scene or bundle manifest
python3 mrson/validate.py <file>         # the same, from Python
```

The conformance test validates the gallery corpus at `../live/{scenes,legacy/scenes}` **when that
sibling checkout is present**, and skips it otherwise — the published scenes are the strongest
evidence available that the schema describes reality, but they are not in this repository.
