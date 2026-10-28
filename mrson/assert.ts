// Minimal assertions, so mrson/ has NO external dependency at all.
//
// Two reasons this exists instead of `jsr:@std/assert`: `mrson/` is meant to be liftable to its own
// repo with `git subtree split` (see mrson/README.md), and the repo's `deno lint` config rejects
// inline `jsr:`/`npm:`/`https:` specifiers. render/test/commits-conformance.test.ts already defines
// its own `assert` for the same reason.

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}

/** Deep structural equality, with a readable diff. Enough for JSON-shaped values. */
export function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  if (same(actual, expected)) return;
  throw new Error(
    (msg ? msg + "\n" : "") +
      "  expected: " + show(expected) + "\n" +
      "  actual:   " + show(actual),
  );
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !same(v, b.get(k))) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

function show(v: unknown): string {
  if (v instanceof Set) return "Set(" + JSON.stringify([...v]) + ")";
  if (v instanceof Map) return "Map(" + JSON.stringify([...v]) + ")";
  try { return JSON.stringify(v); } catch { return String(v); }
}
