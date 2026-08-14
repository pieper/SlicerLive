// SKETCH — not wired up, not imported by anything, not a specification.
//
// This is what an IDC Explorer profile might look like, written down so the two existing
// demos can be sketched against it (remind.sketch.ts, spine.sketch.ts) and the shape can be
// argued with before any of it is built. Per PLAN.md the real interface is written at step 6,
// AFTER a generic viewer exists — written now it is a guess from two data points.
//
// The one structural claim it does encode is the frames/rows/parts model from README.md:
//   frame = a sampling grid (owns renderers, TF, residency); overlays attach HERE
//   row   = (frame, layer-selection) — what the viewer stacks
//   part  = a named sub-case unit — the dashboard axis, the jump chip, the deep-link unit
//
// Deliberately absent: anything describing how the index is BUILT. That is offline Python
// which cannot run in a browser; the index FORMAT is the seam between the two. A field here
// describing a script this code cannot execute would rot.

export type Vec3 = [number, number, number];
export type RGB = [number, number, number];

/** Where a frame's pixels come from. v1 is IDC-native; ZarrRef is the seam for the deferred
 *  external-results case (spine's SPINEPS masks live in a JS2 bucket, not in IDC). */
export type SourceRef =
  | { kind: "idc-series"; uuid: string; bucket?: string; instances?: number; bytes?: number }
  | { kind: "zarr"; base: string; name: string };

/** One sampling grid. Rows sharing a frame share a SliceRenderer — a consequence of the
 *  model, not a flag. Layers are rasterised ONTO this grid, which is why they live here. */
export interface FrameSpec {
  id: string;
  image: SourceRef;
  layers?: { id: string; name: string; src: SourceRef; color?: RGB }[];
  /** Progressive resolution: coarse first, refine in the background (spine's ct_low → ct_med). */
  ladder?: SourceRef[];
  label: string;
  accent?: RGB;
  /** Frames sharing a group share one RAS focus. Default: all frames (they are registered).
   *  Set this when a cohort mixes body parts and a single crosshair would be a lie. */
  registrationGroup?: string;
}

/** What the viewer stacks vertically. 1:1 with frames when the comparison axis is the
 *  acquisition (remind); N:1 onto one frame when it is the overlay (spine). */
export interface RowSpec {
  id: string;
  frame: string;
  /** undefined = every layer of the frame. spine's two rows differ only in this. */
  layers?: string[];
  label: string;
  accent?: RGB;
  rank: number;
}

/** A row after its pixels have landed — what `parts.locate` gets to look at. */
export interface LoadedRow {
  id: string;
  dims: Vec3;
  ijkToRAS: number[];
  rasLo: Vec3;
  rasHi: Vec3;
  labels: Map<number, { name: string; voxels: number; centroid: Vec3; lo: Vec3; hi: Vec3 }>;
}

export interface IdcProfile<Case = unknown, PartId extends string = string> {
  id: string;
  title: string;
  index: { url: string };

  frames(c: Case): FrameSpec[];
  rows(c: Case, frames: FrameSpec[]): RowSpec[];

  /** Named sub-case units. The dashboard axis, the viewer's jump chips and the deep-link
   *  unit, all at once — which is what makes spine's parallel-coordinates chart and
   *  ReMINDer's coverage grid two renderings of ONE shape: case × part → value. */
  parts?: {
    /** A function, not an array, so variable-cardinality longitudinal cohorts survive. */
    order: PartId[] | ((c: Case) => PartId[]);
    label(p: PartId): string;
    color(p: PartId): RGB;
    /** PURE over the index — never needs voxels. Scalar → parallel axis; boolean → coverage
     *  cell. Anything requiring pixels is the worker's job, computed at index-build time. */
    metric?(c: Case, p: PartId): number | boolean | null;
    /** Where the part is, once pixels exist — drives "jump to it" and camera framing. */
    locate?(row: LoadedRow, p: PartId): { centroid: Vec3; lo: Vec3; hi: Vec3 } | null;
  };

  /** Tiles, table columns, sort keys. Pure over the index, same rule as `metric`. */
  caseMetrics?(c: Case): Record<string, number | string | null>;

  view?: {
    /** remind compares images (rock/fade); spine compares overlays over one image, where
     *  rocking is meaningless and per-label visibility carries the signal instead. */
    compare?: "images" | "overlays" | "none";
    /** Rows to MARK as suggested. Returning [] means the page fetches nothing on open —
     *  which is the default, and the right one: a case can be 780 MB. */
    suggestedRows?(c: Case): string[];
    tf?(f: FrameSpec): { ramp: string; points: [number, number][] };
    volumeOpacity?: number;
    overlayOpacity?: number;
    linkCameras?: boolean;
    /** What the bottom strip lists: spine's vertebral levels, or remind's series. */
    strip?: "parts" | "rows" | "none";
  };

  dashboard?: {
    chart: "coverage" | "parallel" | "swimlane" | "custom";
    filters?: { id: string; label: string; test(c: Case): boolean }[];
    blurb?(): string;
  };
}

/** Dashboard ⇄ drilldown, generalized from spine's ad-hoc dialect. */
export type DrillMessage =
  | { type: "jumpPart"; id: string }
  | { type: "stepPart"; delta: number }
  | { type: "closeDrill" };
