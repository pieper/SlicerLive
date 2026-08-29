// T1: the parity oracle's comparison math and the shape of every checked-in parity fixture.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ParityFile, type ParityRow, pyLit, readPath, same, validate } from "./oracle.ts";

const row = (o: Partial<ParityRow>): ParityRow => ({ id: "r", property: "p", node: "n", path: "#/x", slicerGet: "g", slicerSet: "s %V%", inV: 1, outV: 2, ...o });

Deno.test("same(): numbers within tol, arrays element-wise, bools by truthiness", () => {
  assert(same(row({ tol: 0.5 }), 10.4, 10));
  assert(!same(row({ tol: 0.5 }), 10.6, 10));
  assert(same(row({ tol: 0.02 }), [0.21, 0.79, 0.4], [0.2, 0.8, 0.4]));
  assert(!same(row({ tol: 0.02 }), [0.21, 0.9, 0.4], [0.2, 0.8, 0.4]));
  assert(!same(row({ tol: 0.02 }), [0.2], [0.2, 0.8]));
  assert(same(row({ bool: true }), 1, true));
  assert(!same(row({ bool: true }), null, false));
  assert(!same(row({}), { a: 1 }, 1));
});

Deno.test("pyLit() and readPath()", () => {
  assertEquals(pyLit(true), "True"); assertEquals(pyLit([1, 2.5]), "1, 2.5"); assertEquals(pyLit(3), "3");
  assertEquals(readPath({ a: { b: [5, 6] } }, "#/a/b/1"), 6);
  assertEquals(readPath({ a: {} }, "#/a/b/1"), undefined);
});

Deno.test("checked-in parity fixtures are well formed", async () => {
  for await (const e of Deno.readDir("harness/fixtures/parity")) {
    if (!e.name.endsWith(".json")) continue;
    const f = JSON.parse(await Deno.readTextFile(`harness/fixtures/parity/${e.name}`)) as ParityFile;
    const errs = validate(f);
    assertEquals(errs, [], `${e.name}: ${errs.join("; ")}`);
    assert(f.rows.length > 0, `${e.name}: no rows`);
  }
});
