// Hand-written declarations for the vendored dcmjs build, covering exactly the
// surface SlicerLive uses. Following the render/vendor/idc_tools/ precedent:
// plain .js vendored, types written here rather than generated.
//
// Deliberately NOT a full description of dcmjs. Anything not declared here is
// not used by SlicerLive; add to it rather than reaching for `any`.

/** A DICOM element in the dict form: { vr, Value, _rawValue? }. */
export interface DicomElement {
  vr: string;
  Value: unknown[];
  /** The value as encoded, before a numeric VR parses it. Present on read. */
  _rawValue?: unknown[];
}

/** A parsed dataset, keyed by 'GGGGEEEE' in upper case. */
export type DicomElements = Record<string, DicomElement>;

/** A naturalized dataset, keyed by DICOM keyword. */
export type NaturalDataset = Record<string, unknown>;

/** One element of a reserved private block (PS3.5 7.8.1). */
export interface PrivateBlock {
  readonly group: number;
  readonly block: number;
  readonly creator: string;
  /** The 'GGGGEEEE' key of an element of this block. */
  tag(element: number): string;
  has(element: number): boolean;
  get(element: number): DicomElement | undefined;
  set(element: number, vr: string, values: unknown): string;
}

export interface DicomDict {
  meta: DicomElements;
  dict: DicomElements;
  upsertTag(tag: string, vr: string, values: unknown[]): void;
  write(writeOptions?: { allowInvalidVRLength?: boolean }): ArrayBuffer;
  /**
   * The private block this creator has reserved, reserving one if it has none.
   * Which block a creator holds is decided by whoever wrote the file, so it is
   * looked up by creator string and never assumed.
   */
  privateBlock(
    group: number,
    creator: string,
    options?: { create?: boolean },
  ): PrivateBlock | null;
}

export interface DicomDictConstructor {
  new (meta: DicomElements): DicomDict;
}

export interface ReadOptions {
  /** Stop reading once this tag is reached — a prefix read. */
  untilTag?: string;
  ignoreErrors?: boolean;
  noCopy?: boolean;
}

export interface DicomMessageStatic {
  readFile(buffer: ArrayBuffer, options?: ReadOptions): DicomDict;
}

export interface DicomMetaDictionaryStatic {
  naturalizeDataset(dict: DicomElements): NaturalDataset;
  denaturalizeDataset(dataset: NaturalDataset): DicomElements;
  uid(): string;
  date(): string;
  time(): string;
  dateTime(): string;
  unpunctuateTag(tag: string): string;
  punctuateTag(tag: string): string;
  nameMap: Record<string, { tag: string; vr: string; vm?: string; name: string; version?: string }>;
  sopClassUIDsByName: Record<string, string>;
  sopClassNamesByUID: Record<string, string>;
  dictionary: Record<string, { tag: string; vr: string; vm?: string; name: string; version?: string }>;
}

/** A Secondary Capture Image derivation. */
export interface SecondaryCapture {
  dataset: NaturalDataset;
  setPixels(options: {
    rows: number;
    columns: number;
    pixelData: ArrayBuffer | ArrayBufferView;
    samplesPerPixel?: number;
    bitsAllocated?: number;
    photometricInterpretation?: string;
  }): void;
}

export interface SecondaryCaptureConstructor {
  new (
    datasets: NaturalDataset[],
    options?: {
      SeriesDescription?: string;
      SeriesNumber?: string | number;
      Manufacturer?: string;
      ManufacturerModelName?: string;
      SoftwareVersions?: string;
      InstanceNumber?: string | number;
      Modality?: string;
      ConversionType?: string;
      BurnedInAnnotation?: "YES" | "NO";
      SOPInstanceUID?: string;
      SeriesInstanceUID?: string;
      referencedSeries?: {
        SeriesInstanceUID: string;
        instances?: { SOPClassUID?: string; SOPInstanceUID?: string }[];
      }[];
      [key: string]: unknown;
    },
  ): SecondaryCapture;
}

export interface DcmjsData {
  DicomDict: DicomDictConstructor;
  DicomMessage: DicomMessageStatic;
  DicomMetaDictionary: DicomMetaDictionaryStatic;
  datasetToDict(dataset: NaturalDataset): DicomDict;
  datasetToBuffer(dataset: NaturalDataset): Uint8Array;
  datasetToBlob(dataset: NaturalDataset): Blob;
  Colors: { dicomlab2RGB(lab: number[]): number[] };
  /** Register a tag so it can be written BY NAME as well as read. */
  registerTag(
    tagOrHex: string,
    entry: { name: string; vr: string; vm?: string; version?: string },
  ): void;
  dictionary: DicomMetaDictionaryStatic["dictionary"];
  /** Find a creator's reserved block in any parsed dict. */
  findPrivateBlock(dict: DicomElements, group: number, creator: string): PrivateBlock | null;
  reservePrivateBlock(dict: DicomElements, group: number, creator: string): PrivateBlock;
  privateTag(group: number, block: number, element: number): string;
}

export interface Dcmjs {
  data: DcmjsData;
  derivations: {
    SecondaryCapture: SecondaryCaptureConstructor;
    [key: string]: unknown;
  };
  normalizers: Record<string, unknown>;
  utilities: Record<string, unknown>;
  sr: Record<string, unknown>;
  adapters: Record<string, unknown>;
  anonymizer: Record<string, unknown>;
  constants: Record<string, unknown>;
  log: Record<string, unknown>;
}

declare const dcmjs: Dcmjs;
export default dcmjs;
