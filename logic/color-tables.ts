// Color-table catalog + LUT builder (W3). Mirrors Slicer's vtkMRMLColorTableNode continuous ramps
// (Grey/InvertedGrey/Rainbow/Ocean/Iron/Fire/Cool/Warm) as 256-entry RGB ramps, plus a CPU reference
// (`sampleColor`) matching the slice shader's map: scalar --W/L--> t in [0,1] --LUT--> RGBA, threshold zeros
// alpha only. The 256-entry `colorTable` node (entries: number[][] of [r,g,b,a] in 0..1) is what
// livescene.ts:lutFor consumes; `tableNode()` emits one. RAS/geometry-free: pure color math.
//
// deno test -A --no-check logic/color-tables.test.ts

export type RGB = [number, number, number];
export interface ColorTable { id: string; name: string; ramp: (t: number) => RGB; } // t in [0,1]

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
// piecewise-linear ramp through control colors evenly spaced on [0,1]
function pw(stops: RGB[]): (t: number) => RGB {
  const n = stops.length - 1;
  return (t: number) => {
    t = clamp01(t);
    const f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
    const a = stops[i], b = stops[i + 1];
    return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
  };
}
// Rainbow = Slicer's default "Rainbow": hue 0 (red) .. 0.667 (blue) reversed so low=blue, high=red.
function rainbow(t: number): RGB { return hsv2rgb((1 - clamp01(t)) * 0.6667, 1, 1); }
function hsv2rgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), u = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, u, p]; case 1: return [q, v, p]; case 2: return [p, v, u];
    case 3: return [p, q, v]; case 4: return [u, p, v]; default: return [v, p, q];
  }
}

export const COLOR_TABLES: ColorTable[] = [
  { id: "vtkMRMLColorTableNodeGrey", name: "Grey", ramp: (t) => [clamp01(t), clamp01(t), clamp01(t)] },
  { id: "vtkMRMLColorTableNodeInvertedGrey", name: "InvertedGrey", ramp: (t) => [1 - clamp01(t), 1 - clamp01(t), 1 - clamp01(t)] },
  { id: "vtkMRMLColorTableNodeRainbow", name: "Rainbow", ramp: rainbow },
  { id: "vtkMRMLColorTableNodeOcean", name: "Ocean", ramp: pw([[0, 0, 0], [0, 0.25, 0.5], [0, 0.6, 0.85], [0.6, 0.95, 1], [1, 1, 1]]) },
  { id: "vtkMRMLColorTableNodeIron", name: "Iron", ramp: pw([[0, 0, 0], [0.5, 0, 0], [0.9, 0.45, 0], [1, 0.85, 0.2], [1, 1, 1]]) },
  { id: "vtkMRMLColorTableNodeFire", name: "Fire", ramp: pw([[0, 0, 0], [0.7, 0, 0], [1, 0.6, 0], [1, 1, 0], [1, 1, 1]]) },
  { id: "vtkMRMLColorTableNodeCool", name: "Cool", ramp: pw([[0, 1, 1], [0, 0.5, 1], [0.3, 0, 1]]) },
  { id: "vtkMRMLColorTableNodeWarm", name: "Warm", ramp: pw([[0.3, 0, 0], [1, 0.3, 0], [1, 1, 0.3]]) },
];

export function colorTableById(id: string): ColorTable {
  return COLOR_TABLES.find((c) => c.id === id) ?? COLOR_TABLES[0];
}

/** 256-entry RGBA ramp (0..1) for a table -- the shape livescene stores as a `colorTable` node's `entries`. */
export function tableEntries(table: ColorTable | string): number[][] {
  const t = typeof table === "string" ? colorTableById(table) : table;
  const out: number[][] = new Array(256);
  for (let i = 0; i < 256; i++) { const c = t.ramp(i / 255); out[i] = [c[0], c[1], c[2], 1]; }
  return out;
}

/** 256*4 Uint8 LUT (RGBA 0..255) -- a GPU-ready copy of `tableEntries`. */
export function lut(table: ColorTable | string): Uint8Array {
  const e = tableEntries(table), out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { out[i * 4] = Math.round(e[i][0] * 255); out[i * 4 + 1] = Math.round(e[i][1] * 255); out[i * 4 + 2] = Math.round(e[i][2] * 255); out[i * 4 + 3] = 255; }
  return out;
}

/** A ready-to-put `colorTable` node for the catalog entry. */
export function tableNode(table: ColorTable | string): { id: string; type: string; name: string; entries: number[][] } {
  const t = typeof table === "string" ? colorTableById(table) : table;
  return { id: t.id, type: "colorTable", name: t.name, entries: tableEntries(t) };
}

/**
 * CPU reference for the slice shader's mapping, for tests/parity: scalar --W/L--> t in [0,1] --table--> RGBA.
 * threshold (if given, [lo,hi] in scalar units) zeroes alpha OUTSIDE the range, color unchanged (Slicer's
 * "apply threshold" is alpha-only). Returns RGBA in 0..255.
 */
export function sampleColor(
  table: ColorTable | string,
  scalar: number,
  window: number,
  level: number,
  threshold?: [number, number],
): [number, number, number, number] {
  const t = typeof table === "string" ? colorTableById(table) : table;
  const lo = level - window / 2, hi = level + window / 2;
  const u = window <= 0 ? (scalar >= level ? 1 : 0) : clamp01((scalar - lo) / (hi - lo));
  const c = t.ramp(u);
  let a = 255;
  if (threshold && (scalar < threshold[0] || scalar > threshold[1])) a = 0;
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), a];
}
