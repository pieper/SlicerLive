// In-page self-tests (tier T5). Any module can register a check; the page runs them on demand via
// window.__slicerlive.selfTest() and a browser test (T3) asserts fail === 0. Checks are async, must be
// side-effect free enough to run on a live page, and should assert NUMBERS (see docs/HARNESS.md).
export interface SelfTestResult { name: string; ok: boolean; ms: number; detail?: string }
export interface SelfTestReport { pass: number; fail: number; details: SelfTestResult[] }

type Check = () => void | Promise<void>;
const checks = new Map<string, Check>();

/** Register (or replace) a named self-test. Throw (or fail an assertion) to fail. */
export function registerSelfTest(name: string, fn: Check): void { checks.set(name, fn); }
export function selfTestNames(): string[] { return [...checks.keys()]; }

export async function runSelfTests(filter?: string | RegExp): Promise<SelfTestReport> {
  const details: SelfTestResult[] = [];
  for (const [name, fn] of checks) {
    if (filter && !(typeof filter === "string" ? name.includes(filter) : filter.test(name))) continue;
    const t0 = performance.now();
    try { await fn(); details.push({ name, ok: true, ms: Math.round(performance.now() - t0) }); }
    catch (e) { details.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: String((e as Error)?.message ?? e).slice(0, 300) }); }
  }
  return { pass: details.filter((d) => d.ok).length, fail: details.filter((d) => !d.ok).length, details };
}

/** Tiny assertion helpers so self-tests don't import a test library into the page bundle. */
export function expect(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
export function expectClose(a: number, b: number, tol: number, msg = ""): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${a} ≈ ${b} (tol ${tol})`.trim());
}
