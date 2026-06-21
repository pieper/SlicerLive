// LiveInterface state-catalog — schema.
//
// The catalog is a static, agent-free v0 of the LiveInterface "snowflake" UX
// (see SlicerLive docs/SLICERLIVE.md §1b). Each entry describes a candidate
// state-transition that LiveInterface can surface as a branch in the snowflake:
//
//   1. The renderer FORKS the current LiveScene.
//   2. Applies the entry's `delta` to the fork.
//   3. Renders a live mini-viewport of the fork on the user's actual loaded
//      data (NEVER a pre-baked thumbnail — the preview IS the truth).
//
// "Mix the selected ones" composes two deltas onto one fork before rendering.

/** Provenance for a catalog entry — where in slicer-skill it was mined from. */
export interface Source {
  kind: 'slicer-source' | 'slicer-docs' | 'discourse' | 'tutorial' | 'authored';
  /** Repo-relative path inside slicer-source/ (or doc URL). */
  path?: string;
  /** Optional symbol within the path (enum value, function, etc.). */
  symbol?: string;
  /** Short context describing why this source justifies the entry. */
  note?: string;
}

/** Predicate gating whether an entry should surface for the current LiveScene. */
export interface SceneCondition {
  /** At least one volume node loaded. */
  hasVolume?: boolean;
  hasSegmentation?: boolean;
  hasModel?: boolean;
  hasPlot?: boolean;
  hasTable?: boolean;
  /** Restrict to a specific modality on the active volume. */
  modality?: 'CT' | 'MR' | 'US' | 'DTI' | 'PET' | 'uCT';
  /** Minimum number of segments — for bundles that only make sense with N segments. */
  minSegments?: number;
}

// ---------------------------------------------------------------------------
// Deltas — discriminated by `kind`. Add a new variant per category.
// ---------------------------------------------------------------------------

/** Layout change — sets vtkMRMLLayoutNode::ViewArrangement. */
export interface LayoutDelta {
  kind: 'layout';
  /** Slicer's SlicerLayout enum value. */
  layoutId: number;
  /** The C++ enum symbol, for trace/debug. */
  layoutSymbol: string;
}

/** Volume-rendering preset change — applies a named VolumeProperty to the
 *  active volume's display node. The catalog references the preset by NAME;
 *  the renderer resolves the name to a `vtkMRMLVolumePropertyNode` against a
 *  bundled `presets.xml` (Slicer ships ~31 presets there). Keeping the catalog
 *  light: the actual transfer-function XML lives once in presets.xml, not
 *  duplicated per entry. */
export interface VrPresetDelta {
  kind: 'vr-preset';
  /** Matches the `name=` attribute on `<VolumeProperty>` in presets.xml. */
  presetName: string;
}

/** Window/Level preset — sets `window` and `level` on the active volume's
 *  ScalarVolumeDisplayNode. Mined from Slicer's
 *  `Modules/Loadable/Volumes/Resources/VolumeDisplayPresets.json`. */
export interface WlPresetDelta {
  kind: 'wl-preset';
  /** Display name (e.g. "CT-Bone"). */
  presetName: string;
  /** Window width (intensity range mapped to display). */
  window: number;
  /** Window center (display value at the midpoint). */
  level: number;
}

/** Camera preset — orientation of the 3D camera. Positions are unit direction
 *  vectors in RAS from focal point; the renderer multiplies by current camera
 *  distance to preserve zoom across switches. */
export interface CameraDelta {
  kind: 'camera';
  /** Unit direction in RAS (from focal toward camera). */
  position: [number, number, number];
  /** View-up vector in RAS. */
  viewUp: [number, number, number];
  /** Short symbol for tracing (A, P, S, I, R, L, AS, RAS, etc.). */
  symbol: string;
}

/** Segmentation visibility bundle — bulk show/hide/opacity tweaks across all
 *  segments. Bundles are coarse for v0: all-on, all-off, solo-first, fade-others. */
export interface SegmentVisDelta {
  kind: 'segment-vis';
  /** Bundle kind dispatched in the host. */
  mode: 'all-on' | 'all-off' | 'solo-first' | 'fade-others';
}

/** Discriminated union — extend as new categories are added. */
export type SceneDelta =
  | LayoutDelta
  | VrPresetDelta
  | WlPresetDelta
  | CameraDelta
  | SegmentVisDelta;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface CatalogEntry<D extends SceneDelta = SceneDelta> {
  /** Category key (matches the file the entry lives in). */
  category: 'layout' | 'vr-preset' | 'wl-preset' | 'camera' | 'segment-vis';
  /** Stable kebab-case identifier — used in URLs, telemetry, snowflake hashes. */
  id: string;
  /** Short display label (1–5 words). */
  label: string;
  /** Longer human-readable description. */
  description?: string;
  /** Precondition — omitted = always applicable. */
  appliesWhen?: SceneCondition;
  /** The state transition. */
  delta: D;
  /** Provenance — at least one entry expected. */
  source: Source[];
}

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

/** Minimal capability summary of a LiveScene — what the catalog filter needs
 *  to know. The full LiveScene API is richer; this is the projection. */
export interface SceneCapabilities {
  hasVolume: boolean;
  hasSegmentation: boolean;
  hasModel: boolean;
  hasPlot: boolean;
  hasTable: boolean;
  /** Modality of the foregrounded/active volume, if any. */
  activeModality?: SceneCondition['modality'];
  /** Number of segments on the active segmentation node. */
  segmentCount?: number;
}

export function matchesCondition(
  condition: SceneCondition | undefined,
  caps: SceneCapabilities,
): boolean {
  if (!condition) return true;
  if (condition.hasVolume && !caps.hasVolume) return false;
  if (condition.hasSegmentation && !caps.hasSegmentation) return false;
  if (condition.hasModel && !caps.hasModel) return false;
  if (condition.hasPlot && !caps.hasPlot) return false;
  if (condition.hasTable && !caps.hasTable) return false;
  if (condition.modality && caps.activeModality !== condition.modality) return false;
  if (condition.minSegments != null && (caps.segmentCount || 0) < condition.minSegments) return false;
  return true;
}

/** Filter a catalog to the entries that match the current scene's capabilities. */
export function applicableEntries<D extends SceneDelta>(
  entries: readonly CatalogEntry<D>[],
  caps: SceneCapabilities,
): CatalogEntry<D>[] {
  return entries.filter((e) => matchesCondition(e.appliesWhen, caps));
}
