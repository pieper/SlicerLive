// T1: the shared byte helpers. These encode a FORMAT COMMITMENT - a chunk is zlib-wrapped deflate
// named by the sha256 of its compressed bytes - so the round trips and the digest forms are pinned
// rather than assumed. docs/MRCOM-SCENE-BUNDLE.md sections 2.4 and 5.2.
import { assert, assertEquals } from "../mrson/assert.ts";
import {
  bytesToArrayBuffer,
  deflateBytes,
  digestOfName,
  hexOf,
  inflateBytes,
  nameOfDigest,
  sha256Bytes,
  sha256Name,
  utf8Decode,
  utf8Encode,
} from "./bytes.ts";

const payload = () => {
  const b = new Uint8Array(5000);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
};

Deno.test("deflate/inflate round trips, including empty and incompressible input", async () => {
  for (const input of [new Uint8Array(0), new Uint8Array([1]), payload()]) {
    const back = await inflateBytes(await deflateBytes(input));
    assertEquals(back, input, `round trip failed for ${input.length} bytes`);
  }
});

Deno.test("deflate is zlib-wrapped, so Python's zlib.decompress can read it", async () => {
  // A zlib stream starts with a 2-byte header whose first byte is 0x78 for deflate with a 32K
  // window. A raw deflate stream does not. Slicer's serialize.py writes zlib.compress output, and
  // render/zarr.ts inflates with DecompressionStream("deflate") - both sides assume the wrapper.
  const out = await deflateBytes(payload());
  assertEquals(out[0], 0x78, "missing the zlib header: this would break Slicer-written chunks");
});

Deno.test("sha256 comes in two forms, and they convert", async () => {
  const bytes = utf8Encode("hello");
  const hex = await sha256Bytes(bytes);
  const name = await sha256Name(bytes);

  // the known digest of "hello", so this is pinned to a value and not just to itself
  assertEquals(hex, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assertEquals(name, "sha256-" + hex);
  assert(hex.length === 64, "a bare digest is 64 hex characters");
  // why bare: "sha256-" + 64 hex is 71, and LO is 64
  assert(name.length === 71 && 71 > 64, "the prefixed name does not fit LO");

  assertEquals(digestOfName(name), hex);
  assertEquals(nameOfDigest(hex), name);
  assertEquals(digestOfName("not-a-name"), null);
  assertEquals(digestOfName("sha256-xyz"), null);
});

Deno.test("nameOfDigest refuses anything that is not a digest", () => {
  for (const bad of ["", "abc", "A".repeat(64), "sha256-" + "a".repeat(64)]) {
    let threw = false;
    try {
      nameOfDigest(bad);
    } catch {
      threw = true;
    }
    assert(threw, `nameOfDigest should refuse ${JSON.stringify(bad)}`);
  }
});

Deno.test("hexOf pads single digits", () => {
  assertEquals(hexOf(new Uint8Array([0, 1, 15, 16, 255])), "00010f10ff");
});

Deno.test("utf8 round trips non-ASCII", () => {
  const text = 'scène "déjà" åäö 中文';
  assertEquals(utf8Decode(utf8Encode(text)), text);
});

Deno.test("bytesToArrayBuffer copies a partial view instead of exposing the whole buffer", () => {
  const backing = new Uint8Array(100);
  for (let i = 0; i < backing.length; i++) backing[i] = i;
  const view = backing.subarray(10, 20);

  const buffer = bytesToArrayBuffer(view);
  assertEquals(buffer.byteLength, 10, "a partial view must not hand over its whole backing buffer");
  assertEquals(new Uint8Array(buffer), new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));

  // a full view passes through without a copy
  const whole = new Uint8Array(8);
  assert(bytesToArrayBuffer(whole) === whole.buffer, "a full view should not be copied");
});
