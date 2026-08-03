// seal-recording — post-process a finalized recording.json so it emits git-style history: seal its
// event stream into a content-addressed commit chain and write `commits` / `head` / `root` back into the
// manifest. Deterministic (content-addressed), so any reader recomputes the same hashes.
//   deno run -A render/tools/seal-recording.ts /tmp/mrson_rec/rec-<id>/recording.json
//
// (The realtime Slicer recorder stays hash-free; sealing runs at finalize/share time — a ~1Hz bundle.)

import { branchPointAtTime, sealStream, verifyChain } from "../commits.ts";

const path = Deno.args[0];
if (!path) { console.error("usage: seal-recording.ts <recording.json> [intervalMs]"); Deno.exit(2); }
const intervalMs = Number(Deno.args[1] ?? 1000);

const man = JSON.parse(await Deno.readTextFile(path));
const events = (man.events ?? []) as { t?: number }[];
const commits = await sealStream(events, { intervalMs, role: "module" });

man.commits = commits;
man.root = commits[0]?.hash ?? null;
man.head = commits[commits.length - 1]?.hash ?? null;
await Deno.writeTextFile(path, JSON.stringify(man));

const v = await verifyChain(commits);
const mid = man.startedAt ? (man.startedAt + man.endedAt) / 2 : (events[Math.floor(events.length / 2)]?.t ?? 0);
console.log(`sealed ${events.length} events → ${commits.length} commits (interval ${intervalMs}ms)`);
console.log(`  root:  ${man.root}`);
console.log(`  head:  ${man.head}`);
console.log(`  verify: ${v.ok ? "OK ✓" : "FAIL @" + v.badAt + " (" + v.reason + ")"}`);
console.log(`  branch point @ mid (${mid}): ${JSON.stringify(branchPointAtTime(commits, mid))}`);
Deno.exit(v.ok ? 0 : 1);
