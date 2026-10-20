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
    /** Layer 0 of the label stack (the whole labelmap when nothing overlaps). */
    lab: Uint8Array;
    /** Layers 1..n of the stack, same grid as `lab`. DICOM SEG segments may overlap and one
     *  label per voxel cannot hold that, so overlapping segments are decoded into separate
     *  layers and composited by the renderer. Empty for the ordinary non-overlapping SEG. */
    extra?: Uint8Array[];
    /** [segmentNumber, r, g, b] with r,g,b in 0..1 */
    colors: [number, number, number, number][];
    names: Record<number, string>;
    /** per-segment coded terminology (DICOM SEG SegmentedProperty* / AnatomicRegion), keyed by SegmentNumber */
    terminology?: Record<number, SegmentTerminology>;
    /** What a single-label volume could not represent: DICOM SEG allows segments to overlap,
     *  and the frame written last wins. `voxels` counts the overwritten voxels, `pairs` names
     *  the segment numbers that collided. */
    overlap?: {
        voxels: number;
        pairs: [number, number][];
        /** How many label layers the stack needed (1 = no overlap). */
        layers?: number;
        /** Segments that wanted a layer past the cap; where they overlap, the topmost wins. */
        crowded?: number;
    };
}
export interface CodedEntry { scheme: string; value: string; meaning: string }
export interface SegmentTerminology {
    category: CodedEntry | null;
    type: CodedEntry | null;
    typeModifier: CodedEntry | null;
    region: CodedEntry | null;
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
    /** the FIRST decoded slice at full size (RGBA), so a reader can show a real image while
     *  the rest of the series is still downloading */
    onPreview?: (w: number, h: number, rgba: ArrayBuffer) => void;
    onSliceCount?: (count: number) => void;
    /** The series geometry, plus the FIRST decoded slice's 33rd/66th percentile and its
     *  window/level — what a placeholder volume needs to match the study. Fires once, just
     *  before that first slice. */
    onGeometry?: (g: SeriesGeometry & { p33: number; p66: number; win: number; lev: number }) => void;
    /** streaming geometry path: one decoded slice, already at its index in the volume */
    onSlice?: (k: number, px: Float32Array) => void;
    /** the first slice's window/level, so a scene built before the data can re-window early */
    onVOI?: (win: number, lev: number) => void;
    /** every image slice has been posted (`placed` of `expected` instances carried pixels) */
    onVolumeDone?: (placed: number, expected: number, dropped: number, outside: number) => void;
    /** What the ACTUAL DICOM headers say about the series' geometry: whether its instances make
     *  one regular volume, and what is wrong when they don't. Fires on the assemble-then-show
     *  path, before `onCT`, whenever there is something to report. A `stack` series has been
     *  stacked in InstanceNumber order and has no trustworthy third dimension: show the images,
     *  not reformats, and no segmentation. */
    onGeomCheck?: (g: GeomCheck) => void;
    onSegError?: (message: string) => void;
    onSegName?: (name: string) => void;
}
/** Verdict on a series' geometry, measured from its own headers (see LoadHandlers.onGeomCheck). */
export interface GeomCheck {
    /** true = NOT one regular volume; the volume is a stack of images in InstanceNumber order */
    stack: boolean;
    /** why it is not a volume (duplicate positions, uneven spacing, cross-plane drift) */
    reasons: string[];
    /** instances left out of the volume (scouts, a second image size) */
    notes: string[];
    kept: number;
    total: number;
    /** median gap between slice positions, mm */
    spacing: number;
}
export interface LoadResult {
    ct: CTVolume;
    seg?: SegLabelmap;
    entry?: SeriesEntry;
}
export interface SeriesGeometry {
    /** ImagePositionPatient (LPS) of the slice at the minimum slice position = voxel (0,0,0) */
    origin: [number, number, number];
    /** ImageOrientationPatient: 6 direction cosines */
    iop: number[];
    /** distance between slice planes, mm */
    spacing: number;
    dims: [number, number, number];
    /** index->RAS for the same volume, for the SEG decoder */
    ijkToRAS: number[];
}
export interface LoaderOptions {
    /** override the worker URL (defaults to ./idc-worker.js next to the built loader) */
    workerUrl?: string | URL;
    /** Known series geometry (from the IDC index). Switches the worker to the streaming path:
     *  each slice is posted at its own index as it decodes, and the SEG decodes alongside. */
    geometry?: SeriesGeometry;
}
