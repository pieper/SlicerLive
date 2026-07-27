import type { RouletteManifest, SeriesEntry } from './types.js';
/** Load segroulette.json (rows of {c,s,m,col,...} plus optional stats). Cache-busted. */
export declare function loadManifest(url?: string): Promise<RouletteManifest>;
/** Pick a random series, collection-uniform. Optional predicate filters (e.g. CT only). */
export declare function pickRandom(manifest: RouletteManifest, filter?: (e: SeriesEntry) => boolean): SeriesEntry;
