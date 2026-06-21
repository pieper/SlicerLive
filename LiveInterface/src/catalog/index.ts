export type {
  Source,
  SceneCondition,
  SceneCapabilities,
  SceneDelta,
  LayoutDelta,
  VrPresetDelta,
  WlPresetDelta,
  CameraDelta,
  SegmentVisDelta,
  CatalogEntry,
} from './types.js';
export { matchesCondition, applicableEntries } from './types.js';

export { layoutsCatalog } from './layouts.js';
export { vrPresetsCatalog } from './vrPresets.js';
export { wlPresetsCatalog } from './wlPresets.js';
export { cameraPresetsCatalog } from './cameraPresets.js';
export { segVisBundlesCatalog } from './segVisBundles.js';

import type { CatalogEntry, SceneDelta, SceneCapabilities } from './types.js';
import { applicableEntries } from './types.js';
import { layoutsCatalog } from './layouts.js';
import { vrPresetsCatalog } from './vrPresets.js';
import { wlPresetsCatalog } from './wlPresets.js';
import { cameraPresetsCatalog } from './cameraPresets.js';
import { segVisBundlesCatalog } from './segVisBundles.js';

/** All catalog entries across all categories, unfiltered. */
export const fullCatalog: readonly CatalogEntry<SceneDelta>[] = [
  ...layoutsCatalog,
  ...vrPresetsCatalog,
  ...wlPresetsCatalog,
  ...cameraPresetsCatalog,
  ...segVisBundlesCatalog,
];

/** Catalog entries applicable to the given scene capabilities, across all categories. */
export function applicableCatalog(caps: SceneCapabilities): CatalogEntry<SceneDelta>[] {
  return applicableEntries(fullCatalog, caps);
}

/** Applicable entries grouped by category — convenient for the snowflake's
 *  inner-ring layout where each category becomes a major branch. */
export function applicableByCategory(
  caps: SceneCapabilities,
): Record<string, CatalogEntry<SceneDelta>[]> {
  const out: Record<string, CatalogEntry<SceneDelta>[]> = {};
  for (const entry of applicableCatalog(caps)) {
    (out[entry.category] ??= []).push(entry);
  }
  return out;
}
