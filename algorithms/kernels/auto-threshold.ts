// Automatic threshold calculators (W5) — the ITK ImageThresholdCalculators the Segment Editor's Threshold
// effect offers (Otsu / Huang / Triangle / …), as pure 1-D histogram functions (that's all these ITK classes
// are). Operate on a histogram from algorithms/kernels/histogram.ts, return the threshold VALUE (in scalar
// units). Otsu matches itk::OtsuThresholdCalculator; the others follow the standard algorithms ITK implements.
import { histogram, type Histogram, type Scalars } from "./histogram.ts";

export type ThresholdMethod = "otsu" | "huang" | "triangle" | "moments" | "intermodes" | "isodata";

const binCenter = (h: Histogram, i: number) => h.min + (i + 0.5) * h.binWidth;

/** Otsu — maximize between-class variance. itk::OtsuThresholdCalculator. Returns the bin's upper edge value,
 *  matching ITK's "pixels <= threshold are background" convention (threshold = center of the chosen bin). */
export function otsu(h: Histogram): number {
  const c = h.counts, n = c.length;
  let total = 0, sum = 0;
  for (let i = 0; i < n; i++) { total += c[i]; sum += i * c[i]; }
  if (total === 0) return h.min;
  let sumB = 0, wB = 0, best = -1, bestVar = -1;
  for (let i = 0; i < n; i++) {
    wB += c[i]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += i * c[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = i; }
  }
  return binCenter(h, best < 0 ? 0 : best);
}

/** Triangle method (Zack). itk::TriangleThresholdCalculator. */
export function triangle(h: Histogram): number {
  const c = h.counts, n = c.length;
  let peak = 0; for (let i = 1; i < n; i++) if (c[i] > c[peak]) peak = i;
  // find first/last non-empty bins
  let lo = 0; while (lo < n && c[lo] === 0) lo++;
  let hi = n - 1; while (hi > 0 && c[hi] === 0) hi--;
  // the longer tail from the peak determines the side; build the line peak->end, maximize distance
  const farLeft = peak - lo >= hi - peak;
  const a = farLeft ? lo : hi, b = peak;
  const nx = c[b] - c[a], ny = a - b;                // line normal (in (index,count) space)
  const norm = Math.hypot(nx, ny) || 1;
  let best = a, bestD = -1;
  const step = a < b ? 1 : -1;
  for (let i = a; i !== b; i += step) {
    const d = Math.abs(nx * (i - a) + ny * (c[i] - c[a])) / norm;
    if (d > bestD) { bestD = d; best = i; }
  }
  return binCenter(h, best);
}

/** Huang's fuzzy-membership method. itk::HuangThresholdCalculator (Shannon-entropy variant ITK uses). */
export function huang(h: Histogram): number {
  const c = h.counts, n = c.length;
  let first = 0; while (first < n && c[first] === 0) first++;
  let last = n - 1; while (last > 0 && c[last] === 0) last--;
  if (first >= last) return binCenter(h, first);
  // cumulative sums S (counts) and W (i*counts)
  const S = new Float64Array(last + 1), W = new Float64Array(last + 1);
  S[first] = c[first]; W[first] = first * c[first];
  for (let i = Math.max(1, first + 1); i <= last; i++) { S[i] = S[i - 1] + c[i]; W[i] = W[i - 1] + i * c[i]; }
  // C = range for the fuzzy membership
  const C = last - first;
  let best = first, bestFuzzy = Infinity;
  for (let t = first; t <= last; t++) {
    let muLo = 0, muHi = 0;
    if (S[t] > 0) muLo = W[t] / S[t];
    const sHi = S[last] - S[t];
    if (sHi > 0) muHi = (W[last] - W[t]) / sHi;
    let entropy = 0;
    for (let i = first; i <= last; i++) {
      const mu = 1 / (1 + Math.abs(i - (i <= t ? muLo : muHi)) / C);
      if (mu > 1e-6 && mu < 1 - 1e-6) entropy += c[i] * (-mu * Math.log(mu) - (1 - mu) * Math.log(1 - mu));
    }
    if (entropy < bestFuzzy) { bestFuzzy = entropy; best = t; }
  }
  return binCenter(h, best);
}

/** IsoData (Ridler-Calvard iterative). itk::IsoDataThresholdCalculator (also used by "intermodes"/"moments" fallbacks here). */
export function isodata(h: Histogram): number {
  const c = h.counts, n = c.length;
  let t = 0, total = 0, sum = 0;
  for (let i = 0; i < n; i++) { total += c[i]; sum += i * c[i]; }
  if (total === 0) return h.min;
  t = Math.round(sum / total);
  for (let iter = 0; iter < 1000; iter++) {
    let wB = 0, sB = 0; for (let i = 0; i <= t; i++) { wB += c[i]; sB += i * c[i]; }
    let wF = 0, sF = 0; for (let i = t + 1; i < n; i++) { wF += c[i]; sF += i * c[i]; }
    const mB = wB ? sB / wB : 0, mF = wF ? sF / wF : 0;
    const nt = Math.round((mB + mF) / 2);
    if (nt === t) break; t = nt;
  }
  return binCenter(h, t);
}

/** Compute an auto threshold from data (or a prebuilt histogram). ITK uses 128 bins by default for these. */
export function autoThreshold(method: ThresholdMethod, data: Scalars, bins = 128): number {
  const h = histogram(data, { bins });
  return autoThresholdFromHistogram(method, h);
}
export function autoThresholdFromHistogram(method: ThresholdMethod, h: Histogram): number {
  switch (method) {
    case "otsu": return otsu(h);
    case "triangle": return triangle(h);
    case "huang": return huang(h);
    case "isodata": case "intermodes": case "moments": return isodata(h);
    default: return otsu(h);
  }
}
