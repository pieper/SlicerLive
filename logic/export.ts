// Export (W7) — fetch a node's content-addressed voxels and serialize to NRRD / NIfTI. A segmentation exports
// as a .seg.nrrd (labelmap + Slicer segment keys). Returns { bytes, filename, mime } so the caller downloads
// or writes it (browser download or FsaFS). Pure over the LiveScene + blob store.
import type { LiveScene } from "../render/livescene.ts";
import type { ZarrDesc } from "../render/zarr.ts";
import { fetchZarrVolumeNative } from "../render/zarr.ts";
import type { Volume } from "./readers/nifti.ts";
import { writeNrrd } from "./writers/nrrd.ts";
import { writeNifti } from "./writers/nifti.ts";

export type ExportFormat = "nrrd" | "nrrd-gz" | "nifti";
export interface ExportResult { bytes: Uint8Array; filename: string; mime: string; }

async function nodeVolume(live: LiveScene, nodeId: string): Promise<Volume> {
  const n = live.nodes.get(nodeId); if (!n?.zarr) throw new Error("node has no voxels: " + nodeId);
  const zv = await fetchZarrVolumeNative(live.blobBase(), n.zarr as ZarrDesc);
  return { dims: n.dims as [number, number, number], ijkToRAS: n.ijkToRAS as number[], data: zv.data, dtype: (n.zarr as ZarrDesc).dtype, name: (n.name as string) ?? nodeId };
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");

/** Export an image (or any voxel node) to NRRD/NIfTI. */
export async function exportVolume(live: LiveScene, nodeId: string, format: ExportFormat): Promise<ExportResult> {
  const vol = await nodeVolume(live, nodeId);
  const base = safe(vol.name ?? "volume");
  if (format === "nifti") return { bytes: writeNifti(vol), filename: `${base}.nii`, mime: "application/octet-stream" };
  const gz = format === "nrrd-gz";
  return { bytes: await writeNrrd(vol, { encoding: gz ? "gzip" : "raw" }), filename: `${base}.nrrd`, mime: "application/octet-stream" };
}

/** Export a segmentation as a .seg.nrrd (labelmap + segment identity/colour keys). */
export async function exportSegmentation(live: LiveScene, segId: string, format: "nrrd" | "nrrd-gz" = "nrrd"): Promise<ExportResult> {
  const seg = live.nodes.get(segId); if (!seg?.zarr) throw new Error("no segmentation " + segId);
  const vol = await nodeVolume(live, segId);
  const segments = ((seg.segments as { labelValue: number; name: string; color: number[] }[] | undefined) ?? []);
  const bytes = await writeNrrd(vol, { encoding: format === "nrrd-gz" ? "gzip" : "raw", segmentation: { segments } });
  return { bytes, filename: `${safe(vol.name ?? "Segmentation")}.seg.nrrd`, mime: "application/octet-stream" };
}
