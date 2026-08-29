// NIfTI-1 / NIfTI-2 reader (pure TS, no DOM): header + voxels -> a volume in SlicerLive's convention:
// data C-order (z,y,x) as [nz,ny,nx] shape, dims [nx,ny,nz], and a 4x4 ijkToRAS. NIfTI's qform/sform map
// voxel (i,j,k) to RAS already (the NIfTI standard's "+x = Right, +y = Anterior, +z = Superior"), so no
// LPS flip is applied here — see docs/HARNESS.md "Coordinate systems". Precedence follows ITK/Slicer:
// sform (sform_code > 0) over qform (qform_code > 0) over pixdim-only.
// Supports datatypes 2/4/8/16/64/256/512/768 (u8,i16,i32,f32,f64,i8,u16,u32); .nii.gz via DecompressionStream.

export interface Volume {
  dims: [number, number, number];        // [nx, ny, nz]
  ijkToRAS: number[];                    // 16, row-major
  data: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;   // C-order z,y,x
  dtype: string;                         // zarr dtype string, e.g. "<i2"
  name?: string;
  meta?: Record<string, unknown>;
}

const DT: Record<number, { ctor: new (b: ArrayBuffer, o?: number, n?: number) => Volume["data"]; bytes: number; zarr: string }> = {
  2: { ctor: Uint8Array, bytes: 1, zarr: "|u1" }, 4: { ctor: Int16Array, bytes: 2, zarr: "<i2" }, 8: { ctor: Int32Array, bytes: 4, zarr: "<i4" },
  16: { ctor: Float32Array, bytes: 4, zarr: "<f4" }, 64: { ctor: Float64Array, bytes: 8, zarr: "<f8" }, 256: { ctor: Int8Array, bytes: 1, zarr: "|i1" },
  512: { ctor: Uint16Array, bytes: 2, zarr: "<u2" }, 768: { ctor: Uint32Array, bytes: 4, zarr: "<u4" },
};

export function isGzip(bytes: Uint8Array): boolean { return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; }
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds)).arrayBuffer());
}

export function isNifti(bytes: Uint8Array): boolean {
  if (bytes.length < 348) return false;
  const m1 = String.fromCharCode(bytes[344], bytes[345], bytes[346]);            // "n+1" / "ni1" at 344 (NIfTI-1)
  const m2 = String.fromCharCode(bytes[4], bytes[5], bytes[6]);                  // "n+2" / "ni2" at 4 (NIfTI-2)
  return m1 === "n+1" || m1 === "ni1" || m2 === "n+2" || m2 === "ni2";
}

/** Quaternion (b,c,d) + qfac -> 3x3 rotation, as in nifti1.h `nifti_quatern_to_mat44`. */
export function quaternToMat(b: number, c: number, d: number, qfac: number, dx: number, dy: number, dz: number): number[] {
  let a = 1 - (b * b + c * c + d * d);
  if (a < 1e-7) { const l = Math.hypot(b, c, d); b /= l; c /= l; d /= l; a = 0; } else a = Math.sqrt(a);
  const R = [
    a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c,
    2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b,
    2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - c * c - b * b,
  ];
  const s = [dx, dy, dz * (qfac < 0 ? -1 : 1)];
  return R.map((v, i) => v * s[i % 3]);   // column scaling: M[r][c] * s[c]
}

export async function parseNifti(input: Uint8Array, name?: string): Promise<Volume> {
  const bytes = isGzip(input) ? await gunzip(input) : input;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 348) throw new Error("not a NIfTI file (too short)");
  const sizeof = dv.getInt32(0, true);
  const isN2 = String.fromCharCode(bytes[4], bytes[5], bytes[6]).startsWith("n") && (sizeof === 540 || dv.getInt32(0, false) === 540);
  let little = true;
  let dims: number[], datatype: number, pixdim: number[], voxOffset: number, qformCode: number, sformCode: number;
  let quat: number[], qoff: number[], srow: number[], sclSlope: number, sclInter: number;
  if (!isN2) {
    little = sizeof === 348; if (!little && dv.getInt32(0, false) !== 348) throw new Error("bad NIfTI-1 sizeof_hdr");
    const i16 = (o: number) => dv.getInt16(o, little), f32 = (o: number) => dv.getFloat32(o, little);
    dims = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i16(40 + i * 2));
    datatype = i16(70);
    pixdim = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => f32(76 + i * 4));
    voxOffset = f32(108); sclSlope = f32(112); sclInter = f32(116);
    qformCode = i16(252); sformCode = i16(254);
    quat = [f32(256), f32(260), f32(264)]; qoff = [f32(268), f32(272), f32(276)];
    srow = Array.from({ length: 12 }, (_, i) => f32(280 + i * 4));
  } else {
    little = dv.getInt32(0, true) === 540;
    const i64 = (o: number) => Number(dv.getBigInt64(o, little)), f64 = (o: number) => dv.getFloat64(o, little), i32 = (o: number) => dv.getInt32(o, little);
    datatype = dv.getInt16(12, little);
    dims = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i64(16 + i * 8));
    pixdim = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => f64(104 + i * 8));
    voxOffset = i64(168); sclSlope = f64(176); sclInter = f64(184);
    qformCode = i32(344); sformCode = i32(348);
    quat = [f64(352), f64(360), f64(368)]; qoff = [f64(376), f64(384), f64(392)];
    srow = Array.from({ length: 12 }, (_, i) => f64(400 + i * 8));
  }
  const nd = dims[0]; if (nd < 3 && nd !== 2) throw new Error(`unsupported NIfTI ndim ${nd}`);
  const nx = dims[1], ny = dims[2], nz = nd >= 3 ? dims[3] : 1;
  const nt = nd >= 4 ? Math.max(1, dims[4]) : 1;
  if (nt !== 1) throw new Error(`4D NIfTI (${nt} volumes) not supported yet — load one volume at a time`);
  const dt = DT[datatype]; if (!dt) throw new Error(`unsupported NIfTI datatype ${datatype}`);
  const n = nx * ny * nz;
  let data: Volume["data"];
  const off = Math.round(voxOffset);
  if (little || dt.bytes === 1) {
    const buf = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset + off, bytes.byteOffset + off + n * dt.bytes);
    data = new dt.ctor(buf);
  } else {
    const out = new dt.ctor(new ArrayBuffer(n * dt.bytes));
    const src = new DataView(bytes.buffer, bytes.byteOffset + off, n * dt.bytes);
    for (let i = 0; i < n; i++) {
      const o = i * dt.bytes;
      (out as unknown as number[])[i] = dt.bytes === 2 ? (datatype === 512 ? src.getUint16(o, false) : src.getInt16(o, false))
        : dt.bytes === 4 ? (datatype === 16 ? src.getFloat32(o, false) : datatype === 768 ? src.getUint32(o, false) : src.getInt32(o, false))
        : src.getFloat64(o, false);
    }
    data = out;
  }
  // scl_slope/inter: apply only when it changes values (floats), else record in meta
  const meta: Record<string, unknown> = { datatype, qformCode, sformCode, sclSlope, sclInter };
  // ijkToRAS: sform > qform > pixdim (NIfTI voxel->RAS; NO LPS flip here)
  let M: number[];
  if (sformCode > 0) M = [...srow.slice(0, 4), ...srow.slice(4, 8), ...srow.slice(8, 12), 0, 0, 0, 1];
  else if (qformCode > 0) {
    const R = quaternToMat(quat[0], quat[1], quat[2], pixdim[0] === 0 ? 1 : pixdim[0], pixdim[1], pixdim[2], pixdim[3]);
    M = [R[0], R[1], R[2], qoff[0], R[3], R[4], R[5], qoff[1], R[6], R[7], R[8], qoff[2], 0, 0, 0, 1];
  } else M = [pixdim[1] || 1, 0, 0, 0, 0, pixdim[2] || 1, 0, 0, 0, 0, pixdim[3] || 1, 0, 0, 0, 0, 1];
  return { dims: [nx, ny, nz], ijkToRAS: M, data, dtype: dt.zarr, name, meta };
}
