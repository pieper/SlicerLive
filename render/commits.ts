// commits — content-addressed git-style history for an mrson stream (the TS reference implementation of
// mrson structure/commits.struct.json). The realtime op/event log is NOT hashed; a ~1Hz SEALER bundles
// the deltas since the last commit into a content-addressed Commit (delta + parents), so any point is
// nameable, reproducible, tamper-evident, and dedupable — enabling read-only sharing + fork-and-PR.
//
// Overhead is ~0.3-0.9 MB/hr at 1Hz (< 1% of a session) — see docs/MRSON-COMMITS-FORKS.md. Runs in Deno
// and the browser (WebCrypto SHA-256), unit-tested headless.

export type ContentHash = string;   // "sha256-<hex>"
export type Role = "human" | "agent" | "module" | "automated";

export interface BranchPoint { commit: ContentHash; offset: number }

export interface Commit {
  hash: ContentHash;
  parents: ContentHash[];      // 0 = root, 1 = normal, 2+ = merge
  base?: BranchPoint;          // fork's FIRST commit: the upstream branch point
  t: string;                   // ISO-8601 commit time
  author?: string;
  role?: Role;
  message?: string;            // optional; doubles as a LiveStory step/mark label
  ops: unknown[];              // the sealed delta since the parent (events for a recording, ops for a fork)
  tree?: ContentHash;          // optional git-tree: hash of the resulting node-map snapshot
}

// ── canonical serialization (RFC 8785 JCS, for our value types) ──────────────
// Object keys sorted (ASCII keys → codepoint order == JS default sort); numbers via JS Number→String,
// which IS the RFC 8785 number serialization (so 1.0 → "1"); strings via JSON.stringify (minimal escapes).
// `undefined` properties are dropped. This is what a commit's hash is computed over.
export function canonicalize(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
  }
  throw new Error("cannot canonicalize " + typeof v);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A commit's content id = sha256 over the canonical form of the commit WITH `hash` omitted (stripped
 *  defensively, so a full Commit or a hash-less draft both hash identically). */
export async function hashCommit(c: Partial<Commit>): Promise<ContentHash> {
  const { hash: _omit, ...rest } = c as Commit;
  return "sha256-" + await sha256Hex(canonicalize(rest));
}

// ── the sealer ────────────────────────────────────────────────────────────────

export interface SealOpts {
  intervalMs?: number;                 // seal a commit per this much wall-clock of deltas (default 1000)
  author?: string;
  role?: Role;
  base?: BranchPoint;                  // set on a fork's first commit
  isoFromMs?: (ms: number) => string;  // ms → ISO (injectable for deterministic tests)
}
interface TimedDelta { t?: number; [k: string]: unknown }

/** Seal a time-ordered delta stream into a commit chain: consecutive ~intervalMs windows, each a
 *  content-addressed Commit linked to its parent. Deterministic given the same input + isoFromMs. */
export async function sealStream(deltas: TimedDelta[], opts: SealOpts = {}): Promise<Commit[]> {
  const interval = opts.intervalMs ?? 1000;
  const iso = opts.isoFromMs ?? ((ms: number) => new Date(ms).toISOString());
  const commits: Commit[] = [];
  let parent: ContentHash | null = null;
  let bundle: TimedDelta[] = [];
  let windowStart: number | null = null;

  const seal = async () => {
    const last = bundle[bundle.length - 1];
    const c: Omit<Commit, "hash"> = {
      parents: parent ? [parent] : [],
      ...(commits.length === 0 && opts.base ? { base: opts.base } : {}),
      t: iso((last.t as number | undefined) ?? windowStart ?? 0),
      ...(opts.author ? { author: opts.author } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      ops: bundle,
    };
    const hash = await hashCommit(c);
    commits.push({ ...c, hash });
    parent = hash;
    bundle = [];
    windowStart = null;
  };

  for (const d of deltas) {
    const t: number = (d.t as number | undefined) ?? windowStart ?? 0;
    if (windowStart !== null && t - windowStart >= interval) await seal();
    if (windowStart === null) windowStart = t;
    bundle.push(d);
  }
  if (bundle.length) await seal();
  return commits;
}

// ── branch addressing: (commit, offset) ─────────────────────────────────────
// The commit pins a reproducible state; `offset` walks `offset` more deltas into the NEXT commit's ops.
// Fine (per-delta) granularity without a per-delta hash.

/** BranchPoint for the state after the first `globalIndex` deltas of the whole stream. */
export function branchPointAtIndex(commits: Commit[], globalIndex: number): BranchPoint {
  let cum = 0, baseCommit = "", baseCum = 0;
  for (const c of commits) {
    const next = cum + c.ops.length;
    if (next <= globalIndex) { baseCommit = c.hash; baseCum = next; cum = next; }
    else break;
  }
  return { commit: baseCommit, offset: globalIndex - baseCum };   // commit "" + offset N = N deltas from root
}

/** BranchPoint for a wall-clock time: the state after every delta with t ≤ tMs. */
export function branchPointAtTime(commits: Commit[], tMs: number): BranchPoint {
  let n = 0;
  for (const c of commits) for (const op of c.ops) { if (((op as TimedDelta).t ?? 0) <= tMs) n++; else return branchPointAtIndex(commits, n); }
  return branchPointAtIndex(commits, n);
}

// ── verification (integrity) ─────────────────────────────────────────────────

export interface VerifyResult { ok: boolean; badAt?: number; reason?: string }

/** Recompute every commit's hash and check parent linkage — any altered delta breaks the chain. */
export async function verifyChain(commits: Commit[]): Promise<VerifyResult> {
  let parent: ContentHash | null = null;
  for (let i = 0; i < commits.length; i++) {
    const recomputed = await hashCommit(commits[i]);
    if (recomputed !== commits[i].hash) return { ok: false, badAt: i, reason: "hash mismatch (content altered)" };
    const expectedParents = parent ? [parent] : [];
    if (canonicalize(commits[i].parents) !== canonicalize(expectedParents)) return { ok: false, badAt: i, reason: "broken parent link" };
    parent = commits[i].hash;
  }
  return { ok: true };
}
