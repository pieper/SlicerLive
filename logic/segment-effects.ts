// Segment Editor effects (W5), pure labelmap operations. A labelmap is a Uint8Array of segment ids
// (0 = background), C-order (z,y,x), dims [nx,ny,nz]. Each effect returns a NEW labelmap (immutably), so
// undo/sessions capture the before/after. Effects honor a minimal masking model (OverwriteMode): the
// active segment writes over background only, over any segment, or over specific segments. Geometry-aware
// params (margin in mm) use the volume spacing. These are the CPU reference; a GPU path can back the same
// calls later (the unified field-op backend). Kernels: auto-threshold / ccl / morph.
import { autoThreshold, type ThresholdMethod } from "../algorithms/kernels/auto-threshold.ts";
import { keepLargestIsland, removeSmallIslands, type Connectivity } from "../algorithms/kernels/ccl.ts";
import { binaryClose, binaryDilate, binaryErode, binaryOpen, median3d } from "../algorithms/kernels/morph.ts";

export type Scalars = { length: number; [i: number]: number };
export type Dims = [number, number, number];
export type OverwriteMode = "all" | "visible" | "none";   // Slicer OverwriteMode: All / Visible / None(background only)

export interface MaskOpts { segment: number; overwrite?: OverwriteMode; visibleSegments?: number[]; }

/** True if the active segment may write voxel currently holding `cur` under the overwrite rule. */
function canWrite(cur: number, o: Required<Pick<MaskOpts, "segment">> & MaskOpts): boolean {
  if (cur === o.segment) return true;
  const mode = o.overwrite ?? "all";
  if (cur === 0) return true;                                    // background is always writable
  if (mode === "all") return true;
  if (mode === "none") return false;                            // only background (handled above)
  return (o.visibleSegments ?? []).includes(cur);              // "visible": overwrite only visible segments
}

/** The active segment's binary mask (1 where labelmap == segment). */
export function segmentMask(labelmap: Scalars, segment: number): Uint8Array {
  const m = new Uint8Array(labelmap.length);
  for (let i = 0; i < labelmap.length; i++) m[i] = labelmap[i] === segment ? 1 : 0;
  return m;
}

/** Write a binary result mask back as the active segment id, honoring the overwrite rule. Voxels that were
 *  the active segment but are 0 in `result` are cleared (to background). */
function writeBack(labelmap: Scalars, result: Uint8Array, o: MaskOpts): Uint8Array {
  const seg = o.segment;
  const out = Uint8Array.from(labelmap as ArrayLike<number>);
  for (let i = 0; i < out.length; i++) {
    if (result[i]) { if (canWrite(out[i], o)) out[i] = seg; }
    else if (out[i] === seg) out[i] = 0;                         // shrank away
  }
  return out;
}

/** Threshold effect: set the active segment wherever the SOURCE intensity is in [lower,upper]. */
export function applyThreshold(labelmap: Scalars, source: Scalars, _dims: Dims, opts: MaskOpts & { lower: number; upper: number }): Uint8Array {
  const out = Uint8Array.from(labelmap as ArrayLike<number>);
  for (let i = 0; i < out.length; i++) {
    const v = source[i];
    if (v >= opts.lower && v <= opts.upper && canWrite(out[i], opts)) out[i] = opts.segment;
  }
  return out;
}

/** Auto threshold (Otsu/…): pick the range from the source histogram, then threshold ABOVE it. */
export function applyAutoThreshold(labelmap: Scalars, source: Scalars, dims: Dims, opts: MaskOpts & { method: ThresholdMethod }): { labelmap: Uint8Array; threshold: number } {
  const t = autoThreshold(opts.method, source);
  let hi = -Infinity; for (let i = 0; i < source.length; i++) if (source[i] > hi) hi = source[i];
  return { labelmap: applyThreshold(labelmap, source, dims, { ...opts, lower: t, upper: hi }), threshold: t };
}

/** Islands: keep the largest, or remove islands smaller than minSize (in the active segment). */
export function applyIslands(labelmap: Scalars, dims: Dims, opts: MaskOpts & { operation: "keepLargest" | "removeSmall"; minSize?: number; connectivity?: Connectivity }): Uint8Array {
  const mask = segmentMask(labelmap, opts.segment);
  const conn = opts.connectivity ?? 6;
  const result = opts.operation === "keepLargest" ? keepLargestIsland(mask, dims, conn) : removeSmallIslands(mask, dims, opts.minSize ?? 10, conn);
  return writeBack(labelmap, result, opts);
}

/** Smoothing: median / opening / closing on the active segment (radius in voxels). */
export function applySmoothing(labelmap: Scalars, dims: Dims, opts: MaskOpts & { method: "median" | "open" | "close"; radiusVoxels?: number }): Uint8Array {
  const mask = segmentMask(labelmap, opts.segment);
  const r = opts.radiusVoxels ?? 1;
  const result = opts.method === "median" ? median3d(mask, dims, r) : opts.method === "open" ? binaryOpen(mask, dims, r) : binaryClose(mask, dims, r);
  return writeBack(labelmap, result, opts);
}

/** Margin: grow (marginMm > 0) or shrink (< 0) the active segment by a distance in mm. Uses the smallest
 *  voxel spacing to convert mm → a ball radius in voxels. */
export function applyMargin(labelmap: Scalars, dims: Dims, opts: MaskOpts & { marginMm: number; spacingMm: [number, number, number] }): Uint8Array {
  const minSpacing = Math.min(...opts.spacingMm.map(Math.abs).filter((s) => s > 0));
  const rVox = Math.max(1, Math.round(Math.abs(opts.marginMm) / (minSpacing || 1)));
  const mask = segmentMask(labelmap, opts.segment);
  const result = opts.marginMm >= 0 ? binaryDilate(mask, dims, rVox) : binaryErode(mask, dims, rVox);
  return writeBack(labelmap, result, opts);
}
