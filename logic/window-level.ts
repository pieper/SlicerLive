// Window/level math ported from Slicer (pure TS). Two Slicer references:
//   autoWindowLevel  — vtkMRMLScalarVolumeDisplayNode::CalculateAutoLevels: vtkImageHistogramStatistics with
//                       SetAutoRangePercentiles(0.1, 99.9), SetAutoRangeExpansionFactors(0,0) -> the [lo,hi]
//                       range, then window = hi-lo, level = (hi+lo)/2.
//   adjustWindowLevel — vtkMRMLWindowLevelWidget::ProcessAdjustWindowLevel: gain = (rangeHi-rangeLo)/min(vw,vh),
//                       window += gain*dx (>=0), level += gain*dy (clamped to [rangeLo-w/2, rangeHi+w/2]).
export type Scalars = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

const isIntType = (a: Scalars) => !(a instanceof Float32Array || a instanceof Float64Array);

/** Cumulative-histogram percentiles matching vtkImageHistogramStatistics: unit bins for integer scalars,
 *  1000 bins for float. Returns [valueAtLoP, valueAtHiP]. Subsamples very large volumes (parity holds). */
export function histogramPercentiles(data: Scalars, loP = 0.001, hiP = 0.999): [number, number] {
  const n = data.length;
  if (n === 0) return [0, 1];
  const step = n > 4_000_000 ? Math.floor(n / 4_000_000) : 1;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i += step) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx <= mn) return [mn, mn];
  const intType = isIntType(data);
  const bins = intType ? Math.min(mx - mn + 1, 1 << 16) : 1000;
  const scale = (bins - 1) / (mx - mn);
  const hist = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < n; i += step) { hist[Math.round((data[i] - mn) * scale)]++; total++; }
  const binValue = (b: number) => mn + b / scale;
  const at = (frac: number): number => {
    const target = frac * total; let c = 0;
    for (let b = 0; b < bins; b++) { c += hist[b]; if (c >= target) return binValue(b); }
    return mx;
  };
  return [at(loP), at(hiP)];
}

export interface WindowLevel { window: number; level: number }

/** Slicer's auto window/level for a scalar volume (percentiles 0.1/99.9). */
export function autoWindowLevel(data: Scalars): WindowLevel {
  const [lo, hi] = histogramPercentiles(data, 0.001, 0.999);
  return { window: Math.max(1e-6, hi - lo), level: (lo + hi) / 2 };
}

/** vtkMRMLWindowLevelWidget::ProcessAdjustWindowLevel — mouse delta -> new W/L. `range` is the volume's
 *  full scalar range; `viewW/viewH` the slice widget pixel size. */
export function adjustWindowLevel(last: WindowLevel, dx: number, dy: number, range: [number, number], viewW: number, viewH: number): WindowLevel {
  const gain = (range[1] - range[0]) / Math.max(1, Math.min(viewW, viewH));
  const window = Math.max(0, last.window + gain * dx);
  const level = Math.max(range[0] - window / 2, Math.min(range[1] + window / 2, last.level + gain * dy));
  return { window, level };
}

export const wlMinMax = (wl: WindowLevel): [number, number] => [wl.level - wl.window / 2, wl.level + wl.window / 2];
export const minMaxToWl = (lo: number, hi: number): WindowLevel => ({ window: hi - lo, level: (lo + hi) / 2 });

export interface WlPreset { name: string; window: number; level: number }
/** CT window/level presets (HU) — the set the BIR reader ships, plus common additions. */
export const CT_WL_PRESETS: WlPreset[] = [
  { name: "CT Soft Tissue", window: 400, level: 40 },
  { name: "CT Lung", window: 1500, level: -600 },
  { name: "CT Bone", window: 1800, level: 400 },
  { name: "CT Brain", window: 80, level: 40 },
  { name: "CT Abdomen", window: 350, level: 50 },
  { name: "CT Angio", window: 600, level: 300 },
  { name: "CT Mediastinum", window: 350, level: 40 },
  { name: "PET", window: 10000, level: 5000 },
];
