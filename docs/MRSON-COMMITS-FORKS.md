# mrson commits & forks — content-addressed history for sharing

**Status: design sketch (2026-08).** Structure: [`mrson/structure/commits.struct.json`](https://github.com/pieper/mrson/blob/main/structure/commits.struct.json).
Builds on [MRSON-LIVESCENE.md](MRSON-LIVESCENE.md) (op stream + `{origin,v}` envelope) and the
[SceneRecorder](../render/recorder.ts) (keyframe+delta recordings). Enables the **GitHub fork-and-PR
sharing model** for mrson scene recordings, with integrity + audit "for free."

## Why

A recorded mrson stream is an ordered op history over content-addressed blobs. To **share** it the way
GitHub shares code — owners hold write, others read-only, contributors **fork** into their own space and
propose changes back as a **pull request** — the stream needs git's object model: content-addressed
**commits** with parent links, so any point is nameable, reproducible, tamper-evident, and dedupable.

The "suggester" role that no storage backend (Microsoft, Dropbox, JS2) offers natively is *dissolved* by
this model: a suggestion is not a permission on the owner's data, it is **write in your own fork + read on
theirs + a voluntary share-back**. `read / write / owner` is exactly enough.

## Two temporal tiers (avoid hashing the realtime path)

Hashing every op at interaction rates (~30 Hz) is pure waste — the commit bookkeeping (~80 B/commit
binary) would be ~80–100% of the op payload and ~8–27 MB/hr. Hashing is *cheap on CPU* (SHA-256 ≈ 1–2
GB/s; a 1 s bundle ≈ 2 µs) — it is the *storage* of a DAG node per op that costs. So:

| tier | cadence | what | hashed? |
|---|---|---|---|
| **op log** (realtime) | up to ~30 Hz | raw `AnyOp`s appended with `{origin, v}` + `t` | **no** — the unsealed tail |
| **commit** (share/integrity) | **~1 Hz** or on natural boundaries (settle, mark, scene change) | a content-addressed SEAL over the ops since the parent commit | **yes** |
| **replay keyframe** (seek) | ~15–20 s (adaptive) | full node-map snapshot for O(1)-ish `seek` | optional `tree` hash |

**Overhead at ~1 Hz: ~0.3–0.9 MB/hour** of commit-chain metadata — smaller than a *single* volume blob
(the MRHead sample was 6.2 MB), smaller than a handful of 4-up thumbnails (~280 KB each), **< 1% of a
typical session**. Idle-skipped/natural-boundary sealing makes it cheaper still. The commit cadence is
**independent** of the replay-keyframe cadence — commits are for addressing/sharing/integrity, replay
keyframes are for seek speed; don't conflate them.

## The git object model, mapped

| git | mrson | status |
|---|---|---|
| **blob** | content-addressed data chunk (zarr) — `sha256-<hex>` | have |
| **tree** | node-map snapshot (a replay keyframe), hash of its canonical JSON (which refs blob hashes) | `Commit.tree` (optional) |
| **commit** | `{ parents, base?, t, author, role, message?, ops }`, content-addressed | `Commit` |
| **ref / branch / HEAD** | named pointer to a commit hash — a stream/fork HEAD | `Ref`, `Stream.head`, `Fork.head` |
| **tag** | a named commit (e.g., a LiveStory step/mark) | `Ref` + `Commit.message` |

A **commit hashes the delta bundle + parents** (not a full snapshot), so the chain captures the entire
ancestry transitively — the state at a commit is *reproducible by replay from the root*, exactly as a git
commit hash covers its whole history without re-storing content.

## Content addressing

`ContentHash` = `"sha256-<hex>"` over the **canonical serialization** of the referent — **RFC 8785 JSON
Canonicalization Scheme** (sorted keys, fixed number formatting, no whitespace ambiguity) or **canonical
CBOR**. This is the one real gotcha: without a canonical form the same content hashes differently across
hosts/runs. A commit's `hash` is computed over the commit object **with `hash` omitted**.

## Branch addressing: `(commit, offset)`

A `BranchPoint` is a commit hash **+ N ops past it**. The commit pins a reproducible state; the N ops are
deterministic (ordered + deterministic `applyOp`), so `(commit, offset)` is unambiguous **without hashing
frame N**. Result: **~33 ms branch granularity at ~1 Hz hash cost.** A fork records `base: (commit, N)` and
its own commits from there.

## Fork & pull request

- **Fork** — a `Fork` object in the forker's *own writable space* (their OneDrive). It carries `forkOf` +
  `base: BranchPoint` + its own `commits` from that base. **By reference by default (esp. PHI):** ops
  reference upstream blobs *by hash*; the fork's `blobBase` stores only **new** blobs the forker created.
  Revoking the forker's read on upstream then cascades their view to broken — the desired PHI behavior,
  and no PHI is duplicated. (A `vendor`/"export standalone copy" that copies referenced blobs is an
  explicit, non-default action for non-PHI durability.)
- **Pull request** — a `PullRequest` proposes the fork's commits (from `base`) into the upstream. The owner
  replays them on the current upstream `head`: if upstream is unchanged since `base` → fast-forward append;
  else per-node/property resolution using the op envelope's existing `{origin, v}` (Lamport-ish LWW). A
  **merge appends the accepted ops + promotes new blobs**, and **keeps each op's `origin`** — so the
  canonical stream records "from Dr. X's fork, accepted by owner Y at T": git-blame *and* HIPAA §164.312(b)
  audit in one structure. Any altered op breaks the hash chain → §164.312(c) integrity, structurally.

## Storage mapping (Microsoft Graph reference)

- **upstream `Stream`** → a folder in a **SharePoint site** (or owner OneDrive): `stream.json` (commit log
  + head) · `blobs/` · `keyframes/` · `thumbs/`. Others = read (`invite`, org/named for PHI; anon link only
  if the tenant allows, i.e. non-PHI); owner = write.
- **`Fork`** → a folder in the **forker's own OneDrive** (write): `fork.json` · `blobs/` (new only).
- **`PullRequest`** → forker `invite`s the owner to read the fork + posts a PR record; owner merges in-app.

Same shape over any backend (JS2-S3, Dropbox) via the abstract `put/get/thumbnail-by-hash` driver — see
[mrson store: auth + sharing](../../memory) design.

## The sealer (coexists with the live recorder)

The live recorder appends ops (hash-free). A **sealer** runs async ~1 Hz (or on natural boundaries):
`commit = { parents:[prevHead], t, author, ops: <log since prevHead>, hash: sha256(canonical(commit\hash)) }`,
then advances `head`. It never blocks the interactive path; by finalize the chain already exists. A fork's
first commit additionally sets `base`.

## Not yet decided / follow-ups

- Merge conflict UX beyond LWW (three-way over `tree` snapshots?).
- Whether `Commit.ops` inline vs. reference an op-log slice (inline = self-contained/shareable; chosen for v0).
- Signing commits (author non-repudiation) — a `sig` field over `hash` for high-assurance later.
- Reflect commits/head into the SlicerLive recording (`recorder.ts` Session, `recording.json`) — the
  implementation step after this structure lands.
