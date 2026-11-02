// SUV (Standardized Uptake Value) from PET DICOM metadata — pure TS, DOM-free, no renderer deps.
//
// Follows the QIBA vendor-neutral pseudocode
// (https://qibawiki.rsna.org/index.php/Standardized_Uptake_Value_(SUV)), which is also what
// Slicer's SUVFactorCalculator and @cornerstonejs/calculate-suv implement:
//
//   decayTime    = scanTime - radiopharmaceuticalStartTime          // seconds
//   decayedDose  = RadionuclideTotalDose * 2^(-decayTime / RadionuclideHalfLife)
//   SUVbwScale   = PatientWeight * 1000 / decayedDose               // g/Bq
//   SUVbw(voxel) = (stored * RescaleSlope + RescaleIntercept) * SUVbwScale    // g/mL
//
// Rescale slope/intercept are deliberately NOT applied here: QIBA notes they may vary per slice
// (GE), so they belong to the per-frame decode, not to the series-level scale factor.
//
// Deliberately STRICTER than calculate-suv in one place: QIBA guards on DecayCorrection == "START",
// calculate-suv only checks CorrectedImage. When the pixels are decay-corrected to ADMIN the dose
// must not be decayed again, so computing SUVbw the same way would be silently wrong.
//
// Failure is a typed result, never a thrown number: a missing SUV is clinically safer than a wrong
// one, and the UI needs to say WHY it is missing.

/** DICOM Units (0054,1001) values that matter for SUV. Others exist and are simply not convertible. */
export type PetUnits = "BQML" | "CNTS" | "GML" | "CPS" | "PROPCPS" | "PROPCNTS" | "NONE" | string;

/** Per-instance PET metadata, naturalized. Field names are DICOM keywords. */
export interface PetInstanceMeta {
  CorrectedImage: string[] | string;              // (0028,0051)
  Units: PetUnits;                                // (0054,1001)
  DecayCorrection: string;                        // (0054,1102) NONE | START | ADMIN
  RadionuclideHalfLife: number;                   // (0018,1075) seconds
  RadionuclideTotalDose: number;                  // (0018,1074) Bq
  PatientWeight?: number;                         // (0010,1030) kg
  SeriesDate: string;                             // (0008,0021)
  SeriesTime: string;                             // (0008,0031)
  AcquisitionDate: string;                        // (0008,0022)
  AcquisitionTime: string;                        // (0008,0032)
  RadiopharmaceuticalStartTime?: string;          // (0018,1072)
  RadiopharmaceuticalStartDateTime?: string;      // (0018,1078)
  GEPrivatePostInjectionDateTime?: string;        // (0009,100d) "GEMS_PETD_01"
  FrameReferenceTime?: number;                    // (0054,1300) ms
  ActualFrameDuration?: number;                   // (0018,1242) ms
  PatientSize?: number;                           // (0010,1020) metres
  PatientSex?: string;                            // (0010,0040)
  SUVType?: string;                               // (0054,1006) BW | LBM | BSA — disambiguates GML
  PhilipsPETPrivateGroup?: {
    SUVScaleFactor?: unknown;                     // (7053,1000)
    ActivityConcentrationScaleFactor?: unknown;   // (7053,1009)
  };
}

export interface SuvFactors {
  /** Multiply activity concentration (post rescale) by this to get SUVbw in g/mL. */
  suvbw: number;
  /** Lean-body-mass normalised (Janmahasatian — EANM v2.0's recommendation). Needs size + sex. */
  suvlbm?: number;
  /** Lean-body-mass normalised using the older James formulas. Reported for comparison only. */
  suvlbmJames?: number;
  /** Body-surface-area normalised (Du Bois). Units are cm^2 * (conc/activity), NOT g/mL. */
  suvbsa?: number;
}

export type SuvResult =
  | ({ ok: true } & SuvFactors)
  | { ok: false; reason: string };

/** What a viewport should label this series, and whether it is quantitative at all. */
export interface PetDisplayUnits {
  /** Short label for the voxel readout, e.g. "SUV/W", "Bq/mL", "counts". */
  label: string;
  /** True only when SUV is defined for this series. */
  quantitative: boolean;
  /** Why not, when it is not. */
  reason?: string;
}

const MS_PER_SEC = 1000;

// ---------------------------------------------------------------------------------------------
// DICOM DA / TM / DT parsing
// ---------------------------------------------------------------------------------------------

/** DICOM DA (0008,xxxx style date), "YYYYMMDD". Returns null when unparseable. */
export function parseDA(value: string | undefined | null): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^\d{8}$/.test(s)) return null;
  const year = +s.slice(0, 4), month = +s.slice(4, 6), day = +s.slice(6, 8);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** DICOM TM, "HHMMSS.FFFFFF" with optional fraction and optional truncation. */
export function parseTM(
  value: string | undefined | null,
): { hours: number; minutes: number; seconds: number } | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^\d{2}(\d{2}(\d{2}(\.\d+)?)?)?$/.test(s)) return null;
  const hours = +s.slice(0, 2);
  const minutes = s.length >= 4 ? +s.slice(2, 4) : 0;
  const seconds = s.length >= 6 ? parseFloat(s.slice(4)) : 0;
  if (hours > 23 || minutes > 59 || seconds >= 61) return null;
  return { hours, minutes, seconds };
}

/** DICOM DT, "YYYYMMDDHHMMSS.FFFFFF" (timezone suffix ignored — all comparisons are within a series). */
export function parseDT(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const m = /^(\d{8})(\d{2}(?:\d{2}(?:\d{2}(?:\.\d+)?)?)?)?/.exec(s);
  if (!m) return null;
  const da = parseDA(m[1]);
  if (!da) return null;
  const tm = m[2] ? parseTM(m[2]) : { hours: 0, minutes: 0, seconds: 0 };
  if (!tm) return null;
  return combineDateTime(da, tm);
}

/** Epoch seconds (UTC) for a parsed date + time. Only differences are ever used. */
export function combineDateTime(
  da: { year: number; month: number; day: number },
  tm: { hours: number; minutes: number; seconds: number },
): number {
  const whole = Math.floor(tm.seconds);
  const frac = tm.seconds - whole;
  return Date.UTC(da.year, da.month - 1, da.day, tm.hours, tm.minutes, whole) / MS_PER_SEC + frac;
}

// ---------------------------------------------------------------------------------------------
// Scan time and injection time (QIBA's decision tree)
// ---------------------------------------------------------------------------------------------

/** QIBA: Series Date/Time unless it is AFTER the earliest Acquisition Date/Time (which means the
 *  series was created by post-processing and its timestamp is unrelated to acquisition); then the
 *  GE private post-injection datetime; else the earliest acquisition across the series. */
export function calculateScanTimes(instances: PetInstanceMeta[]): number[] | null {
  if (instances.length === 0) return null;
  const first = instances[0];
  const seriesDA = parseDA(first.SeriesDate), seriesTM = parseTM(first.SeriesTime);
  const acq: number[] = [];
  for (const i of instances) {
    const da = parseDA(i.AcquisitionDate), tm = parseTM(i.AcquisitionTime);
    if (da && tm) acq.push(combineDateTime(da, tm));
  }
  const earliestAcq = acq.length ? Math.min(...acq) : null;

  if (seriesDA && seriesTM) {
    const seriesDT = combineDateTime(seriesDA, seriesTM);
    if (earliestAcq === null || seriesDT <= earliestAcq) return instances.map(() => seriesDT);
  }
  const ge = parseDT(first.GEPrivatePostInjectionDateTime);
  if (ge !== null) return instances.map(() => ge);
  if (earliestAcq !== null) return instances.map(() => earliestAcq);
  return null;
}

/** QIBA: RadiopharmaceuticalStartDateTime if present, else StartTime paired with the Series Date.
 *  The time-only form cannot express a study that crosses midnight; a negative decay time is the
 *  symptom, and the caller surfaces it rather than producing a >1 scale factor. */
export function calculateStartTime(instance: PetInstanceMeta): number | null {
  const dt = parseDT(instance.RadiopharmaceuticalStartDateTime);
  if (dt !== null) return dt;
  const tm = parseTM(instance.RadiopharmaceuticalStartTime);
  const da = parseDA(instance.SeriesDate);
  if (tm && da) return combineDateTime(da, tm);
  return null;
}

/** Siemens PETsyngo multi-injection back-computation (QIBA's "reliable in all cases" branch).
 *  calculate-suv has this commented out, so it is opt-in here to keep fixture parity by default. */
export function frameReferenceScanTime(instance: PetInstanceMeta): number | null {
  const frt = instance.FrameReferenceTime, afd = instance.ActualFrameDuration;
  const halfLife = instance.RadionuclideHalfLife;
  if (!(typeof frt === "number" && frt > 0 && typeof afd === "number" && afd > 0 && halfLife > 0)) return null;
  const da = parseDA(instance.AcquisitionDate), tm = parseTM(instance.AcquisitionTime);
  if (!da || !tm) return null;
  const frameDuration = afd / MS_PER_SEC;
  const decayConstant = Math.LN2 / halfLife;
  const decayDuringFrame = decayConstant * frameDuration;
  const avgCountRateTime = (1 / decayConstant) *
    Math.log(decayDuringFrame / (1 - Math.exp(-decayDuringFrame)));
  return combineDateTime(da, tm) - frt / MS_PER_SEC + avgCountRateTime;
}

// ---------------------------------------------------------------------------------------------
// Body-habitus normalisations
// ---------------------------------------------------------------------------------------------

/** Janmahasatian LBM in grams — EANM v2.0's recommendation, which explicitly rejects James
 *  ("fails at weights greater than about 120 kg"). weight kg, size metres. */
export function leanBodyMassJanmahasatian(weightKg: number, sizeM: number, sex: string): number | null {
  if (!(weightKg > 0 && sizeM > 0)) return null;
  const bmi = weightKg / (sizeM * sizeM);
  if (sex === "F") return ((9270 * weightKg) / (8780 + 244 * bmi)) * 1000;
  if (sex === "M") return ((9270 * weightKg) / (6680 + 216 * bmi)) * 1000;
  return null;
}

/** James LBM in grams. NOTE the male coefficient: the published James (1976) value is 128, but
 *  calculate-suv follows medicalconnections.co.uk and uses 120. We use 128 (the literature value)
 *  and expose the difference rather than hide it — this factor is reported for comparison only,
 *  never as the primary SUV. */
export function leanBodyMassJames(weightKg: number, sizeM: number, sex: string): number | null {
  if (!(weightKg > 0 && sizeM > 0)) return null;
  const heightCm = sizeM * 100;
  const q = (weightKg / heightCm) * (weightKg / heightCm);
  if (sex === "F") return (1.07 * weightKg - 148 * q) * 1000;
  if (sex === "M") return (1.10 * weightKg - 128 * q) * 1000;
  return null;
}

/** Du Bois body surface area in cm^2. weight kg, size metres. */
export function bodySurfaceArea(weightKg: number, sizeM: number): number | null {
  if (!(weightKg > 0 && sizeM > 0)) return null;
  return Math.pow(weightKg, 0.425) * Math.pow(sizeM * 100, 0.725) * 71.84;
}

// ---------------------------------------------------------------------------------------------
// Philips private factors
// ---------------------------------------------------------------------------------------------

/** Philips (7053,1000)/(7053,1009) may arrive over WADO-RS as an unresolved {BulkDataURI} object,
 *  which is TRUTHY. Treating that as a factor silently corrupts every SUV in the series, so any
 *  non-finite value is rejected outright. */
export function coerceFactor(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? value : null;
  if (typeof value === "string") {
    const n = parseFloat(value.trim());
    return Number.isFinite(n) && n !== 0 ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The scale factors
// ---------------------------------------------------------------------------------------------

export interface SuvOptions {
  /** Require DecayCorrection === "START" (QIBA). Default true. */
  requireDecayCorrectionStart?: boolean;
  /** Use the Siemens FrameReferenceTime back-computation when the simple branches do not apply. */
  useFrameReferenceTime?: boolean;
}

const asList = (v: string[] | string | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === "string" ? v.split("\\").map((s) => s.trim()) : [];

/** One SuvResult per instance (some acquisitions carry per-frame timing). */
export function suvScalingFactors(
  instances: PetInstanceMeta[],
  options: SuvOptions = {},
): SuvResult[] {
  const fail = (reason: string): SuvResult[] => instances.map(() => ({ ok: false as const, reason }));
  if (instances.length === 0) return [];
  const first = instances[0];

  const corrected = asList(first.CorrectedImage);
  if (!corrected.includes("ATTN") || !corrected.includes("DECY")) {
    return fail(`not attenuation- and decay-corrected (CorrectedImage = ${corrected.join(",") || "empty"})`);
  }
  if ((options.requireDecayCorrectionStart ?? true) && first.DecayCorrection !== "START") {
    return fail(`DecayCorrection is "${first.DecayCorrection}", not START`);
  }

  const units = first.Units;
  const weightKg = first.PatientWeight;

  // Decay correction (1 / decayedDose), shared by the BQML and the (7053,1009) paths.
  let decayCorrection: number[] | null = null;
  let decayFailure: string | null = null;
  {
    const scans = calculateScanTimes(instances);
    const start = calculateStartTime(first);
    const halfLife = first.RadionuclideHalfLife;
    const dose = first.RadionuclideTotalDose;
    if (scans === null) decayFailure = "no usable scan time (SeriesDate/Time and AcquisitionDate/Time both unparseable)";
    else if (start === null) decayFailure = "no usable radiopharmaceutical start time";
    else if (!(halfLife > 0)) decayFailure = "RadionuclideHalfLife missing or non-positive";
    else if (!(dose > 0)) decayFailure = "RadionuclideTotalDose missing or non-positive";
    else {
      const out: number[] = [];
      for (let i = 0; i < instances.length; i++) {
        let scan = scans[i];
        if (options.useFrameReferenceTime) {
          const alt = frameReferenceScanTime(instances[i]);
          if (alt !== null) scan = alt;
        }
        const decayTime = scan - start;
        if (decayTime < 0) {
          decayFailure = `decay time is negative (${decayTime.toFixed(1)} s) — injection appears to postdate the scan, ` +
            `often a study crossing midnight with a time-only RadiopharmaceuticalStartTime`;
          break;
        }
        out.push(1 / (dose * Math.pow(2, -decayTime / halfLife)));
      }
      if (!decayFailure) decayCorrection = out;
    }
  }

  const habitus = (base: number[], index: number): SuvFactors => {
    const f: SuvFactors = { suvbw: base[index] };
    const sizeM = first.PatientSize, sex = first.PatientSex ?? "";
    if (weightKg && sizeM && decayCorrection) {
      const lbmJ = leanBodyMassJanmahasatian(weightKg, sizeM, sex);
      const lbmJames = leanBodyMassJames(weightKg, sizeM, sex);
      const bsa = bodySurfaceArea(weightKg, sizeM);
      // These presume Bq/mL pixels, so they are only meaningful on the decay-corrected paths.
      if (units === "BQML" || units === "GML") {
        if (lbmJ !== null) f.suvlbm = decayCorrection[index] * lbmJ;
        if (lbmJames !== null) f.suvlbmJames = decayCorrection[index] * lbmJames;
        if (bsa !== null) f.suvbsa = decayCorrection[index] * bsa;
      }
    }
    return f;
  };

  if (units === "BQML") {
    if (!weightKg) return fail("PatientWeight is missing, so SUVbw is undefined");
    if (!decayCorrection) return fail(decayFailure ?? "decay correction failed");
    const g = weightKg * 1000;
    const base = decayCorrection.map((d) => d * g);
    return instances.map((_, i) => ({ ok: true as const, ...habitus(base, i) }));
  }

  if (units === "CNTS") {
    // Philips. (7053,1000) already contains weight AND decay — do not reapply either.
    const direct = instances.map((i) => coerceFactor(i.PhilipsPETPrivateGroup?.SUVScaleFactor));
    if (direct.every((v) => v !== null)) {
      return direct.map((v) => ({ ok: true as const, suvbw: v as number }));
    }
    const acsf = instances.map((i) => coerceFactor(i.PhilipsPETPrivateGroup?.ActivityConcentrationScaleFactor));
    if (acsf.every((v) => v !== null)) {
      if (!weightKg) return fail("PatientWeight is missing, so SUVbw is undefined");
      if (!decayCorrection) return fail(decayFailure ?? "decay correction failed");
      const g = weightKg * 1000;
      const base = decayCorrection.map((d, i) => (acsf[i] as number) * d * g);
      return instances.map((_, i) => ({ ok: true as const, ...habitus(base, i) }));
    }
    return fail("Units are CNTS but the Philips private group has no usable (7053,1000) or (7053,1009) factor");
  }

  if (units === "GML") {
    // Pixels are already SUV. QIBA assumes body weight; (0054,1006) can say otherwise.
    const t = (first.SUVType ?? "").toUpperCase();
    if (t && t !== "BW") return fail(`Units are GML but SUV Type is "${t}", not BW — the normalisation is not body weight`);
    return instances.map(() => ({ ok: true as const, suvbw: 1 }));
  }

  return fail(`Units "${units}" are not convertible to SUV`);
}

/** Convenience: the series-level factor, or a typed failure. */
export function seriesSuvFactor(instances: PetInstanceMeta[], options?: SuvOptions): SuvResult {
  const all = suvScalingFactors(instances, options);
  return all.length ? all[0] : { ok: false, reason: "no instances" };
}

/** What the voxel readout should say for this series. Keeps a non-quantitative series (our NAC,
 *  which is PROPCPS) structurally incapable of being labelled SUV. */
export function petDisplayUnits(instances: PetInstanceMeta[], options?: SuvOptions): PetDisplayUnits {
  const r = seriesSuvFactor(instances, options);
  if (r.ok) return { label: "SUV/W", quantitative: true };
  const units = instances[0]?.Units ?? "";
  const label = units === "BQML" ? "Bq/mL"
    : units === "CNTS" ? "counts"
    : units === "CPS" || units === "PROPCPS" ? "counts/s"
    : units === "PROPCNTS" ? "counts"
    : units || "value";
  return { label, quantitative: false, reason: r.reason };
}
