// DICOM series -> a single Volume (W1). Two layers, split so the geometry is testable without dcmjs:
//   reconstructSeries(instances)  — PURE: subseries split by orientation, sort by IPP·normal, ijkToRAS with
//                                   LPS->RAS, per-slice rescale, assemble. Ported from render/vendor/idc_tools
//                                   (idc-worker.js) so a local file series and an IDC series reconstruct the same.
//   parseInstances / loadDicomSeries — use dcmjs (browser: lazy-loaded from a CDN) to fill DicomInstance.
// Matches Slicer's DICOMScalarVolumePlugin geometry: IJK->RAS from IOP/IPP/PixelSpacing, subseries by orientation.
import type { Volume } from "./nifti.ts";
import { zarrDtype } from "./registry.ts";

export interface DicomInstance {
  seriesInstanceUID: string;
  sopInstanceUID?: string;
  rows: number;                 // Rows (ny)
  columns: number;              // Columns (nx)
  pixelSpacing: [number, number];             // [between-rows (y), between-columns (x)] mm — DICOM order
  imageOrientationPatient: number[];          // 6: rowDir(3), colDir(3), LPS
  imagePositionPatient: [number, number, number];  // LPS mm
  sliceThickness?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  pixelRepresentation?: 0 | 1;  // 0 unsigned, 1 signed
  instanceNumber?: number;
  windowCenter?: number;
  windowWidth?: number;
  modality?: string;
  pixels: Int16Array | Uint16Array;           // rows*columns, row-major
  patientName?: string;
  studyInstanceUID?: string;
  seriesDescription?: string;
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lps2ras = (v: number[]) => [-v[0], -v[1], v[2]];
const orientKey = (iop: number[]) => iop.map((v) => Math.round(v * 1000) / 1000).join(",");

export interface Series { seriesInstanceUID: string; description?: string; modality?: string; instances: DicomInstance[] }

/** Group instances into series, then split each series by ImageOrientationPatient (Slicer subseries rule). */
export function groupSeries(instances: DicomInstance[]): Series[] {
  const byUid = new Map<string, DicomInstance[]>();
  for (const i of instances) { const k = i.seriesInstanceUID; if (!byUid.has(k)) byUid.set(k, []); byUid.get(k)!.push(i); }
  const out: Series[] = [];
  for (const [uid, list] of byUid) {
    const byOrient = new Map<string, DicomInstance[]>();
    for (const i of list) { const k = orientKey(i.imageOrientationPatient); if (!byOrient.has(k)) byOrient.set(k, []); byOrient.get(k)!.push(i); }
    let idx = 0;
    for (const g of byOrient.values()) out.push({ seriesInstanceUID: byOrient.size > 1 ? `${uid}#${idx++}` : uid, description: g[0].seriesDescription, modality: g[0].modality, instances: g });
  }
  return out;
}

/** Reconstruct ONE geometrically consistent series (single orientation) into a Volume. Pure. */
export function reconstructSeries(instances: DicomInstance[]): Volume {
  if (instances.length === 0) throw new Error("empty DICOM series");
  const iop = instances[0].imageOrientationPatient.map(Number);
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
  const slices = [...instances].sort((a, b) => dot(a.imagePositionPatient as number[], normal) - dot(b.imagePositionPatient as number[], normal));
  const s0 = slices[0], nz = slices.length, ny = s0.rows, nx = s0.columns;
  const ps = s0.pixelSpacing;                             // [rowSpacing(y), colSpacing(x)]
  const p0 = slices[0].imagePositionPatient as number[], p1 = slices[nz - 1].imagePositionPatient as number[];
  const sliceSpacing = nz > 1 ? dot(sub(p1, p0), normal) / (nz - 1) : (s0.sliceThickness || 1);
  const c0 = lps2ras(rowDir.map((v) => v * ps[1]));       // i (columns, x-fastest) uses COLUMN spacing
  const c1 = lps2ras(colDir.map((v) => v * ps[0]));       // j (rows) uses ROW spacing
  const c2 = lps2ras(normal.map((v) => v * sliceSpacing));
  const o = lps2ras(p0);
  const ijkToRAS = [c0[0], c1[0], c2[0], o[0], c0[1], c1[1], c2[1], o[1], c0[2], c1[2], c2[2], o[2], 0, 0, 0, 1];
  const signed = slices.some((s) => (s.rescaleIntercept ?? 0) !== 0 || (s.pixelRepresentation === 1) || (s.modality === "CT"));
  const data = signed ? new Int16Array(nx * ny * nz) : new Uint16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const s = slices[k], slope = s.rescaleSlope ?? 1, inter = s.rescaleIntercept ?? 0, off = k * nx * ny, px = s.pixels;
    if (slope === 1 && inter === 0) (data as { set(a: ArrayLike<number>, o: number): void }).set(px, off);
    else for (let p = 0; p < nx * ny; p++) data[off + p] = px[p] * slope + inter;
  }
  const dtype = zarrDtype(data);
  const name = s0.seriesDescription || s0.modality || "DICOM";
  const meta: Record<string, unknown> = { seriesInstanceUID: s0.seriesInstanceUID, studyInstanceUID: s0.studyInstanceUID, modality: s0.modality, patientName: s0.patientName };
  if (typeof s0.windowCenter === "number" && typeof s0.windowWidth === "number") { meta.windowCenter = s0.windowCenter; meta.windowWidth = s0.windowWidth; }
  return { dims: [nx, ny, nz], ijkToRAS, data, dtype, name, meta };
}

// ---- dcmjs parse (browser) ------------------------------------------------------------------
interface Dcmjs { data: { DicomMessage: { readFile(b: ArrayBuffer): { dict: unknown } }; DicomMetaDictionary: { naturalizeDataset(d: unknown): Record<string, unknown> } } }
let dcmjsPromise: Promise<Dcmjs> | null = null;
const DCMJS_MIRRORS = ["https://cdn.jsdelivr.net/npm/dcmjs@0.41.0/build/dcmjs.min.js", "https://unpkg.com/dcmjs@0.41.0/build/dcmjs.min.js"];

/** Lazy-load dcmjs (UMD) via a script tag; returns window.dcmjs. Browser only. */
export function loadDcmjs(): Promise<Dcmjs> {
  const w = globalThis as unknown as { dcmjs?: Dcmjs; document?: { createElement(t: string): { src: string; onload: () => void; onerror: () => void; remove(): void }; head: { appendChild(e: unknown): void } } };
  if (w.dcmjs) return Promise.resolve(w.dcmjs);
  if (!w.document) return Promise.reject(new Error("dcmjs is only available in a browser (no document); use reconstructSeries with parsed instances in Deno"));
  if (!dcmjsPromise) dcmjsPromise = new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= DCMJS_MIRRORS.length) { reject(new Error("dcmjs: all CDN mirrors failed")); return; }
      const s = w.document!.createElement("script"); s.src = DCMJS_MIRRORS[i++];
      s.onload = () => (w.dcmjs ? resolve(w.dcmjs) : tryNext());
      s.onerror = () => { s.remove(); tryNext(); };
      w.document!.head.appendChild(s);
    };
    tryNext();
  });
  return dcmjsPromise;
}

const num = (v: unknown, d = 0): number => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) ? n : d; };

/** Parse DICOM instance buffers into DicomInstance[] (drops non-image objects — SEG/SR/PR handled elsewhere). */
export async function parseInstances(buffers: ArrayBuffer[]): Promise<DicomInstance[]> {
  const dcmjs = await loadDcmjs();
  const out: DicomInstance[] = [];
  for (const buf of buffers) {
    let ds: Record<string, unknown>;
    try { ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(buf).dict); } catch { continue; }
    if (!ds.PixelData || !ds.ImageOrientationPatient || !ds.ImagePositionPatient || !ds.PixelSpacing) continue;
    let pd = ds.PixelData as ArrayBuffer | ArrayBuffer[]; if (Array.isArray(pd)) pd = pd[0];
    const signed = ds.PixelRepresentation === 1;
    out.push({
      seriesInstanceUID: String(ds.SeriesInstanceUID ?? "series"),
      sopInstanceUID: ds.SOPInstanceUID as string | undefined,
      rows: num(ds.Rows), columns: num(ds.Columns),
      pixelSpacing: (ds.PixelSpacing as number[]).map(Number) as [number, number],
      imageOrientationPatient: (ds.ImageOrientationPatient as number[]).map(Number),
      imagePositionPatient: (ds.ImagePositionPatient as number[]).map(Number) as [number, number, number],
      sliceThickness: ds.SliceThickness != null ? num(ds.SliceThickness) : undefined,
      rescaleSlope: ds.RescaleSlope != null ? num(ds.RescaleSlope, 1) : 1,
      rescaleIntercept: ds.RescaleIntercept != null ? num(ds.RescaleIntercept) : 0,
      pixelRepresentation: signed ? 1 : 0,
      instanceNumber: ds.InstanceNumber != null ? num(ds.InstanceNumber) : undefined,
      windowCenter: ds.WindowCenter != null ? num(ds.WindowCenter) : undefined,
      windowWidth: ds.WindowWidth != null ? num(ds.WindowWidth) : undefined,
      modality: ds.Modality as string | undefined,
      pixels: signed ? new Int16Array(pd as ArrayBuffer) : new Uint16Array(pd as ArrayBuffer),
      patientName: typeof ds.PatientName === "object" ? (ds.PatientName as { Alphabetic?: string }).Alphabetic : ds.PatientName as string | undefined,
      studyInstanceUID: ds.StudyInstanceUID as string | undefined,
      seriesDescription: ds.SeriesDescription as string | undefined,
    });
  }
  return out;
}

/** Parse a set of DICOM buffers and reconstruct each distinct series into a Volume. */
export async function loadDicomSeries(buffers: ArrayBuffer[]): Promise<{ series: Series; volume: Volume }[]> {
  const series = groupSeries(await parseInstances(buffers));
  return series.map((s) => ({ series: s, volume: reconstructSeries(s.instances) }));
}
