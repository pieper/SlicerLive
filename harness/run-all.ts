// Regression runner for the Slicer-parity suite.
//
//   deno run -A harness/run-all.ts             # pure checks only (no browser/Slicer needed)
//   deno run -A harness/run-all.ts --browser   # also the live-browser checks (needs Chrome
//                                              # on :9222 + the gallery served on :8099)
//
// Pure checks replay ground truth captured from a real Slicer session (harness/fixtures/)
// against the TS ports, so they run anywhere. Browser checks additionally prove the DOM
// wiring — same numbers, driven through real synthetic input over CDP.
// See docs/HARNESS.md for the rationale behind each check and how to refresh fixtures.

const PURE = [
  ["vtkCamera port vs real VTK", "harness/verify-vtk-camera.ts"],
  ["camera bindings (rotate/pan/zoom/wheel)", "harness/verify-actions.ts"],
  ["slice stepping math", "harness/verify-slice-step-math.ts"],
];
const BROWSER = [
  ["startup geometry", "harness/compare-startup.ts"],
  ["drag through Slicer's real widget", "harness/verify-drag-parity.ts"],
  ["slice stepping via DOM", "harness/verify-slice-step.ts"],
];

const withBrowser = Deno.args.includes("--browser");
const verbose = Deno.args.includes("-v");

// A check "passes" if it exits 0 AND its output contains no failure marker.
const FAIL_MARKERS = [/\bXX\b/, /MISMATCH/, /DIFFER/];

async function run(label: string, script: string): Promise<boolean> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", script],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  const failed = code !== 0 || FAIL_MARKERS.some((re) => re.test(out));
  console.log(`${failed ? "FAIL" : "PASS"}  ${label}`);
  if (failed || verbose) console.log(out.split("\n").map((l) => "        " + l).join("\n"));
  return !failed;
}

console.log("\n--- pure checks (fixtures + TS ports) ---");
let ok = true;
for (const [label, script] of PURE) ok = await run(label, script) && ok;

if (withBrowser) {
  console.log("\n--- browser checks (CDP -> live page) ---");
  for (const [label, script] of BROWSER) ok = await run(label, script) && ok;
} else {
  console.log("\n(skipping browser checks; pass --browser to include them)");
}

console.log(`\n${ok ? "ALL PARITY CHECKS PASS" : "SOME PARITY CHECKS FAILED"}\n`);
if (!ok) Deno.exit(1);
