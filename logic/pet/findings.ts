// The longitudinal finding record: Studies x Findings, with one measurement per (finding, study).
//
// This is the shape the reading workflow needs and that a per-measurement list cannot provide.
// Three things fall out of it that otherwise have nowhere to live:
//
//  * RESPONSE IS JUDGED FROM THE NADIR, not only from baseline. PERCIST calls progression against
//    the lowest value the lesion has reached, which is why a nadir comparator is a requirement
//    rather than a convenience -- and it is only computable if every timepoint's measurement for
//    THIS lesion is kept together.
//  * TOTAL BURDEN is the thesis. SUVmax and a single target lesion are sparse measures; TMTV,
//    total TLG and lesion count are the point, and they are sums across findings at one study.
//  * EDIT RATE is a funded success criterion ("edit rates will be monitored to quantify
//    performance"; "<5% analyst correction rate" gates deployment). It can only be measured if
//    every reader action on an AI candidate is recorded as it happens -- it cannot be backfilled.
//
// Pure data and pure functions: no renderer, no DOM, no storage. Serialises as JSON.

import { isRealChange, PERCIST_ABSOLUTE, PERCIST_RELATIVE } from "./percist.ts";

/** One lesion measured on one study. Everything needed to defend the number later. */
export interface LesionRecord {
  studyInstanceUID: string;
  /** DICOM StudyDate, "YYYYMMDD". */
  studyDate: string | null;
  suvMax: number;
  suvMean: number;
  /** EANM-conformant 1 mL sphere peak. Null when it could not be computed. */
  suvPeak: number | null;
  /** Metabolic tumour volume, mL. */
  mtvMl: number;
  /** MTV x SUVmean. */
  tlg: number;
  voxels: number;
  /** Which threshold convention produced the segmentation -- it changes MTV substantially, and
   *  EANM requires the SAME method at every timepoint, so it travels with the measurement. */
  thresholdId: string;
  thresholdUsed: number | null;
  longAxisMm?: number;
  shortAxisMm?: number;
  /** CT density stats over the same region, which the literature treats as an SUV surrogate. */
  ctMeanHu?: number;
  ctVolumeMl?: number;
  /** ISO 8601. */
  measuredAt: string;
  /** Manual study-alignment shift in force when this was measured, mm. Non-zero means the reader
   *  had to nudge the timepoints into line by hand, which a later comparison should know. */
  rowOffsetMm?: number;
  /** Which of the candidate rigid registrations was selected, when one was. */
  registrationId?: string;
}

export type FindingSource = "reader" | "ai" | "ai-corrected";

/** The reader's call on whether this is PET-positive. Null means not yet adjudicated. */
export type PetStatus = "positive" | "negative" | "equivocal" | null;

export type FindingAction =
  | "created"
  | "accepted"
  | "dismissed"
  | "edited"
  | "relabelled"
  | "remeasured"
  | "statusSet";

export interface FindingEvent {
  at: string;
  action: FindingAction;
  detail?: string;
}

export interface Finding {
  id: string;
  /** Free text, e.g. "right external iliac lymph node". */
  label: string;
  /** Anatomic station, once organ segmentation can assign one. */
  station?: string;
  /** RECIST follows the SHORT axis for a node and the long axis otherwise, so this is not cosmetic. */
  isLymphNode: boolean;
  petStatus: PetStatus;
  source: FindingSource;
  /** Measurements keyed by StudyInstanceUID. */
  records: Record<string, LesionRecord>;
  /** Every reader action, in order. The edit-rate instrument. */
  history: FindingEvent[];
  /** True once the reader has dismissed it; kept rather than deleted, because a dismissal IS the
   *  measurement we are collecting. */
  dismissed?: boolean;
}

export interface StudyRef {
  studyInstanceUID: string;
  studyDate: string | null;
  /** Reader-facing role, for the comparator picker. */
  role?: "current" | "baseline" | "prior" | "nadir";
}

export interface Report {
  patientId: string;
  /** Oldest first. Response math needs the order, not just the set. */
  studies: StudyRef[];
  findings: Finding[];
}

let seq = 0;
/** A short, collision-resistant id. Not a UID: findings are local until exported as DICOM. */
export function newFindingId(): string {
  seq += 1;
  return `f${Date.now().toString(36)}${seq.toString(36)}`;
}

export function newFinding(init: Partial<Finding> & { label: string }): Finding {
  const now = new Date().toISOString();
  const source = init.source ?? "reader";
  return {
    id: init.id ?? newFindingId(),
    label: init.label,
    station: init.station,
    isLymphNode: init.isLymphNode ?? true,
    petStatus: init.petStatus ?? null,
    source,
    records: init.records ?? {},
    history: init.history ?? [{ at: now, action: "created", detail: source }],
    dismissed: init.dismissed,
  };
}

/** Append an event. Returns the finding, so it composes. */
export function note(f: Finding, action: FindingAction, detail?: string): Finding {
  f.history.push({ at: new Date().toISOString(), action, detail });
  return f;
}

/** The value response is judged on: SUVpeak where available, else SUVmax.
 *
 *  PERCIST measures SULpeak; falling back to the maximum is a documented degradation, not an
 *  equivalence, so `peakAvailable` lets a caller say so in the report. */
export function responseValue(r: LesionRecord): { value: number; peakAvailable: boolean } {
  return r.suvPeak !== null ? { value: r.suvPeak, peakAvailable: true } : { value: r.suvMax, peakAvailable: false };
}

/** Studies in report order that this finding has a measurement for. */
export function measuredStudies(f: Finding, studies: StudyRef[]): LesionRecord[] {
  return studies.map((s) => f.records[s.studyInstanceUID]).filter((r): r is LesionRecord => !!r);
}

/** The lowest value this lesion has reached up to and including `uptoUID`.
 *
 *  Progression is judged from here, not from baseline -- a lesion that responded and then grew
 *  back to its starting value has progressed, and comparing with baseline alone would call it
 *  stable. Returns null when the finding has no measurement at or before that study. */
export function nadirRecord(f: Finding, studies: StudyRef[], uptoUID?: string): LesionRecord | null {
  let best: LesionRecord | null = null;
  for (const s of studies) {
    const r = f.records[s.studyInstanceUID];
    if (r) {
      const v = responseValue(r).value;
      if (!best || v < responseValue(best).value) best = r;
    }
    if (uptoUID && s.studyInstanceUID === uptoUID) break;
  }
  return best;
}

export interface Change {
  /** Fractional change, e.g. -0.42 for a 42% fall. Null when the reference is zero. */
  fraction: number | null;
  absolute: number;
  /** Whether the change exceeds QIBA's test-retest limits (+39% / -28%). */
  significant: boolean;
  /** Whether it also clears PERCIST's 30% AND 0.8-unit double requirement. */
  percistThreshold: boolean;
}

/** Change between two measurements of the same lesion. */
export function changeBetween(current: LesionRecord, reference: LesionRecord): Change {
  const c = responseValue(current).value;
  const r = responseValue(reference).value;
  const absolute = c - r;
  const fraction = r === 0 ? null : absolute / r;
  return {
    fraction,
    absolute,
    significant: fraction !== null && isRealChange(fraction),
    // PERCIST requires BOTH a 30% relative change and a 0.8-unit absolute one -- either alone is
    // not a response.
    percistThreshold: fraction !== null && Math.abs(fraction) >= PERCIST_RELATIVE && Math.abs(absolute) >= PERCIST_ABSOLUTE,
  };
}

export interface FindingAssessment {
  findingId: string;
  current: LesionRecord | null;
  baseline: LesionRecord | null;
  nadir: LesionRecord | null;
  vsBaseline: Change | null;
  vsNadir: Change | null;
  /** True when SUVpeak was unavailable anywhere in the comparison, so SUVmax stood in. */
  degradedToMax: boolean;
  notes: string[];
}

/** Per-lesion response, against both baseline and nadir. */
export function assessFinding(
  f: Finding,
  studies: StudyRef[],
  currentUID: string,
  baselineUID?: string,
): FindingAssessment {
  const current = f.records[currentUID] ?? null;
  const baseUID = baselineUID ?? studies[0]?.studyInstanceUID;
  const baseline = baseUID ? (f.records[baseUID] ?? null) : null;
  const nadir = nadirRecord(f, studies, currentUID);
  const notes: string[] = [];

  // EANM is explicit that the SAME VOI method must be used at every timepoint in a patient. A
  // mixed comparison is a methodological error, not a preference, so it is surfaced.
  if (current && baseline && current.thresholdId !== baseline.thresholdId) {
    notes.push(`threshold differs between timepoints (${baseline.thresholdId} -> ${current.thresholdId}); EANM requires one method per patient`);
  }
  if (current?.rowOffsetMm) {
    notes.push(`measured with a manual ${current.rowOffsetMm.toFixed(0)} mm alignment shift`);
  }

  const degradedToMax = [current, baseline, nadir].some((r) => r && !responseValue(r).peakAvailable);
  if (degradedToMax) notes.push("SUVpeak unavailable; SUVmax used, which PERCIST does not specify");

  return {
    findingId: f.id,
    current,
    baseline,
    nadir,
    vsBaseline: current && baseline ? changeBetween(current, baseline) : null,
    vsNadir: current && nadir ? changeBetween(current, nadir) : null,
    degradedToMax,
    notes,
  };
}

export interface TotalBurden {
  /** Lesions with a measurement on this study, excluding dismissed findings. */
  lesionCount: number;
  /** Total metabolic tumour volume, mL. */
  tmtvMl: number;
  /** Sum of per-lesion TLG. */
  totalTlg: number;
  /** Highest SUVmax across the included lesions -- the sparse measure, reported alongside. */
  suvMaxOverall: number | null;
}

/** Whole-patient burden at one study.
 *
 *  This is the measure the grant argues should supersede SUVmax and single-lesion diameters, so
 *  it is a first-class number, not something derived at export time. Dismissed findings are
 *  excluded; that is what dismissing means. */
export function totalBurden(findings: Finding[], studyUID: string): TotalBurden {
  let lesionCount = 0, tmtvMl = 0, totalTlg = 0;
  let suvMaxOverall: number | null = null;
  for (const f of findings) {
    if (f.dismissed) continue;
    const r = f.records[studyUID];
    if (!r) continue;
    lesionCount++;
    tmtvMl += r.mtvMl;
    totalTlg += r.tlg;
    if (suvMaxOverall === null || r.suvMax > suvMaxOverall) suvMaxOverall = r.suvMax;
  }
  return { lesionCount, tmtvMl, totalTlg, suvMaxOverall };
}

export interface EditRate {
  /** AI candidates presented (source "ai" or "ai-corrected"). */
  candidates: number;
  accepted: number;
  dismissed: number;
  /** Candidates whose segmentation or label the reader changed. */
  edited: number;
  /** edited / candidates -- the number the grant gates deployment on (<5%). Null with no
   *  candidates, rather than a misleading zero. */
  rate: number | null;
  /** Reader-created findings: a candidate the model missed entirely. */
  readerAdded: number;
}

/** The edit-rate metric over a set of findings. */
export function editRate(findings: Finding[]): EditRate {
  let candidates = 0, accepted = 0, dismissed = 0, edited = 0, readerAdded = 0;
  for (const f of findings) {
    if (f.source === "reader") { readerAdded++; continue; }
    candidates++;
    if (f.dismissed) dismissed++;
    else if (f.history.some((e) => e.action === "accepted")) accepted++;
    if (f.history.some((e) => e.action === "edited" || e.action === "relabelled")) edited++;
  }
  return { candidates, accepted, dismissed, edited, rate: candidates ? edited / candidates : null, readerAdded };
}

/** Findings that have a measurement on `studyUID`, in report order. */
export function findingsAt(findings: Finding[], studyUID: string): Finding[] {
  return findings.filter((f) => !f.dismissed && f.records[studyUID]);
}
