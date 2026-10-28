"""validate.py -- the mrson validator, stdlib only.

A deliberate transliteration of mrson/validate.ts, reading the SAME declarative field tables in
mrson/schema/. mrson/validate-parity.test.ts asserts the two produce byte-identical issue lists over
the fixture corpus, so neither can drift from the other or from the schema.

Importable by LiveStory/LiveStoryLib/serialize_mrson.py for a self-check, and runnable as a CLI:

    python3 mrson/validate.py <scene-or-manifest.json> [...]

Transliteration hazards handled explicitly (each one would otherwise break parity):
  * bool is a subclass of int in Python but not a number in JS -- _is_int/_is_num exclude it.
  * JSON.stringify emits no spaces; json.dumps does -- _js() uses compact separators.
  * JSON.stringify(1.0) is "1"; json.dumps(1.0) is "1.0" -- _js() drops a trailing ".0".
  * JS `typeof` names differ from Python type names -- _typeof() returns the JS name.
"""

import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name):
    with open(os.path.join(_HERE, "schema", name), encoding="utf-8") as f:
        return json.load(f)


CORE = _load("mrson-core.schema.json")
BULK = _load("bulk.schema.json")
MRCOM = _load("mrcom.schema.json")

HASH_RE = re.compile(r"^sha256-[0-9a-f]{64}$")


# --- JS-semantics helpers ---------------------------------------------------------------------

def _is_obj(v):
    return isinstance(v, dict)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _typeof(v):
    """JS `typeof`, so messages match validate.ts exactly."""
    if v is None:
        return "object"            # typeof null === "object"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"                # arrays and dicts


def _js(v):
    """JSON.stringify for a single value: compact, and integral floats without a trailing .0."""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, list):
        return "[" + ",".join(_js(x) for x in v) + "]"
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


class Bag(object):
    def __init__(self):
        self.issues = []

    def _add(self, sev, path, code, message):
        self.issues.append({"path": path, "code": code, "message": message, "severity": sev})

    def err(self, path, code, message):
        self._add("error", path, code, message)

    def warn(self, path, code, message):
        self._add("warning", path, code, message)

    def info(self, path, code, message):
        self._add("info", path, code, message)


# --- kind checking ----------------------------------------------------------------------------

def _check_array(b, p, v, spec, each, what):
    if not isinstance(v, list):
        return b.err(p, "type", "expected %s[], got %s" % (what, _typeof(v)))
    if isinstance(spec.get("len"), int) and len(v) != spec["len"]:
        b.err(p, "length", "expected %d elements, got %d" % (spec["len"], len(v)))
    if isinstance(spec.get("minLen"), int) and len(v) < spec["minLen"]:
        b.err(p, "length", "expected at least %d elements, got %d" % (spec["minLen"], len(v)))
    for i, x in enumerate(v):
        if not each(x):
            b.err("%s[%d]" % (p, i), "type", "expected %s" % what)
            break


def _check_kind(b, p, v, spec):
    kind = str(spec.get("kind", "any"))
    if v is None:
        if spec.get("nullable"):
            return
        return b.err(p, "null", "null is not allowed for %s" % kind)

    if kind == "any":
        return

    if kind == "string":
        if not isinstance(v, str):
            return b.err(p, "type", "expected string, got %s" % _typeof(v))
        if isinstance(spec.get("minLen"), int) and len(v) < spec["minLen"]:
            return b.err(p, "length", "expected a non-empty string")
        if isinstance(spec.get("pattern"), str) and not re.search(spec["pattern"], v):
            return b.err(p, "pattern", "%s does not match %s" % (_js(v), spec["pattern"]))
        if isinstance(spec.get("value"), str) and v != spec["value"]:
            return b.err(p, "value", "expected %s, got %s" % (_js(spec["value"]), _js(v)))
        return

    if kind == "int":
        if not _is_int(v):
            return b.err(p, "type", "expected an integer, got %s" % _js(v))
        if _is_num(spec.get("value")) and v != spec["value"]:
            return b.err(p, "value", "expected %s, got %s" % (_js(spec["value"]), _js(v)))
        return

    if kind == "number":
        if not _is_num(v):
            return b.err(p, "type", "expected a finite number, got %s" % _js(v))
        return

    if kind == "bool":
        if not isinstance(v, bool):
            return b.err(p, "type", "expected a boolean, got %s" % _typeof(v))
        return

    if kind == "object":
        if not _is_obj(v):
            return b.err(p, "type", "expected an object, got %s"
                         % ("array" if isinstance(v, list) else _typeof(v)))
        if _is_obj(spec.get("fields")):
            _check_fields(b, p, v, spec["fields"])
        return

    if kind == "enum":
        vals = spec.get("values") or []
        if v not in vals:
            return b.err(p, "enum", "expected one of %s, got %s" % (_js(vals), _js(v)))
        return

    if kind == "int-or-numeric-string":
        if _is_int(v):
            return
        if isinstance(v, str) and re.fullmatch(r"[0-9]+", v):
            return b.warn(p, "legacy.numericString",
                          "numeric string %s; normalized to a number on read (advisory field)" % _js(v))
        return b.err(p, "type", "expected an integer or a numeric string, got %s" % _js(v))

    if kind == "string[]":
        return _check_array(b, p, v, spec, lambda x: isinstance(x, str), "string")
    if kind == "int[]":
        return _check_array(b, p, v, spec, _is_int, "integer")
    if kind == "number[]":
        return _check_array(b, p, v, spec, _is_num, "number")

    if kind == "object[]":
        _check_array(b, p, v, spec, _is_obj, "object")
        req = spec.get("itemRequired") or []
        if req and isinstance(v, list):
            for i, x in enumerate(v):
                if not _is_obj(x):
                    continue
                for k in req:
                    if k not in x:
                        b.err("%s[%d]" % (p, i), "required", "missing required key %s" % _js(k))
        return

    if kind == "number[][]":
        if not isinstance(v, list):
            return b.err(p, "type", "expected an array of number arrays")
        inner = spec.get("innerLen")
        for i, row in enumerate(v):
            if not isinstance(row, list) or not all(_is_num(x) for x in row):
                b.err("%s[%d]" % (p, i), "type", "expected a number array")
                break
            if isinstance(inner, int) and len(row) != inner:
                b.err("%s[%d]" % (p, i), "length",
                      "expected %d numbers, got %d" % (inner, len(row)))
                break
        return

    if kind == "bulk-hash":
        if not isinstance(v, str) or not HASH_RE.match(v):
            return b.err(p, "bulk.hash",
                         'expected a content-addressed blob name "sha256-<64 hex>", got %s' % _js(v))
        return
    if kind == "bulk-hashref":
        return _validate_hashref_into(b, p, v)
    if kind == "bulk-zarr":
        return _validate_zarr_into(b, p, v)
    if kind == "bulk-dicom":
        return _validate_dicom_into(b, p, v)
    if kind == "bulk":
        return _validate_bulk_into(b, p, v)

    if kind == "map<string,string[]>":
        if not _is_obj(v):
            return b.err(p, "type", "expected an object")
        for k, val in v.items():
            if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
                b.err("%s/%s" % (p, k), "refs.notArray",
                      "every refs value must be an array of node-id strings, even for a single target")
        return

    if kind == "map<string,hash>":
        if not _is_obj(v):
            return b.err(p, "type", "expected an object")
        for k, val in v.items():
            if isinstance(spec.get("keyPattern"), str) and not re.search(spec["keyPattern"], k):
                b.err("%s/%s" % (p, k), "key.pattern", "key does not match %s" % spec["keyPattern"])
            if not isinstance(val, str) or not HASH_RE.match(val):
                b.err("%s/%s" % (p, k), "bulk.hash",
                      'expected "sha256-<64 hex>", got %s' % _js(val))
        return

    if kind == "map<string,node>":
        if not _is_obj(v):
            return b.err(p, "type", "`nodes` must be an object keyed by node id")
        return

    if kind in ("map<string,bulk>", "map<string,hash|zarr>"):
        if isinstance(v, list):
            return b.err(p, "blobs.array",
                         "`blobs` must be a map { role: BulkRef }; a bare [] is not valid "
                         "(nothing emits it any more)")
        if not _is_obj(v):
            return b.err(p, "type", "expected an object")
        for k, val in v.items():
            _validate_bulk_into(b, "%s/%s" % (p, k), val)
        return

    b.info(p, "schema.unknownKind",
           "schema kind %s is not implemented; value not checked" % _js(kind))


def _check_fields(b, base, v, fields):
    """Walk a field table against a dict. Mirrors checkFields() in validate.ts with `open: true`:
    a missing field is skipped (the strictness rule leaves unknown/absent fields alone), and a
    present-but-null field goes to _check_kind, which handles `nullable`."""
    for name, spec in fields.items():
        if name.startswith("_") or name not in v:
            continue
        _check_kind(b, "%s/%s" % (base, name), v[name], spec)


# --- bulk descriptors -------------------------------------------------------------------------

def _validate_hashref_into(b, p, v):
    hr = BULK["shapes"]["hashRef"]
    if not _is_obj(v):
        return b.err(p, "type", "expected a BulkRef(hash) object { hash, dtype, count, comps, size }")
    for k in hr["required"]:
        if k not in v:
            b.err("%s/%s" % (p, k), "required", "BulkRef(hash) missing %s" % _js(k))
    _check_fields(b, p, v, hr["fields"])
    b.warn(p, "legacy.hashRef",
           'legacy BulkRef(hash) form { hash, dtype, count, comps, size }; current producers write '
           'the bare "sha256-<hex>" string (see mrson/README.md)')


def _validate_zarr_into(b, p, v):
    zarr = BULK["shapes"]["zarr"]
    if not _is_obj(v):
        return b.err(p, "type", "expected a zarr descriptor object")
    for k in zarr["required"]:
        if k not in v:
            b.err("%s/%s" % (p, k), "required", "zarr descriptor missing %s" % _js(k))
    _check_fields(b, p, v, zarr["fields"])

    has_hashes = _is_obj(v.get("chunkHashes"))
    has_positional = isinstance(v.get("dir"), str) and isinstance(v.get("dataset"), str)
    if not has_hashes and not has_positional:
        b.err(p, "zarr.noChunkLocator",
              "a zarr descriptor needs chunkHashes, or the legacy dir+dataset pair -- otherwise a "
              "reader cannot locate any chunk")
    if has_positional and not has_hashes:
        b.warn(p, "legacy.positionalZarr",
               "legacy positional chunk layout (dir+dataset); chunkHashes is the content-addressed form")

    sh, ch, gr = v.get("shape"), v.get("chunks"), v.get("chunkGrid")
    if (isinstance(sh, list) and isinstance(ch, list) and isinstance(gr, list)
            and len(sh) == 3 and len(ch) == 3 and len(gr) == 3
            and all(_is_int(x) for x in sh + ch + gr)):
        for d in range(3):
            c = ch[d]
            if c <= 0:
                b.err("%s/chunks[%d]" % (p, d), "zarr.chunkSize", "chunk size must be positive")
                continue
            want = -(-sh[d] // c)                     # ceil
            if gr[d] != want:
                b.err("%s/chunkGrid[%d]" % (p, d), "zarr.gridMismatch",
                      "chunkGrid[%d]=%d but ceil(shape[%d]/chunks[%d]) = ceil(%d/%d) = %d"
                      % (d, gr[d], d, d, sh[d], c, want))


def _validate_dicom_into(b, p, v):
    dicom = BULK["shapes"]["dicom"]
    if not _is_obj(v):
        return b.err(p, "type", "expected a dicom bulk descriptor object")
    for k in dicom["required"]:
        if k not in v:
            b.err("%s/%s" % (p, k), "required", "dicom descriptor missing %s" % _js(k))
    _check_fields(b, p, v, dicom["fields"])
    if isinstance(v.get("retrieve"), list):
        for i, h in enumerate(v["retrieve"]):
            if not _is_obj(h) or not isinstance(h.get("scheme"), str):
                b.err("%s/retrieve[%d]" % (p, i), "retrieve.noScheme",
                      "every retrieve hint needs a `scheme` so a reader can dispatch it to a resolver")
                continue
            for k in h:
                if re.match(r"^(secret|password|token|credential|accessKey|secretKey|sessionToken|signature)",
                            k, re.I):
                    b.err("%s/retrieve[%d]/%s" % (p, i, k), "retrieve.credential",
                          "a retrieve hint names a location and a scheme only; credentials must never "
                          "be written into a bundle")


def _validate_bulk_into(b, p, v):
    # Dispatch order is normative -- see `dispatch` in bulk.schema.json.
    if isinstance(v, str):
        return _check_kind(b, p, v, {"kind": "bulk-hash"})
    if _is_obj(v) and isinstance(v.get("kind"), str) and v["kind"].startswith("dicom-"):
        return _validate_dicom_into(b, p, v)
    if _is_obj(v) and "hash" in v:
        return _validate_hashref_into(b, p, v)
    if _is_obj(v):
        return _validate_zarr_into(b, p, v)
    b.err(p, "bulk.shape",
          'expected a "sha256-<hex>" string, a BulkRef(hash) object, a zarr descriptor, or a dicom descriptor')


def validate_bulk(v, path="#"):
    b = Bag()
    _validate_bulk_into(b, path, v)
    return b.issues


# --- nodes ------------------------------------------------------------------------------------

def hoist_legacy_attrs(node):
    """Lift a legacy `attrs` object onto the node (README divergence 1). Returns a new dict."""
    if not _is_obj(node.get("attrs")):
        return node
    out = dict(node["attrs"])
    for k, v in node.items():
        if k != "attrs":
            out[k] = v                       # explicit flat fields win over a legacy alias
    return out


def _validate_node_into(b, p, raw):
    if not _is_obj(raw):
        return b.err(p, "type", "expected a node object")

    if _is_obj(raw.get("attrs")):
        b.warn("%s/attrs" % p, "legacy.attrs",
               "type-specific fields are flat on the node for mrson 0; `attrs` is a legacy input "
               "alias and is hoisted on read (see mrson/README.md)")
    node = hoist_legacy_attrs(raw)
    core = CORE["node"]

    for k in core["required"]:
        if k == "type" and isinstance(node.get("class"), str) and "type" not in node:
            b.warn("%s/type" % p, "legacy.class",
                   "legacy scene keys on `class` instead of the neutral `type`; the MRML class "
                   "belongs in source.mrmlClass")
            continue
        if k not in node:
            b.err("%s/%s" % (p, k), "required", "node missing required field %s" % _js(k))
    _check_fields(b, p, node, core["fields"])

    t = node.get("type") if isinstance(node.get("type"), str) else None
    if t is not None:
        td = CORE["types"].get(t)
        if not _is_obj(td):
            b.info("%s/type" % p, "type.unknown",
                   "type %s is not in the schema; its fields are not checked (mrson is an open model)"
                   % _js(t))
        elif _is_obj(td.get("fields")):
            _check_fields(b, p, node, td["fields"])

    dims, zarr = node.get("dims"), node.get("zarr")
    if (isinstance(dims, list) and len(dims) == 3 and all(_is_int(x) for x in dims)
            and _is_obj(zarr) and isinstance(zarr.get("shape"), list)):
        s = zarr["shape"]
        if len(s) == 3 and all(_is_int(x) for x in s):
            want = [s[2], s[1], s[0]]
            if dims != want:
                b.err("%s/dims" % p, "dimsOrder",
                      "dims %s must be [nx,ny,nz] = reverse of C-order zarr.shape %s = %s"
                      % (_js(dims), _js(s), _js(want)))


def validate_node(node, path="#"):
    b = Bag()
    _validate_node_into(b, path, node)
    return b.issues


# --- scenes -----------------------------------------------------------------------------------

def validate_scene(doc):
    b = Bag()
    if not _is_obj(doc):
        b.err("#", "type", "expected an mrson document object")
        return b.issues

    nodes = None
    if _is_obj(doc.get("nodes")):
        nodes = doc["nodes"]
        _check_fields(b, "#", doc, CORE["envelope"]["fields"])
    elif "nodes" not in doc:
        vals = list(doc.values())
        looks = len(vals) > 0 and all(_is_obj(v) and ("type" in v or "class" in v) for v in vals)
        if looks:
            b.warn("#", "legacy.bareMap",
                   "bare { <id>: Node } map with no envelope; the current form is "
                   "{ mrson, blobBase, nodes }")
            nodes = doc
        else:
            b.err("#/nodes", "required",
                  "document has no `nodes` map and does not look like a bare node map")
            return b.issues
    else:
        b.err("#/nodes", "type", "`nodes` must be an object keyed by node id")
        return b.issues

    ids = set(nodes.keys())
    for nid, n in nodes.items():
        p = "#/nodes/%s" % nid
        _validate_node_into(b, p, n)
        if _is_obj(n):
            if isinstance(n.get("id"), str) and n["id"] != nid:
                b.err("%s/id" % p, "idMatches",
                      "node.id %s does not match its key %s" % (_js(n["id"]), _js(nid)))
            if _is_obj(n.get("refs")):
                for role, targets in n["refs"].items():
                    if not isinstance(targets, list):
                        continue
                    for tgt in targets:
                        if isinstance(tgt, str) and tgt not in ids:
                            b.warn("%s/refs/%s" % (p, role), "refs.dangling",
                                   "references %s, which is not in this document (legitimate for a "
                                   "partial closure)" % _js(tgt))
    return b.issues


# --- MRCOM manifest ---------------------------------------------------------------------------

def validate_mrcom_manifest(m):
    b = Bag()
    if not _is_obj(m):
        b.err("#", "type", "expected an MRCOM manifest object")
        return b.issues
    man = MRCOM["manifest"]
    for k in man["required"]:
        if k not in m:
            b.err("#/%s" % k, "required", "manifest missing required field %s" % _js(k))
    _check_fields(b, "#", m, man["fields"])

    mode = m.get("mode")
    bulk = m.get("bulk") if _is_obj(m.get("bulk")) else None
    required = bulk["required"] if bulk and isinstance(bulk.get("required"), list) else []
    embedded = bulk.get("embedded") if bulk and _is_obj(bulk.get("embedded")) else None

    if mode == "embed" and len(required) > 0:
        b.err("#/bulk/required", "mode.embed",
              'mode "embed" means nothing is left to fetch, but bulk.required lists %d hash(es)'
              % len(required))
    if mode == "reference" and embedded and _is_int(embedded.get("count")) and embedded["count"] > 0:
        b.err("#/bulk/embedded/count", "mode.reference",
              'mode "reference" means no blobs are embedded, but bulk.embedded.count is %s'
              % _js(embedded["count"]))
    if mode == "reference" and len(required) == 0:
        b.warn("#/bulk/required", "mode.reference",
               'mode "reference" with an empty bulk.required -- a reader has nothing to resolve')
    return b.issues


def errors_only(issues):
    return [i for i in issues if i["severity"] == "error"]


def format_issues(issues):
    if not issues:
        return "clean"
    return "\n".join("  %-7s %s  [%s] %s" % (i["severity"], i["path"], i["code"], i["message"])
                     for i in issues)


def _main(argv):
    files = [a for a in argv if not a.startswith("-")]
    if not files:
        sys.stderr.write("usage: python3 mrson/validate.py <scene-or-manifest.json> [...]\n")
        return 2
    emit_json = "--json" in argv
    bad = 0
    for f in files:
        with open(f, encoding="utf-8") as fh:
            raw = json.load(fh)
        is_manifest = _is_obj(raw) and "mrcom" in raw
        issues = validate_mrcom_manifest(raw) if is_manifest else validate_scene(raw)
        if emit_json:
            print(json.dumps(issues))
            continue
        errs = errors_only(issues)
        if errs:
            bad += 1
        print("%s (%s): %d error(s), %d other"
              % (f, "mrcom manifest" if is_manifest else "mrson scene", len(errs),
                 len(issues) - len(errs)))
        if issues:
            print(format_issues(issues))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
