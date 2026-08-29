// Synthetic NIfTI-1 bytes for tests (unit + in-page self-tests): int16 4x3x2, value = i + 10*j + 100*k.
export interface SyntheticNiftiOpts { sform?: number[]; qform?: { b: number; c: number; d: number; qfac: number; off: number[] }; pixdim?: number[]; bigEndian?: boolean }
export const SYNTHETIC_DIMS: [number, number, number] = [4, 3, 2];
export function makeNifti(o: SyntheticNiftiOpts = {}): Uint8Array {
  const [nx, ny, nz] = SYNTHETIC_DIMS, hdr = new ArrayBuffer(352), dv = new DataView(hdr), le = !o.bigEndian;
  dv.setInt32(0, 348, le);
  dv.setInt16(40, 3, le); dv.setInt16(42, nx, le); dv.setInt16(44, ny, le); dv.setInt16(46, nz, le); dv.setInt16(48, 1, le);
  dv.setInt16(70, 4, le); dv.setInt16(72, 16, le);
  const pd = o.pixdim ?? [1, 1, 1, 1];
  dv.setFloat32(76, o.qform?.qfac ?? pd[0], le); dv.setFloat32(80, pd[1], le); dv.setFloat32(84, pd[2], le); dv.setFloat32(88, pd[3], le);
  dv.setFloat32(108, 352, le); dv.setFloat32(112, 1, le);
  dv.setInt16(252, o.qform ? 1 : 0, le); dv.setInt16(254, o.sform ? 1 : 0, le);
  if (o.qform) { dv.setFloat32(256, o.qform.b, le); dv.setFloat32(260, o.qform.c, le); dv.setFloat32(264, o.qform.d, le); dv.setFloat32(268, o.qform.off[0], le); dv.setFloat32(272, o.qform.off[1], le); dv.setFloat32(276, o.qform.off[2], le); }
  if (o.sform) o.sform.forEach((v, i) => dv.setFloat32(280 + i * 4, v, le));
  new Uint8Array(hdr, 344, 4).set(new TextEncoder().encode("n+1\0"));
  const vox = new ArrayBuffer(nx * ny * nz * 2), vv = new DataView(vox);
  let n = 0; for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) vv.setInt16(n++ * 2, i + 10 * j + 100 * k, le);
  const out = new Uint8Array(352 + vox.byteLength); out.set(new Uint8Array(hdr)); out.set(new Uint8Array(vox), 352);
  return out;
}
