// NIfTI-1 writer (W7) — serialize a Volume to a single-file .nii (348-byte header + 4-byte pad + raw data).
// Writes the sform (and qform-compatible) as the RAS ijkToRAS directly (NIfTI is RAS: +x=R,+y=A,+z=S), so no
// LPS flip. sform_code = 1 (scanner). Little-endian. Pure (bytes out); gzip via DecompressionStream on read.
import type { Volume } from "../readers/nifti.ts";

const DT: Record<string, { code: number; bits: number }> = {
  "|u1": { code: 2, bits: 8 }, "<u1": { code: 2, bits: 8 },     // uint8
  "|i1": { code: 256, bits: 8 }, "<i1": { code: 256, bits: 8 }, // int8
  "<i2": { code: 4, bits: 16 }, "<u2": { code: 512, bits: 16 }, // int16 / uint16
  "<i4": { code: 8, bits: 32 }, "<u4": { code: 768, bits: 32 }, // int32 / uint32
  "<f4": { code: 16, bits: 32 }, "<f8": { code: 64, bits: 64 }, // float32 / float64
};

/** Serialize a Volume to NIfTI-1 (.nii) bytes. */
export function writeNifti(vol: Volume): Uint8Array {
  const dt = DT[vol.dtype]; if (!dt) throw new Error(`NIfTI writer: unsupported dtype ${vol.dtype}`);
  const [nx, ny, nz] = vol.dims;
  const m = vol.ijkToRAS;
  const spacing = (c: number) => Math.hypot(m[c], m[4 + c], m[8 + c]) || 1;

  const total = 352 + vol.data.byteLength;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const LE = true;

  dv.setInt32(0, 348, LE);                 // sizeof_hdr
  dv.setInt16(40, 3, LE);                   // dim[0] = 3
  dv.setInt16(42, nx, LE); dv.setInt16(44, ny, LE); dv.setInt16(46, nz, LE);   // dim[1..3]
  dv.setInt16(48, 1, LE); dv.setInt16(50, 1, LE); dv.setInt16(52, 1, LE);       // dim[4..6]=1
  dv.setInt16(70, dt.code, LE);             // datatype
  dv.setInt16(72, dt.bits, LE);             // bitpix
  dv.setFloat32(76, 0, LE);                 // pixdim[0] (qfac)
  dv.setFloat32(80, spacing(0), LE); dv.setFloat32(84, spacing(1), LE); dv.setFloat32(88, spacing(2), LE);   // pixdim[1..3]
  dv.setFloat32(108, 352, LE);              // vox_offset
  dv.setFloat32(112, 1, LE);                // scl_slope
  dv.setInt16(252, 0, LE);                  // qform_code = 0 (use sform)
  dv.setInt16(254, 1, LE);                  // sform_code = 1 (scanner/RAS)
  // srow_x/y/z = rows of ijkToRAS (RAS), at offsets 280/296/312
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) dv.setFloat32(280 + r * 16 + c * 4, m[r * 4 + c], LE);
  // magic "n+1\0" at 344
  const magic = [0x6e, 0x2b, 0x31, 0x00];
  for (let i = 0; i < 4; i++) dv.setUint8(344 + i, magic[i]);

  new Uint8Array(buf, 352).set(new Uint8Array(vol.data.buffer, vol.data.byteOffset, vol.data.byteLength));
  return new Uint8Array(buf);
}
