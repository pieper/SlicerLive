export interface BinningResult {
  bins: Uint32Array;
  range: [number, number];
  total: number;
  maxBin: number;
}

export type ScalarArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array;

export function computeBins(
  data: ScalarArray,
  opts: { min?: number; max?: number; bins?: number } = {},
): BinningResult {
  const binCount = Math.max(1, Math.floor(opts.bins ?? 256));
  let min = opts.min;
  let max = opts.max;
  if (min === undefined || max === undefined) {
    let mn = +Infinity;
    let mx = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (min === undefined) min = mn;
    if (max === undefined) max = mx;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0; max = 1;
  }
  if (max <= min) max = min + 1;

  const bins = new Uint32Array(binCount);
  const inv = binCount / (max - min);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let b = Math.floor((v - min) * inv);
    if (b < 0) b = 0;
    else if (b >= binCount) b = binCount - 1;
    bins[b]++;
  }
  let maxBin = 0;
  for (let i = 0; i < binCount; i++) {
    const c = bins[i];
    if (c > maxBin) maxBin = c;
  }
  return { bins, range: [min, max], total: data.length, maxBin };
}
