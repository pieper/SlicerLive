// Format sniffing + a single readVolume() entry for local files (W1). Pure TS: bytes in, Volume out.
import { isGzip, isNifti, gunzip, parseNifti, type Volume } from "./nifti.ts";
import { parseNrrd } from "../../render/nrrd.ts";

export type Format = "nrrd" | "nifti" | "dicom" | "unknown";

export function sniff(bytes: Uint8Array, fileName = ""): Format {
  const lower = fileName.toLowerCase();
  if (bytes.length >= 4 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "NRRD") return "nrrd";
  if (bytes.length >= 132 && String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]) === "DICM") return "dicom";
  if (isNifti(bytes)) return "nifti";
  if (isGzip(bytes)) return lower.endsWith(".nii.gz") ? "nifti" : lower.endsWith(".nrrd.gz") ? "nrrd" : "unknown";
  if (lower.endsWith(".nii")) return "nifti";
  if (lower.endsWith(".nrrd") || lower.endsWith(".nhdr")) return "nrrd";
  if (lower.endsWith(".dcm")) return "dicom";
  return "unknown";
}

/** Read one volume file (NRRD / NIfTI, optionally gzipped). DICOM series go through logic/readers/dicom-series.ts. */
export async function readVolume(bytes: Uint8Array, fileName = ""): Promise<Volume> {
  const fmt = sniff(bytes, fileName);
  if (fmt === "nifti") return parseNifti(bytes, fileName.replace(/\.nii(\.gz)?$/i, ""));
  if (fmt === "nrrd") {
    const raw = isGzip(bytes) && !fileName.toLowerCase().endsWith(".nrrd") ? await gunzip(bytes) : bytes;   // .nrrd.gz wrapper; inline gzip encoding is handled by parseNrrd
    const n = await parseNrrd(raw);
    return { dims: n.dims, ijkToRAS: n.ijkToRAS, data: n.data, dtype: zarrDtype(n.data), name: fileName.replace(/\.nrrd$/i, "") };
  }
  throw new Error(fmt === "dicom" ? "DICOM: load the series through the DICOM browser" : `unrecognised volume format: ${fileName || "(bytes)"}`);
}

export function zarrDtype(a: ArrayBufferView): string {
  if (a instanceof Int16Array) return "<i2"; if (a instanceof Uint16Array) return "<u2"; if (a instanceof Uint8Array) return "|u1"; if (a instanceof Int8Array) return "|i1";
  if (a instanceof Int32Array) return "<i4"; if (a instanceof Uint32Array) return "<u4"; if (a instanceof Float32Array) return "<f4"; if (a instanceof Float64Array) return "<f8";
  return "<f4";
}
