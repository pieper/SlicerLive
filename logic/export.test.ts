// T1 unit (W7): export result shape + filenames (round-trip fidelity is covered by the writer tests/parity).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { exportSegmentation, exportVolume } from "./export.ts";
import { LocalBlobStore, volumeToZarr } from "./ingest.ts";
import type { LiveScene } from "../render/livescene.ts";

// a tiny fake LiveScene backed by a blob store
async function fakeScene(): Promise<{ live: LiveScene; imgId: string; segId: string }> {
  const store = new LocalBlobStore();
  const nodes = new Map<string, unknown>();
  const mk = async (id: string, name: string, dtype: string, extra: Record<string, unknown>) => {
    const data = dtype === "|u1" ? new Uint8Array(8) : new Int16Array(8);
    for (let i = 0; i < 8; i++) data[i] = i;
    const { desc, blobs } = await volumeToZarr(data, [2, 2, 2], dtype); store.add(blobs);
    nodes.set(id, { type: extra.type, id, name, dims: [2, 2, 2], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], zarr: desc, ...extra });
  };
  await mk("img1", "MyVol", "<i2", { type: "image" });
  await mk("seg1", "MySeg", "|u1", { type: "segmentation", segments: [{ labelValue: 1, name: "Seg_1", color: [1, 0, 0] }] });
  const live = { nodes, blobBase: () => "blob://" } as unknown as LiveScene;
  return { live, imgId: "img1", segId: "seg1" };
}

Deno.test("exportVolume produces .nrrd / .nii with the node name", async () => {
  const { live, imgId } = await fakeScene();
  const nrrd = await exportVolume(live, imgId, "nrrd");
  assertEquals(nrrd.filename, "MyVol.nrrd");
  assert(new TextDecoder().decode(nrrd.bytes.slice(0, 8)).startsWith("NRRD"), "NRRD magic");
  const nii = await exportVolume(live, imgId, "nifti");
  assertEquals(nii.filename, "MyVol.nii");
  assert(nii.bytes.byteLength >= 352, "NIfTI header present");
});

Deno.test("exportSegmentation writes a .seg.nrrd with segment keys", async () => {
  const { live, segId } = await fakeScene();
  const r = await exportSegmentation(live, segId);
  assertEquals(r.filename, "MySeg.seg.nrrd");
  const head = new TextDecoder().decode(r.bytes.slice(0, 600));
  assert(head.includes("Segment0_LabelValue:=1"), "segment key written");
});
