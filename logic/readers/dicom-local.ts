// Walk local files/folders for DICOM, group into series, and load a chosen one — the browser glue over the
// pure reconstructor in dicom-series.ts. A "project" here is a File System Access directory the user grants;
// the minimal browser lists its series so one can be loaded. (The richer SlicerRad project browser — FSA
// directories toggled on/off — reconciles onto these same Project/StudyIndex/SeriesSource seams later.)
import { loadDcmjs, parseInstances, groupSeries, reconstructSeries, type DicomInstance, type Series } from "./dicom-series.ts";
import type { Volume } from "./nifti.ts";

export interface SeriesEntry {
  seriesInstanceUID: string;
  studyInstanceUID?: string;
  patientName?: string;
  modality?: string;
  description?: string;
  count: number;                          // #image instances
  buffers: ArrayBuffer[];                 // the raw instances (kept so a load is instant after browse)
}

/** True if the first bytes look like a DICOM Part-10 file (DICM at offset 128) or a raw dataset. */
function looksDicom(bytes: Uint8Array, name: string): boolean {
  if (bytes.length >= 132 && String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]) === "DICM") return true;
  return /\.dcm$/i.test(name) || /^[0-9.]+$/.test(name) || name.toLowerCase() === "dicomdir" === false && /(^|\/)[^./]+$/.test(name) && bytes.length > 256;
}

async function* walkDir(dir: FileSystemDirectoryHandle, prefix = ""): AsyncGenerator<{ name: string; file: File }> {
  // deno-lint-ignore no-explicit-any
  for await (const [name, handle] of (dir as any).entries()) {
    const h = handle as FileSystemDirectoryHandle | FileSystemFileHandle;
    if (h.kind === "directory") yield* walkDir(h as FileSystemDirectoryHandle, `${prefix}${name}/`);
    else { try { yield { name: `${prefix}${name}`, file: await (h as FileSystemFileHandle).getFile() }; } catch { /* skip */ } }
  }
}

export interface IndexProgress { scanned: number; dicom: number; note?: string }

/** Index a set of File objects (from a picker or drop) into series entries. */
export async function indexFiles(files: File[], onProgress?: (p: IndexProgress) => void): Promise<SeriesEntry[]> {
  const buffers: ArrayBuffer[] = [];
  let scanned = 0, dicom = 0;
  for (const f of files) {
    scanned++;
    const buf = await f.arrayBuffer();
    if (looksDicom(new Uint8Array(buf, 0, Math.min(200, buf.byteLength)), f.name)) { buffers.push(buf); dicom++; }
    if (scanned % 20 === 0) onProgress?.({ scanned, dicom, note: f.name });
  }
  onProgress?.({ scanned, dicom, note: "parsing headers…" });
  return seriesEntries(buffers);
}

/** Index a granted directory handle (a "project"). */
export async function indexDirectory(dir: FileSystemDirectoryHandle, onProgress?: (p: IndexProgress) => void): Promise<SeriesEntry[]> {
  const files: File[] = [];
  for await (const { file } of walkDir(dir)) files.push(file);
  return indexFiles(files, onProgress);
}

async function seriesEntries(buffers: ArrayBuffer[]): Promise<SeriesEntry[]> {
  // Parse once; the parsed instances (pixels included) are stashed on the entry so a load is instant — no
  // re-parse, no need to hold the raw buffers.
  const groups = groupSeries(await parseInstances(buffers));
  return groups.map((g): SeriesEntry => {
    const e: SeriesEntry & { _instances?: DicomInstance[] } = {
      seriesInstanceUID: g.seriesInstanceUID, studyInstanceUID: g.instances[0].studyInstanceUID,
      patientName: g.instances[0].patientName, modality: g.modality, description: g.description,
      count: g.instances.length, buffers: [],
    };
    e._instances = g.instances;
    return e;
  });
}

/** Reconstruct a browsed series entry into a Volume. */
export function loadEntry(entry: SeriesEntry): Volume {
  const inst = (entry as SeriesEntry & { _instances?: DicomInstance[] })._instances;
  if (inst && inst.length) return reconstructSeries(inst);
  throw new Error("series has no parsed instances (re-index the folder)");
}

export { loadDcmjs };
export type { Series };
