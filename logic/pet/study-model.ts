// Group a patient's series into PET/CT timepoints with reading roles.
//
// A PET/CT reading session is organised by TIMEPOINT, not by series: each timepoint carries a CT,
// an attenuation-corrected PET (the quantitative one) and, when the site acquired it, a
// non-attenuation-corrected PET. Heather Jacene's layout specification puts exactly these three
// plus the fusion of the first two on the primary screen, and EANM v2.0 requires the NAC to be
// available for review because it is how a CT-attenuation artifact is told from a real lesion.
//
// Two real-world messes this handles, both present in the ACRIN 6668 reference case:
//
//   1. Duplicate studies. The same acquisition can appear under two StudyInstanceUIDs with
//      identical series. Showing the reader two identical "priors" is worse than useless, so
//      duplicates are collapsed and the richer one kept.
//   2. Interleaved CT-only studies. A diagnostic chest CT between two PET/CTs is a legitimate
//      prior but is NOT a PET/CT timepoint; it must not become a comparison row.

import { isAttenuationCorrected, type SeriesRow } from "../idc/sql.ts";

export interface PetCtTimepoint {
  studyInstanceUID: string;
  /** DICOM StudyDate, "YYYYMMDD". De-identified dates are offset but internally consistent. */
  studyDate: string | null;
  ct: SeriesRow | null;
  /** Attenuation-corrected PET — the only series SUV may be computed from. */
  ac: SeriesRow | null;
  /** Non-attenuation-corrected PET. Reviewed for artifacts; never quantitative. */
  nac: SeriesRow | null;
  /** Segmentations referencing this study (AI candidates, expert corrections). */
  segs: SeriesRow[];
  /** Everything else in the study, in index order. */
  others: SeriesRow[];
}

export interface StudyGroupOptions {
  /** Drop studies with no PET at all (diagnostic CT priors). Default true. */
  requirePet?: boolean;
  /** Collapse studies that look like duplicates of one another. Default true. */
  dedupe?: boolean;
}

/** Prefer the largest reconstructed volume, then the lowest series number, so a soft-tissue
 *  whole-body recon wins over a topogram or a bone-kernel repeat. */
function pickBest(candidates: SeriesRow[]): SeriesRow | null {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    const ra = a.geometry ? 1 : 0, rb = b.geometry ? 1 : 0;
    if (ra !== rb) return rb - ra;                              // a real volume beats one that isn't
    if (a.instanceCount !== b.instanceCount) return b.instanceCount - a.instanceCount;
    return (a.SeriesNumber ?? 1e9) - (b.SeriesNumber ?? 1e9);
  })[0];
}

/** A shape signature for duplicate detection: same date, same per-modality slice counts. Two
 *  submissions of one acquisition agree on all of it; two genuinely different studies on the same
 *  day (a PET/CT and a separate diagnostic CT) do not. */
function signatureOf(t: PetCtTimepoint): string {
  const part = (s: SeriesRow | null) => (s ? `${s.Modality}:${s.instanceCount}` : "-");
  return [t.studyDate ?? "?", part(t.ct), part(t.ac), part(t.nac)].join("|");
}

/** Richer = more of the three reading roles present, then more segmentations, then more series. */
function richness(t: PetCtTimepoint): number {
  const roles = (t.ct ? 1 : 0) + (t.ac ? 1 : 0) + (t.nac ? 1 : 0);
  return roles * 1000 + t.segs.length * 10 + t.others.length;
}

/** Group series rows (as returned by IdcClient.seriesOfPatient) into ordered timepoints. */
export function groupTimepoints(rows: SeriesRow[], options: StudyGroupOptions = {}): PetCtTimepoint[] {
  const requirePet = options.requirePet ?? true;
  const dedupe = options.dedupe ?? true;

  const byStudy = new Map<string, SeriesRow[]>();
  for (const r of rows) {
    const list = byStudy.get(r.StudyInstanceUID);
    if (list) list.push(r);
    else byStudy.set(r.StudyInstanceUID, [r]);
  }

  let timepoints: PetCtTimepoint[] = [];
  for (const [studyInstanceUID, series] of byStudy) {
    const pet = series.filter((s) => s.Modality === "PT");
    const tp: PetCtTimepoint = {
      studyInstanceUID,
      studyDate: series.find((s) => s.StudyDate)?.StudyDate ?? null,
      ct: pickBest(series.filter((s) => s.Modality === "CT")),
      ac: pickBest(pet.filter((s) => isAttenuationCorrected(s))),
      nac: pickBest(pet.filter((s) => !isAttenuationCorrected(s))),
      segs: series.filter((s) => s.Modality === "SEG"),
      others: [],
    };
    const claimed = new Set([tp.ct, tp.ac, tp.nac, ...tp.segs].filter(Boolean) as SeriesRow[]);
    tp.others = series.filter((s) => !claimed.has(s));
    if (requirePet && !tp.ac && !tp.nac) continue;
    timepoints.push(tp);
  }

  if (dedupe) {
    const best = new Map<string, PetCtTimepoint>();
    for (const tp of timepoints) {
      const sig = signatureOf(tp);
      const prev = best.get(sig);
      if (!prev || richness(tp) > richness(prev)) best.set(sig, tp);
    }
    timepoints = [...best.values()];
  }

  // Oldest first. The reading layouts put the NEWEST study on top, which is the renderer's job;
  // keeping chronological order here means "baseline" is index 0 and "current" is the last.
  timepoints.sort((a, b) => (a.studyDate ?? "").localeCompare(b.studyDate ?? ""));
  return timepoints;
}

/** Index of the most recent timepoint — the one that is always displayed per the LNQ layout spec. */
export const currentIndex = (timepoints: PetCtTimepoint[]): number => timepoints.length - 1;

/** The comparators a reader can select against the current study, per the Lugano/PERCIST model:
 *  baseline (first), prior (immediately preceding) and nadir (lowest burden so far). Nadir needs
 *  measurements, so it is supplied by the caller once findings exist. */
export interface Comparators {
  baseline: number | null;
  prior: number | null;
  current: number;
}

export function comparatorsFor(timepoints: PetCtTimepoint[]): Comparators | null {
  const n = timepoints.length;
  if (n === 0) return null;
  const current = n - 1;
  return {
    baseline: n > 1 ? 0 : null,
    prior: n > 1 ? current - 1 : null,
    current,
  };
}
