// Cross-language conformance: the Python sealer (LiveStory/LiveStoryLib/mrson_commits.py) must produce
// BYTE-IDENTICAL content hashes to the TS sealer (render/commits.ts), so a recording sealed in Slicer
// verifies in SlicerLive and vice-versa. Both sides parse the SAME JSON TEXT (literal 1.0 / 30.0 / 1e-7)
// so we exercise float parsing + the RFC 8785 number rule where json.dumps and JSON.stringify diverge.
//   deno test -A render/test/commits-conformance.test.ts     (needs python3 on PATH; pure stdlib)

import { canonicalize, sealStream, sha256Hex } from "../commits.ts";

const PY = "LiveStory/LiveStoryLib/mrson_commits.py";

async function python(mode: string, stdinText: string): Promise<unknown> {
  const child = new Deno.Command("python3", { args: [PY, mode], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(stdinText));
  await w.close();
  const { stdout, stderr, code } = await child.output();
  if (code !== 0) throw new Error("python3 failed: " + new TextDecoder().decode(stderr));
  return JSON.parse(new TextDecoder().decode(stdout));
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error("assertion failed: " + m); }

// Tricky JSON TEXT — hand-written so the float literals survive (JS JSON.stringify would collapse 1.0→1).
const FIXTURES_TEXT =
  `[1.0, 30.0, 0.5, 100.0, 0.1, 0.30000000000000004, -275.71766085266023, 1e21, 1e-7, 1e-6, 123456789.5,` +
  ` -0.0, 0, -30.0, 100, 1785766145587, "hello", "sha256-abcdef",` +
  ` {"b":1.0,"a":2.5,"c":[3.0,4.5]},` +
  ` {"position":[12.4,-30.1,55.8],"viewAngle":30.0,"opacity":1.0,"color":[0.2,0.8,0.4,1.0]},` +
  ` [true,false,null]]`;

Deno.test("JCS conformance: Python canonical hashes == TS for the same JSON text", async () => {
  const fixtures = JSON.parse(FIXTURES_TEXT) as unknown[];
  const tsHashes = await Promise.all(fixtures.map(async (v) => "sha256-" + await sha256Hex(canonicalize(v))));
  const pyHashes = await python("hash-each", FIXTURES_TEXT) as string[];
  // also surface the canonical strings on mismatch for debuggability
  const pyCanon = await python("canon-each", FIXTURES_TEXT) as string[];
  for (let i = 0; i < fixtures.length; i++) {
    assert(tsHashes[i] === pyHashes[i],
      `fixture ${i} = ${JSON.stringify(fixtures[i])}\n  TS canon: ${canonicalize(fixtures[i])}\n  PY canon: ${pyCanon[i]}`);
  }
});

Deno.test("seal conformance: Python sealed head == TS sealed head (incl ISO commit time)", async () => {
  const eventsText =
    `[{"t":1785766145587,"event":"CameraModified","position":[1.0,2.5,-275.71766085266023],"viewAngle":30.0},` +
    `{"t":1785766145620,"event":"Modified","sourceId":"vtkMRMLSliceNodeRed"},` +
    `{"t":1785766147200,"event":"NodeAdded","node":{"type":"segmentation","opacity":1.0,"color":[0.2,0.8,0.4,1.0]}}]`;
  const events = JSON.parse(eventsText) as { t: number }[];
  const tsCommits = await sealStream(events, { intervalMs: 1000, role: "module" });
  const pyOut = await python("seal", `{"events":${eventsText},"intervalMs":1000,"role":"module"}`) as { head: string; root: string; commits: unknown[] };
  assert(tsCommits.length === pyOut.commits.length, `commit count: TS ${tsCommits.length} != PY ${pyOut.commits.length}`);
  assert(tsCommits[tsCommits.length - 1].hash === pyOut.head, `HEAD: TS ${tsCommits[tsCommits.length - 1].hash} != PY ${pyOut.head}`);
  assert(tsCommits[0].hash === pyOut.root, `ROOT mismatch`);
});
