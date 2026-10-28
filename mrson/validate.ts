// validate.ts — the mrson validator. Interprets the declarative field tables in mrson/schema/.
//
// DOM-free and dependency-free, so the SAME function runs in Deno, in the browser, and inside a
// bundled demo. It is NOT a JSON Schema engine (see mrson/README.md for why the schema is a field
// table instead).
//
// STRICTNESS RULE (README "The strictness rule"): mrson is an OPEN model, so an unknown field or an
// unknown `type` is `info`, a known field with the wrong shape is an `error`, and a legacy form that
// still ships is a `warning`. A validator that rejected unknown fields would make the format closed.

import CORE from "./schema/mrson-core.schema.json" with { type: "json" };
import BULK from "./schema/bulk.schema.json" with { type: "json" };
import MRCOM from "./schema/mrcom.schema.json" with { type: "json" };

export type Severity = "error" | "warning" | "info";
export interface Issue { path: string; code: string; message: string; severity: Severity }

type Obj = Record<string, unknown>;
// A field spec out of the schema tables: { kind, len?, optional?, values?, pattern?, ... }
type Spec = Obj;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

class Bag {
  readonly issues: Issue[] = [];
  err(path: string, code: string, message: string) { this.issues.push({ path, code, message, severity: "error" }); }
  warn(path: string, code: string, message: string) { this.issues.push({ path, code, message, severity: "warning" }); }
  info(path: string, code: string, message: string) { this.issues.push({ path, code, message, severity: "info" }); }
}

// ---------------------------------------------------------------------------------------------
// kind checking
// ---------------------------------------------------------------------------------------------

const HASH_RE = /^sha256-[0-9a-f]{64}$/;

function checkArray(b: Bag, p: string, v: unknown, spec: Spec, each: (x: unknown, i: number) => boolean, what: string): void {
  if (!Array.isArray(v)) return b.err(p, "type", `expected ${what}[], got ${typeof v}`);
  if (typeof spec.len === "number" && v.length !== spec.len) {
    b.err(p, "length", `expected ${spec.len} elements, got ${v.length}`);
  }
  if (typeof spec.minLen === "number" && v.length < (spec.minLen as number)) {
    b.err(p, "length", `expected at least ${spec.minLen} elements, got ${v.length}`);
  }
  for (let i = 0; i < v.length; i++) {
    if (!each(v[i], i)) { b.err(`${p}[${i}]`, "type", `expected ${what}`); break; }
  }
}

/** Check one value against one field spec. Exported shape-level entry points wrap this. */
function checkKind(b: Bag, p: string, v: unknown, spec: Spec): void {
  const kind = String(spec.kind ?? "any");
  if (v === null) {
    if (spec.nullable) return;
    return b.err(p, "null", `null is not allowed for ${kind}`);
  }
  switch (kind) {
    case "any": return;
    case "string":
      if (typeof v !== "string") return b.err(p, "type", `expected string, got ${typeof v}`);
      if (typeof spec.minLen === "number" && v.length < (spec.minLen as number)) {
        return b.err(p, "length", `expected a non-empty string`);
      }
      if (typeof spec.pattern === "string" && !new RegExp(spec.pattern as string).test(v)) {
        return b.err(p, "pattern", `${JSON.stringify(v)} does not match ${spec.pattern}`);
      }
      if (typeof spec.value === "string" && v !== spec.value) {
        return b.err(p, "value", `expected ${JSON.stringify(spec.value)}, got ${JSON.stringify(v)}`);
      }
      return;
    case "int":
      if (!isInt(v)) return b.err(p, "type", `expected an integer, got ${JSON.stringify(v)}`);
      if (typeof spec.value === "number" && v !== spec.value) {
        return b.err(p, "value", `expected ${spec.value}, got ${v}`);
      }
      return;
    case "number":
      if (!isNum(v)) return b.err(p, "type", `expected a finite number, got ${JSON.stringify(v)}`);
      return;
    case "bool":
      if (typeof v !== "boolean") return b.err(p, "type", `expected a boolean, got ${typeof v}`);
      return;
    case "object":
      if (!isObj(v)) return b.err(p, "type", `expected an object, got ${Array.isArray(v) ? "array" : typeof v}`);
      if (isObj(spec.fields)) checkFields(b, p, v, spec.fields as Obj, { open: true });
      return;
    case "enum": {
      const vals = (spec.values as unknown[]) ?? [];
      if (!vals.includes(v as never)) {
        return b.err(p, "enum", `expected one of ${JSON.stringify(vals)}, got ${JSON.stringify(v)}`);
      }
      return;
    }
    case "int-or-numeric-string":
      // Adjudicated divergence (README #3): serialize_mrson.py stringifies zarr.bytes.
      if (isInt(v)) return;
      if (typeof v === "string" && /^[0-9]+$/.test(v)) {
        return b.warn(p, "legacy.numericString", `numeric string ${JSON.stringify(v)}; normalized to a number on read (advisory field)`);
      }
      return b.err(p, "type", `expected an integer or a numeric string, got ${JSON.stringify(v)}`);

    case "string[]":  return checkArray(b, p, v, spec, (x) => typeof x === "string", "string");
    case "int[]":     return checkArray(b, p, v, spec, (x) => isInt(x), "integer");
    case "number[]":  return checkArray(b, p, v, spec, (x) => isNum(x), "number");
    case "object[]": {
      checkArray(b, p, v, spec, (x) => isObj(x), "object");
      const req = (spec.itemRequired as string[]) ?? [];
      if (req.length && Array.isArray(v)) {
        v.forEach((x, i) => {
          if (!isObj(x)) return;
          for (const k of req) if (!(k in x)) b.err(`${p}[${i}]`, "required", `missing required key ${JSON.stringify(k)}`);
        });
      }
      return;
    }
    case "number[][]": {
      if (!Array.isArray(v)) return b.err(p, "type", "expected an array of number arrays");
      const inner = spec.innerLen as number | undefined;
      for (let i = 0; i < v.length; i++) {
        const row = v[i];
        if (!Array.isArray(row) || !row.every(isNum)) { b.err(`${p}[${i}]`, "type", "expected a number array"); break; }
        if (typeof inner === "number" && row.length !== inner) {
          b.err(`${p}[${i}]`, "length", `expected ${inner} numbers, got ${row.length}`); break;
        }
      }
      return;
    }

    case "bulk-hash":
      if (typeof v !== "string" || !HASH_RE.test(v)) {
        return b.err(p, "bulk.hash", `expected a content-addressed blob name "sha256-<64 hex>", got ${JSON.stringify(v)}`);
      }
      return;
    case "bulk-hashref": return validateHashRefInto(b, p, v);
    case "bulk-zarr":  return validateZarrInto(b, p, v);
    case "bulk-dicom": return validateDicomInto(b, p, v);
    case "bulk":       return validateBulkInto(b, p, v);

    case "map<string,string[]>":
      if (!isObj(v)) return b.err(p, "type", "expected an object");
      for (const [k, val] of Object.entries(v)) {
        // refs are ALWAYS arrays of node ids, even for a single target (core invariant refsArrays).
        if (!Array.isArray(val) || !val.every((x) => typeof x === "string")) {
          b.err(`${p}/${k}`, "refs.notArray", "every refs value must be an array of node-id strings, even for a single target");
        }
      }
      return;
    case "map<string,hash>":
      if (!isObj(v)) return b.err(p, "type", "expected an object");
      for (const [k, val] of Object.entries(v)) {
        if (typeof spec.keyPattern === "string" && !new RegExp(spec.keyPattern as string).test(k)) {
          b.err(`${p}/${k}`, "key.pattern", `key does not match ${spec.keyPattern}`);
        }
        if (typeof val !== "string" || !HASH_RE.test(val)) {
          b.err(`${p}/${k}`, "bulk.hash", `expected "sha256-<64 hex>", got ${JSON.stringify(val)}`);
        }
      }
      return;
    case "map<string,node>":
      // Each node is validated by validateScene(), which also checks id/key agreement and refs;
      // here we only assert the container shape.
      if (!isObj(v)) return b.err(p, "type", "`nodes` must be an object keyed by node id");
      return;
    case "map<string,bulk>":
    case "map<string,hash|zarr>":
      if (Array.isArray(v)) {
        // Adjudicated divergence (README #2).
        return b.err(p, "blobs.array", "`blobs` must be a map { role: BulkRef }; a bare [] is not valid (nothing emits it any more)");
      }
      if (!isObj(v)) return b.err(p, "type", "expected an object");
      for (const [k, val] of Object.entries(v)) validateBulkInto(b, `${p}/${k}`, val);
      return;

    default:
      b.info(p, "schema.unknownKind", `schema kind ${JSON.stringify(kind)} is not implemented; value not checked`);
  }
}

/** Walk a field table against an object. `open` permits unknown keys (the strictness rule). */
function checkFields(b: Bag, base: string, v: Obj, fields: Obj, o: { open: boolean; reserved?: Set<string>; known?: Set<string> }): void {
  for (const [name, rawSpec] of Object.entries(fields)) {
    if (name.startsWith("_")) continue;
    const spec = rawSpec as Spec;
    if (!(name in v) || v[name] === undefined) {
      if (!spec.optional && !o.open) b.err(`${base}/${name}`, "required", `missing required field ${JSON.stringify(name)}`);
      continue;
    }
    checkKind(b, `${base}/${name}`, v[name], spec);
  }
}

// ---------------------------------------------------------------------------------------------
// bulk descriptors
// ---------------------------------------------------------------------------------------------

function validateZarrInto(b: Bag, p: string, v: unknown): void {
  const shape = (BULK as Obj).shapes as Obj;
  const zarr = shape.zarr as Obj;
  if (!isObj(v)) return b.err(p, "type", "expected a zarr descriptor object");
  for (const k of (zarr.required as string[])) {
    if (!(k in v)) b.err(`${p}/${k}`, "required", `zarr descriptor missing ${JSON.stringify(k)}`);
  }
  checkFields(b, p, v, zarr.fields as Obj, { open: true });

  const hasHashes = isObj(v.chunkHashes);
  const hasPositional = typeof v.dir === "string" && typeof v.dataset === "string";
  if (!hasHashes && !hasPositional) {
    b.err(p, "zarr.noChunkLocator", "a zarr descriptor needs chunkHashes, or the legacy dir+dataset pair — otherwise a reader cannot locate any chunk");
  }
  if (hasPositional && !hasHashes) {
    b.warn(p, "legacy.positionalZarr", "legacy positional chunk layout (dir+dataset); chunkHashes is the content-addressed form");
  }
  // chunkGrid[d] == ceil(shape[d] / chunks[d])
  const sh = v.shape, ch = v.chunks, gr = v.chunkGrid;
  if (Array.isArray(sh) && Array.isArray(ch) && Array.isArray(gr) &&
      sh.length === 3 && ch.length === 3 && gr.length === 3 &&
      sh.every(isInt) && ch.every(isInt) && gr.every(isInt)) {
    for (let d = 0; d < 3; d++) {
      const c = ch[d] as number;
      if (c <= 0) { b.err(`${p}/chunks[${d}]`, "zarr.chunkSize", "chunk size must be positive"); continue; }
      const want = Math.ceil((sh[d] as number) / c);
      if (gr[d] !== want) {
        b.err(`${p}/chunkGrid[${d}]`, "zarr.gridMismatch", `chunkGrid[${d}]=${gr[d]} but ceil(shape[${d}]/chunks[${d}]) = ceil(${sh[d]}/${c}) = ${want}`);
      }
    }
  }
}

function validateHashRefInto(b: Bag, p: string, v: unknown): void {
  const hr = ((BULK as Obj).shapes as Obj).hashRef as Obj;
  if (!isObj(v)) return b.err(p, "type", "expected a BulkRef(hash) object { hash, dtype, count, comps, size }");
  for (const k of (hr.required as string[])) {
    if (!(k in v)) b.err(`${p}/${k}`, "required", `BulkRef(hash) missing ${JSON.stringify(k)}`);
  }
  checkFields(b, p, v, hr.fields as Obj, { open: true });
  b.warn(p, "legacy.hashRef", "legacy BulkRef(hash) form { hash, dtype, count, comps, size }; current producers write the bare \"sha256-<hex>\" string (see mrson/README.md)");
}

function validateDicomInto(b: Bag, p: string, v: unknown): void {
  const dicom = ((BULK as Obj).shapes as Obj).dicom as Obj;
  if (!isObj(v)) return b.err(p, "type", "expected a dicom bulk descriptor object");
  for (const k of (dicom.required as string[])) {
    if (!(k in v)) b.err(`${p}/${k}`, "required", `dicom descriptor missing ${JSON.stringify(k)}`);
  }
  checkFields(b, p, v, dicom.fields as Obj, { open: true });
  if (Array.isArray(v.retrieve)) {
    v.retrieve.forEach((h, i) => {
      if (!isObj(h) || typeof h.scheme !== "string") {
        b.err(`${p}/retrieve[${i}]`, "retrieve.noScheme", "every retrieve hint needs a `scheme` so a reader can dispatch it to a resolver");
        return;
      }
      for (const k of Object.keys(h)) {
        // Credentials are NEVER stored in a bundle (docs/MRCOM-SCENE-BUNDLE.md 6.2).
        if (/^(secret|password|token|credential|accessKey|secretKey|sessionToken|signature)/i.test(k)) {
          b.err(`${p}/retrieve[${i}]/${k}`, "retrieve.credential", "a retrieve hint names a location and a scheme only; credentials must never be written into a bundle");
        }
      }
    });
  }
}

function validateBulkInto(b: Bag, p: string, v: unknown): void {
  // Dispatch order is normative — see `dispatch` in bulk.schema.json.
  if (typeof v === "string") return checkKind(b, p, v, { kind: "bulk-hash" });
  if (isObj(v) && typeof v.kind === "string" && String(v.kind).startsWith("dicom-")) return validateDicomInto(b, p, v);
  if (isObj(v) && "hash" in v) return validateHashRefInto(b, p, v);
  if (isObj(v)) return validateZarrInto(b, p, v);
  b.err(p, "bulk.shape", 'expected a "sha256-<hex>" string, a BulkRef(hash) object, a zarr descriptor, or a dicom descriptor');
}

/** Validate one bulk descriptor in any of its three shapes. */
export function validateBulk(v: unknown, path = "#"): Issue[] {
  const b = new Bag();
  validateBulkInto(b, path, v);
  return b.issues;
}

// ---------------------------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------------------------

/** Lift a legacy `attrs` object onto the node (README divergence #1). Returns a new object. */
export function hoistLegacyAttrs(node: Obj): Obj {
  if (!isObj(node.attrs)) return node;
  const { attrs, ...rest } = node;
  return { ...(attrs as Obj), ...rest };   // explicit flat fields win over a legacy alias
}

function validateNodeInto(b: Bag, p: string, raw: unknown): void {
  if (!isObj(raw)) return b.err(p, "type", "expected a node object");

  if (isObj(raw.attrs)) {
    b.warn(`${p}/attrs`, "legacy.attrs", "type-specific fields are flat on the node for mrson 0; `attrs` is a legacy input alias and is hoisted on read (see mrson/README.md)");
  }
  const node = hoistLegacyAttrs(raw);
  const core = (CORE as Obj).node as Obj;

  for (const k of (core.required as string[])) {
    if (k === "type" && typeof node.class === "string" && !("type" in node)) {
      b.warn(`${p}/type`, "legacy.class", "legacy scene keys on `class` instead of the neutral `type`; the MRML class belongs in source.mrmlClass");
      continue;
    }
    if (!(k in node)) b.err(`${p}/${k}`, "required", `node missing required field ${JSON.stringify(k)}`);
  }
  checkFields(b, p, node, core.fields as Obj, { open: true });

  // Type-specific known fields. An unknown type is info, not an error (the strictness rule).
  const t = typeof node.type === "string" ? node.type : undefined;
  const types = (CORE as Obj).types as Obj;
  if (t) {
    const td = types[t];
    if (!isObj(td)) {
      b.info(`${p}/type`, "type.unknown", `type ${JSON.stringify(t)} is not in the schema; its fields are not checked (mrson is an open model)`);
    } else if (isObj(td.fields)) {
      checkFields(b, p, node, td.fields as Obj, { open: true });
    }
  }

  // invariant dimsOrder: node.dims is [nx,ny,nz]; zarr.shape is C order [nz,ny,nx].
  const dims = node.dims, zarr = node.zarr;
  if (Array.isArray(dims) && dims.length === 3 && dims.every(isInt) && isObj(zarr) && Array.isArray(zarr.shape)) {
    const s = zarr.shape as unknown[];
    if (s.length === 3 && s.every(isInt)) {
      const want = [s[2], s[1], s[0]];
      if (dims[0] !== want[0] || dims[1] !== want[1] || dims[2] !== want[2]) {
        b.err(`${p}/dims`, "dimsOrder", `dims ${JSON.stringify(dims)} must be [nx,ny,nz] = reverse of C-order zarr.shape ${JSON.stringify(s)} = ${JSON.stringify(want)}`);
      }
    }
  }
}

/** Validate one node record. */
export function validateNode(node: unknown, path = "#"): Issue[] {
  const b = new Bag();
  validateNodeInto(b, path, node);
  return b.issues;
}

// ---------------------------------------------------------------------------------------------
// scenes
// ---------------------------------------------------------------------------------------------

/** Validate a whole mrson document: the envelope plus every node. */
export function validateScene(doc: unknown): Issue[] {
  const b = new Bag();
  if (!isObj(doc)) { b.err("#", "type", "expected an mrson document object"); return b.issues; }

  let nodes: Obj | undefined;
  if (isObj(doc.nodes)) {
    nodes = doc.nodes as Obj;
    checkFields(b, "#", doc, ((CORE as Obj).envelope as Obj).fields as Obj, { open: true });
  } else if (!("nodes" in doc)) {
    // legacyBareMap: a bare { id: Node } map with no envelope.
    const vals = Object.values(doc);
    const looksLikeNodes = vals.length > 0 && vals.every((v) => isObj(v) && ("type" in v || "class" in v));
    if (looksLikeNodes) {
      b.warn("#", "legacy.bareMap", "bare { <id>: Node } map with no envelope; the current form is { mrson, blobBase, nodes }");
      nodes = doc as Obj;
    } else {
      b.err("#/nodes", "required", "document has no `nodes` map and does not look like a bare node map");
      return b.issues;
    }
  } else {
    b.err("#/nodes", "type", "`nodes` must be an object keyed by node id");
    return b.issues;
  }

  const ids = new Set(Object.keys(nodes));
  for (const [id, n] of Object.entries(nodes)) {
    const p = `#/nodes/${id}`;
    validateNodeInto(b, p, n);
    if (isObj(n)) {
      if (typeof n.id === "string" && n.id !== id) {
        b.err(`${p}/id`, "idMatches", `node.id ${JSON.stringify(n.id)} does not match its key ${JSON.stringify(id)}`);
      }
      // Dangling refs are a warning: a partial scene (one closure of a larger one) is legitimate.
      if (isObj(n.refs)) {
        for (const [role, targets] of Object.entries(n.refs)) {
          if (!Array.isArray(targets)) continue;
          for (const tgt of targets) {
            if (typeof tgt === "string" && !ids.has(tgt)) {
              b.warn(`${p}/refs/${role}`, "refs.dangling", `references ${JSON.stringify(tgt)}, which is not in this document (legitimate for a partial closure)`);
            }
          }
        }
      }
    }
  }
  return b.issues;
}

// ---------------------------------------------------------------------------------------------
// MRCOM manifest
// ---------------------------------------------------------------------------------------------

/** Validate an MRCOM bundle manifest (the contents of private element (4D43,1004)). */
export function validateMrcomManifest(m: unknown): Issue[] {
  const b = new Bag();
  if (!isObj(m)) { b.err("#", "type", "expected an MRCOM manifest object"); return b.issues; }
  const man = (MRCOM as Obj).manifest as Obj;
  for (const k of (man.required as string[])) {
    if (!(k in m)) b.err(`#/${k}`, "required", `manifest missing required field ${JSON.stringify(k)}`);
  }
  checkFields(b, "#", m, man.fields as Obj, { open: true });

  const mode = m.mode;
  const bulk = isObj(m.bulk) ? (m.bulk as Obj) : undefined;
  const required = bulk && Array.isArray(bulk.required) ? bulk.required : [];
  const embedded = bulk && isObj(bulk.embedded) ? (bulk.embedded as Obj) : undefined;

  if (mode === "embed" && required.length > 0) {
    b.err("#/bulk/required", "mode.embed", `mode "embed" means nothing is left to fetch, but bulk.required lists ${required.length} hash(es)`);
  }
  if (mode === "reference" && embedded && isInt(embedded.count) && (embedded.count as number) > 0) {
    b.err("#/bulk/embedded/count", "mode.reference", `mode "reference" means no blobs are embedded, but bulk.embedded.count is ${embedded.count}`);
  }
  if (mode === "reference" && required.length === 0) {
    b.warn("#/bulk/required", "mode.reference", `mode "reference" with an empty bulk.required — a reader has nothing to resolve`);
  }
  return b.issues;
}

/** Issues at `error` severity only — the gate a caller should refuse on. */
export function errorsOnly(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.severity === "error");
}

/** Format issues for a terminal or a test failure message. */
export function formatIssues(issues: Issue[]): string {
  if (!issues.length) return "clean";
  return issues.map((i) => `  ${i.severity.padEnd(7)} ${i.path}  [${i.code}] ${i.message}`).join("\n");
}

// --- CLI: deno run -A mrson/validate.ts <file.json> [...] -------------------------------------
if (import.meta.main) {
  const files = Deno.args.filter((a) => !a.startsWith("-"));
  if (!files.length) {
    console.error("usage: deno run -A mrson/validate.ts <scene-or-manifest.json> [...]");
    Deno.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const raw = JSON.parse(await Deno.readTextFile(f));
    const isManifest = isObj(raw) && "mrcom" in raw;
    const issues = isManifest ? validateMrcomManifest(raw) : validateScene(raw);
    const errs = errorsOnly(issues);
    if (errs.length) bad++;
    console.log(`${f} (${isManifest ? "mrcom manifest" : "mrson scene"}): ${errs.length} error(s), ${issues.length - errs.length} other`);
    if (issues.length) console.log(formatIssues(issues));
  }
  Deno.exit(bad ? 1 : 0);
}
