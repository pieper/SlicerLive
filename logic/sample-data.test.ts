// T1: the sample-data catalog verifies checksums (fake fetch); the real download is gated on SL_NET.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { downloadSample, SAMPLE_DATA, sampleUrl, sha256Hex } from "./sample-data.ts";

Deno.test("catalog: Slicer's names, files and 64-hex checksums", () => {
  for (const d of SAMPLE_DATA) { assert(/^[0-9a-f]{64}$/.test(d.sha256), d.name); assert(sampleUrl(d).endsWith("/SHA256/" + d.sha256)); }
  assertEquals(SAMPLE_DATA.find((d) => d.name === "MRHead")?.fileName, "MR-head.nrrd");
});

Deno.test("downloadSample: verifies SHA-256 and rejects a mismatch", async () => {
  const bytes = new TextEncoder().encode("not really MRHead");
  const fake = () => Promise.resolve(bytes);
  await assertRejects(() => downloadSample("MRHead", fake), Error, "SHA-256 mismatch");
  const good = SAMPLE_DATA[0];
  const h = await sha256Hex(bytes);
  const patched = { ...good, sha256: h };
  SAMPLE_DATA.push({ ...patched, name: "__fake" });
  const r = await downloadSample("__fake", fake);
  assertEquals(r.bytes, bytes);
  SAMPLE_DATA.pop();
});

Deno.test({ name: "downloadSample: MRHead from SlicerTestingData (SL_NET)", ignore: !Deno.env.get("SL_NET"), async fn() {
  const r = await downloadSample("MRHead");
  assert(r.bytes.length > 1_000_000);
} });
