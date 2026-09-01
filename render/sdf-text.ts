// SDF text — the foundational "in-scene GPU text" primitive (previously absent: all SlicerLive text was
// canvas2d overlay). This module is the CPU half, kept free of GPU/DOM lib types so it is Deno-testable:
//   • buildFontAtlas() — rasterize a glyph set via canvas2d, convert coverage to a signed-distance atlas
//     (2D Felzenszwalb EDT), return the atlas bytes + per-glyph metrics. Browser-only (uses a canvas,
//     reached through globalThis so `deno check` needs no DOM lib).
//   • layoutText() — pure: shape a string into positioned glyph quads with word-wrap; unit-tested.
// The GPU upload + draw pipeline lives with its consumer (render/label-cards.ts). An SDF atlas stays
// crisp at any scale/rotation via `smoothstep(0.5-aa, 0.5+aa, d)`, which is why it — not a baked bitmap —
// is the primitive for the scene-native UI direction (rotatable/flippable labels later).

export interface GlyphMetric {
  advance: number;                 // pen advance at atlas sizePx
  ax: number; ay: number;          // atlas cell top-left (px)
  aw: number; ah: number;          // atlas cell size (px) — inked box grown by `spread` on every side
  offX: number; offY: number;      // cell top-left relative to the pen origin (baseline-left), px
}

export interface FontAtlas {
  sizePx: number;                  // glyph raster size the metrics are in
  spread: number;                  // SDF half-range in px (== pad); 0.5 = edge
  atlasW: number; atlasH: number;
  data: Uint8Array;                // atlasW*atlasH, r8 SDF (0..255; 128 ≈ edge)
  glyphs: Map<string, GlyphMetric>;
  ascent: number; descent: number; lineHeight: number;   // px at sizePx
}

export interface GlyphQuad { x: number; y: number; w: number; h: number; u0: number; v0: number; u1: number; v1: number }
export interface TextLayout { quads: GlyphQuad[]; width: number; height: number; lines: number }

// ── pure: string → positioned glyph quads (word-wrap), scaled to pxSize ──────────────────────────────
export function layoutText(font: FontAtlas, text: string, opts: { pxSize?: number; maxWidthPx?: number; lineGap?: number } = {}): TextLayout {
  const pxSize = opts.pxSize ?? font.sizePx;
  const s = pxSize / font.sizePx;
  const maxW = opts.maxWidthPx ?? Infinity;
  const lineH = (font.lineHeight + (opts.lineGap ?? 0)) * s;
  const space = (font.glyphs.get(" ")?.advance ?? font.sizePx * 0.3) * s;

  const quads: GlyphQuad[] = [];
  let maxLineW = 0, lineIdx = 0;
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    const words = para.split(" ").filter((w, _i, a) => w.length > 0 || a.length === 1);
    let penX = 0;
    const baseline = () => lineIdx * lineH + font.ascent * s;
    const wordWidth = (w: string) => { let x = 0; for (const ch of w) x += (font.glyphs.get(ch)?.advance ?? space / s) * s; return x; };
    const emit = (w: string) => {
      for (const ch of w) {
        const g = font.glyphs.get(ch);
        if (g) {
          if (g.aw > 0 && g.ah > 0) quads.push({
            x: penX + g.offX * s, y: baseline() + g.offY * s, w: g.aw * s, h: g.ah * s,
            u0: g.ax / font.atlasW, v0: g.ay / font.atlasH, u1: (g.ax + g.aw) / font.atlasW, v1: (g.ay + g.ah) / font.atlasH,
          });
          penX += g.advance * s;
        } else penX += space;
      }
    };
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      const need = (penX > 0 ? space : 0) + wordWidth(w);
      if (penX > 0 && penX + need > maxW) { maxLineW = Math.max(maxLineW, penX); lineIdx++; penX = 0; }
      else if (penX > 0) penX += space;
      emit(w);
    }
    maxLineW = Math.max(maxLineW, penX);
    lineIdx++;
  }
  return { quads, width: maxLineW, height: lineIdx * lineH, lines: lineIdx };
}

// ── pure: signed distance field from a coverage mask (2D Felzenszwalb EDT) ────────────────────────────
const INF = 1e20;
/** 1D squared-distance transform of `f` (Felzenszwalb & Huttenlocher). `f[i]`=0 at feature pixels, INF else. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dv = q - v[k];
    d[q] = dv * dv + f[v[k]];
  }
}
/** Squared Euclidean distance (px^2) from every pixel to the nearest feature pixel (mask!=0). */
function edt2d(mask: Uint8Array, w: number, h: number): Float64Array {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  const maxn = Math.max(w, h);
  const f = new Float64Array(maxn), d = new Float64Array(maxn), z = new Float64Array(maxn + 1); const v = new Int32Array(maxn);
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = g[y * w + x]; edt1d(f, h, d, v, z); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[y * w + x]; edt1d(f, w, d, v, z); for (let x = 0; x < w; x++) g[y * w + x] = d[x]; }
  return g;
}
/** Signed distance (px, inside positive) from a coverage mask, encoded to r8 with `spread` px half-range. */
export function sdfFromMask(alpha: Uint8Array, w: number, h: number, spread: number): Uint8Array {
  const inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const on = alpha[i] >= 128 ? 1 : 0; inside[i] = on; outside[i] = on ? 0 : 1; }
  const dOut = edt2d(inside, w, h);   // outside pixels: dist to nearest inside
  const dIn = edt2d(outside, w, h);   // inside pixels: dist to nearest outside
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const signed = inside[i] ? Math.sqrt(dIn[i]) : -Math.sqrt(dOut[i]);   // inside positive
    out[i] = Math.max(0, Math.min(255, Math.round((0.5 + signed / (2 * spread)) * 255)));
  }
  return out;
}

// ── browser: rasterize glyphs → signed-distance atlas (reached via globalThis, no DOM lib needed) ─────
interface Ctx2D {
  font: string; fillStyle: string; textBaseline: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number; actualBoundingBoxLeft?: number; actualBoundingBoxRight?: number };
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface Canvas2D { width: number; height: number; getContext(id: "2d"): Ctx2D | null }

function makeCanvas(w: number, h: number): Canvas2D {
  const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => Canvas2D; document?: { createElement(t: string): Canvas2D } };
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(w, h);
  if (g.document) { const c = g.document.createElement("canvas"); c.width = w; c.height = h; return c; }
  throw new Error("sdf-text: no canvas available (browser only)");
}

export const DEFAULT_CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~°±×µ–—";

/** Rasterize `chars` at `sizePx` in `fontFamily`, convert each cell to a signed-distance field. Browser. */
export function buildFontAtlas(opts: { sizePx?: number; spread?: number; chars?: string; fontFamily?: string; weight?: string; atlasW?: number } = {}): FontAtlas {
  const sizePx = opts.sizePx ?? 44;
  const spread = opts.spread ?? 6;
  const chars = [...(opts.chars ?? DEFAULT_CHARS)];
  const fontStr = `${opts.weight ?? "normal"} ${sizePx}px ${opts.fontFamily ?? "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"}`;
  const cell = Math.ceil(sizePx * 1.6) + spread * 2;            // uniform cell; fits tall/wide glyphs + halo
  const atlasW = opts.atlasW ?? 1024;
  const cols = Math.max(1, Math.floor(atlasW / cell));
  const rows = Math.ceil(chars.length / cols);
  const atlasH = rows * cell;

  const cv = makeCanvas(atlasW, atlasH);
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("sdf-text: no 2d context");
  ctx.font = fontStr; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#fff";

  const glyphs = new Map<string, GlyphMetric>();
  let ascent = 0, descent = 0;
  const placed: { ch: string; cx: number; cy: number; iw: number; ih: number; offX: number; offY: number; advance: number }[] = [];
  chars.forEach((ch, i) => {
    const m = ctx.measureText(ch);
    const asc = m.actualBoundingBoxAscent ?? sizePx * 0.75, desc = m.actualBoundingBoxDescent ?? sizePx * 0.2;
    const left = m.actualBoundingBoxLeft ?? 0, right = m.actualBoundingBoxRight ?? m.width;
    ascent = Math.max(ascent, asc); descent = Math.max(descent, desc);
    const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
    const inkW = Math.max(0, left + right), inkH = Math.max(0, asc + desc);
    // draw so the inked box sits at (cx+spread, cy+spread); baseline-left pen there
    const drawX = cx + spread + left, drawY = cy + spread + asc;
    if (ch !== " " && inkW > 0 && inkH > 0) ctx.fillText(ch, drawX, drawY);
    placed.push({ ch, cx, cy, iw: inkW, ih: inkH, offX: -(spread + left), offY: -(spread + asc), advance: m.width });
  });

  const img = ctx.getImageData(0, 0, atlasW, atlasH).data;   // rgba; glyph is white on transparent → use alpha
  const alpha = new Uint8Array(atlasW * atlasH);
  for (let i = 0; i < atlasW * atlasH; i++) alpha[i] = img[i * 4 + 3];

  const data = new Uint8Array(atlasW * atlasH); data.fill(0);   // 0 = fully outside
  for (const p of placed) {
    const cw = Math.min(cell, atlasW - p.cx), chh = Math.min(cell, atlasH - p.cy);
    if (p.iw <= 0 || p.ih <= 0) { glyphs.set(p.ch, { advance: p.advance, ax: p.cx, ay: p.cy, aw: 0, ah: 0, offX: 0, offY: 0 }); continue; }
    // per-cell signed EDT (bleed-free): extract the cell, transform, write back
    const sub = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) sub[y * cw + x] = alpha[(p.cy + y) * atlasW + (p.cx + x)];
    const sdf = sdfFromMask(sub, cw, chh, spread);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) data[(p.cy + y) * atlasW + (p.cx + x)] = sdf[y * cw + x];
    const aw = Math.ceil(p.iw) + spread * 2, ah = Math.ceil(p.ih) + spread * 2;
    glyphs.set(p.ch, { advance: p.advance, ax: p.cx, ay: p.cy, aw: Math.min(aw, cw), ah: Math.min(ah, chh), offX: p.offX, offY: p.offY });
  }

  return { sizePx, spread, atlasW, atlasH, data, glyphs, ascent, descent, lineHeight: ascent + descent };
}
