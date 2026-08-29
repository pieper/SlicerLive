// Native segmentation editor (W5) — create a segmentation over a source volume and apply the Segment Editor
// effects (logic/segment-effects.ts) by materializing the new labelmap: fetch the current labelmap zarr,
// run the effect, re-upload as a content-addressed zarr, and patch the segmentation node's `zarr` so the
// SegmentationDisplayableManager re-bakes. Discrete-effect editing (threshold/islands/smoothing/margin);
// interactive paint stays on the GPU EditableSegmentation path. This is where W5 materializes voxels — the
// unified field-op backend will host these ops (GPU + out-of-core) later.
import type { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";
import type { ZarrDesc } from "../render/zarr.ts";
import { fetchZarrVolumeNative } from "../render/zarr.ts";
import { LocalBlobStore, volumeToZarr } from "./ingest.ts";
import { applyAutoThreshold, applyIslands, applyMargin, applySmoothing, applyThreshold, type OverwriteMode } from "./segment-effects.ts";
import type { ThresholdMethod } from "../algorithms/kernels/auto-threshold.ts";

let segSeq = 0;
const SEG_PALETTE = [[0.9, 0.3, 0.3], [0.3, 0.7, 0.95], [0.5, 0.85, 0.4], [0.95, 0.8, 0.3], [0.8, 0.5, 0.9], [0.4, 0.85, 0.85]];

async function emptyLabelmap(store: LocalBlobStore, dims: [number, number, number]): Promise<ZarrDesc> {
  const { desc, blobs } = await volumeToZarr(new Uint8Array(dims[0] * dims[1] * dims[2]), dims, "|u1");
  store.add(blobs);
  return desc;
}

/** Create a segmentation node (empty labelmap matching the source geometry) + one segment. */
export async function createSegmentation(live: LiveScene, store: LocalBlobStore, sourceImageId: string, opts: { name?: string } = {}): Promise<{ segId: string; segment: number }> {
  const src = live.nodes.get(sourceImageId); if (!src) throw new Error("no source image " + sourceImageId);
  const dims = src.dims as [number, number, number];
  const zarr = await emptyLabelmap(store, dims);
  const segId = `local-segmentation-${++segSeq}`;
  const node: MrsonNode = {
    type: "segmentation", id: segId, name: opts.name ?? "Segmentation", frame: "RAS", dims,
    ijkToRAS: src.ijkToRAS, zarr, refs: { source: [sourceImageId] },
    segments: [{ labelValue: 1, name: "Segment_1", color: SEG_PALETTE[0], visible: true }],
    visible: true, opacity: 1, source: { mrmlClass: "vtkMRMLSegmentationNode" }, origin: { local: true },
  } as unknown as MrsonNode;
  live.write({ op: "put", id: segId, node });
  return { segId, segment: 1 };
}

/** Append a new segment; returns its label value. */
export function addSegment(live: LiveScene, segId: string, opts: { name?: string; color?: number[] } = {}): number {
  const n = live.nodes.get(segId); if (!n) throw new Error("no segmentation " + segId);
  const segs = ((n.segments as { labelValue: number }[] | undefined) ?? []).slice();
  const labelValue = segs.reduce((m, s) => Math.max(m, s.labelValue), 0) + 1;
  segs.push({ labelValue, name: opts.name ?? `Segment_${labelValue}`, color: opts.color ?? SEG_PALETTE[(labelValue - 1) % SEG_PALETTE.length], visible: true } as unknown as { labelValue: number });
  live.write({ op: "patch", id: segId, path: "#/segments", value: segs });
  return labelValue;
}

export interface EffectParams {
  segment: number; overwrite?: OverwriteMode;
  // threshold
  lower?: number; upper?: number; autoMethod?: ThresholdMethod;
  // islands
  islands?: "keepLargest" | "removeSmall"; minSize?: number;
  // smoothing
  smooth?: "median" | "open" | "close"; radiusVoxels?: number;
  // margin
  marginMm?: number;
}

/** Apply an effect, materialize the new labelmap, patch the segmentation node. Returns the segment's voxel count. */
export async function applyEffect(live: LiveScene, store: LocalBlobStore, segId: string, effect: "threshold" | "autoThreshold" | "islands" | "smoothing" | "margin", params: EffectParams): Promise<{ voxels: number; threshold?: number }> {
  const seg = live.nodes.get(segId); if (!seg?.zarr) throw new Error("no segmentation " + segId);
  const dims = seg.dims as [number, number, number];
  const lab = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as ZarrDesc);
  const labelmap = lab.data instanceof Uint8Array ? lab.data : Uint8Array.from(lab.data as ArrayLike<number>);

  let out: Uint8Array, threshold: number | undefined;
  if (effect === "threshold" || effect === "autoThreshold") {
    const srcId = ((seg.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    const srcNode = srcId ? live.nodes.get(srcId) : undefined;
    if (!srcNode?.zarr) throw new Error("threshold needs a source volume");
    const src = await fetchZarrVolumeNative(live.blobBase(), srcNode.zarr as ZarrDesc);
    if (effect === "autoThreshold") { const r = applyAutoThreshold(labelmap, src.data, dims, { segment: params.segment, overwrite: params.overwrite, method: params.autoMethod ?? "otsu" }); out = r.labelmap; threshold = r.threshold; }
    else out = applyThreshold(labelmap, src.data, dims, { segment: params.segment, overwrite: params.overwrite, lower: params.lower ?? 0, upper: params.upper ?? 0 });
  } else if (effect === "islands") {
    out = applyIslands(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, operation: params.islands ?? "keepLargest", minSize: params.minSize });
  } else if (effect === "smoothing") {
    out = applySmoothing(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, method: params.smooth ?? "median", radiusVoxels: params.radiusVoxels });
  } else {
    const sp = spacingFromIjkToRAS(seg.ijkToRAS as number[]);
    out = applyMargin(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, marginMm: params.marginMm ?? 0, spacingMm: sp });
  }

  const { desc, blobs } = await volumeToZarr(out, dims, "|u1");
  store.add(blobs);
  live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
  let voxels = 0; for (let i = 0; i < out.length; i++) if (out[i] === params.segment) voxels++;
  return { voxels, threshold };
}

function spacingFromIjkToRAS(m: number[]): [number, number, number] {
  const col = (c: number): number => Math.hypot(m[c], m[4 + c], m[8 + c]);
  return [col(0), col(1), col(2)];
}
