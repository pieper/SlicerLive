// Synthetic DICOM instances, for tests that need real Part 10 bytes without a network or a fixture
// file.
//
// This was a template string inside harness/dicom.browser.test.ts, evaluated in a browser tab. It
// moves here so T1 tests (the MRCOM writer and reader) and T3 browser tests build the SAME fixture
// from one place - otherwise the geometry oracle quietly forks, and the browser test's expected
// ijkToRAS is the only independently validated geometry in the suite.
//
// The default series is deliberately that fixture: 4 x 3 x 5, PixelSpacing [0.8, 0.5], slices 2 mm
// apart from z = 5, whose expected ijkToRAS is
//   [-0.5, 0, 0, 10,  0, -0.8, 0, 20,  0, 0, 2, 5,  0, 0, 0, 1]
// and is asserted by harness/dicom.browser.test.ts against the real reconstruction path.
//
// DOM-free apart from needing a dcmjs instance, which the caller passes in - so the same code runs
// in Deno (vendored ESM build) and in a page (the UMD global).

/** The subset of dcmjs this module uses. Passed in, so Deno and the browser both work. */
export interface DcmjsLike {
  data: {
    DicomDict: new (meta: Record<string, unknown>) => {
      dict: Record<string, unknown>;
      write(): ArrayBuffer;
    };
    DicomMetaDictionary: {
      denaturalizeDataset(dataset: Record<string, unknown>): Record<string, unknown>;
    };
  };
}

export interface SyntheticSeriesOptions {
  /** Columns. Default 4. */
  nx?: number;
  /** Rows. Default 3. */
  ny?: number;
  /** Number of instances. Default 5. */
  slices?: number;
  /** Root UID; instances are `<uid>.<k>`. Default is time-based and unique per call. */
  uid?: string;
  modality?: string;
  seriesDescription?: string;
  patientName?: string;
  patientID?: string;
  /** [rowSpacing, columnSpacing], as DICOM orders it. Default [0.8, 0.5]. */
  pixelSpacing?: [number, number];
  /** Millimetres between slices. Default 2. */
  sliceThickness?: number;
  /** ImagePositionPatient of the first slice. Default [-10, -20, 5]. */
  origin?: [number, number, number];
  /** Written as-is; use "1.2.840.10008.1.2" to exercise the implicit VR path. */
  transferSyntaxUID?: string;
  /** Per-voxel values. Default `k * 1000 + p - 1024`, i.e. distinguishable per slice. */
  voxel?: (sliceIndex: number, pixelIndex: number) => number;
}

export interface SyntheticSeries {
  /** Part 10 bytes, one per instance, in geometric order. */
  buffers: ArrayBuffer[];
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUIDs: string[];
  sopClassUID: string;
  /** [nx, ny, nz], as mrson orders dims. */
  dims: [number, number, number];
  /** The geometry the reconstruction should produce, row-major 4x4. */
  ijkToRAS: number[];
}

/**
 * The default fixture's geometry, as a shared oracle.
 *
 * harness/dicom.browser.test.ts builds the same series inside the page (it cannot import a module
 * into an eval'd string) and asserts against THIS constant, while
 * logic/readers/synthetic-dicom.test.ts asserts that reconstructSeries() produces it from the
 * builder's bytes. So the in-page copy and this module are pinned to one value in one place, and a
 * change to either side fails rather than drifting.
 */
export const VALIDATED_FIXTURE = {
  dims: [4, 3, 5] as [number, number, number],
  ijkToRAS: [-0.5, 0, 0, 10, 0, -0.8, 0, 20, 0, 0, 2, 5, 0, 0, 0, 1],
  instances: 5,
  modality: "CT",
};

const CT_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.2";
const SEG_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.66.4";

/**
 * Build a synthetic CT series.
 *
 * @param dcmjs a dcmjs instance
 * @param options see SyntheticSeriesOptions; the defaults are the validated 4x3x5 fixture
 * @returns the instance bytes and the geometry they should reconstruct to
 */
export function makeDicomSeries(
  dcmjs: DcmjsLike,
  options: SyntheticSeriesOptions = {},
): SyntheticSeries {
  const nx = options.nx ?? 4;
  const ny = options.ny ?? 3;
  const slices = options.slices ?? 5;
  const uid = options.uid ?? "1.2.826.0.1.3680043.8.498." + Date.now();
  const [rowSpacing, colSpacing] = options.pixelSpacing ?? [0.8, 0.5];
  const thickness = options.sliceThickness ?? 2;
  const origin = options.origin ?? [-10, -20, 5];
  const transferSyntaxUID = options.transferSyntaxUID ?? "1.2.840.10008.1.2.1";
  const voxel = options.voxel ?? ((k, p) => k * 1000 + p - 1024);

  const studyInstanceUID = uid + ".study";
  const sopInstanceUIDs: string[] = [];
  const buffers: ArrayBuffer[] = [];

  for (let k = 0; k < slices; k++) {
    const pixels = new Int16Array(nx * ny);
    for (let p = 0; p < nx * ny; p++) pixels[p] = voxel(k, p);
    const sopInstanceUID = `${uid}.${k}`;
    sopInstanceUIDs.push(sopInstanceUID);

    const dataset: Record<string, unknown> = {
      SOPClassUID: CT_SOP_CLASS,
      SOPInstanceUID: sopInstanceUID,
      SeriesInstanceUID: uid,
      StudyInstanceUID: studyInstanceUID,
      Modality: options.modality ?? "CT",
      SeriesDescription: options.seriesDescription ?? "TestCT",
      PatientName: options.patientName ?? "Test^Patient",
      PatientID: options.patientID ?? "TEST-1",
      Rows: ny,
      Columns: nx,
      BitsAllocated: 16,
      BitsStored: 16,
      HighBit: 15,
      PixelRepresentation: 1,
      SamplesPerPixel: 1,
      PhotometricInterpretation: "MONOCHROME2",
      PixelSpacing: [rowSpacing, colSpacing],
      SliceThickness: thickness,
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      ImagePositionPatient: [origin[0], origin[1], origin[2] + k * thickness],
      RescaleSlope: 1,
      RescaleIntercept: 0,
      InstanceNumber: k + 1,
      PixelData: pixels.buffer,
      // PixelData's dictionary VR is "ox" (OB or OW, depending on BitsAllocated), so dcmjs has to
      // be told which. 16-bit samples are OW. Without this it warns and guesses.
      _vrMap: { PixelData: "OW" },
      _meta: {},
    };
    buffers.push(writeInstance(dcmjs, dataset, transferSyntaxUID));
  }

  // LPS -> RAS flips x and y, so the in-plane spacings come out negative. ImagePositionPatient is
  // the first voxel's centre, also flipped.
  const ijkToRAS = [
    -colSpacing, 0, 0, -origin[0],
    0, -rowSpacing, 0, -origin[1],
    0, 0, thickness, origin[2],
    0, 0, 0, 1,
  ];

  return {
    buffers,
    studyInstanceUID,
    seriesInstanceUID: uid,
    sopInstanceUIDs,
    sopClassUID: CT_SOP_CLASS,
    dims: [nx, ny, slices],
    ijkToRAS,
  };
}

export interface SyntheticSegOptions {
  /** The series this segmentation is drawn on. */
  source: SyntheticSeries;
  uid?: string;
  segments?: { labelValue: number; label: string }[];
  /** Which voxels belong to a segment. Default: a block in the middle of every slice. */
  mask?: (segmentIndex: number, sliceIndex: number, x: number, y: number) => boolean;
  transferSyntaxUID?: string;
}

export interface SyntheticSeg {
  buffer: ArrayBuffer;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  sopClassUID: string;
  /** The per-frame bitmaps, so a test can assert against them without decoding the instance. */
  frames: Uint8Array[];
}

/**
 * Build a synthetic DICOM SEG over a series from makeDicomSeries.
 *
 * Enough for MRCOM's purposes: it carries `ReferencedSeriesSequence`, a `SegmentSequence` and
 * bit-packed `BINARY` frames, so a bundle can reference it and a reader can see what it points at.
 * It is NOT a full SEG - no shared/per-frame functional group geometry - because MRCOM embeds
 * segmentation voxels rather than resolving them in M1 (docs/MRCOM-PLAN.md section 6, M6).
 */
export function makeDicomSeg(
  dcmjs: DcmjsLike,
  options: SyntheticSegOptions,
): SyntheticSeg {
  const { source } = options;
  const uid = options.uid ?? source.seriesInstanceUID + ".seg";
  const segments = options.segments ?? [{ labelValue: 1, label: "Segment_1" }];
  const [nx, ny, nz] = source.dims;
  const mask = options.mask ??
    ((_s, _k, x, y) => x >= nx / 4 && x < (nx * 3) / 4 && y >= ny / 4 && y < (ny * 3) / 4);

  const frames: Uint8Array[] = [];
  const packed: number[] = [];
  let bitCount = 0;
  let current = 0;
  const pushBit = (bit: number) => {
    if (bit) current |= 1 << (bitCount % 8);
    bitCount++;
    if (bitCount % 8 === 0) {
      packed.push(current);
      current = 0;
    }
  };

  for (let s = 0; s < segments.length; s++) {
    for (let k = 0; k < nz; k++) {
      const frame = new Uint8Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const on = mask(s, k, x, y) ? 1 : 0;
          frame[y * nx + x] = on;
          pushBit(on);
        }
      }
      frames.push(frame);
    }
  }
  if (bitCount % 8 !== 0) packed.push(current);
  const pixelData = new Uint8Array(packed);

  const sopInstanceUID = uid + ".1";
  const dataset: Record<string, unknown> = {
    SOPClassUID: SEG_SOP_CLASS,
    SOPInstanceUID: sopInstanceUID,
    SeriesInstanceUID: uid,
    StudyInstanceUID: source.studyInstanceUID,
    Modality: "SEG",
    SeriesDescription: "TestSEG",
    SegmentationType: "BINARY",
    Rows: ny,
    Columns: nx,
    BitsAllocated: 1,
    BitsStored: 1,
    HighBit: 0,
    PixelRepresentation: 0,
    SamplesPerPixel: 1,
    PhotometricInterpretation: "MONOCHROME2",
    NumberOfFrames: String(segments.length * nz),
    SegmentSequence: segments.map((segment, index) => ({
      SegmentNumber: index + 1,
      SegmentLabel: segment.label,
      SegmentAlgorithmType: "MANUAL",
      // 1-byte values, so a reader can map a frame to a label value
      RecommendedDisplayCIELabValue: [0xffff, 0x8080, 0x8080],
    })),
    ReferencedSeriesSequence: [
      {
        SeriesInstanceUID: source.seriesInstanceUID,
        ReferencedInstanceSequence: source.sopInstanceUIDs.map((instance) => ({
          ReferencedSOPClassUID: source.sopClassUID,
          ReferencedSOPInstanceUID: instance,
        })),
      },
    ],
    PixelData: pixelData.buffer,
    // BitsAllocated 1: a bit-packed SEG frame is a byte stream, so OB rather than OW.
    _vrMap: { PixelData: "OB" },
    _meta: {},
  };

  return {
    buffer: writeInstance(dcmjs, dataset, options.transferSyntaxUID ?? "1.2.840.10008.1.2.1"),
    seriesInstanceUID: uid,
    sopInstanceUID,
    sopClassUID: SEG_SOP_CLASS,
    frames,
  };
}

function writeInstance(
  dcmjs: DcmjsLike,
  dataset: Record<string, unknown>,
  transferSyntaxUID: string,
): ArrayBuffer {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const meta = {
    TransferSyntaxUID: transferSyntaxUID,
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
  };
  const denaturalizedMeta = DicomMetaDictionary.denaturalizeDataset(meta);
  const dict = DicomMetaDictionary.denaturalizeDataset({
    ...dataset,
    _meta: denaturalizedMeta,
  });
  const dicomDict = new DicomDict(denaturalizedMeta);
  dicomDict.dict = dict;
  return dicomDict.write();
}
