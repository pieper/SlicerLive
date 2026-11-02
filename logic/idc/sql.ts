// IDC (NCI Imaging Data Commons) v3 index client — pure TS, DOM-free, injectable fetch.
//
// Resolves DICOM UIDs to downloadable series through the free, unmetered index API at
// api.imaging.datacommons.cancer.gov/v3/sql. Deliberately NOT the DICOMweb proxy: the proxy is
// the metered part of IDC's infrastructure and its policy reserves it for IDC's own viewers,
// while the index and the public buckets are free.
//
// The fetch is a parameter, never a module-level global, so a caller in a no-egress context can
// pass one that throws instead of silently reaching the network.
//
// Extracted from render/demos/bir-browser.ts so other applications can resolve IDC series without
// importing a demo. The geometry construction is the valuable part: with Rows/Columns, the
// in-plane spacing, the origin, the orientation and the slice spacing, a viewer can allocate the
// volume and place it in patient space BEFORE a single pixel arrives, which is what makes a
// streaming load possible.

export const IDC_API_BASE = "https://api.imaging.datacommons.cancer.gov/v3";

/** A DICOM UID is digits and dots (PS3.5 §9.1); a crdc_series_uuid is hex and hyphens. Checked
 *  before anything reaches a statement — they bind as parameters anyway, but a mistyped URL
 *  should fail here with something readable rather than as an empty result. */
export const UID_RE = /^[0-9a-fA-F.-]{1,64}$/;

/** A DICOM PatientID is LO (PS3.5), not a UID: collection identifiers like
 *  "ACRIN-NSCLC-FDG-PET-131" are letters, digits, hyphens and underscores. Bounded and
 *  conservative — parameters bind server-side regardless, so this only exists to make a mistyped
 *  identifier fail readably instead of returning zero rows. */
export const PATIENT_ID_RE = /^[\w.^ -]{1,64}$/;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IdcClientOptions {
  /** Required. Pass a throwing stub in no-egress contexts. */
  fetch: FetchLike;
  apiBase?: string;
}

/** Per-series geometry sufficient to allocate and place a volume before any pixels load. */
export interface SeriesGeometry {
  origin: [number, number, number];
  /** ImageOrientationPatient, 6 numbers (row direction then column direction), LPS. */
  iop: number[];
  /** Spacing between slice planes, mm. */
  spacing: number;
  dims: [number, number, number];
  /** Row-major 4x4, index -> RAS mm. */
  ijkToRAS: number[];
}

export interface SeriesRow {
  StudyInstanceUID: string;
  SeriesInstanceUID: string;
  crdc_series_uuid: string;
  aws_bucket: string;
  Modality: string;
  instanceCount: number;
  SeriesNumber: number | null;
  SeriesDescription: string | null;
  PatientID: string;
  collection_id: string;
  license_short_name: string | null;
  source_DOI: string | null;
  StudyDate?: string | null;
  /** PET-only, from pt_index. Absent for other modalities. */
  Units?: string | null;
  DecayCorrection?: string | null;
  CorrectedImage?: string[] | null;
  geometry: SeriesGeometry | null;
}

const SLIM_COLS = [
  "i.StudyInstanceUID", "i.SeriesInstanceUID", "i.crdc_series_uuid", "i.aws_bucket", "i.Modality",
  "i.instanceCount", "i.SeriesNumber", "i.SeriesDescription", "i.PatientID", "i.collection_id",
  "i.license_short_name", "i.source_DOI",
].join(", ");

// Per-series geometry in the SAME call as the series list. Rows/Columns and the in-plane spacing
// live in the modality indices; the origin, orientation and between-plane spacing come from
// volume_geometry_index, which also says whether the series is a regularly-spaced volume at all.
const GEOM_SELECT = `
  COALESCE(c.Rows, m.Rows, p.Rows) AS g_rows,
  COALESCE(c.Columns, m.Columns, p.Columns) AS g_cols,
  COALESCE(c.PixelSpacing_row_mm, m.PixelSpacing_row_mm, p.PixelSpacing_row_mm) AS g_ps_row,
  COALESCE(c.PixelSpacing_col_mm, m.PixelSpacing_col_mm, p.PixelSpacing_col_mm) AS g_ps_col,
  v.origin_patient AS g_origin,
  v.ImageOrientationPatient AS g_iop,
  v.slice_spacing_mm AS g_slice_mm,
  v.regularly_spaced_3d_volume AS g_regular`;

// PET quantification fields, so a caller can tell AC from NAC and compute SUV without a header
// pre-pass. CorrectedImage containing 'ATTN' is the attenuation-corrected series.
const PET_SELECT = `p.Units AS pt_units, p.DecayCorrection AS pt_decay, p.CorrectedImage AS pt_corrected`;

const JOINS = `
  LEFT JOIN ct_index c ON c.SeriesInstanceUID = i.SeriesInstanceUID
  LEFT JOIN mr_index m ON m.SeriesInstanceUID = i.SeriesInstanceUID
  LEFT JOIN pt_index p ON p.SeriesInstanceUID = i.SeriesInstanceUID
  LEFT JOIN volume_geometry_index v ON v.SeriesInstanceUID = i.SeriesInstanceUID`;

/** The index->RAS matrix for a series row, or null when the index says this series is not a
 *  regularly-spaced volume (gantry tilt, variable spacing, duplicate positions) or has no
 *  geometry row. Those fall back to reading every header, which is always right but slower. */
// deno-lint-ignore no-explicit-any
export function geometryOf(row: any): SeriesGeometry | null {
  if (!row?.g_regular || !row.g_origin || !row.g_iop) return null;
  const origin = (row.g_origin as unknown[]).map(Number) as [number, number, number];
  const iop = (row.g_iop as unknown[]).map(Number);
  const psRow = Number(row.g_ps_row), psCol = Number(row.g_ps_col), sliceMm = Number(row.g_slice_mm);
  const nx = Number(row.g_cols), ny = Number(row.g_rows), nz = Number(row.instanceCount);
  if (![psRow, psCol, sliceMm, nx, ny, nz].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (origin.some((v) => !Number.isFinite(v)) || iop.length !== 6) return null;
  // i runs along the row direction scaled by the COLUMN spacing, j along the column direction
  // scaled by the ROW spacing, k along the plane normal scaled by the slice spacing, origin at
  // voxel (0,0,0). Same construction the DICOM path uses in dicom-volume.js assembleSlices.
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6);
  const n = [
    rowDir[1] * colDir[2] - rowDir[2] * colDir[1],
    rowDir[2] * colDir[0] - rowDir[0] * colDir[2],
    rowDir[0] * colDir[1] - rowDir[1] * colDir[0],
  ];
  const ras = (v: number[]) => [-v[0], -v[1], v[2]];   // LPS -> RAS
  const c0 = ras(rowDir.map((x) => x * psCol));
  const c1 = ras(colDir.map((x) => x * psRow));
  const c2 = ras(n.map((x) => x * sliceMm));
  const o = ras(origin);
  return {
    origin,
    iop,
    spacing: sliceMm,
    dims: [nx, ny, nz],
    ijkToRAS: [
      c0[0], c1[0], c2[0], o[0],
      c0[1], c1[1], c2[1], o[1],
      c0[2], c1[2], c2[2], o[2],
      0, 0, 0, 1,
    ],
  };
}

// deno-lint-ignore no-explicit-any
function toSeriesRow(row: any): SeriesRow {
  return {
    StudyInstanceUID: row.StudyInstanceUID,
    SeriesInstanceUID: row.SeriesInstanceUID,
    crdc_series_uuid: row.crdc_series_uuid,
    aws_bucket: row.aws_bucket,
    Modality: row.Modality,
    instanceCount: Number(row.instanceCount),
    SeriesNumber: row.SeriesNumber === null || row.SeriesNumber === undefined ? null : Number(row.SeriesNumber),
    SeriesDescription: row.SeriesDescription ?? null,
    PatientID: row.PatientID,
    collection_id: row.collection_id,
    license_short_name: row.license_short_name ?? null,
    source_DOI: row.source_DOI ?? null,
    StudyDate: row.StudyDate ?? null,
    Units: row.pt_units ?? null,
    DecayCorrection: row.pt_decay ?? null,
    CorrectedImage: row.pt_corrected ?? null,
    geometry: geometryOf(row),
  };
}

export class IdcClient {
  #fetch: FetchLike;
  #apiBase: string;

  constructor(options: IdcClientOptions) {
    this.#fetch = options.fetch;
    this.#apiBase = (options.apiBase ?? IDC_API_BASE).replace(/\/$/, "");
  }

  /** One read-only query. `values` bind to the statement's `?` placeholders server-side, so a UID
   *  taken from a page URL never becomes statement text. */
  // deno-lint-ignore no-explicit-any
  async sql(sql: string, values: string[] = [], validate: RegExp = UID_RE): Promise<any[]> {
    for (const v of values) {
      if (!validate.test(v)) throw new Error(`parameter is not a well-formed identifier: ${v}`);
    }
    const resp = await this.#fetch(`${this.#apiBase}/sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params: values }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`IDC API ${resp.status} at ${this.#apiBase}/sql — ${detail.slice(0, 300)}`);
    }
    const body = await resp.json();
    if (body?.error) throw new Error(`IDC API: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.rows ?? [];
  }

  /** The IDC release the API is serving, for an error message. Never throws. */
  async version(): Promise<string> {
    try {
      const v = await (await this.#fetch(`${this.#apiBase}/version`)).json();
      return `${v.idc_version} / idc-index-data ${v.idc_index_data_version}`;
    } catch {
      return "unknown version";
    }
  }

  /** Every series of a study, with geometry and PET quantification fields. */
  async seriesOfStudy(studyInstanceUID: string): Promise<SeriesRow[]> {
    const rows = await this.sql(
      `SELECT ${SLIM_COLS}, ${PET_SELECT}, ${GEOM_SELECT}
       FROM index i ${JOINS}
       WHERE i.StudyInstanceUID = ?
       ORDER BY i.Modality, i.SeriesNumber`,
      [studyInstanceUID],
    );
    return rows.map(toSeriesRow);
  }

  /** Every CT/PT/SEG series for a patient, across studies, ordered by study date. */
  async seriesOfPatient(patientID: string, modalities = ["CT", "PT", "SEG"]): Promise<SeriesRow[]> {
    const list = modalities.map((m) => `'${m.replace(/[^A-Z]/gi, "")}'`).join(", ");
    const rows = await this.sql(
      `SELECT ${SLIM_COLS}, i.StudyDate, ${PET_SELECT}, ${GEOM_SELECT}
       FROM index i ${JOINS}
       WHERE i.PatientID = ? AND i.Modality IN (${list})
       ORDER BY i.StudyDate, i.StudyInstanceUID, i.Modality, i.SeriesNumber`,
      [patientID],
      PATIENT_ID_RE,
    );
    return rows.map(toSeriesRow);
  }
}

/** The public S3 base for a series' bucket. Objects are `<base><crdc_series_uuid>/<sop>.dcm`. */
export const idcS3Base = (bucket: string): string => `https://${bucket}.s3.us-east-1.amazonaws.com/`;

/** True when a PET series is attenuation-corrected, i.e. the quantitative one. */
export const isAttenuationCorrected = (row: SeriesRow): boolean =>
  !!row.CorrectedImage?.includes("ATTN");
