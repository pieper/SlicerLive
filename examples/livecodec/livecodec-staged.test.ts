/** End-to-end against the PUBLISHED staged tier: decode all three stages from
 *  the bucket and check the final one reproduces the monolithic fine.gz codes
 *  exactly. This is the artifact the browser will actually fetch. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeFineStage } from "./livecodec-range.ts";

const B = "https://js2.jetstream-cloud.org:8001/livecodec-demo/versions/prior2/";
const SID = "13b2886c6cafa1e8";

Deno.test("published staged tier decodes to the published codes", async () => {
  const meta = await (await fetch(`${B}${SID}/meta.json`)).json();
  const [, C, Df, Hf, Wf] = meta.latent.fine;
  const chunks = meta.latent.chunks;
  const levels: number[] = meta.levels;

  const gz = new Uint8Array(await (await fetch(`${B}${SID}/fine.gz`)).arrayBuffer());
  const raw = new Uint8Array(await new Response(
    new Response(gz).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

  let prev: Int32Array<ArrayBufferLike>[] = levels.map(() => new Int32Array(chunks * Df * Hf * Wf));
  let prevN = levels.map(() => 1);
  let codes: Float32Array<ArrayBufferLike> = new Float32Array(0);
  for (let s = 1; s <= meta.staged.stages; s++) {
    const idx = await (await fetch(`${B}${SID}/fine-s${s}.json`)).json();
    const buf = new Uint8Array(await (await fetch(`${B}${SID}/fine-s${s}.bin`)).arrayBuffer());
    const r = decodeFineStage(buf, idx, levels, prev, prevN, chunks, Df, Hf, Wf);
    prev = r.buckets;
    prevN = idx.buckets;
    codes = r.codes;
    assert(codes.length === raw.length, `stage ${s} length ${codes.length} != ${raw.length}`);
  }
  let bad = 0;
  for (let i = 0; i < raw.length; i++) if (codes[i] !== raw[i]) bad++;
  assertEquals(bad, 0, `${bad}/${raw.length} codes differ after the final stage`);
});
