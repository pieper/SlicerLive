export type RGB = readonly [number, number, number];
export type HSV = readonly [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function rgbToHsv([r, g, b]: RGB): HSV {
  const R = clamp01(r), G = clamp01(g), B = clamp01(b);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

export function hsvToRgb([h, s, v]: HSV): RGB {
  const H = clamp01(h), S = clamp01(s), V = clamp01(v);
  const c = V * S;
  const h6 = H * 6;
  const x = c * (1 - Math.abs((h6 % 2) - 1));
  const m = V - c;
  let r = 0, g = 0, b = 0;
  if (h6 < 1)      { r = c; g = x; b = 0; }
  else if (h6 < 2) { r = x; g = c; b = 0; }
  else if (h6 < 3) { r = 0; g = c; b = x; }
  else if (h6 < 4) { r = 0; g = x; b = c; }
  else if (h6 < 5) { r = x; g = 0; b = c; }
  else             { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}

export function rgbToHex([r, g, b]: RGB, alpha?: number): string {
  const h = (v: number) =>
    Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return alpha === undefined || alpha === 1 ? base : `${base}${h(alpha)}`;
}

export function hexToRgba(hex: string): { rgb: RGB; alpha: number } | null {
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const alpha = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  return { rgb: [r, g, b], alpha };
}

/** Distance for tests / quick equality. */
export function rgbApproxEqual(a: RGB, b: RGB, eps = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) <= eps
      && Math.abs(a[1] - b[1]) <= eps
      && Math.abs(a[2] - b[2]) <= eps;
}
