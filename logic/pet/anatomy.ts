// Automatic placement of PERCIST's reference regions from the CT.
//
// PERCIST wants "mean SUL and SD in a 3-cm-diameter spherical ROI" in the NORMAL right hepatic
// lobe. Placed by hand that is a judgement call a reader makes in seconds; placed badly it is
// silently catastrophic, because 1.5 x (a sphere full of air) + 2 SD is a measurability gate under
// which every lesion in the study qualifies.
//
// This is deliberately NOT organ segmentation. It answers one much smaller question — where is a
// 3 cm ball of uniform liver parenchyma, as far from any boundary as possible — which is exactly
// what the criteria ask for and what a distance transform answers directly. The deepest interior
// point of the right-lobe parenchyma mask is, by construction, the point furthest from vessels,
// the capsule, the gallbladder fossa and any neighbouring organ.
//
// The anatomical anchor is the LUNG BASE rather than an absolute coordinate: the liver sits
// immediately inferior to the right hemidiaphragm, and the lungs are trivially findable in CT
// (air inside the body). Anchoring to the patient rather than to the scanner means an arbitrary
// scan range or table height does not move the answer.

import { connectedComponents, keepLargestIsland } from "../../algorithms/kernels/ccl.ts";

export type Dims = [number, number, number];
export type Spacing = [number, number, number];

/** HU windows. Non-contrast liver parenchyma runs about 55-65 HU; the window is widened to cover
 *  mild steatosis (which lowers it) and scanner variation, while staying clear of fat (< 0) and
 *  of contrast-enhanced vessels and calcification (> 100). */
export const LIVER_HU: [number, number] = [35, 85];
/** Anything denser than this is tissue rather than air: used to separate the patient from the
 *  scanner's surrounding air. */
export const BODY_HU_MIN = -500;
/** Lung parenchyma is air-filled but inside the body. */
export const LUNG_HU_MAX = -400;

/** Mask of the patient, including air-filled interior structures.
 *
 *  NOT a simple density threshold. Thresholding at > -500 HU would exclude the LUNGS, which are
 *  air-density and therefore the one interior structure this module most needs to find. Instead
 *  the OUTSIDE air is flooded from the volume border and the body is its complement, so any air
 *  the patient encloses — lungs, bowel gas, trachea — stays inside. Keeping the largest island
 *  then drops the table and any detached accessory. */
export function bodyMask(ct: Float32Array, dims: Dims, huMin = BODY_HU_MIN): Uint8Array {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const isAir = (idx: number) => ct[idx] <= huMin;
  const push = (i: number, j: number, k: number) => {
    const idx = (k * ny + j) * nx + i;
    if (outside[idx] || !isAir(idx)) return;
    outside[idx] = 1;
    stack.push(idx);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) { push(0, j, k); push(nx - 1, j, k); }
    for (let i = 0; i < nx; i++) { push(i, 0, k); push(i, ny - 1, k); }
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { push(i, j, 0); push(i, j, nz - 1); }
  while (stack.length) {
    const idx = stack.pop()!;
    const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    if (i > 0) push(i - 1, j, k);
    if (i < nx - 1) push(i + 1, j, k);
    if (j > 0) push(i, j - 1, k);
    if (j < ny - 1) push(i, j + 1, k);
    if (k > 0) push(i, j, k - 1);
    if (k < nz - 1) push(i, j, k + 1);
  }
  const body = new Uint8Array(n);
  for (let idx = 0; idx < n; idx++) body[idx] = outside[idx] ? 0 : 1;
  return keepLargestIsland(body, dims, 6);
}

/** Exact Euclidean distance, in mm, from each masked voxel to the nearest UNMASKED voxel.
 *
 *  Separable Felzenszwalb-Huttenlocher lower-envelope transform, the same algorithm as
 *  render/edt-cpu.ts but for a plain binary mask (no feature transform, no sign). Exact, not a
 *  chamfer approximation: the number is used to decide whether a 15 mm sphere actually fits, and
 *  a chamfer error of a few percent at that size is a sphere poking out of the liver. */
export function distanceInside(mask: ArrayLike<number>, dims: Dims, spacing: Spacing): Float32Array {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const LARGE = 1e18;
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = mask[i] ? LARGE : 0;

  const maxLen = Math.max(nx, ny, nz);
  const line = new Float64Array(maxLen);
  const out = new Float64Array(maxLen);
  const v = new Int32Array(maxLen);
  const z = new Float64Array(maxLen + 1);

  /** 1D squared-distance transform along a strided line. */
  const pass = (len: number, s: number, read: (q: number) => number, write: (q: number, val: number) => void) => {
    for (let q = 0; q < len; q++) line[q] = read(q);
    const s2 = s * s;
    const g = (q: number) => line[q] + q * s * (q * s);
    let k = 0;
    v[0] = 0; z[0] = -LARGE; z[1] = LARGE;
    for (let q = 1; q < len; q++) {
      let sIx: number;
      for (;;) {
        const r = v[k];
        sIx = (g(q) - g(r)) / (2 * s2 * (q - r));
        if (sIx <= z[k]) k--;
        else break;
      }
      k++;
      v[k] = q; z[k] = sIx; z[k + 1] = LARGE;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const w = v[k];
      out[q] = (q - w) * (q - w) * s2 + line[w];
    }
    for (let q = 0; q < len; q++) write(q, out[q]);
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const base = (k * ny + j) * nx;
      pass(nx, spacing[0], (q) => f[base + q], (q, val) => { f[base + q] = val; });
    }
  }
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const base = k * ny * nx + i;
      pass(ny, spacing[1], (q) => f[base + q * nx], (q, val) => { f[base + q * nx] = val; });
    }
  }
  const plane = nx * ny;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const base = j * nx + i;
      pass(nz, spacing[2], (q) => f[base + q * plane], (q, val) => { f[base + q * plane] = val; });
    }
  }

  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.sqrt(f[i]);
  return d;
}

export interface DeepestPoint {
  center: [number, number, number];
  /** Distance from that voxel to the nearest voxel outside the mask, in mm. */
  depthMm: number;
}

/** The masked voxel furthest from any boundary — the centre of the largest inscribed sphere. */
export function deepestPoint(mask: ArrayLike<number>, dims: Dims, spacing: Spacing): DeepestPoint | null {
  const d = distanceInside(mask, dims, spacing);
  const [nx, ny] = dims;
  let best = 0;
  let center: [number, number, number] | null = null;
  for (let i = 0; i < d.length; i++) {
    if (!mask[i] || d[i] <= best) continue;
    best = d[i];
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    center = [x, y, z];
  }
  return center ? { center, depthMm: best } : null;
}

/** INFERIOR extent (in k) of the patient-right lung, which marks the top of the liver.
 *
 *  Which end of the k range that is depends on the volume's direction, so the caller must say:
 *  with +k superior the base is the MINIMUM k, otherwise the maximum. Getting this backwards
 *  silently anchors the search at the lung apex and sends it hunting for liver in the neck. */
export function rightLungBase(
  ct: Float32Array,
  dims: Dims,
  body: Uint8Array,
  rightIsPositiveI: boolean,
  superiorIsPositiveK = true,
): number | null {
  const [nx, ny, nz] = dims;
  // Interior air found PER SLICE, not from the 3D body mask. A whole-body scan cropped at the
  // lung apex has lung air touching the top of the volume, where a 3D flood from the border
  // swallows it as outside air and the lungs vanish. Flooding each slice's border independently
  // still sees them enclosed in-plane, which is the property that actually distinguishes lung
  // from room air.
  const air = new Uint8Array(ct.length);
  const seen = new Uint8Array(nx * ny);
  const stack: number[] = [];
  for (let k = 0; k < nz; k++) {
    const base = k * ny * nx;
    seen.fill(0);
    stack.length = 0;
    const push2 = (i: number, j: number) => {
      const p2 = j * nx + i;
      if (seen[p2] || ct[base + p2] >= LUNG_HU_MAX) return;
      seen[p2] = 1;
      stack.push(p2);
    };
    for (let j = 0; j < ny; j++) { push2(0, j); push2(nx - 1, j); }
    for (let i = 0; i < nx; i++) { push2(i, 0); push2(i, ny - 1); }
    while (stack.length) {
      const p2 = stack.pop()!;
      const i = p2 % nx, j = Math.floor(p2 / nx);
      if (i > 0) push2(i - 1, j);
      if (i < nx - 1) push2(i + 1, j);
      if (j > 0) push2(i, j - 1);
      if (j < ny - 1) push2(i, j + 1);
    }
    for (let p2 = 0; p2 < nx * ny; p2++) {
      air[base + p2] = !seen[p2] && ct[base + p2] < LUNG_HU_MAX ? 1 : 0;
    }
  }
  void body;
  const comps = connectedComponents(air, dims, 6);
  if (comps.count === 0) return null;

  // Lungs are the big air islands inside the body; bowel gas is smaller and more inferior. Take
  // the two largest, then the one whose centroid is on the patient's right.
  const order = comps.sizes.map((s, idx) => [s, idx + 1] as [number, number])
    .sort((a, b) => b[0] - a[0]).slice(0, 2);
  if (order.length === 0) return null;

  let bestLabel = order[0][1];
  let bestI = -Infinity;
  for (const [, label] of order) {
    let sumI = 0, count = 0;
    for (let idx = 0; idx < comps.labels.length; idx++) {
      if (comps.labels[idx] !== label) continue;
      sumI += idx % nx;
      count++;
    }
    if (count === 0) continue;
    const meanI = sumI / count;
    const score = rightIsPositiveI ? meanI : -meanI;
    if (score > bestI) { bestI = score; bestLabel = label; }
  }

  let minK = nz, maxK = -1;
  for (let idx = 0; idx < comps.labels.length; idx++) {
    if (comps.labels[idx] !== bestLabel) continue;
    const k = Math.floor(idx / (nx * ny));
    if (k < minK) minK = k;
    if (k > maxK) maxK = k;
  }
  void ny;
  if (maxK < 0) return null;
  return superiorIsPositiveK ? minK : maxK;
}

export interface LiverSphere {
  /** Voxel centre for the reference sphere. */
  center: [number, number, number];
  /** Radius of the largest sphere that fits at that point, in mm. */
  depthMm: number;
  /** True when a full 15 mm radius fits — i.e. PERCIST's 3 cm sphere is genuinely interior. */
  fits: boolean;
  /** How the search was constrained, for the record. */
  note: string;
}

/** Block-average a volume down to approximately `targetMm` isotropic voxels.
 *
 *  Two problems, one answer. A per-voxel HU window on a noisy CT produces a mask riddled with
 *  single-voxel holes, and a distance transform then measures the distance to the nearest hole —
 *  on a real liver that reads about 4 mm rather than the ~50 mm the organ actually offers.
 *  Averaging first removes the noise that punches those holes. It also drops the work by the cube
 *  of the factor: a 512x512x297 search falls from ~21 s to well under a second. The liver is
 *  ~15 cm across, so 3 mm sampling loses nothing that matters to placing a 3 cm ball inside it. */
export function decimate(
  vol: Float32Array,
  dims: Dims,
  spacing: Spacing,
  targetMm = 3,
): { data: Float32Array; dims: Dims; spacing: Spacing; factor: [number, number, number] } {
  const f: [number, number, number] = [
    Math.max(1, Math.round(targetMm / spacing[0])),
    Math.max(1, Math.round(targetMm / spacing[1])),
    Math.max(1, Math.round(targetMm / spacing[2])),
  ];
  if (f[0] === 1 && f[1] === 1 && f[2] === 1) {
    return { data: vol, dims, spacing, factor: f };
  }
  const [nx, ny, nz] = dims;
  const mx = Math.max(1, Math.floor(nx / f[0]));
  const my = Math.max(1, Math.floor(ny / f[1]));
  const mz = Math.max(1, Math.floor(nz / f[2]));
  const out = new Float32Array(mx * my * mz);
  for (let k = 0; k < mz; k++) {
    for (let j = 0; j < my; j++) {
      for (let i = 0; i < mx; i++) {
        let sum = 0, n = 0;
        for (let dk = 0; dk < f[2]; dk++) {
          const kk = k * f[2] + dk;
          for (let dj = 0; dj < f[1]; dj++) {
            const jj = j * f[1] + dj;
            const row = (kk * ny + jj) * nx + i * f[0];
            for (let di = 0; di < f[0]; di++) { sum += vol[row + di]; n++; }
          }
        }
        out[(k * my + j) * mx + i] = sum / n;
      }
    }
  }
  return {
    data: out,
    dims: [mx, my, mz],
    spacing: [spacing[0] * f[0], spacing[1] * f[1], spacing[2] * f[2]],
    factor: f,
  };
}

export interface LiverSearchOptions {
  /** +i is the patient's right. Derived from ijkToRAS by the caller. */
  rightIsPositiveI: boolean;
  /** +k is superior. */
  superiorIsPositiveK: boolean;
  huRange?: [number, number];
  /** Radius the sphere needs, mm. */
  radiusMm?: number;
  /** How far below the lung base to search, mm. */
  spanMm?: number;
  /** Working resolution, mm. Set to 0 to search the native grid (slow, and noise-sensitive). */
  targetMm?: number;
}

/** Find a PERCIST liver reference location in a CT volume.
 *
 *  Returns the deepest interior point of the right-lobe parenchyma, which is what "normal liver,
 *  away from vessels" means geometrically. `fits` is the honest part: when no 15 mm-deep point
 *  exists the caller must not pretend it placed a 3 cm sphere. */
export function findLiverSphere(
  ctIn: Float32Array,
  dimsIn: Dims,
  spacingIn: Spacing,
  options: LiverSearchOptions,
): LiverSphere | null {
  const targetMm = options.targetMm ?? 3;
  const dec = targetMm > 0
    ? decimate(ctIn, dimsIn, spacingIn, targetMm)
    : { data: ctIn, dims: dimsIn, spacing: spacingIn, factor: [1, 1, 1] as [number, number, number] };
  const ct = dec.data, dims = dec.dims, spacing = dec.spacing;
  const [nx, ny, nz] = dims;
  const radiusMm = options.radiusMm ?? 15;
  const spanMm = options.spanMm ?? 200;
  const [huLo, huHi] = options.huRange ?? LIVER_HU;

  const body = bodyMask(ct, dims);
  const lungBase = rightLungBase(ct, dims, body, options.rightIsPositiveI, options.superiorIsPositiveK);

  // Axial window: from the lung base, extend INFERIORLY. Without a lung (a scan that starts below
  // the diaphragm) fall back to the whole volume and say so.
  let kLo = 0, kHi = nz - 1;
  let note = "whole volume (no lung found to anchor on)";
  if (lungBase !== null) {
    const spanK = Math.max(1, Math.round(spanMm / spacing[2]));
    if (options.superiorIsPositiveK) { kHi = lungBase; kLo = Math.max(0, lungBase - spanK); }
    else { kLo = lungBase; kHi = Math.min(nz - 1, lungBase + spanK); }
    note = `right lung base at k=${lungBase}, searching ${spanMm} mm inferior`;
  }

  // Parenchyma on the patient's right, inside the body, inside the axial window.
  const midI = nx / 2;
  const cand = new Uint8Array(ct.length);
  for (let k = kLo; k <= kHi; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const idx = row + i;
        if (!body[idx]) continue;
        const onRight = options.rightIsPositiveI ? i > midI : i < midI;
        if (!onRight) continue;
        const v = ct[idx];
        cand[idx] = v >= huLo && v <= huHi ? 1 : 0;
      }
    }
  }

  // The largest such island in that window is the liver: the spleen is on the other side, the
  // kidneys are smaller and more posterior, and muscle is thin.
  const liver = keepLargestIsland(cand, dims, 6);
  const deep = deepestPoint(liver, dims, spacing);
  if (!deep) return null;
  // Map back to the caller's grid: the block average centred each coarse voxel on its block.
  const f = dec.factor;
  const center: [number, number, number] = [
    Math.min(dimsIn[0] - 1, Math.round(deep.center[0] * f[0] + (f[0] - 1) / 2)),
    Math.min(dimsIn[1] - 1, Math.round(deep.center[1] * f[1] + (f[1] - 1) / 2)),
    Math.min(dimsIn[2] - 1, Math.round(deep.center[2] * f[2] + (f[2] - 1) / 2)),
  ];
  return {
    center,
    depthMm: deep.depthMm,
    fits: deep.depthMm >= radiusMm,
    note: f[0] * f[1] * f[2] > 1 ? `${note}, at ${spacing[0].toFixed(1)} mm working resolution` : note,
  };
}
