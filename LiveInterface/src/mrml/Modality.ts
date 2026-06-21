/**
 * Heuristic guess of an imaging modality from a value histogram.
 * Used when the DICOM Modality tag isn't available (or when we want to
 * cross-check it).
 *
 * Returns a confidence in [0, 1] alongside a guess. Callers should treat
 * `unknown` and `confidence < 0.3` as "ask the user".
 */

export type Modality = 'CT' | 'MR' | 'PT' | 'unknown';

export interface ModalityGuess {
  modality: Modality;
  units: 'HU' | 'intensity' | 'SUV' | 'arb';
  confidence: number;
  reason: string;
}

export function guessModality(
  bins: Uint32Array,
  range: readonly [number, number],
): ModalityGuess {
  const [min, max] = range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { modality: 'unknown', units: 'arb', confidence: 0, reason: 'invalid range' };
  }

  const span = max - min;
  const N = bins.length;
  const idx = (v: number) => {
    const i = Math.floor(((v - min) / span) * N);
    return Math.max(0, Math.min(N - 1, i));
  };
  let total = 0;
  for (let i = 0; i < N; i++) total += bins[i];

  // Distinctive air peak around -1000 HU (CT) — count bins inside the
  // air window relative to the total. CT scans typically have 30–60%
  // air voxels in a full-FOV box. idx() clamps so a partly out-of-range
  // window still works as long as it overlaps [min, max] at all.
  const lo = idx(-1100);
  const hi = idx(-900);
  let airCount = 0;
  if (-1100 <= max && -900 >= min && hi >= lo) {
    for (let i = lo; i <= hi; i++) airCount += bins[i];
  }
  const airFrac = total > 0 ? airCount / total : 0;

  // ---- CT — wide HU window, characteristic air peak.
  if (min < -500 && max > 800) {
    if (airFrac > 0.05) {
      return {
        modality: 'CT', units: 'HU',
        confidence: Math.min(0.95, 0.70 + airFrac),
        reason: `range [${min.toFixed(0)}, ${max.toFixed(0)}] looks like HU; ` +
          `${(airFrac * 100).toFixed(0)}% of voxels in the air window`,
      };
    }
    // Wide window but no air peak — still likely CT (e.g. cropped to body).
    return {
      modality: 'CT', units: 'HU', confidence: 0.6,
      reason: `wide negative→positive HU range, no air peak (likely cropped)`,
    };
  }

  // ---- PET (typical SUV) — non-negative, narrow peak under ~20.
  if (min >= -0.5 && max < 40) {
    return {
      modality: 'PT', units: 'SUV', confidence: 0.55,
      reason: `non-negative, max=${max.toFixed(1)} ≈ SUV range`,
    };
  }

  // ---- MR — broadly non-negative intensity, no characteristic HU window.
  // MR signal is arbitrary; allow modest negatives from gradient artifacts
  // / background noise. Reject obvious CT (min < -500) which we'd have
  // caught above.
  if (min >= -200 && max <= 65535 && max > 50) {
    return {
      modality: 'MR', units: 'intensity', confidence: 0.55,
      reason: `intensity range [${min.toFixed(0)}, ${max.toFixed(0)}] — typical MR`,
    };
  }

  return {
    modality: 'unknown', units: 'arb', confidence: 0,
    reason: `range [${min.toFixed(2)}, ${max.toFixed(2)}] didn't match CT/MR/PT heuristics`,
  };
}
