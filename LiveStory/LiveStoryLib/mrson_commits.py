"""mrson commits (Python) — the Slicer-side content-addressed sealer, a byte-exact port of
render/commits.ts so a recording sealed in Slicer hashes IDENTICALLY to one sealed/verified in
SlicerLive (TS). PURE STDLIB (json/decimal/hashlib/datetime) — no Slicer deps — so it runs in
Slicer's Python AND under system python3 for the Deno<->Python conformance test.

The hard part is RFC 8785 (JSON Canonicalization Scheme): object keys sorted, and NUMBERS serialized
per ECMAScript Number->String (so 1.0 -> "1", 1e-7 -> "1e-7", no trailing .0), which json.dumps does
NOT do. `_es_number` reproduces that via Decimal(repr(x)) (repr = shortest round-trip, unique for an
IEEE-754 double, so the digits match JS; we only re-apply the ES formatting rules). Strings + key sort
are ASCII in our data, where json.dumps(ensure_ascii=False) matches JSON.stringify.

CLI (for the conformance test):
  echo '[1.0, 30.0, 1e-7]' | python3 mrson_commits.py hash-each
  echo '{"events":[...],"intervalMs":1000}' | python3 mrson_commits.py seal
"""
import datetime
import hashlib
import json
from decimal import Decimal


# ── canonical serialization (RFC 8785 JCS) ──────────────────────────────────

def _es_number(n):
    """ECMAScript Number::toString(n) == RFC 8785 number serialization (n is int or float)."""
    if isinstance(n, bool):
        raise TypeError("bool is not a number")
    if isinstance(n, int):
        return str(n)
    if n != n or n in (float("inf"), float("-inf")):
        raise ValueError("non-finite number not allowed in JCS")
    if n == 0:
        return "0"                                  # also -0.0 (JS: "0")
    neg = n < 0
    # repr() gives the shortest decimal that round-trips (unique for a double) -> same digits as JS.
    _sign, digs, exp = Decimal(repr(abs(n))).as_tuple()
    s = "".join(map(str, digs))
    stripped = s.rstrip("0") or "0"                 # drop trailing zeros, adjust exponent
    exp += len(s) - len(stripped)
    s = stripped
    k = len(s)
    m = k + exp                                     # ES 'n': 10^(m-1) <= |x| < 10^m
    if k <= m <= 21:
        out = s + "0" * (m - k)
    elif 0 < m <= 21:
        out = s[:m] + "." + s[m:]
    elif -6 < m <= 0:
        out = "0." + "0" * (-m) + s
    else:
        e = m - 1
        out = (s[0] + ("." + s[1:] if k > 1 else "")) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return ("-" + out) if neg else out


def canonicalize(v):
    """RFC 8785 canonical serialization of a JSON value (matches render/commits.ts canonicalize)."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _es_number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)    # ASCII data -> matches JSON.stringify
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys())                      # ASCII keys -> UTF-16 code-unit order
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonicalize(v[k]) for k in keys) + "}"
    raise TypeError("cannot canonicalize %r" % type(v))


def sha256_hex(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def hash_commit(c):
    """sha256 over the commit canonicalized with `hash` OMITTED."""
    rest = {k: val for k, val in c.items() if k != "hash"}
    return "sha256-" + sha256_hex(canonicalize(rest))


# ── the sealer ────────────────────────────────────────────────────────────

def iso_from_ms(ms):
    """ms epoch -> ISO-8601 matching JS `new Date(ms).toISOString()` exactly (UTC, 3-digit ms, Z)."""
    sec, msec = divmod(int(ms), 1000)
    dt = datetime.datetime.fromtimestamp(sec, tz=datetime.timezone.utc)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, msec)


def seal_stream(deltas, interval_ms=1000, author=None, role=None, base=None, iso=None):
    """Seal a time-ordered delta stream into a content-addressed commit chain (port of sealStream)."""
    iso = iso or iso_from_ms
    commits = []
    parent = None
    bundle = []
    window_start = None

    def seal():
        nonlocal parent, bundle, window_start
        last = bundle[-1]
        c = {"parents": [parent] if parent else []}
        if not commits and base is not None:
            c["base"] = base
        c["t"] = iso(last.get("t", window_start if window_start is not None else 0))
        if author is not None:
            c["author"] = author
        if role is not None:
            c["role"] = role
        c["ops"] = list(bundle)
        c["hash"] = hash_commit(c)
        commits.append(c)
        parent = c["hash"]
        bundle = []
        window_start = None

    for d in deltas:
        t = d.get("t", window_start if window_start is not None else 0)
        if window_start is not None and t - window_start >= interval_ms:
            seal()
        if window_start is None:
            window_start = t
        bundle.append(d)
    if bundle:
        seal()
    return commits


# ── branch addressing + verification ────────────────────────────────────────

def branch_point_at_index(commits, global_index):
    cum = 0
    base_commit = ""
    base_cum = 0
    for c in commits:
        nxt = cum + len(c["ops"])
        if nxt <= global_index:
            base_commit = c["hash"]
            base_cum = nxt
            cum = nxt
        else:
            break
    return {"commit": base_commit, "offset": global_index - base_cum}


def branch_point_at_time(commits, t_ms):
    n = 0
    for c in commits:
        for op in c["ops"]:
            if op.get("t", 0) <= t_ms:
                n += 1
            else:
                return branch_point_at_index(commits, n)
    return branch_point_at_index(commits, n)


def verify_chain(commits):
    parent = None
    for i, c in enumerate(commits):
        if hash_commit(c) != c.get("hash"):
            return {"ok": False, "badAt": i, "reason": "hash mismatch (content altered)"}
        expected = [parent] if parent else []
        if canonicalize(c.get("parents", [])) != canonicalize(expected):
            return {"ok": False, "badAt": i, "reason": "broken parent link"}
        parent = c["hash"]
    return {"ok": True}


# ── CLI (conformance harness) ────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "hash-each"
    data = json.load(sys.stdin)
    if mode == "hash-each":
        print(json.dumps(["sha256-" + sha256_hex(canonicalize(v)) for v in data]))
    elif mode == "canon-each":
        print(json.dumps([canonicalize(v) for v in data]))
    elif mode == "seal":
        cs = seal_stream(data["events"], interval_ms=data.get("intervalMs", 1000),
                         author=data.get("author"), role=data.get("role"), base=data.get("base"))
        print(json.dumps({"commits": cs, "head": cs[-1]["hash"] if cs else None, "root": cs[0]["hash"] if cs else None}))
    else:
        sys.stderr.write("unknown mode %s\n" % mode)
        sys.exit(2)
