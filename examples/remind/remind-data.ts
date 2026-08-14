// ReMINDer data layer: the collection index (built by worker/build_index.py from the IDC
// public API) plus the browser-side loader that turns one index entry into a volume or a
// labelmap, straight out of IDC's public bucket — no intermediate store, no pipeline.
//
// Listing lives here (main thread: s3ListKeys needs DOMParser); decoding lives in
// remind-worker.js. Loads are queued at a small concurrency so a row that the user just
// toggled on is not stuck behind five others saturating the connection pool.
import { s3ListKeys } from "../../render/vendor/idc_tools/s3.js";

export interface SegEntry {
  u: string;            // crdc_series_uuid — the object-store prefix
  si: string;           // SeriesInstanceUID
  s: string;            // structure: tumor | cerebrum | ventricles | tumor_residual | …
  b: number;            // bytes
  bk: string;           // bucket
}

export interface SeriesEntry {
  u: string;
  si: string;
  m: "MR" | "US";
  d: string;            // SeriesDescription (the sequence name, or US_pre_dura…)
  sn: number;           // SeriesNumber
  n: number;            // instances
  b: number;            // bytes
  tp: TimepointKey;
  st: string;           // StudyInstanceUID
  bk: string;
  segs: SegEntry[];
}

export type TimepointKey = "preop" | "pre_dura" | "post_dura" | "pre_imri" | "intraop";

export interface CaseEntry {
  pid: string;
  studies: { preop: string; intraop: string };
  bytes: number;
  series: SeriesEntry[];
}

export interface ReMINDIndex {
  collection: string;
  idc_version: string;
  generated: string;
  source: {
    doi?: string; url?: string; cancer_type?: string; location?: string;
    subject_count?: number; date_updated?: string; portal: string; bucket: string;
  };
  timeline: { key: TimepointKey; rank: number; label: string }[];
  stats: {
    cases: number; series: number; studies: number; bytes: number;
    modalities: Record<string, number>;
    timeline: { key: TimepointKey; rank: number; label: string; cases: number; series: number }[];
    sequences: Record<string, number>;
    structures: Record<string, { series: number; cases: number }>;
  };
  cases: CaseEntry[];
}

// ── colour ───────────────────────────────────────────────────────────────────
// The timeline is COMPOSITE data — an ordered stage (5 of them) crossed with a modality
// (MR or US) — so it gets a composite encoding rather than five arbitrary hues: hue says
// modality, and lightness advances with the operation. Two one-hue ordinal ramps, blue for
// MR and orange for US, each running light → dark forward in time. Both ramps validate as
// ordinal ramps (monotone lightness, ≥0.06 step gaps, end step clear of the surface) against
// this viewer's near-black surface and the dashboard's light one, and the two anchors clear
// every categorical gate against each other. A five-hue categorical set could not: the
// ordering IS the data here, and a rainbow would have thrown it away.
const hex = (h: string): [number, number, number] =>
  [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** Timeline presentation: order, short chip label, and the row accent (dark-surface steps —
 *  the dashboard declares the light steps of the same two ramps). */
export const TIMEPOINTS: Record<TimepointKey, { rank: number; short: string; label: string; color: [number, number, number] }> = {
  preop: { rank: 0, short: "PRE-OP", label: "pre-op MRI", color: hex("#9ec5f4") },
  pre_dura: { rank: 1, short: "PRE-DURA", label: "iUS before dura opening", color: hex("#f0a276") },
  post_dura: { rank: 2, short: "POST-DURA", label: "iUS after dura opening", color: hex("#d95926") },
  pre_imri: { rank: 3, short: "PRE-iMRI", label: "iUS before intra-op MRI", color: hex("#a03d13") },
  intraop: { rank: 4, short: "INTRA-OP", label: "intra-op MRI", color: hex("#3987e5") },
};

// Structure colours for the segmentation overlays (2D fill + outline and 3D shell alike).
// Checked all-pairs against mid-grey anatomy for the sets that ACTUALLY co-occur in this
// collection — {tumor, ventricles, previous_resection_cavity} (10 series) and the tumour
// family (tumor/residual/target) — which pass. Five colour-carrying structures at once is
// only reachable in 2 of 114 cases (ReMIND-076/-077, and only with both rows loaded); at
// that width no five-hue set can clear the all-pairs floors, so identity leans on the
// secondary encoding this viewer always draws: a per-segment outline in 2D, the structure
// names in every row label, and direct-labelled jump chips. `cerebrum` is deliberately a
// neutral ink rather than a series hue — it is the context envelope, not a finding.
export const STRUCTURE_COLORS: Record<string, [number, number, number]> = {
  tumor: hex("#e34948"),
  tumor_residual: hex("#eda100"),
  tumor_target: hex("#e87ba4"),
  previous_resection_cavity: hex("#1baf7a"),
  ventricles: hex("#3987e5"),
  cerebrum: hex("#c3c2b7"),
};
export const structureColor = (s: string): [number, number, number] => STRUCTURE_COLORS[s] ?? [0.8, 0.8, 0.8];

export const rgbCss = (c: [number, number, number], a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/** Human label for a series row: the sequence name for MR, the timepoint for US. */
export const seriesLabel = (e: SeriesEntry) => e.m === "US" ? TIMEPOINTS[e.tp].short : e.d;

export async function loadIndex(url = "remind-index.json"): Promise<ReMINDIndex> {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`remind-index.json: HTTP ${r.status}`);
  return await r.json() as ReMINDIndex;
}

// ── decode worker plumbing ───────────────────────────────────────────────────
export interface LoadedVolume {
  vol: Float32Array;
  dims: [number, number, number];
  ijkToRAS: number[];
  win: number;
  lev: number;
  vox: number;                            // isotropic voxel (mm) of the delivered grid
  native: { dims: [number, number, number] };
}

export interface LoadedLabelmap {
  lab: Uint8Array;
  colors: [number, number, number, number][];
  names: Record<number, string>;
  filled: number;                         // voxels set — 0 means the SEG missed the grid
}

export interface LoadOpts {
  maxDim?: number;
  maxVoxels?: number;
  onProgress?: (msg: string, frac: number) => void;
  workerUrl?: string | URL;
}

let seq = 0;
const WORKER_URL = () => new URL("./remind-worker.js", import.meta.url);

function runWorker<T>(msg: Record<string, unknown>, opts: LoadOpts | undefined, want: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = new Worker(opts?.workerUrl ?? WORKER_URL());
    const id = ++seq;
    let result: T | undefined;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { t: string; id: number; msg?: string; frac?: number; error?: string };
      if (m.id !== id) return;
      if (m.t === "progress") { opts?.onProgress?.(m.msg ?? "", m.frac ?? 0); return; }
      if (m.t === want) { result = e.data as T; return; }
      if (m.t === "error") { w.terminate(); reject(new Error(m.error)); return; }
      if (m.t === "done") {
        w.terminate();
        result ? resolve(result) : reject(new Error(`worker finished without a ${want} message`));
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error("remind-worker: " + (e.message || e))); };
    w.postMessage({ ...msg, id });
  });
}

// Two concurrent series loads: enough to overlap a stalled listing with real transfer,
// few enough that the browser's per-host connection pool still gives each row's ranged
// GETs their parallelism (a US object is fetched in 8 pieces).
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

/** Load one image series (MR stack or multi-frame US) as an isotropic float volume. */
export function loadVolume(e: SeriesEntry, opts?: LoadOpts): Promise<LoadedVolume> {
  return slot(async () => {
    opts?.onProgress?.("listing…", 0.01);
    const keys = await s3ListKeys(e.u, e.bk);
    if (!keys.length) throw new Error(`no DICOM objects under ${e.bk}/${e.u}`);
    const r = await runWorker<{ vol: ArrayBuffer } & Omit<LoadedVolume, "vol">>(
      { op: "volume", keys, bucket: e.bk, modality: e.m, maxDim: opts?.maxDim, maxVoxels: opts?.maxVoxels },
      opts, "volume");
    return { ...r, vol: new Float32Array(r.vol) };
  });
}

/** Rasterise one SEG series onto an already-loaded row's grid. */
export function loadSeg(
  g: SegEntry, grid: { dims: [number, number, number]; ijkToRAS: number[] }, opts?: LoadOpts,
): Promise<LoadedLabelmap> {
  return slot(async () => {
    const keys = await s3ListKeys(g.u, g.bk);
    if (!keys.length) throw new Error(`no DICOM objects under ${g.bk}/${g.u}`);
    const r = await runWorker<{ lab: ArrayBuffer } & Omit<LoadedLabelmap, "lab">>(
      { op: "seg", key: keys[0], bucket: g.bk, grid }, opts, "labelmap");
    return { ...r, lab: new Uint8Array(r.lab) };
  });
}
