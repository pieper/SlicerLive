// The ONE test entry point for SlicerLive (docs/HARNESS.md). A plain script that only spawns `deno test`
// per tier — deliberately not a deno.json task (CONTRIBUTING: no build system, no task runner).
//
//   deno run -A test/run.ts                  # T1 unit: hermetic (no GPU, no Slicer, no network) — what CI runs
//   deno run -A test/run.ts --gpu            # + T2: *.gpu.test.ts (needs --unstable-webgpu; skipped w/o adapter)
//   deno run -A test/run.ts --browser        # + T3: *.browser.test.ts (headed Chrome on :9222 + static server)
//   deno run -A test/run.ts --parity         # + T4: *.parity.test.ts (Slicer MCP at $SL_MCP, default :2126)
//   deno run -A test/run.ts --all [-v]       # everything; -v prints each tier's full output
//   deno run -A test/run.ts --gpu --update-golden   # regenerate golden images (review the diff!)
//   deno run -A test/run.ts --list           # show which files each tier would run
//
// Tiers are decided by file NAME, not location:  foo.test.ts = T1, foo.gpu.test.ts = T2,
// foo.browser.test.ts = T3, foo.parity.test.ts = T4.  A T1 file whose header contains `// @needs-net`
// runs only when SL_NET is set (the net-dependent livecodec tests), so the default run is offline-safe.
// Legacy `deno run` verification scripts under harness/ (fixtures + TS ports) are run as part of T1 via
// the SCRIPTS table; pass/fail = exit code OR a failure marker in the output (some never exit non-zero).

const args = new Set(Deno.args);
const verbose = args.has("-v");
const all = args.has("--all");
const want = { unit: true, gpu: all || args.has("--gpu"), browser: all || args.has("--browser"), parity: all || args.has("--parity") };
const listOnly = args.has("--list");
const updateGolden = args.has("--update-golden");

const SKIP_DIRS = new Set(["node_modules", ".git", "desktop", "vendor", "build", "dist"]);
async function walk(dir: string, out: string[]) {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) { if (!SKIP_DIRS.has(e.name)) await walk(p, out); }
    else if (e.isFile && e.name.endsWith(".test.ts")) out.push(p);
  }
}
const files: string[] = [];
await walk(".", files);
files.sort();

import { needsNet as needsNetHeader, scriptFailed, tierOf as tier } from "./tiers.ts";
async function needsNet(f: string) { return needsNetHeader(await Deno.readTextFile(f)); }

const byTier: Record<string, string[]> = { unit: [], gpu: [], browser: [], parity: [] };
for (const f of files) {
  if (tier(f) === "unit" && !Deno.env.get("SL_NET") && await needsNet(f)) { if (verbose || listOnly) console.log(`  (skip, needs SL_NET) ${f}`); continue; }
  byTier[tier(f)].push(f);
}

// Legacy verification scripts that are not Deno.test files (fixtures + TS ports; hermetic). From harness/run-all.ts.
const SCRIPTS: [string, string][] = [
  ["vtkCamera port vs real VTK", "harness/verify-vtk-camera.ts"],
  ["camera bindings (rotate/pan/zoom/wheel)", "harness/verify-actions.ts"],
  ["slice stepping math", "harness/verify-slice-step-math.ts"],
];

const FLAGS: Record<string, string[]> = {
  unit: ["-A"],
  gpu: ["-A", "--unstable-webgpu"],
  browser: ["-A"],
  parity: ["-A"],
};

async function runDeno(argv: string[], env: Record<string, string> = {}): Promise<{ ok: boolean; out: string }> {
  const cmd = new Deno.Command(Deno.execPath(), { args: argv, stdout: "piped", stderr: "piped", env: { ...Deno.env.toObject(), ...env } });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  return { ok: code === 0, out };
}

const results: { tier: string; label: string; ok: boolean; out: string }[] = [];
async function tierRun(name: string, list: string[]) {
  if (!list.length) { results.push({ tier: name, label: `${name}: no files`, ok: true, out: "" }); return; }
  if (listOnly) { console.log(`\n[${name}]`); for (const f of list) console.log("  " + f); return; }
  const env: Record<string, string> = updateGolden ? { SL_UPDATE_GOLDEN: "1" } : {};
  if (name === "parity") env.SL_SLICER = Deno.env.get("SL_SLICER") ?? "1";
  const r = await runDeno(["test", ...FLAGS[name], "--no-check", ...list], env);
  results.push({ tier: name, label: `${name}: ${list.length} file${list.length === 1 ? "" : "s"}`, ...r });
}

if (want.unit) {
  await tierRun("unit", byTier.unit);
  if (!listOnly) for (const [label, script] of SCRIPTS) {
    const r = await runDeno(["run", "-A", script]);
    const failed = scriptFailed(r.ok ? 0 : 1, r.out);
    results.push({ tier: "unit", label: `script: ${label}`, ok: !failed, out: r.out });
  } else { console.log("\n[unit scripts]"); for (const [, s] of SCRIPTS) console.log("  " + s); }
}
if (want.gpu) await tierRun("gpu", byTier.gpu);
if (want.browser) await tierRun("browser", byTier.browser);
if (want.parity) await tierRun("parity", byTier.parity);
if (listOnly) Deno.exit(0);

console.log("\n  tier      result   what");
console.log("  " + "-".repeat(60));
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`  ${r.tier.padEnd(9)} ${(r.ok ? "PASS" : "FAIL").padEnd(8)} ${r.label}`);
  if (!r.ok || verbose) console.log(r.out.split("\n").map((l) => "           " + l).join("\n"));
}
console.log(`\n  ${bad ? `${bad} FAILED` : "ALL PASS"}` + (want.gpu || want.browser || want.parity ? "" : "   (unit tier only; --gpu --browser --parity for the rest)") + "\n");
Deno.exit(bad ? 1 : 0);
