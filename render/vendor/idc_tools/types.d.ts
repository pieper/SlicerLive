/** A reconstructed image volume on an IJK grid, with the IJK->RAS mapping (row-major 4x4). */
export interface CTVolume {
    /** Scalars in C order, k (slice) slowest. Int16 = CT (HU) / MR (raw); Float32 = PET activity. */
    vol: Int16Array | Float32Array;
    /** [nx, ny, nz] */
    dims: [number, number, number];
    /** row-major 4x4 IJK->RAS (mm) */
    ijkToRAS: number[];
    /** display window width */
    win: number;
    /** display window level (center) */
    lev: number;
    dtype: 'int16' | 'float32';
    /** source modality label ('CT' | 'MR' | 'PET') */
    modality?: string;
}
/** A segmentation labelmap resampled onto the CT grid (value = DICOM SegmentNumber). */
export interface SegLabelmap {
    lab: Uint8Array;
    /** [segmentNumber, r, g, b] with r,g,b in 0..1 */
    colors: [number, number, number, number][];
    names: Record<number, string>;
}
/** One spinnable IDC series pair (compact keys match segroulette.json). */
export interface SeriesEntry {
    /** CT/MR/PET source series prefix (crdc_series_uuid) */
    c: string;
    /** SEG series prefix (optional) */
    s?: string;
    /** modality: 'CT' | 'MR' | 'PT' */
    m: string;
    /** IDC collection id */
    col: string;
    /** CT source bucket (defaults to idc-open-data) */
    cb?: string;
    /** SEG bucket */
    sb?: string;
    /** study instance UID (for an OHIF deep link) */
    st?: string;
    /** SEG series description */
    sd?: string;
    /** license string */
    lic?: string;
}
export interface RouletteManifest {
    rows: SeriesEntry[];
    stats?: any;
}
export interface LoadProgress {
    frac: number;
    msg: string;
}
export interface LoadHandlers {
    /** fires as soon as the source volume is reconstructed (before the SEG) */
    onCT?: (ct: CTVolume) => void | Promise<void>;
    onLabelmap?: (seg: SegLabelmap) => void | Promise<void>;
    onProgress?: (p: LoadProgress) => void;
    /** streaming slice thumbnail (RGBA) for a progress mosaic, keyed by InstanceNumber */
    onThumb?: (n: number, w: number, h: number, rgba: ArrayBuffer) => void;
    onSliceCount?: (count: number) => void;
    onSegName?: (name: string) => void;
}
export interface LoadResult {
    ct: CTVolume;
    seg?: SegLabelmap;
    entry?: SeriesEntry;
}
export interface LoaderOptions {
    /** override the worker URL (defaults to ./idc-worker.js next to the built loader) */
    workerUrl?: string | URL;
}
