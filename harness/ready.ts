// Settle detection for browser/parity tests — replaces fixed sleeps. A page that installs introspection
// (render/introspect.ts) exposes frameCount + idle(); we wait on those, not on a timer.
import type { CDP } from "./cdp.ts";

/** Wait until the page's __slicerlive hook exists and at least one frame has rendered. */
export async function waitReady(cdp: CDP, timeoutMs = 60000): Promise<void> {
  await cdp.waitForValue<number>("(window.__slicerlive && window.__slicerlive.ready) ? (window.__slicerlive.frameCount ?? 1) : 0", (n) => n > 0, timeoutMs);
}

/** Wait until the page reports idle (a rendered frame with no pending work) — after an input or an op. */
export async function waitIdle(cdp: CDP, timeoutMs = 20000): Promise<void> {
  await cdp.eval(`if (window.__slicerlive && window.__slicerlive.idle) await window.__slicerlive.idle(${timeoutMs}); return 1;`);
}

/** Wait until `expr` (JSON-serialisable) stops changing for `quietMs`. For pages without idle(). */
export async function waitStable<T>(cdp: CDP, expr: string, quietMs = 400, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let prev = JSON.stringify(await cdp.evalJson<T>(expr)), since = Date.now();
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    const cur = JSON.stringify(await cdp.evalJson<T>(expr));
    if (cur !== prev) { prev = cur; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return JSON.parse(cur) as T;
  }
  throw new Error(`waitStable(${expr}) never settled`);
}
