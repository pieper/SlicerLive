// T1: synthetic NIfTI-1 volumes (sform / qform / gz) -> correct voxel order and ijkToRAS. No LPS flip.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseNifti, quaternToMat } from "./nifti.ts";
import { readVolume, sniff } from "./registry.ts";

import { makeNifti } from "./synthetic.ts";

Deno.test("sform wins: ijkToRAS = srow, voxel order (z,y,x) C-order", async () => {
  const sform = [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5];
  const v = await parseNifti(makeNifti({ sform, qform: { b: 0, c: 0, d: 0, qfac: 1, off: [99, 99, 99] } }));
  assertEquals(v.dims, [4, 3, 2]);
  assertEquals(v.ijkToRAS, [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5, 0, 0, 0, 1]);
  assertEquals(v.data[0], 0); assertEquals(v.data[1], 1); assertEquals(v.data[4], 10); assertEquals(v.data[12], 100);   // i fastest, then j, then k
  assertEquals(v.dtype, "<i2");
});

Deno.test("qform: identity quaternion -> pixdim scaling + offset; qfac=-1 flips k", async () => {
  const v = await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: 1, off: [1, 2, 3] }, pixdim: [1, 0.5, 0.75, 2] }));
  assertEquals(v.ijkToRAS, [0.5, 0, 0, 1, 0, 0.75, 0, 2, 0, 0, 2, 3, 0, 0, 0, 1]);
  const f = await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: -1, off: [0, 0, 0] }, pixdim: [-1, 1, 1, 1] }));
  assertEquals(f.ijkToRAS[10], -1);
  // a 90° rotation about z (b=0,c=0,d=sin45) maps i -> +A
  const R = quaternToMat(0, 0, Math.SQRT1_2, 1, 1, 1, 1);
  assert(Math.abs(R[0]) < 1e-6 && Math.abs(R[3] - 1) < 1e-6, "i axis should map to +y");
});

Deno.test("pixdim only, big-endian, gzip, and sniffing", async () => {
  const be = await parseNifti(makeNifti({ bigEndian: true, pixdim: [1, 1.5, 1.5, 3] }));
  assertEquals(be.ijkToRAS[0], 1.5); assertEquals(be.data[12], 100);
  const raw = makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] });
  const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  assertEquals(sniff(gz, "x.nii.gz"), "nifti"); assertEquals(sniff(raw), "nifti"); assertEquals(sniff(new TextEncoder().encode("NRRD0004\n")), "nrrd");
  const v = await readVolume(gz, "brain.nii.gz");
  assertEquals(v.name, "brain"); assertEquals(v.data.length, 24);
});
