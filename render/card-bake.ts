// Bake a label card's "ink" (border + colour swatch + name + terminology + stats + buttons; NO glass
// fill) into an RGBA texture via canvas2d, for use as a CardField's front-face content. Alpha marks ink;
// the glass body (alpha 0) is supplied by the CardField in the ray-march. Browser-only (canvas), reached
// through globalThis so `deno check` needs no DOM lib.

export interface CardContent {
  title: string;
  subtitle?: string;
  swatch?: [number, number, number];
  lines?: string[];                    // stat lines shown when expanded
  buttons?: string[];                  // action buttons shown when expanded
  expanded?: boolean;
}
export interface CardBakeStyle {
  titlePx?: number; bodyPx?: number; padPx?: number; gapPx?: number; maxTextPx?: number;
  fontFamily?: string; radiusPx?: number; borderPx?: number; btnPx?: number;
}
export interface BakedCard { data: Uint8Array; w: number; h: number; buttons: { x: number; y: number; w: number; h: number; label: string }[] }

interface Ctx2D {
  font: string; fillStyle: string; strokeStyle: string; lineWidth: number; textBaseline: string;
  measureText(t: string): { width: number };
  fillText(t: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void; roundRect?(x: number, y: number, w: number, h: number, r: number): void; stroke(): void; fill(): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  clearRect(x: number, y: number, w: number, h: number): void;
}
interface Canvas2D { width: number; height: number; getContext(id: "2d"): Ctx2D | null }
function makeCanvas(w: number, h: number): Canvas2D {
  const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => Canvas2D; document?: { createElement(t: string): Canvas2D } };
  if (g.OffscreenCanvas) return new g.OffscreenCanvas(w, h);
  if (g.document) { const c = g.document.createElement("canvas"); c.width = w; c.height = h; return c; }
  throw new Error("card-bake: no canvas (browser only)");
}

/** Bake `content` to an ink texture at device-pixel scale `dpr`. Returns the RGBA bytes + size + button
 *  rects (in the baked px space) for hit-testing. */
export function bakeCardFace(content: CardContent, dpr = 2, style: CardBakeStyle = {}): BakedCard {
  const titlePx = (style.titlePx ?? 15) * dpr, bodyPx = (style.bodyPx ?? 12) * dpr, pad = (style.padPx ?? 10) * dpr,
    gap = (style.gapPx ?? 5) * dpr, maxT = (style.maxTextPx ?? 240) * dpr, radius = (style.radiusPx ?? 6) * dpr,
    border = (style.borderPx ?? 1.25) * dpr, btnH = (style.btnPx ?? 12) * dpr + 10 * dpr, btnGap = 4 * dpr, btnPad = 8 * dpr;
  const fam = style.fontFamily ?? 'Helvetica, "Helvetica Neue", Arial, sans-serif';
  const sw = Math.round(titlePx);

  // measure with a scratch context
  const scratch = makeCanvas(8, 8).getContext("2d")!;
  const wrap = (text: string, px: number, maxW: number): string[] => {
    scratch.font = `${px}px ${fam}`;
    const words = text.split(" "); const out: string[] = []; let line = "";
    for (const w of words) { const t = line ? line + " " + w : w; if (scratch.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    if (line) out.push(line); return out.length ? out : [""];
  };
  const measure = (text: string, px: number) => { scratch.font = `${px}px ${fam}`; return scratch.measureText(text).width; };

  const titleLines = wrap(content.title, titlePx, maxT - sw - gap);
  const subLines = content.subtitle ? wrap(content.subtitle, bodyPx, maxT) : [];
  const statLines = content.expanded ? (content.lines ?? []) : [];
  const btns = content.expanded ? (content.buttons ?? []) : [];

  const titleW = Math.max(...titleLines.map((l) => measure(l, titlePx)));
  const subW = subLines.length ? Math.max(...subLines.map((l) => measure(l, bodyPx))) : 0;
  const statW = statLines.length ? Math.max(...statLines.map((l) => measure(l, bodyPx))) : 0;
  const btnLabelW = btns.length ? Math.max(...btns.map((b) => measure(b, bodyPx))) : 0;
  const lh = (px: number) => px * 1.25;
  const row1H = Math.max(titleLines.length * lh(titlePx), sw);

  const contentW = Math.max(sw + gap + titleW, subW, statW, btnLabelW + btnPad * 2);
  const w = Math.ceil(contentW + pad * 2);
  let y = pad + row1H + (subLines.length ? gap + subLines.length * lh(bodyPx) : 0);
  const statTop = y + gap;
  if (statLines.length) y = statTop + statLines.length * lh(bodyPx) + gap;
  const btnTop = y;
  const buttons: BakedCard["buttons"] = [];
  if (btns.length) { for (let i = 0; i < btns.length; i++) buttons.push({ x: pad, y: btnTop + i * (btnH + btnGap), w: w - pad * 2, h: btnH, label: btns[i] }); y = btnTop + btns.length * (btnH + btnGap) - btnGap; }
  const h = Math.ceil(y + pad);

  const cv = makeCanvas(w, h), g = cv.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  const rrect = (x: number, yy: number, ww: number, hh: number, r: number) => { g.beginPath(); if (g.roundRect) g.roundRect(x, yy, ww, hh, r); else { g.strokeRect(x, yy, ww, hh); return; } };
  // border (ink)
  g.strokeStyle = "#000"; g.lineWidth = border; rrect(border / 2, border / 2, w - border, h - border, radius); g.stroke();
  // swatch
  if (content.swatch) { const [r, gg, b] = content.swatch; g.fillStyle = `rgb(${r * 255|0},${gg * 255|0},${b * 255|0})`; g.fillRect(pad, pad, sw, sw); g.strokeStyle = "#000"; g.lineWidth = 1.5 * dpr; g.strokeRect(pad, pad, sw, sw); }
  // title (black)
  g.fillStyle = "#000"; g.textBaseline = "alphabetic"; g.font = `${titlePx}px ${fam}`;
  titleLines.forEach((l, i) => g.fillText(l, pad + sw + gap, pad + titlePx * 0.9 + i * lh(titlePx)));
  // subtitle (grey)
  g.fillStyle = "#4a4a52"; g.font = `${bodyPx}px ${fam}`;
  subLines.forEach((l, i) => g.fillText(l, pad, pad + row1H + gap + bodyPx * 0.9 + i * lh(bodyPx)));
  // stats (black)
  g.fillStyle = "#000";
  statLines.forEach((l, i) => g.fillText(l, pad, statTop + bodyPx * 0.9 + i * lh(bodyPx)));
  // buttons (light fill + border + centred label)
  for (const b of buttons) {
    g.fillStyle = "#e8e9ef"; g.fillRect(b.x, b.y, b.w, b.h);
    g.strokeStyle = "#000"; g.lineWidth = 1 * dpr; g.strokeRect(b.x, b.y, b.w, b.h);
    g.fillStyle = "#000"; const lw = measure(b.label, bodyPx); g.fillText(b.label, b.x + (b.w - lw) / 2, b.y + b.h / 2 + bodyPx * 0.35);
  }

  const img = g.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h * 4); data.set(img);
  return { data, w, h, buttons };
}

/** Upload a baked card to an r… rgba8unorm-srgb texture the CardField samples. */
export function uploadCard(dev: GPUDevice, baked: BakedCard): GPUTexture {
  const tex = dev.createTexture({ size: [baked.w, baked.h], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  dev.queue.writeTexture({ texture: tex }, baked.data, { bytesPerRow: baked.w * 4, rowsPerImage: baked.h }, [baked.w, baked.h]);
  return tex;
}
