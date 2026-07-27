import type { LoadHandlers, LoadResult, SeriesEntry, LoaderOptions } from './types.js';
/** Load one series (and its SEG, if present) by manifest entry. */
export declare function loadSeries(entry: SeriesEntry, handlers?: LoadHandlers, opts?: LoaderOptions): Promise<LoadResult>;
/** Spin a random series from the manifest and load it. `filter` narrows the pool (e.g. CT only). */
export declare function spinRandom(handlers?: LoadHandlers, opts?: LoaderOptions & {
    manifestUrl?: string;
    filter?: (e: SeriesEntry) => boolean;
}): Promise<LoadResult>;
