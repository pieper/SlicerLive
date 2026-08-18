/** Cross-language conformance: streams produced by the PYTHON encoder must
 *  decode, symbol for symbol, in the browser implementation.
 *
 *  Two independent implementations of an arithmetic coder agreeing by inspection
 *  is not a thing that happens; a single wrong increment or a missed carry
 *  desynchronises everything after it, usually far from the mistake. The vectors
 *  come from scripts/pack_staged.py via the same context construction the real
 *  tier uses, including the progressive refinement across stages.
 *
 *    deno test examples/livecodec/livecodec-range.test.ts
 */
import { assertEquals } from "jsr:@std/assert@1";
import { bucketsToCodes, decodeStage } from "./livecodec-range.ts";

interface Stage { q: number; K: number; buf: number[]; expect: number[] }
interface Vector { name: string; dims: [number, number, number, number]; levels: number; stages: Stage[] }

const vectors: Vector[] = JSON.parse(
  await Deno.readTextFile(new URL("./rc-vectors.json", import.meta.url)));

for (const v of vectors) {
  Deno.test(`python stream decodes in the browser coder: ${v.name}`, () => {
    const [C, D, H, W] = v.dims;
    let prev: Int32Array<ArrayBufferLike> = new Int32Array(C * D * H * W);
    let prevN = 1;
    for (const st of v.stages) {
      const got = decodeStage(new Uint8Array(st.buf), prev, prevN, st.q, st.K, v.dims);
      assertEquals(Array.from(got), st.expect,
        `stage q=${st.q} of ${v.name} diverged from the encoder`);
      prev = got;
      prevN = st.q;
    }
    // the last stage is full resolution, so it must be the original codes
    const last = v.stages[v.stages.length - 1];
    assertEquals(last.q, v.levels);
  });
}

Deno.test("partial stages reconstruct at the bucket centre", () => {
  // A stage that has not reached full resolution knows only an interval; the
  // centre is what makes it renderable instead of biased toward zero.
  const q = new Int32Array([0, 1]);
  const c = bucketsToCodes(q, 2, 8);
  assertEquals(Array.from(c), [1.5, 5.5]);
  const exact = bucketsToCodes(new Int32Array([0, 7]), 8, 8);
  assertEquals(Array.from(exact), [0, 7]);
});
