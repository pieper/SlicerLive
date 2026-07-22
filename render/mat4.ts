// Minimal column-major 4x4 matrix math (WebGPU/WGSL convention). Zero deps.
// Matrices are Float32Array(16) in COLUMN-MAJOR order, matching WGSL mat4x4<f32>.

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// a * b  (both column-major); result column-major.
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

// Right-handed perspective, WebGPU clip space (depth 0..1). fovy in radians.
export function perspectiveZO(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  m[10] = far / (near - far);
  m[14] = (far * near) / (near - far);
  return m;
}

// Right-handed lookAt (camera looks from eye toward center, up ~ +y).
export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;      // forward (+z away)
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  let xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;      // right
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx; // up
  const m = new Float32Array(16);
  m[0] = xx; m[4] = xy; m[8] = xz; m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[1] = yx; m[5] = yy; m[9] = yz; m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[2] = zx; m[6] = zy; m[10] = zz; m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

// General 4x4 inverse (column-major in/out). Returns identity if singular.
export function invert(a: Mat4): Mat4 {
  const m = a;
  const b00 = m[0] * m[5] - m[1] * m[4], b01 = m[0] * m[6] - m[2] * m[4];
  const b02 = m[0] * m[7] - m[3] * m[4], b03 = m[1] * m[6] - m[2] * m[5];
  const b04 = m[1] * m[7] - m[3] * m[5], b05 = m[2] * m[7] - m[3] * m[6];
  const b06 = m[8] * m[13] - m[9] * m[12], b07 = m[8] * m[14] - m[10] * m[12];
  const b08 = m[8] * m[15] - m[11] * m[12], b09 = m[9] * m[14] - m[10] * m[13];
  const b10 = m[9] * m[15] - m[11] * m[13], b11 = m[10] * m[15] - m[11] * m[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity();
  det = 1 / det;
  const o = new Float32Array(16);
  o[0] = (m[5] * b11 - m[6] * b10 + m[7] * b09) * det;
  o[1] = (m[2] * b10 - m[1] * b11 - m[3] * b09) * det;
  o[2] = (m[13] * b05 - m[14] * b04 + m[15] * b03) * det;
  o[3] = (m[10] * b04 - m[9] * b05 - m[11] * b03) * det;
  o[4] = (m[6] * b08 - m[4] * b11 - m[7] * b07) * det;
  o[5] = (m[0] * b11 - m[2] * b08 + m[3] * b07) * det;
  o[6] = (m[14] * b02 - m[12] * b05 - m[15] * b01) * det;
  o[7] = (m[8] * b05 - m[10] * b02 + m[11] * b01) * det;
  o[8] = (m[4] * b10 - m[5] * b08 + m[7] * b06) * det;
  o[9] = (m[1] * b08 - m[0] * b10 - m[3] * b06) * det;
  o[10] = (m[12] * b04 - m[13] * b02 + m[15] * b00) * det;
  o[11] = (m[9] * b02 - m[8] * b04 - m[11] * b00) * det;
  o[12] = (m[5] * b07 - m[4] * b09 - m[6] * b06) * det;
  o[13] = (m[0] * b09 - m[1] * b07 + m[2] * b06) * det;
  o[14] = (m[13] * b01 - m[12] * b03 - m[14] * b00) * det;
  o[15] = (m[8] * b03 - m[9] * b01 + m[10] * b00) * det;
  return o;
}

// Build a RAS(patient) -> texture[0,1] matrix for an axis-aligned volume whose
// world box is [center - ext, center + ext], ext = dims*spacing/2. tex(world) =
// world*scale + (0.5 - center*scale), scale = 1/(dims*spacing). center=0 -> the
// origin-centered case (translate 0.5), matching single_volume's voxel-center map.
export function patientToTexture(dims: Vec3, spacing: Vec3, center: Vec3 = [0, 0, 0]): Mat4 {
  const m = new Float32Array(16); // column-major
  for (let a = 0; a < 3; a++) {
    const s = 1 / (spacing[a] * dims[a]);
    m[a * 4 + a] = s;                    // diagonal (col a, row a)
    m[12 + a] = 0.5 - center[a] * s;     // translation (col 3, row a)
  }
  m[15] = 1;
  return m;
}

/** World-space AABB [min,max] of an axis-aligned volume box centered at `center`. */
export function volumeAABB(dims: Vec3, spacing: Vec3, center: Vec3 = [0, 0, 0]): [Vec3, Vec3] {
  const ext: Vec3 = [dims[0] * spacing[0] / 2, dims[1] * spacing[1] / 2, dims[2] * spacing[2] / 2];
  return [[center[0] - ext[0], center[1] - ext[1], center[2] - ext[2]],
          [center[0] + ext[0], center[1] + ext[1], center[2] + ext[2]]];
}

/** Transpose a row-major flat 4x4 into a column-major Mat4 (and vice-versa). */
export function transpose4(m: ArrayLike<number>): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}

// --- Real (rotated / anisotropic) volume geometry from a Slicer ijkToRAS -------
// ijkToRAS is the row-major 4x4 that maps a voxel-center index (i,j,k,1) -> RAS,
// exactly as stored in the scene json. dims = [nx,ny,nz] (i,j,k extents).
//
// Texture coords are [0,1]^3 with voxel center i at u=(i+0.5)/nx, so
// (i,j,k) = diag(nx,ny,nz)*(u,v,w) - 0.5. texToRAS = ijkToRAS * A with
// A the homogeneous (u,v,w,1)->(i,j,k,1) map; patientToTexture = inverse(texToRAS).

/** Column-major RAS(patient) -> texture[0,1] matrix for a volume with the given ijkToRAS. */
export function patientToTextureFromIjkToRAS(ijkToRAS: ArrayLike<number>, dims: Vec3): Mat4 {
  return invert(texToRASFromIjkToRAS(ijkToRAS, dims));
}

/** Column-major texture[0,1] -> RAS matrix (the inverse of patientToTexture). */
export function texToRASFromIjkToRAS(ijkToRAS: ArrayLike<number>, dims: Vec3): Mat4 {
  const M = transpose4(ijkToRAS);                 // -> column-major
  const A = new Float32Array(16);                 // (u,v,w,1) -> (i,j,k,1), column-major
  for (let a = 0; a < 3; a++) { A[a * 4 + a] = dims[a]; A[12 + a] = -0.5; }
  A[15] = 1;
  return multiply(M, A);
}

/** World-space AABB [min,max] enclosing the sampled box (tex in [0,1]^3) of an ijkToRAS volume. */
export function volumeAABBFromIjkToRAS(ijkToRAS: ArrayLike<number>, dims: Vec3): [Vec3, Vec3] {
  const t2r = texToRASFromIjkToRAS(ijkToRAS, dims);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const u = c & 1, v = (c >> 1) & 1, w = (c >> 2) & 1;
    for (let r = 0; r < 3; r++) {
      const p = t2r[r] * u + t2r[4 + r] * v + t2r[8 + r] * w + t2r[12 + r];
      if (p < lo[r]) lo[r] = p;
      if (p > hi[r]) hi[r] = p;
    }
  }
  return [lo, hi];
}

/** Apply a row-major 4x4 (e.g. ijkToRAS) to a point. */
export function applyRowMajor(m: ArrayLike<number>, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** Effective voxel spacing (mm) from ijkToRAS column norms (i,j,k axis lengths). */
export function spacingFromIjkToRAS(ijkToRAS: ArrayLike<number>): Vec3 {
  const col = (c: number): number => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}
