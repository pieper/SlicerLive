// SKETCH — spine-review expressed as a profile. Not wired up; nothing imports this.
// The working implementation is examples/spine/. This exists to test the SHAPE against the
// case that a naive "one row per series" model gets WRONG.
//
// What it demonstrates: ONE frame, TWO rows. Both rows are the same CT on the same grid;
// they differ only in which labelmap layer they select. That is why "rows sharing a frame
// share a SliceRenderer" is a consequence of the model rather than a configuration flag —
// and why overlays attach to frames, not to rows.
//
// NOTE: this profile needs the DEFERRED external-results join. The SPINEPS masks are not in
// IDC — they were computed on Jetstream2 and live in a public JS2 bucket — so `image` and
// the two layers span two source kinds. v1 is IDC-native, so this sketch is aspirational.
// Before anyone implements it: examples/spine/worker/build_cases.py hardcodes a scratchpad
// path and is currently unreproducible.
import type { FrameSpec, IdcProfile, RGB, RowSpec } from "./profile-shape.sketch.ts";

interface SpineCase {
  pid: string;
  collection: "mets" | "myeloma";
  compare?: { mean_dice_same?: number; n_agree?: number; n_ref_labels?: number; n_shifted?: number };
  /** per-vertebra: d = Dice vs the same-named reference level, b = best-matching level */
  levels?: Record<string, { d: number; b: string; s: number; v: number; db?: number }>;
}

const LEVELS = [
  "C1", "C2", "C3", "C4", "C5", "C6", "C7",
  "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13",
  "L1", "L2", "L3", "L4", "L5", "L6", "S1", "S2", "S3", "Cocc",
] as const;
type Level = typeof LEVELS[number];

const METHOD: Record<"spineps" | "ref", RGB> = {
  spineps: [0.95, 0.60, 0.20],   // warm
  ref: [0.30, 0.65, 0.95],       // cool
};

// Adjacent vertebrae must never share a colour — a level MISMATCH between the two rows has to
// read as a colour mismatch. That is the whole visual argument of the demo.
const levelColor = (name: string): RGB => {
  const RAMP: RGB[] = [
    [0.85, 0.42, 0.42], [0.42, 0.75, 0.42], [0.42, 0.55, 0.90], [0.90, 0.78, 0.35],
    [0.72, 0.45, 0.85], [0.35, 0.80, 0.80], [0.90, 0.55, 0.25], [0.55, 0.72, 0.30],
  ];
  return RAMP[LEVELS.indexOf(name as Level) % RAMP.length];
};

const BUCKET = "https://js2.jetstream-cloud.org:8001/swift/v1/spine-review/";

export const spineProfile: IdcProfile<SpineCase, Level> = {
  id: "spine",
  title: "SPINEPS vs IDC reference — per-vertebra discrepancy",
  index: { url: BUCKET + "cases.json" },

  // ONE frame: the CT, carrying BOTH labelmaps as layers. They are both rasterised onto the
  // CT's grid, so they belong to the frame. The ladder is spine's real low→med progression.
  frames: (c): FrameSpec[] => [{
    id: "ct",
    image: { kind: "zarr", base: `${BUCKET}${c.collection}/${c.pid}/zarr/`, name: "ct_med" },
    ladder: [{ kind: "zarr", base: `${BUCKET}${c.collection}/${c.pid}/zarr/`, name: "ct_low" }],
    layers: [
      { id: "spineps", name: "SPINEPS", src: { kind: "zarr", base: `${BUCKET}${c.collection}/${c.pid}/zarr/`, name: "spineps_med" }, color: METHOD.spineps },
      { id: "ref", name: "reference", src: { kind: "zarr", base: `${BUCKET}${c.collection}/${c.pid}/zarr/`, name: "ref_med" }, color: METHOD.ref },
    ],
    label: "CT",
  }],

  // TWO rows over that ONE frame, each selecting a single layer. This is the whole point.
  rows: (): RowSpec[] => [
    { id: "spineps", frame: "ct", layers: ["spineps"], label: "SPINEPS", accent: METHOD.spineps, rank: 0 },
    { id: "ref", frame: "ct", layers: ["ref"], label: "REFERENCE", accent: METHOD.ref, rank: 1 },
  ],

  // Parts are vertebral levels, and unlike ReMINDer's stages the metric is SCALAR — which is
  // the only difference that turns the coverage grid into a parallel-coordinates chart.
  // Both are case × part → value.
  parts: {
    order: [...LEVELS],
    label: (p) => p,
    color: levelColor,
    metric: (c, p) => {
      const d = c.levels?.[p]?.d;
      return d == null ? null : 1 - d;         // 0 = perfect agreement, 1 = no overlap
    },
    // levels ARE spatial — this is what the level buttons jump to, and what the extent
    // control frames. The real implementation computes centroid + RAS bbox per label in one
    // pass (spine-compare-scene.ts levelGeometry).
    locate: (row, p) => {
      const g = [...row.labels.values()].find((l) => l.name === p);
      return g ? { centroid: g.centroid, lo: g.lo, hi: g.hi } : null;
    },
  },

  caseMetrics: (c) => ({
    mean_dice: c.compare?.mean_dice_same ?? null,
    agree: c.compare?.n_agree ?? null,
    shifted: c.compare?.n_shifted ?? null,
    collection: c.collection,
  }),

  view: {
    // rocking two labelmaps over ONE identical CT would show nothing move; the level palette
    // and per-label visibility carry the signal instead. A genuine fork, one word wide.
    compare: "overlays",
    suggestedRows: () => ["spineps", "ref"],   // both rows are one download — cheap here
    strip: "parts",                            // the level buttons
  },

  dashboard: {
    chart: "parallel",
    filters: [
      { id: "bad", label: "Has discrepancy (>0.5 at any level)", test: (c) =>
        Object.values(c.levels ?? {}).some((l) => 1 - l.d > 0.5) },
      { id: "shift", label: "Label shifted", test: (c) => (c.compare?.n_shifted ?? 0) > 0 },
    ],
  },
};
