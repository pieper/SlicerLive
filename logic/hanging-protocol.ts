// Declarative, serializable hanging protocols: which viewports a reading layout shows, what each
// one displays, and in which plane. Plain data, so a protocol set is a JSON file a site can edit
// and distribute — the thing Slicer cannot do today (Discourse 28598: "it is not easy to create
// hanging protocols and distribute them to users", naming the DICOM Hanging Protocol IOD and
// OHIF's hpModule as the models).
//
// Deliberately NOT modality-specific. A viewport names image ROLES ("ct", "ac", "t1") as opaque
// strings; resolving a role to a series is the application's job, because only it knows the study.
// That keeps this module free of PET, MR or CT vocabulary and liftable into other viewers.
//
// Mapping onto OHIF's hpModule, for the Yunu delivery path: `roles` here play the part of
// `displaySetSelectors`, and `viewports[]` of a stage's `viewports[].displaySets`. OHIF's
// multi-stage protocols are deliberately omitted — a stage switch is just selecting another
// protocol from the list, which is what a reading-room tab strip already does.

/** A reslice plane, or a projection instead of a plane. */
export type ViewMode = "axial" | "coronal" | "sagittal" | "mip" | "3d";

export const VIEW_MODES: ViewMode[] = ["axial", "coronal", "sagittal", "mip", "3d"];

/** How a slab composites the voxels it spans. */
export type SlabMode = "mean" | "max" | "min";

export interface SlabSpec {
  thicknessMm: number;
  mode: SlabMode;
}

/** One viewport of a layout. */
export interface ViewportSpec {
  /** The image role shown as the background layer, e.g. "ct". Resolved by the application. */
  source: string;
  /** An optional second role blended over `source` — i.e. this viewport is a fusion. */
  overlay?: string;
  /** Reslice plane, or a projection. */
  view: ViewMode;
  /** Overrides the derived viewport title. */
  label?: string;
  /** Slab to open this viewport with. Absent means a single slice. */
  slab?: SlabSpec;
}

export interface HangingProtocol {
  id: string;
  label: string;
  /** Which reading-room screen this belongs to. Purely organisational — it groups the tab strip. */
  screen?: string;
  /** Viewports in row-major order. */
  viewports: ViewportSpec[];
  /** Grid width. Omitted means the application picks one (see `gridOf`). */
  cols?: number;
  /** How many timepoints the protocol is designed for. A comparison protocol repeats its
   *  viewports once per timepoint, newest first. Default 1. */
  timepoints?: number;
  /** Roles that must be present for the protocol to be offered. Derived from the viewports when
   *  omitted, which is almost always what you want; set it only to demand MORE than is displayed. */
  requires?: string[];
}

/** Every role a protocol displays, in first-appearance order. */
export function rolesOf(p: HangingProtocol): string[] {
  const out: string[] = [];
  for (const v of p.viewports) {
    for (const r of [v.source, v.overlay]) if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** The roles a protocol needs in order to be offered at all. */
export function requiredRoles(p: HangingProtocol): string[] {
  return p.requires ?? rolesOf(p);
}

/** Grid for a protocol: its own `cols` if given, else the squarest arrangement that is at least as
 *  wide as it is tall — a 4-viewport layout hangs 2x2, a 3-viewport one 3x1 rather than 2x2 with a
 *  hole. Rows are whatever that implies. */
export function gridOf(p: HangingProtocol): { cols: number; rows: number } {
  const n = p.viewports.length;
  if (n === 0) return { cols: 0, rows: 0 };
  const cols = p.cols ?? (n === 4 ? 2 : n);
  return { cols, rows: Math.ceil(n / cols) };
}

/** Default title for a viewport when it carries no explicit label. */
export function viewportTitle(v: ViewportSpec, names: Record<string, string> = {}): string {
  if (v.label) return v.label;
  const nm = (r: string) => names[r] ?? r.toUpperCase();
  const base = v.overlay ? `${nm(v.source)}+${nm(v.overlay)}` : nm(v.source);
  return v.view === "mip" || v.view === "3d" ? `${base} ${v.view.toUpperCase()}` : `${base} ${v.view}`;
}

/** A protocol is applicable when every role it requires is available, and the study has at least
 *  as many timepoints as it is designed for. */
export function isApplicable(p: HangingProtocol, available: Iterable<string>, timepoints = 1): boolean {
  const have = new Set(available);
  return (p.timepoints ?? 1) <= timepoints && requiredRoles(p).every((r) => have.has(r));
}

export function applicableProtocols(
  protocols: HangingProtocol[],
  available: Iterable<string>,
  timepoints = 1,
): HangingProtocol[] {
  const have = [...available];
  return protocols.filter((p) => isApplicable(p, have, timepoints));
}

/** Group protocols by `screen`, preserving list order within each group and the order in which the
 *  screens first appear. Protocols with no screen land under "". */
export function byScreen(protocols: HangingProtocol[]): { screen: string; protocols: HangingProtocol[] }[] {
  const out: { screen: string; protocols: HangingProtocol[] }[] = [];
  for (const p of protocols) {
    const s = p.screen ?? "";
    let g = out.find((x) => x.screen === s);
    if (!g) out.push(g = { screen: s, protocols: [] });
    g.protocols.push(p);
  }
  return out;
}

/** One viewport, bound to a timepoint. `timepoint` indexes the application's own list, 0 = newest,
 *  which is the firm convention in every reading layout: newer study on top. */
export interface ResolvedViewport extends ViewportSpec {
  timepoint: number;
  /** Row-major position in the grid. */
  row: number;
  col: number;
}

export interface ResolvedLayout {
  protocol: HangingProtocol;
  cols: number;
  rows: number;
  viewports: ResolvedViewport[];
}

/** Expand a protocol into concrete viewports for `timepoints` studies.
 *
 *  A single-timepoint protocol shown against several studies repeats its whole viewport block once
 *  per study, as successive grid rows, newest first — so a 2x2 single-study layout becomes 2x4 for
 *  a comparison without the protocol having to know. A protocol that declares `timepoints` > 1
 *  already describes every timepoint itself and is laid out verbatim. */
export function resolveLayout(p: HangingProtocol, timepoints = 1): ResolvedLayout {
  const { cols } = gridOf(p);
  const declared = p.timepoints ?? 1;
  const reps = declared > 1 ? 1 : Math.max(1, timepoints);
  const per = Math.ceil(p.viewports.length / Math.max(1, cols)); // grid rows per repetition
  const viewports: ResolvedViewport[] = [];
  for (let t = 0; t < reps; t++) {
    p.viewports.forEach((v, i) => {
      viewports.push({ ...v, timepoint: declared > 1 ? 0 : t, row: t * per + Math.floor(i / cols), col: i % cols });
    });
  }
  return { protocol: p, cols, rows: reps * per, viewports };
}

export class ProtocolError extends Error {}

/** Validate one protocol, throwing on anything that would produce a broken layout. Returns it, so
 *  it composes: `const p = validateProtocol(JSON.parse(text))`. */
export function validateProtocol(p: unknown): HangingProtocol {
  const bad = (m: string): never => { throw new ProtocolError(m); };
  if (typeof p !== "object" || p === null) bad("protocol must be an object");
  const o = p as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) bad("protocol.id must be a non-empty string");
  if (typeof o.label !== "string" || !o.label) bad(`protocol ${o.id}: label must be a non-empty string`);
  if (o.screen !== undefined && typeof o.screen !== "string") bad(`protocol ${o.id}: screen must be a string`);
  if (!Array.isArray(o.viewports) || o.viewports.length === 0) bad(`protocol ${o.id}: viewports must be a non-empty array`);
  if (o.cols !== undefined && (!Number.isInteger(o.cols) || (o.cols as number) < 1)) bad(`protocol ${o.id}: cols must be a positive integer`);
  if (o.timepoints !== undefined && (!Number.isInteger(o.timepoints) || (o.timepoints as number) < 1)) bad(`protocol ${o.id}: timepoints must be a positive integer`);
  if (o.requires !== undefined && (!Array.isArray(o.requires) || (o.requires as unknown[]).some((r) => typeof r !== "string"))) {
    bad(`protocol ${o.id}: requires must be an array of strings`);
  }
  (o.viewports as unknown[]).forEach((vv, i) => {
    const at = `protocol ${o.id} viewport ${i}`;
    if (typeof vv !== "object" || vv === null) bad(`${at}: must be an object`);
    const v = vv as Record<string, unknown>;
    if (typeof v.source !== "string" || !v.source) bad(`${at}: source must be a non-empty string`);
    if (v.overlay !== undefined && (typeof v.overlay !== "string" || !v.overlay)) bad(`${at}: overlay must be a non-empty string`);
    if (v.overlay === v.source) bad(`${at}: overlay must differ from source`);
    if (!VIEW_MODES.includes(v.view as ViewMode)) bad(`${at}: view must be one of ${VIEW_MODES.join(", ")}`);
    if (v.label !== undefined && typeof v.label !== "string") bad(`${at}: label must be a string`);
    if (v.slab !== undefined) {
      const s = v.slab as Record<string, unknown>;
      if (typeof s !== "object" || s === null) bad(`${at}: slab must be an object`);
      if (typeof s.thicknessMm !== "number" || !(s.thicknessMm >= 0)) bad(`${at}: slab.thicknessMm must be a non-negative number`);
      if (!["mean", "max", "min"].includes(s.mode as string)) bad(`${at}: slab.mode must be mean, max or min`);
    }
  });
  return p as HangingProtocol;
}

/** Validate a whole protocol set, rejecting duplicate ids. */
export function parseProtocols(json: unknown): HangingProtocol[] {
  if (!Array.isArray(json)) throw new ProtocolError("protocol set must be an array");
  const out = json.map(validateProtocol);
  const seen = new Set<string>();
  for (const p of out) {
    if (seen.has(p.id)) throw new ProtocolError(`duplicate protocol id: ${p.id}`);
    seen.add(p.id);
  }
  return out;
}
