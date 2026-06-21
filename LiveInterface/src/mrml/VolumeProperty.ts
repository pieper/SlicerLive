// MRML round-trip helpers for vtkMRMLVolumePropertyNode attributes.
// Format from vtkMRMLVolumePropertyNode.cxx:
//   scalarOpacity   = "N x1 y1 x2 y2 ... xN yN"
//   gradientOpacity = "N x1 y1 x2 y2 ... xN yN"   (same shape)
//   colorTransfer   = "N x1 r1 g1 b1 ... xN rN gN bN"

export interface PiecewisePoint {
  x: number;
  y: number;
}

export interface ColorPoint {
  x: number;
  r: number;
  g: number;
  b: number;
}

function tokenize(s: string): number[] {
  if (!s) return [];
  const out: number[] = [];
  for (const t of s.trim().split(/\s+/)) {
    if (!t) continue;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`MRML attr contains non-number: '${t}'`);
    out.push(n);
  }
  return out;
}

// MRML stores the *number of values*, not the number of points.
// For a piecewise function each point is 2 values (x, y), so a 7-point
// curve serializes with count=14. For a color transfer each point is 4
// values (x, r, g, b), so count=4*N. See vtkMRMLVolumePropertyNode.cxx.

export function parsePiecewise(attr: string): PiecewisePoint[] {
  const t = tokenize(attr);
  if (t.length === 0) return [];
  const count = t[0];
  if (!Number.isInteger(count) || count < 0 || count % 2 !== 0) {
    throw new Error(`piecewise: invalid count '${t[0]}' (must be non-negative even integer)`);
  }
  if (t.length !== 1 + count) {
    throw new Error(`piecewise: count=${count} expects ${1 + count} tokens, got ${t.length}`);
  }
  const numPoints = count / 2;
  const out: PiecewisePoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    out.push({ x: t[1 + i * 2], y: t[2 + i * 2] });
  }
  return out;
}

export function serializePiecewise(points: readonly PiecewisePoint[]): string {
  const parts: string[] = [String(points.length * 2)];
  for (const p of points) {
    parts.push(num(p.x), num(p.y));
  }
  return parts.join(' ');
}

export function parseColorTransfer(attr: string): ColorPoint[] {
  const t = tokenize(attr);
  if (t.length === 0) return [];
  const count = t[0];
  if (!Number.isInteger(count) || count < 0 || count % 4 !== 0) {
    throw new Error(`colorTransfer: invalid count '${t[0]}' (must be non-negative multiple of 4)`);
  }
  if (t.length !== 1 + count) {
    throw new Error(`colorTransfer: count=${count} expects ${1 + count} tokens, got ${t.length}`);
  }
  const numPoints = count / 4;
  const out: ColorPoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    const o = 1 + i * 4;
    out.push({ x: t[o], r: t[o + 1], g: t[o + 2], b: t[o + 3] });
  }
  return out;
}

export function serializeColorTransfer(points: readonly ColorPoint[]): string {
  const parts: string[] = [String(points.length * 4)];
  for (const p of points) {
    parts.push(num(p.x), num(p.r), num(p.g), num(p.b));
  }
  return parts.join(' ');
}

/** Unified point used by combined color × opacity TF editors. */
export interface CombinedTFPoint {
  x: number;
  opacity: number;
  rgb: [number, number, number];
}

/** Linear-interpolate an opacity TF at x, clamping outside the defined range. */
export function sampleOpacity(points: readonly PiecewisePoint[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.x <= x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return 0;
}

/** Linear-interpolate a color TF at x, clamping outside the defined range. */
export function sampleColor(
  points: readonly ColorPoint[],
  x: number,
): [number, number, number] {
  if (points.length === 0) return [1, 1, 1];
  if (x <= points[0].x) return [points[0].r, points[0].g, points[0].b];
  const last = points[points.length - 1];
  if (x >= last.x) return [last.r, last.g, last.b];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.x <= x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return [
        a.r + t * (b.r - a.r),
        a.g + t * (b.g - a.g),
        a.b + t * (b.b - a.b),
      ];
    }
  }
  return [1, 1, 1];
}

/**
 * A single editable curve. The CombinedTransferFunctionEditor holds a stack
 * of these; toMrmlAttributes() composes them into a single output TF.
 */
export interface TFLayer {
  id: string;
  name: string;
  visible: boolean;
  controlPoints: CombinedTFPoint[];
}

export type LayerBlendMode = 'max' | 'add';

/**
 * Sample one layer's combined-TF curve at x: returns both opacity and color
 * with linear interpolation, clamping outside the defined range.
 */
export function sampleCombinedAt(
  pts: readonly CombinedTFPoint[],
  x: number,
): { opacity: number; rgb: [number, number, number] } {
  if (pts.length === 0) return { opacity: 0, rgb: [1, 1, 1] };
  if (x <= pts[0].x) {
    return { opacity: pts[0].opacity, rgb: [...pts[0].rgb] as [number, number, number] };
  }
  const last = pts[pts.length - 1];
  if (x >= last.x) {
    return { opacity: last.opacity, rgb: [...last.rgb] as [number, number, number] };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.x <= x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return {
        opacity: a.opacity + t * (b.opacity - a.opacity),
        rgb: [
          a.rgb[0] + t * (b.rgb[0] - a.rgb[0]),
          a.rgb[1] + t * (b.rgb[1] - a.rgb[1]),
          a.rgb[2] + t * (b.rgb[2] - a.rgb[2]),
        ],
      };
    }
  }
  return { opacity: 0, rgb: [1, 1, 1] };
}

/**
 * Composite a stack of TF layers into a single (scalarOpacity, colorTransfer)
 * pair. Layers are sampled at the union of all their control-point xs.
 *
 *   blend='max'  → output_opacity = max(layer_opacity at x), output_color = color from the layer that won the max
 *   blend='add'  → output_opacity = clamp01(Σ layer_opacity at x), color weighted by each layer's opacity contribution
 */
export function compositeLayers(
  layers: readonly TFLayer[],
  blend: LayerBlendMode = 'max',
): { opacity: PiecewisePoint[]; color: ColorPoint[] } {
  const visible = layers.filter((l) => l.visible && l.controlPoints.length >= 2);
  if (visible.length === 0) return { opacity: [], color: [] };
  const xs = new Set<number>();
  for (const l of visible) for (const p of l.controlPoints) xs.add(p.x);
  const sortedXs = [...xs].sort((a, b) => a - b);

  const opacity: PiecewisePoint[] = [];
  const color: ColorPoint[] = [];

  for (const x of sortedXs) {
    if (blend === 'max') {
      // Initialise from the first visible layer so opacity-zero regions
      // still carry their layer's actual color (otherwise pure-zero points
      // would all default to white in the output color TF).
      const seed = sampleCombinedAt(visible[0].controlPoints, x);
      let maxOp = seed.opacity;
      let bestRgb: [number, number, number] = seed.rgb;
      for (let li = 1; li < visible.length; li++) {
        const s = sampleCombinedAt(visible[li].controlPoints, x);
        if (s.opacity > maxOp) {
          maxOp = s.opacity;
          bestRgb = s.rgb;
        }
      }
      opacity.push({ x, y: maxOp });
      color.push({ x, r: bestRgb[0], g: bestRgb[1], b: bestRgb[2] });
    } else {
      // additive: sum opacities, opacity-weighted color
      let sumOp = 0;
      let wR = 0, wG = 0, wB = 0;
      for (const l of visible) {
        const s = sampleCombinedAt(l.controlPoints, x);
        sumOp += s.opacity;
        wR += s.opacity * s.rgb[0];
        wG += s.opacity * s.rgb[1];
        wB += s.opacity * s.rgb[2];
      }
      const o = Math.min(1, sumOp);
      const norm = sumOp > 1e-9 ? 1 / sumOp : 0;
      opacity.push({ x, y: o });
      color.push({
        x,
        r: norm ? wR * norm : 1,
        g: norm ? wG * norm : 1,
        b: norm ? wB * norm : 1,
      });
    }
  }
  return { opacity, color };
}

/**
 * Project two separately-defined transfer functions onto a single unified
 * set of x positions (union of both TFs' xs), sampling each at every x.
 * Useful when importing MRML where scalarOpacity and colorTransfer may not
 * share the same control point xs.
 */
export function unifyTransferFunctions(
  opacity: readonly PiecewisePoint[],
  color: readonly ColorPoint[],
): CombinedTFPoint[] {
  const xs = new Set<number>();
  for (const p of opacity) xs.add(p.x);
  for (const p of color) xs.add(p.x);
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.map((x) => ({
    x,
    opacity: sampleOpacity(opacity, x),
    rgb: sampleColor(color, x),
  }));
}

/** Sort and merge near-duplicate xs to keep the function single-valued. */
export function normalizePiecewise(
  points: readonly PiecewisePoint[],
  tolerance = 1e-6,
): PiecewisePoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const out: PiecewisePoint[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) < tolerance) {
      // Keep the later point's y but nudge x forward to maintain order.
      prev.y = p.y;
    } else {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

/** Format number trim-friendly: integers stay integers, floats use up to 6 sig digits. */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const s = n.toPrecision(7);
  // Strip trailing zeros from fixed forms only ("1.2300" → "1.23"; "1e-7" left alone).
  if (s.includes('e') || s.includes('E')) return s;
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
