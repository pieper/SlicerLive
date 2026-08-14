// SKETCH — ReMINDer expressed as a profile. Not wired up; nothing imports this.
// The working implementation is examples/remind/. This exists to test the SHAPE against a
// demo that already works: N frames, one row each, parts = surgical stages.
//
// What it demonstrates: the many-volume case, where every row is a different acquisition on
// a different grid and the only thing holding them together is patient space.
import type { FrameSpec, IdcProfile, RGB, RowSpec } from "./profile-shape.sketch.ts";

type Stage = "preop" | "pre_dura" | "post_dura" | "pre_imri" | "intraop";

interface RemindSeries {
  u: string; bk: string; m: "MR" | "US"; d: string; sn: number; n: number; b: number;
  tp: Stage;
  segs: { u: string; bk: string; s: string; b: number }[];
}
interface RemindCase { pid: string; bytes: number; series: RemindSeries[] }

// Two one-hue ORDINAL ramps rather than five categorical hues: the timeline is composite
// data — an ordered stage crossed with a modality — so hue says modality (blue MR / orange
// US) and lightness advances with the operation. See examples/remind/remind-data.ts for the
// validation this encodes; a profile that picks five arbitrary hues fails the same gates.
const STAGE: Record<Stage, { rank: number; short: string; color: RGB }> = {
  preop: { rank: 0, short: "PRE-OP", color: [0.62, 0.77, 0.96] },
  pre_dura: { rank: 1, short: "PRE-DURA", color: [0.94, 0.64, 0.46] },
  post_dura: { rank: 2, short: "POST-DURA", color: [0.85, 0.35, 0.15] },
  pre_imri: { rank: 3, short: "PRE-iMRI", color: [0.63, 0.24, 0.07] },
  intraop: { rank: 4, short: "INTRA-OP", color: [0.22, 0.53, 0.90] },
};

const STRUCTURE: Record<string, RGB> = {
  tumor: [0.89, 0.29, 0.28],
  tumor_residual: [0.93, 0.63, 0.00],
  ventricles: [0.22, 0.53, 0.90],
  cerebrum: [0.76, 0.76, 0.72],
  previous_resection_cavity: [0.11, 0.69, 0.48],
  tumor_target: [0.91, 0.48, 0.64],
};

export const remindProfile: IdcProfile<RemindCase, Stage> = {
  id: "remind",
  title: "ReMINDer — brain-tumour resection timeline",
  index: { url: "remind-index.json" },

  // ONE FRAME PER SERIES: each acquisition has its own grid — a 1 mm MR of the whole head
  // beside a 0.125 mm oblique ultrasound block. The SEGs of a series rasterise onto that
  // series' own grid, which is exactly why layers hang off the frame.
  frames: (c) => c.series.map((e): FrameSpec => ({
    id: e.u,
    image: { kind: "idc-series", uuid: e.u, bucket: e.bk, instances: e.n, bytes: e.b },
    layers: e.segs.map((g) => ({
      id: g.u,
      name: g.s,
      src: { kind: "idc-series", uuid: g.u, bucket: g.bk, bytes: g.b },
      color: STRUCTURE[g.s],
    })),
    label: e.m === "US" ? STAGE[e.tp].short : e.d,
    accent: STAGE[e.tp].color,
    // every frame is the same head in one operation — one registration group, the default
  })),

  // 1:1 with frames, ordered along the surgical timeline.
  rows: (c, frames) => frames.map((f, i): RowSpec => {
    const e = c.series[i];
    return { id: f.id, frame: f.id, label: f.label, accent: f.accent, rank: STAGE[e.tp].rank * 100 + e.sn };
  }),

  // Parts are the five surgical stages. The metric is BOOLEAN — "does this case have this
  // stage" — which is what makes the dashboard a coverage grid rather than a chart.
  parts: {
    order: Object.keys(STAGE) as Stage[],
    label: (p) => STAGE[p].short,
    color: (p) => STAGE[p].color,
    metric: (c, p) => c.series.some((e) => e.tp === p),
    // locate: stages are not spatial, so nothing to jump to. Structures ARE, and in the real
    // implementation they are the jump chips — a hint that "part" may eventually need to be
    // two axes (a timeline axis and a structure axis) rather than one. Left unresolved on
    // purpose: the third collection should settle it, not this sketch.
  },

  caseMetrics: (c) => ({
    series: c.series.length,
    segmentations: c.series.reduce((n, e) => n + e.segs.length, 0),
    bytes: c.bytes,
  }),

  view: {
    compare: "images",              // rock/fade/toggle between two acquisitions
    suggestedRows: () => [],        // MARK only — the page fetches nothing on open
    tf: (f) => f.label.startsWith("PRE-") || f.label.includes("DURA") || f.label.includes("iMRI")
      ? { ramp: "amber", points: [[0, 0], [0.45, 0], [0.6, 0.07], [0.75, 0.3], [0.9, 0.66], [1, 1]] }
      : { ramp: "grey", points: [[0, 0], [0.45, 0], [0.6, 0.07], [0.75, 0.3], [0.9, 0.66], [1, 1]] },
    strip: "rows",
  },

  dashboard: {
    chart: "coverage",
    filters: [
      { id: "us3", label: "All three ultrasound stages", test: (c) =>
        new Set(c.series.filter((e) => e.m === "US").map((e) => e.tp)).size === 3 },
      { id: "residual", label: "Has residual-tumour label", test: (c) =>
        c.series.some((e) => e.segs.some((g) => g.s === "tumor_residual")) },
    ],
  },
};
