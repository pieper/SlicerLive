// Response-assessment criteria: PERCIST measurability and response, Deauville reference levels,
// and the QIBA repeatability floor. Pure TS, DOM-free.
//
// Every threshold here is quoted from its source, because these numbers decide whether a patient
// is called a responder:
//
//   PERCIST 1.0 — Wahl et al., J Nucl Med 2009;50(Suppl 1):122S-150S
//   Lugano/Deauville — Cheson, Chin Clin Oncol 2015;4(1):5
//   QIBA FDG-PET/CT Profile (repeatability)
//
// One rule is enforced rather than merely documented: **Deauville is a visual scale**. This module
// will report the reference levels and a SUGGESTED band, and labels it as an aid. It does not
// return "the score". Cheson's own wording carves out cases a number cannot see — Waldeyer's ring,
// marrow activation after G-CSF, and anything where "uptake may be greater than normal mediastinum
// and/or liver" without being disease.

/** Statistics of a reference region (liver or blood pool), in SUV units. */
export interface ReferenceRegion {
  mean: number;
  /** Sample standard deviation over the region's voxels. */
  stdDev: number;
  /** mL — reported so a reader can see the ROI really was the size the criteria assume. */
  volumeMl: number;
}

/** PERCIST's normal-liver ROI: "mean SUL and SD in a 3-cm-diameter spherical ROI" in the right
 *  hepatic lobe. 3 cm diameter = 15 mm radius = 14.14 mL. */
export const PERCIST_LIVER_DIAMETER_MM = 30;
/** PERCIST's blood-pool fallback: "1-cm-diameter ROI in descending thoracic aorta extended over
 *  2 cm in length" — a cylinder, approximated here by the sphere of the same diameter unless the
 *  caller builds the cylinder itself. */
export const PERCIST_BLOODPOOL_DIAMETER_MM = 10;

export interface MeasurabilityGate {
  /** A lesion is measurable when its SULpeak is at or above this. */
  threshold: number;
  /** Which reference produced it. */
  basis: "liver" | "bloodPool";
  explanation: string;
  /** False when the reference that produced this gate is not a plausible normal region, in which
   *  case the threshold is arithmetic rather than meaning. */
  trustworthy: boolean;
  plausibilityNote: string;
}

/** PERCIST measurability.
 *
 *  Verbatim: "Each baseline (pretreatment) tumor SUL peak must be >= 1.5 x mean liver SUL + 2 SDs
 *  of mean SUL. If the liver is diseased, 2.0 x blood-pool SUL + 2 SDs is suggested as minimal
 *  metabolically measurable tumor activity." */
export function measurabilityGate(
  liver: ReferenceRegion | null,
  bloodPool: ReferenceRegion | null,
  liverAbnormal = false,
): MeasurabilityGate | null {
  if (!liverAbnormal && liver) {
    const p = referencePlausibility("liver", liver);
    return {
      threshold: 1.5 * liver.mean + 2 * liver.stdDev,
      basis: "liver",
      explanation: `1.5 x liver mean (${liver.mean.toFixed(2)}) + 2 SD (${liver.stdDev.toFixed(2)})`,
      trustworthy: p.ok,
      plausibilityNote: p.note,
    };
  }
  if (bloodPool) {
    const p = referencePlausibility("bloodPool", bloodPool);
    return {
      threshold: 2.0 * bloodPool.mean + 2 * bloodPool.stdDev,
      basis: "bloodPool",
      explanation: `2.0 x blood-pool mean (${bloodPool.mean.toFixed(2)}) + 2 SD (${bloodPool.stdDev.toFixed(2)})`,
      trustworthy: p.ok,
      plausibilityNote: p.note,
    };
  }
  return null;
}

/** Plausible SUVbw ranges for a NORMAL reference region on an FDG study at a conventional ~60 min
 *  uptake time. These are sanity bounds, not a standard: the criteria assume a normal liver and
 *  say nothing about what to do when the ROI misses it.
 *
 *  They exist because the failure is silent and consequential. A liver sphere dropped outside the
 *  patient reads near zero, and 1.5 x 0 + 2 x 0 is a measurability gate of ~0, under which every
 *  lesion in the study is "measurable" and every Deauville comparison is against nothing. The tool
 *  has to say so rather than compute confidently from a reference that cannot be a liver.
 *
 *  Typical normal values: liver ~1.5-3.0, mediastinal blood pool ~1.0-2.5. The bounds below are
 *  deliberately wider than that so an unusual but genuine patient is not nagged. */
export const PLAUSIBLE_REFERENCE: Record<"liver" | "bloodPool", [number, number]> = {
  liver: [0.8, 4.5],
  bloodPool: [0.5, 3.5],
};

export interface Plausibility {
  ok: boolean;
  note: string;
}

export function referencePlausibility(kind: "liver" | "bloodPool", region: ReferenceRegion): Plausibility {
  const [lo, hi] = PLAUSIBLE_REFERENCE[kind];
  const name = kind === "liver" ? "liver" : "blood pool";
  if (region.mean < lo) {
    return {
      ok: false,
      note: `${region.mean.toFixed(2)} is below the plausible range for normal ${name} ` +
        `(${lo}-${hi}). The ROI may be outside the patient, in lung, or in bowel gas.`,
    };
  }
  if (region.mean > hi) {
    return {
      ok: false,
      note: `${region.mean.toFixed(2)} is above the plausible range for normal ${name} ` +
        `(${lo}-${hi}). The ROI may be on a lesion or on physiological uptake, and PERCIST ` +
        `assumes a NORMAL reference.`,
    };
  }
  return { ok: true, note: `within the plausible range for normal ${name} (${lo}-${hi})` };
}

/** PERCIST's segmentation floor for TLG: "an outer boundary equal to 3 SDs above normal-liver
 *  mean SUL", with 2 SD offered as the routine alternative. */
export const percistTlgThreshold = (liver: ReferenceRegion, sds = 3): number =>
  liver.mean + sds * liver.stdDev;

// ---------------------------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------------------------

export type PercistCategory = "CMR" | "PMR" | "SMD" | "PMD";

export interface PercistAssessment {
  category: PercistCategory;
  /** Percent change in SULpeak against the chosen comparator. Negative = decrease. */
  percentChange: number;
  absoluteChange: number;
  /** Which timepoint the comparison used, and why. */
  comparedWith: "baseline" | "nadir";
  reasons: string[];
  /** True when the change is smaller than the QIBA repeatability floor. */
  withinMeasurementNoise: boolean;
}

export interface PercistInput {
  /** SULpeak of the hottest measurable lesion now. */
  current: number;
  /** SULpeak at baseline (the denominator for response). */
  baseline: number;
  /** Lowest SULpeak observed so far, if any — progression is judged from best response. */
  nadir?: number;
  /** Liver reference at the CURRENT timepoint, for the CMR test. */
  liver?: ReferenceRegion | null;
  /** New lesions typical of cancer were seen. */
  newLesions?: boolean;
  /** Percent change in TLG, if the caller computed it. */
  tlgPercentChange?: number;
}

/** PERCIST thresholds, verbatim from Wahl et al.:
 *   PMR  "reduction of minimum of 30% in target measurable tumor 18F-FDG SUL peak. Absolute drop
 *         in SUL must be at least 0.8 SUL units, as well."
 *   PMD  "> 30% increase in 18F-FDG SUL peak, with > 0.8 SUL unit increase ... OR visible increase
 *         in extent ... (> 75% in TLG volume with no decline in SUL) OR new 18F-FDG avid lesions"
 *   CMR  "complete resolution of 18F-FDG uptake within measurable target lesion so that it is less
 *         than mean liver activity and indistinguishable from surrounding background blood-pool"
 *   SMD  "not CMR, PMR, or PMD" */
export const PERCIST_RELATIVE = 0.30;
export const PERCIST_ABSOLUTE = 0.8;
export const PERCIST_TLG_PROGRESSION = 0.75;

/** QIBA FDG-PET/CT Profile: SUVmax has a within-subject coefficient of variation of 10-12%, so
 *  "a measured increase in SUVmax of 39% or more, or a decrease of -28% or more, indicates that a
 *  true change has occurred with 95% confidence". Anything smaller is not distinguishable from
 *  measurement variability, which almost no viewer tells the reader. */
export const QIBA_INCREASE = 0.39;
export const QIBA_DECREASE = -0.28;

export const isRealChange = (fraction: number): boolean =>
  fraction >= QIBA_INCREASE || fraction <= QIBA_DECREASE;

export function assessPercist(input: PercistInput): PercistAssessment {
  const { current, baseline, nadir, liver, newLesions, tlgPercentChange } = input;
  const reasons: string[] = [];

  // Progression is judged from best response, not baseline: "Progression is judged from best
  // response if being assessed after first scan was performed."
  const useNadir = nadir !== undefined && nadir < baseline && current > nadir;
  const reference = useNadir ? nadir! : baseline;
  const comparedWith: "baseline" | "nadir" = useNadir ? "nadir" : "baseline";

  const absoluteChange = current - reference;
  const percentChange = reference === 0 ? 0 : (absoluteChange / reference) * 100;
  const fraction = percentChange / 100;

  let category: PercistCategory = "SMD";

  if (newLesions) {
    category = "PMD";
    reasons.push("new FDG-avid lesions typical of cancer");
  } else if (liver && current < liver.mean) {
    category = "CMR";
    reasons.push(`SULpeak ${current.toFixed(2)} is below mean liver ${liver.mean.toFixed(2)}`);
  } else if (fraction <= -PERCIST_RELATIVE && absoluteChange <= -PERCIST_ABSOLUTE) {
    category = "PMR";
    reasons.push(`${percentChange.toFixed(0)}% decrease and ${Math.abs(absoluteChange).toFixed(2)} SUL absolute drop`);
  } else if (fraction >= PERCIST_RELATIVE && absoluteChange >= PERCIST_ABSOLUTE) {
    category = "PMD";
    reasons.push(`${percentChange.toFixed(0)}% increase and ${absoluteChange.toFixed(2)} SUL absolute rise from ${comparedWith}`);
  } else if (tlgPercentChange !== undefined && tlgPercentChange >= PERCIST_TLG_PROGRESSION * 100 && absoluteChange >= 0) {
    category = "PMD";
    reasons.push(`TLG grew ${tlgPercentChange.toFixed(0)}% with no decline in SUL`);
  } else {
    // Say which half of the AND failed — "not 30%" and "not 0.8 units" are different clinical
    // situations and a reader should not have to work out which one applied.
    if (fraction <= -PERCIST_RELATIVE) reasons.push(`${percentChange.toFixed(0)}% decrease but only ${Math.abs(absoluteChange).toFixed(2)} SUL absolute (needs 0.8)`);
    else if (fraction >= PERCIST_RELATIVE) reasons.push(`${percentChange.toFixed(0)}% increase but only ${absoluteChange.toFixed(2)} SUL absolute (needs 0.8)`);
    else reasons.push(`${percentChange.toFixed(0)}% change does not reach +/-30%`);
  }

  return {
    category,
    percentChange,
    absoluteChange,
    comparedWith,
    reasons,
    withinMeasurementNoise: !isRealChange(fraction),
  };
}

// ---------------------------------------------------------------------------------------------
// Deauville
// ---------------------------------------------------------------------------------------------

export type DeauvilleBand = 1 | 2 | 3 | 4 | 5;

export interface DeauvilleAid {
  /** The band the reference levels SUGGEST. Never "the score" — Deauville is read visually. */
  suggested: DeauvilleBand | null;
  mediastinum: number | null;
  liver: number | null;
  lesion: number;
  /** Plain-language statement of where the lesion sits relative to the two references. */
  relation: string;
  /** Always present. The caller must show it next to any suggested band. */
  caveat: string;
}

const DEAUVILLE_CAVEAT =
  "Deauville is a VISUAL scale. This is an aid, not a score. Uptake in Waldeyer's ring, " +
  "in spleen or marrow after chemotherapy or G-CSF, and at other sites of high physiological " +
  "uptake may exceed mediastinum or liver without being disease.";

/** Reference levels for a Deauville read, per the Lugano 5-point scale:
 *   1 no uptake above background; 2 uptake <= mediastinum; 3 > mediastinum but <= liver;
 *   4 moderately > liver; 5 markedly higher than liver and/or new lesions.
 *
 *  "Moderately" and "markedly" are not numeric in the source. The common working convention puts
 *  the 4/5 boundary near 2-3x liver; `markedlyFactor` exposes it rather than burying it. */
export function deauvilleAid(
  lesionSuv: number,
  mediastinumSuv: number | null,
  liverSuv: number | null,
  options: { backgroundSuv?: number; markedlyFactor?: number } = {},
): DeauvilleAid {
  const bg = options.backgroundSuv ?? 0.5;
  const markedly = options.markedlyFactor ?? 2.0;
  let suggested: DeauvilleBand | null = null;
  let relation = "no reference regions placed";

  if (mediastinumSuv !== null && liverSuv !== null) {
    if (lesionSuv <= bg) {
      suggested = 1;
      relation = "no uptake above background";
    } else if (lesionSuv <= mediastinumSuv) {
      suggested = 2;
      relation = `at or below mediastinal blood pool (${mediastinumSuv.toFixed(2)})`;
    } else if (lesionSuv <= liverSuv) {
      suggested = 3;
      relation = `above mediastinum (${mediastinumSuv.toFixed(2)}), at or below liver (${liverSuv.toFixed(2)})`;
    } else if (lesionSuv < liverSuv * markedly) {
      suggested = 4;
      relation = `above liver (${liverSuv.toFixed(2)}) but below ${markedly}x liver`;
    } else {
      suggested = 5;
      relation = `at or above ${markedly}x liver (${(liverSuv * markedly).toFixed(2)})`;
    }
  } else if (liverSuv !== null) {
    relation = lesionSuv > liverSuv
      ? `above liver (${liverSuv.toFixed(2)}); place a mediastinal ROI to separate bands 2 and 3`
      : `at or below liver (${liverSuv.toFixed(2)}); place a mediastinal ROI to separate bands 1-3`;
  } else if (mediastinumSuv !== null) {
    relation = `mediastinum ${mediastinumSuv.toFixed(2)}; place a liver ROI to separate bands 3 and 4`;
  }

  return { suggested, mediastinum: mediastinumSuv, liver: liverSuv, lesion: lesionSuv, relation, caveat: DEAUVILLE_CAVEAT };
}

/** PERCIST's own quality check: "Typically, liver uptake should not vary by more than 0.3 SUL unit
 *  from study to study." A cheap and effective guard that two timepoints are comparable at all. */
export const LIVER_STABILITY_LIMIT = 0.3;

export function liverComparable(a: ReferenceRegion, b: ReferenceRegion): { ok: boolean; delta: number; note: string } {
  const delta = Math.abs(a.mean - b.mean);
  return {
    ok: delta <= LIVER_STABILITY_LIMIT,
    delta,
    note: delta <= LIVER_STABILITY_LIMIT
      ? `liver differs by ${delta.toFixed(2)} SUL between studies`
      : `liver differs by ${delta.toFixed(2)} SUL (> ${LIVER_STABILITY_LIMIT}); the two studies may not be comparable`,
  };
}
