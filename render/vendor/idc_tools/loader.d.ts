import type { LoadHandlers, LoadResult, SegLabelmap, SeriesEntry, LoaderOptions } from './types.js';
/** Load one series (and its SEG, if present) by manifest entry. */
export declare function loadSeries(entry: SeriesEntry, handlers?: LoadHandlers, opts?: LoaderOptions): Promise<LoadResult>;
/** Decode JUST a segmentation onto a grid the caller already has (the decoded image volume's
 *  { dims, ijkToRAS }) — for switching which SEG is shown without re-downloading the images.
 *  Private short-lived worker. Returns null when the prefix holds no DICOM. */
export declare function loadSegmentation(prefix: string, bucket: string,
    ctLike: { dims: [number, number, number]; ijkToRAS: number[] },
    handlers?: Pick<LoadHandlers, 'onProgress' | 'onSegError' | 'onSegName'>,
    opts?: LoaderOptions): Promise<SegLabelmap | null>;
/** Decode ONE representative (middle) slice of a series into a small grayscale preview (private
 *  short-lived worker). Returns null when there's no DICOM / no pixel data / decode fails. */
export declare function loadThumbnail(prefix: string, bucket: string, modality: string, opts?: LoaderOptions): Promise<{
    vol: Int16Array | Float32Array;
    dims: [number, number, number];
    win: number;
    lev: number;
} | null>;
/** Spin a random series from the manifest and load it. `filter` narrows the pool (e.g. CT only). */
export declare function spinRandom(handlers?: LoadHandlers, opts?: LoaderOptions & {
    manifestUrl?: string;
    filter?: (e: SeriesEntry) => boolean;
}): Promise<LoadResult>;
