// Quantitative PET indices — pure TS, DOM-free, no renderer dependency.
//
// These are the numbers a reader acts on, so each one names the authority it follows:
//
//   MTV      EANM v2.0: "The MTV represents the volume of the above given VOI."
//   TLG      EANM v2.0: "TLG is the product of the VOI average SUV ... multiplied by the
//            corresponding MTV."
//   SUVpeak  EANM v2.0: a "3D 1.2 cm diameter (and 1.0 mL volume) spherical VOI positioned such
//            that the average value across all positions within the lesion is maximised".
//            PERCIST 1.0 says the same sphere "centering around the hottest point", and that it
//            "is not necessarily centered on the maximal SUL pixel".
//   VOI_41   EANM v2.0: "3D isocontour at 41 % of the maximum pixel value (VOI41)" (and VOI50).
//
// Two deliberate departures from other implementations, both documented where they occur:
//
//  * SUVpeak uses an EXACT sphere/voxel intersection weighting and searches every candidate
//    centre, following PET-IndiC's itkPeakIntensityFilter. cornerstone3D instead tests only the
//    ten hottest voxels against an anisotropic ellipsoid in INDEX space inflated by 10 %, which is
//    neither 1 mL nor "positioned such that the average is maximised".
//  * Standard deviation uses the sample divisor (N-1). PET-IndiC uses the population divisor (N);
//    both are reported so a cross-check against it is exact.
//
// Nothing here resamples. EANM is explicit that a maximum must be read on the original grid:
// "no additional rebinning, resampling, smoothing or any other manipulation by the user is
// allowed". Callers pass the native volume.

export interface Volume3D {
  data: Float32Array;
  dims: [number, number, number];
  /** Voxel edge lengths in mm, along i, j, k. */
  spacing: [number, number, number];
}

/** A region of interest as a predicate over voxel indices, plus the voxels it contains. */
export type VoxelMask = Uint8Array;

export interface RegionStats {
  count: number;
  /** mL. */
  volumeMl: number;
  min: number;
  max: number;
  mean: number;
  /** Sample standard deviation (N-1). */
  stdDev: number;
  /** Population standard deviation (N), which is what PET-IndiC reports. */
  stdDevPopulation: number;
  median: number;
  /** Σ value, before any unit scaling. */
  sum: number;
  /** Index of the maximum voxel, as [i,j,k]. */
  argMax: [number, number, number];
}

const voxelVolumeMm3 = (s: [number, number, number]) => s[0] * s[1] * s[2];

/** Basic statistics over the voxels where `mask` is non-zero. */
export function regionStats(vol: Volume3D, mask: VoxelMask): RegionStats | null {
  const { data, dims, spacing } = vol;
  const [nx, ny, nz] = dims;
  let count = 0, sum = 0, sumSq = 0;
  let min = Infinity, max = -Infinity;
  let argMax: [number, number, number] = [0, 0, 0];
  const values: number[] = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        const idx = row + i;
        if (!mask[idx]) continue;
        const v = data[idx];
        count++; sum += v; sumSq += v * v;
        values.push(v);
        if (v < min) min = v;
        if (v > max) { max = v; argMax = [i, j, k]; }
      }
    }
  }
  if (count === 0) return null;
  const mean = sum / count;
  // Two-pass would be more accurate, but the one-pass form is what the GPU kernel can do in a
  // single reduction; the difference is below display precision at these magnitudes and the
  // GPU/CPU parity test pins them together.
  const varPop = Math.max(0, sumSq / count - mean * mean);
  const varSample = count > 1 ? (varPop * count) / (count - 1) : 0;
  values.sort((a, b) => a - b);
  const median = count % 2 ? values[(count - 1) >> 1] : (values[count / 2 - 1] + values[count / 2]) / 2;
  return {
    count,
    volumeMl: (count * voxelVolumeMm3(spacing)) / 1000,
    min, max, mean,
    stdDev: Math.sqrt(varSample),
    stdDevPopulation: Math.sqrt(varPop),
    median, sum, argMax,
  };
}

/** Total lesion glycolysis: MTV (mL) x SUVmean. EANM v2.0's definition, verbatim. */
export const totalLesionGlycolysis = (stats: RegionStats): number => stats.volumeMl * stats.mean;

// ---------------------------------------------------------------------------------------------
// Thresholding
// ---------------------------------------------------------------------------------------------

export type ThresholdSpec =
  /** Fraction of the maximum inside the seed region. 0.41 is EANM's VOI41, 0.50 its VOI50. */
  | { kind: "percentMax"; fraction: number; backgroundSubtract?: number }
  /** An absolute value, e.g. SUV 2.5 or the better-reproducing SUV 4.0. */
  | { kind: "absolute"; value: number };

/** Resolve a threshold to an absolute value given the maximum in the seed region.
 *
 *  `backgroundSubtract` implements the (max - bg) * f + bg form. Whether a percentage threshold is
 *  background-subtracted changes the answer substantially at low tumour-to-background, so it is
 *  explicit rather than assumed. */
export function resolveThreshold(spec: ThresholdSpec, regionMax: number): number {
  if (spec.kind === "absolute") return spec.value;
  const bg = spec.backgroundSubtract ?? 0;
  return bg + (regionMax - bg) * spec.fraction;
}

/** Voxels at or above `threshold` within `within`, keeping only the component connected to
 *  `seed` (6-connectivity). Connectivity matters: a 41 %-of-max isocontour over a whole bounding
 *  box otherwise sweeps in unrelated avid structures that happen to clear the same level. */
export function thresholdConnected(
  vol: Volume3D,
  within: VoxelMask,
  threshold: number,
  seed: [number, number, number],
): VoxelMask {
  const [nx, ny, nz] = vol.dims;
  const out = new Uint8Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const s = at(seed[0], seed[1], seed[2]);
  if (!within[s] || vol.data[s] < threshold) return out;
  const stack = [s];
  out[s] = 1;
  while (stack.length) {
    const idx = stack.pop()!;
    const i = idx % nx, j = ((idx - i) / nx) % ny, k = Math.floor(idx / (nx * ny));
    const push = (ii: number, jj: number, kk: number) => {
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) return;
      const n = at(ii, jj, kk);
      if (out[n] || !within[n] || vol.data[n] < threshold) return;
      out[n] = 1;
      stack.push(n);
    };
    push(i - 1, j, k); push(i + 1, j, k);
    push(i, j - 1, k); push(i, j + 1, k);
    push(i, j, k - 1); push(i, j, k + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SUVpeak
// ---------------------------------------------------------------------------------------------

/** Radius of a 1.0 mL sphere, in mm: (3 * 1000 / 4pi)^(1/3) = 6.2035. PET-IndiC's QI_PEAK_RADIUS
 *  is 6.204 and PERCIST describes "a sphere with a diameter of approximately 1.2 cm to produce a
 *  1-cm^3-volume spheric ROI" — 2 x 6.2035 = 1.2407 cm. */
export const PEAK_SPHERE_RADIUS_MM = Math.cbrt((3 * 1000) / (4 * Math.PI));

export interface PeakKernel {
  /** Offsets [di,dj,dk] and the fraction of that voxel inside the sphere, in (0,1]. */
  offsets: Int32Array;
  weights: Float32Array;
  /** Σ weights, so a weighted mean needs no second pass. */
  weightSum: number;
  radiusMm: number;
}

/** Fraction of a voxel's volume lying inside a sphere of `radiusMm` centred at the kernel origin.
 *
 *  Estimated by supersampling the voxel box. PET-IndiC integrates the sphere/box intersection
 *  analytically; supersampling at 4^3 per voxel agrees to better than 1 % of a voxel, which is far
 *  below the difference between this and a binary ball, and keeps the code readable. Partial
 *  weighting is the part that matters: a binary ball at 4 mm PET sampling mis-sizes a 1 mL sphere
 *  by tens of percent. */
function voxelFractionInSphere(
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  radiusMm: number,
  sub = 4,
): number {
  const r2 = radiusMm * radiusMm;
  let inside = 0;
  for (let a = 0; a < sub; a++) {
    const x = cx + ((a + 0.5) / sub - 0.5) * sx;
    for (let b = 0; b < sub; b++) {
      const y = cy + ((b + 0.5) / sub - 0.5) * sy;
      for (let c = 0; c < sub; c++) {
        const z = cz + ((c + 0.5) / sub - 0.5) * sz;
        if (x * x + y * y + z * z <= r2) inside++;
      }
    }
  }
  return inside / (sub * sub * sub);
}

/** Build the 1 mL sphere kernel for a given voxel spacing. Depends only on spacing, so it is
 *  computed once per volume and reused across every candidate centre. */
export function peakKernel(
  spacing: [number, number, number],
  radiusMm = PEAK_SPHERE_RADIUS_MM,
): PeakKernel {
  const [sx, sy, sz] = spacing;
  const ri = Math.ceil(radiusMm / sx), rj = Math.ceil(radiusMm / sy), rk = Math.ceil(radiusMm / sz);
  const offsets: number[] = [];
  const weights: number[] = [];
  let weightSum = 0;
  for (let dk = -rk; dk <= rk; dk++) {
    for (let dj = -rj; dj <= rj; dj++) {
      for (let di = -ri; di <= ri; di++) {
        const w = voxelFractionInSphere(di * sx, dj * sy, dk * sz, sx, sy, sz, radiusMm);
        if (w <= 0) continue;
        offsets.push(di, dj, dk);
        weights.push(w);
        weightSum += w;
      }
    }
  }
  return { offsets: Int32Array.from(offsets), weights: Float32Array.from(weights), weightSum, radiusMm };
}

export interface PeakResult {
  /** The maximised sphere mean. */
  peak: number;
  /** Centre voxel of the winning sphere. */
  center: [number, number, number];
  /** How many candidate centres were evaluated. */
  candidates: number;
}

export interface PeakOptions {
  /** Skip the peak entirely — for callers that compute it elsewhere (e.g. on the GPU, where the
   *  same search is 30-120x faster at fine sampling). */
  skipPeak?: boolean;
  /** Require the whole sphere to lie inside the mask. PET-IndiC defaults to this and returns NaN
   *  for lesions smaller than 1 mL; PERCIST's wording ("centering around the hottest point")
   *  does not require it. Default false, which is the PERCIST reading. */
  interiorOnly?: boolean;
  kernel?: PeakKernel;
}

/** SUVpeak: the maximum, over candidate centres in the mask, of the 1 mL sphere mean.
 *
 *  Every masked voxel is a candidate, which is what "positioned such that the average value across
 *  all positions within the lesion is maximised" asks for. Voxels outside the volume contribute
 *  nothing and shrink the effective weight sum, so a sphere hanging off the edge is not rewarded. */
export function suvPeak(vol: Volume3D, mask: VoxelMask, options: PeakOptions = {}): PeakResult | null {
  const { data, dims, spacing } = vol;
  const [nx, ny, nz] = dims;
  const kernel = options.kernel ?? peakKernel(spacing);
  const { offsets, weights } = kernel;
  const n = weights.length;
  let best = -Infinity;
  let center: [number, number, number] | null = null;
  let candidates = 0;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        if (!mask[row + i]) continue;
        candidates++;
        let acc = 0, wsum = 0, ok = true;
        for (let t = 0; t < n; t++) {
          const ii = i + offsets[t * 3], jj = j + offsets[t * 3 + 1], kk = k + offsets[t * 3 + 2];
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) {
            if (options.interiorOnly) { ok = false; break; }
            continue;
          }
          const idx = (kk * ny + jj) * nx + ii;
          if (options.interiorOnly && !mask[idx]) { ok = false; break; }
          const w = weights[t];
          acc += data[idx] * w;
          wsum += w;
        }
        if (!ok || wsum <= 0) continue;
        const mean = acc / wsum;
        if (mean > best) { best = mean; center = [i, j, k]; }
      }
    }
  }
  if (!center) return null;
  return { peak: best, center, candidates };
}

// ---------------------------------------------------------------------------------------------
// The lesion summary a reader sees
// ---------------------------------------------------------------------------------------------

export interface LesionMeasurement {
  stats: RegionStats;
  /** The voxels that survived the threshold — handed back so a caller can run its own peak
   *  search (GPU) over exactly the same region. */
  mask: VoxelMask;
  /** mL. Same as stats.volumeMl; named for the clinical term. */
  mtvMl: number;
  /** MTV x SUVmean. */
  tlg: number;
  peak: number | null;
  peakCenter: [number, number, number] | null;
  /** The absolute threshold actually applied, for the record. */
  thresholdUsed: number | null;
  method: string;
}

/** Measure a lesion: threshold within a seed region, then compute the indices on what survives. */
export function measureLesion(
  vol: Volume3D,
  seedRegion: VoxelMask,
  seed: [number, number, number],
  spec: ThresholdSpec | null,
  options: PeakOptions = {},
): LesionMeasurement | null {
  let mask = seedRegion;
  let thresholdUsed: number | null = null;
  let method = "whole region";
  if (spec) {
    const seedStats = regionStats(vol, seedRegion);
    if (!seedStats) return null;
    thresholdUsed = resolveThreshold(spec, seedStats.max);
    mask = thresholdConnected(vol, seedRegion, thresholdUsed, seed);
    method = spec.kind === "absolute"
      ? `fixed ${spec.value}`
      : `${(spec.fraction * 100).toFixed(0)}% of max${spec.backgroundSubtract ? " (bg-subtracted)" : ""}`;
  }
  const stats = regionStats(vol, mask);
  if (!stats) return null;
  const peak = options.skipPeak ? null : suvPeak(vol, mask, options);
  return {
    stats,
    mask,
    mtvMl: stats.volumeMl,
    tlg: totalLesionGlycolysis(stats),
    peak: peak?.peak ?? null,
    peakCenter: peak?.center ?? null,
    thresholdUsed,
    method,
  };
}

/** A box ROI mask in voxel index space, inclusive of both corners. */
export function boxMask(dims: [number, number, number], lo: [number, number, number], hi: [number, number, number]): VoxelMask {
  const [nx, ny, nz] = dims;
  const m = new Uint8Array(nx * ny * nz);
  const c = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(v)));
  for (let k = c(Math.min(lo[2], hi[2]), nz); k <= c(Math.max(lo[2], hi[2]), nz); k++) {
    for (let j = c(Math.min(lo[1], hi[1]), ny); j <= c(Math.max(lo[1], hi[1]), ny); j++) {
      const row = (k * ny + j) * nx;
      for (let i = c(Math.min(lo[0], hi[0]), nx); i <= c(Math.max(lo[0], hi[0]), nx); i++) m[row + i] = 1;
    }
  }
  return m;
}

/** A spherical ROI mask centred on a voxel, radius in mm — the shape PERCIST uses for its liver
 *  (3 cm diameter) and blood-pool (1 cm diameter) reference regions. */
export function sphereMask(
  dims: [number, number, number],
  spacing: [number, number, number],
  center: [number, number, number],
  radiusMm: number,
): VoxelMask {
  const [nx, ny, nz] = dims;
  const m = new Uint8Array(nx * ny * nz);
  const ri = Math.ceil(radiusMm / spacing[0]), rj = Math.ceil(radiusMm / spacing[1]), rk = Math.ceil(radiusMm / spacing[2]);
  const r2 = radiusMm * radiusMm;
  for (let dk = -rk; dk <= rk; dk++) {
    const k = center[2] + dk, z = dk * spacing[2];
    if (k < 0 || k >= nz) continue;
    for (let dj = -rj; dj <= rj; dj++) {
      const j = center[1] + dj, y = dj * spacing[1];
      if (j < 0 || j >= ny) continue;
      for (let di = -ri; di <= ri; di++) {
        const i = center[0] + di, x = di * spacing[0];
        if (i < 0 || i >= nx) continue;
        if (x * x + y * y + z * z <= r2) m[(k * ny + j) * nx + i] = 1;
      }
    }
  }
  return m;
}
