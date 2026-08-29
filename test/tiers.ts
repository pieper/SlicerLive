// Tier rules for test/run.ts (pure, unit-tested): which tier a test file belongs to and whether it is
// gated by an environment marker. Tiers are decided by file NAME so a test can live next to its code.
export type Tier = "unit" | "gpu" | "browser" | "parity";

export function tierOf(file: string): Tier {
  if (file.endsWith(".gpu.test.ts")) return "gpu";
  if (file.endsWith(".browser.test.ts")) return "browser";
  if (file.endsWith(".parity.test.ts")) return "parity";
  return "unit";
}

/** A `// @needs-net` marker in the first 2 KB gates a unit test behind SL_NET (offline-safe default run). */
export function needsNet(headerText: string): boolean { return headerText.slice(0, 2000).includes("@needs-net"); }

/** Legacy verification scripts: exit code OR a failure marker in the output decides. */
export const FAIL_MARKERS = [/\bXX\b/, /MISMATCH/, /DIFFER/];
export function scriptFailed(exitCode: number, output: string): boolean { return exitCode !== 0 || FAIL_MARKERS.some((re) => re.test(output)); }
