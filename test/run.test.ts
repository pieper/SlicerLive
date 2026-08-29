// T1: the tier rules behind test/run.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { needsNet, scriptFailed, tierOf } from "./tiers.ts";

Deno.test("tierOf: by file name suffix", () => {
  assertEquals(tierOf("render/test/liveops.test.ts"), "unit");
  assertEquals(tierOf("render/test/bg-flash.gpu.test.ts"), "gpu");
  assertEquals(tierOf("harness/smoke.browser.test.ts"), "browser");
  assertEquals(tierOf("harness/parity/baseline.parity.test.ts"), "parity");
});

Deno.test("needsNet: marker in the header only", () => {
  assert(needsNet("// @needs-net — hits a bucket\nDeno.test(...)"));
  assert(!needsNet("// plain\n" + "x".repeat(3000) + "@needs-net"));
});

Deno.test("scriptFailed: exit code or a failure marker", () => {
  assert(!scriptFailed(0, "PASS all good\n"));
  assert(scriptFailed(1, "PASS"));
  assert(scriptFailed(0, "camera XX 1e-3"));
  assert(scriptFailed(0, "MISMATCH at row 3"));
  assert(!scriptFailed(0, "no differ here")); // DIFFER is case-sensitive
});
