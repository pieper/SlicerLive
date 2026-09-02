// Anatomy label cards — a WebGPU overlay of museum-exhibit tags over the 3D scene. Each card is a
// ground-glass panel tethered by a leader line to a pin at its segment's location; a force-directed
// layout (render/label-layout.ts) keeps <=12 legible and non-overlapping as the camera/specimen move.
// Text is SDF (render/sdf-text.ts) → crisp at any size.
//
// COLLAPSED: a colour swatch (black border) + name (black) + coded-terminology line (grey), sized snug to
// that content. CLICK to EXPAND: the card grows to reveal segment stats (voxels, volume cc, HU mean±sd)
// and action buttons Isolate / Hide / Reset opacities; click again to collapse. The card is only ever as
// big as its shown content (the force layout reflows neighbours when it changes size). The overlay
// hit-tests + toggles expansion; the host wires the button actions.
//
// Two pipelines share a viewport uniform: a rounded-rect/line "shape" pass (card bg, border, swatch,
// buttons, leader lines, pins) and an SDF "text" pass. Ground glass is approximated (translucent white +
// thin black border); a true backdrop blur is a follow-up. Screen space = DEVICE px; draw AFTER the scene
// with loadOp:"load". Premultiplied-alpha blending throughout.

import type { Gpu } from "./device.ts";
import type { Vec3 } from "./mat4.ts";
import type { VtkCamera } from "./vtk-camera.ts";
import { type FontAtlas, type GlyphQuad, layoutText } from "./sdf-text.ts";
import { type CardBody, layoutStep, seedCards } from "./label-layout.ts";

export type CardAction = "toggle" | "isolate" | "hide" | "reset";
export interface CardStat { voxels: number; volumeCc: number; hu?: { mean: number; std: number } }
export interface CardSpec {
  anchorRAS: Vec3;
  id?: number;                        // segment number (for the host's action dispatch)
  title: string;
  subtitle?: string;                  // terminology line
  swatch?: [number, number, number];  // segment colour block
  stat?: CardStat;                    // revealed on expand
}
export interface Viewport { w: number; h: number; dpr: number }
export interface HitResult { index: number; action: CardAction }

type RGBA = [number, number, number, number];
interface TextRun { quads: GlyphQuad[]; color: RGBA }
interface Rect { x: number; y: number; w: number; h: number }
interface Button extends Rect { part: CardAction; label: TextRun }
interface PreparedCard {
  spec: CardSpec;
  cw: number; ch: number; ew: number; eh: number;   // collapsed / expanded size
  mw: number; mh: number;                            // mini card size (compact mode: swatch + name, no terminology)
  miniHead: { runs: TextRun[]; swatch?: Rect & { color: RGBA } };
  head: { runs: TextRun[]; swatch?: Rect & { color: RGBA } };
  extra: { runs: TextRun[]; buttons: Button[] };
  expanded: boolean;
}

const BUTTONS: { label: string; part: CardAction }[] = [
  { label: "Isolate", part: "isolate" }, { label: "Hide", part: "hide" }, { label: "Reset opacities", part: "reset" },
];
const BLACK: RGBA = [0, 0, 0, 1];
const GREY: RGBA = [0.32, 0.32, 0.36, 1];

const SHAPE_WGSL = /* wgsl */ `
struct VP { size : vec4<f32> };
@group(0) @binding(0) var<uniform> u : VP;
struct VO { @builtin(position) pos : vec4<f32>, @location(0) p : vec2<f32>, @location(1) center : vec2<f32>,
            @location(2) half : vec2<f32>, @location(3) params : vec4<f32>, @location(4) fill : vec4<f32>, @location(5) border : vec4<f32> };
@vertex fn vs(@location(0) posPx : vec2<f32>, @location(1) center : vec2<f32>, @location(2) half : vec2<f32>,
              @location(3) params : vec4<f32>, @location(4) fill : vec4<f32>, @location(5) border : vec4<f32>) -> VO {
  var o : VO;
  o.pos = vec4<f32>(posPx.x / u.size.x * 2.0 - 1.0, 1.0 - posPx.y / u.size.y * 2.0, 0.0, 1.0);
  o.p = posPx; o.center = center; o.half = half; o.params = params; o.fill = fill; o.border = border;
  return o;
}
fn sdRoundBox(p : vec2<f32>, b : vec2<f32>, r : f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0))) - r;
}
@fragment fn fs(i : VO) -> @location(0) vec4<f32> {
  if (i.params.z > 0.5) { return vec4<f32>(i.fill.rgb * i.fill.a, i.fill.a); }   // plain (leader lines)
  let d = sdRoundBox(i.p - i.center, i.half, i.params.x);
  let cov = 1.0 - smoothstep(0.0, 1.0, d);
  if (cov <= 0.0) { discard; }
  let inner = 1.0 - smoothstep(0.0, 1.0, d + i.params.y);
  var col = mix(i.border, i.fill, inner);
  col.a = col.a * cov;
  return vec4<f32>(col.rgb * col.a, col.a);
}`;

const TEXT_WGSL = /* wgsl */ `
struct VP { size : vec4<f32> };
@group(0) @binding(0) var<uniform> u : VP;
@group(0) @binding(1) var atlas : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;
struct TO { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32>, @location(1) color : vec4<f32> };
@vertex fn vs(@location(0) posPx : vec2<f32>, @location(1) uv : vec2<f32>, @location(2) color : vec4<f32>) -> TO {
  var o : TO;
  o.pos = vec4<f32>(posPx.x / u.size.x * 2.0 - 1.0, 1.0 - posPx.y / u.size.y * 2.0, 0.0, 1.0);
  o.uv = uv; o.color = color; return o;
}
@fragment fn fs(i : TO) -> @location(0) vec4<f32> {
  let d = textureSample(atlas, samp, i.uv).r;
  let aa = fwidth(d) + 1e-4;
  let a = smoothstep(0.5 - aa, 0.5 + aa, d) * i.color.a;
  if (a <= 0.001) { discard; }
  return vec4<f32>(i.color.rgb * a, a);
}`;

const PREMUL_BLEND: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

export interface LayoutExtra { boundary?: { minX: number; minY: number; maxX: number; maxY: number }; ringGap?: number }

export interface CardStyle {
  scale?: number;   // multiply all px metrics (card + text size) — e.g. 2 for a larger card in a busy 3D cell
  titlePx?: number; bodyPx?: number; padPx?: number; gapPx?: number; maxTextPx?: number;
  radiusPx?: number; borderPx?: number; glassRGBA?: RGBA; borderRGBA?: RGBA;
  leaderRGBA?: RGBA; leaderPx?: number; buttonRGBA?: RGBA;
}

export class CardOverlay {
  private dev: GPUDevice;
  private shapePipe: GPURenderPipeline;
  private textPipe: GPURenderPipeline;
  private vpBuf: GPUBuffer;
  private shapeBind: GPUBindGroup;
  private textBind: GPUBindGroup;
  private atlasTex: GPUTexture;
  private font: FontAtlas;
  private st: Required<Omit<CardStyle, "scale">>;
  private dpr = 1;
  private compact = false;   // many segments → cards collapse to a mini card (swatch + name), full card on click

  private shapeBuf?: GPUBuffer; private shapeCap = 0;
  private textBuf?: GPUBuffer; private textCap = 0;

  private cards: PreparedCard[] = [];
  private bodies: CardBody[] = [];
  private seeded = false;
  private lastVisible: boolean[] = [];
  perf = { layoutMs: 0, buildMs: 0, submitMs: 0 };
  private maxSpeed = 0;
  /** True when every card is at rest — lets the host stop rendering (dormant) until the next change. */
  settled(): boolean { return this.maxSpeed < 1.5; }

  constructor(gpu: Gpu, format: GPUTextureFormat, font: FontAtlas, style: CardStyle = {}) {
    this.dev = gpu.device;
    this.font = font;
    const sc = style.scale ?? 1;
    this.st = {
      titlePx: (style.titlePx ?? 15) * sc, bodyPx: (style.bodyPx ?? 12) * sc, padPx: (style.padPx ?? 10) * sc, gapPx: (style.gapPx ?? 5) * sc,
      maxTextPx: (style.maxTextPx ?? 240) * sc, radiusPx: (style.radiusPx ?? 6) * sc, borderPx: (style.borderPx ?? 1.25) * sc,
      glassRGBA: style.glassRGBA ?? [1, 1, 1, 0.82], borderRGBA: style.borderRGBA ?? [0, 0, 0, 0.92],
      leaderRGBA: style.leaderRGBA ?? [0.05, 0.05, 0.05, 0.85], leaderPx: (style.leaderPx ?? 1.5) * sc,
      buttonRGBA: style.buttonRGBA ?? [0.9, 0.91, 0.95, 1],
    };

    this.atlasTex = this.dev.createTexture({ size: [font.atlasW, font.atlasH], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.dev.queue.writeTexture({ texture: this.atlasTex }, font.data, { bytesPerRow: font.atlasW, rowsPerImage: font.atlasH }, [font.atlasW, font.atlasH]);
    const sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.vpBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const shapeMod = this.dev.createShaderModule({ code: SHAPE_WGSL });
    this.shapePipe = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: shapeMod, entryPoint: "vs", buffers: [{ arrayStride: 72, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" },
        { shaderLocation: 2, offset: 16, format: "float32x2" }, { shaderLocation: 3, offset: 24, format: "float32x4" },
        { shaderLocation: 4, offset: 40, format: "float32x4" }, { shaderLocation: 5, offset: 56, format: "float32x4" } ] }] },
      fragment: { module: shapeMod, entryPoint: "fs", targets: [{ format, blend: PREMUL_BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    const textMod = this.dev.createShaderModule({ code: TEXT_WGSL });
    this.textPipe = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: textMod, entryPoint: "vs", buffers: [{ arrayStride: 32, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" } ] }] },
      fragment: { module: textMod, entryPoint: "fs", targets: [{ format, blend: PREMUL_BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    this.shapeBind = this.dev.createBindGroup({ layout: this.shapePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.vpBuf } }] });
    this.textBind = this.dev.createBindGroup({ layout: this.textPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.vpBuf } }, { binding: 1, resource: this.atlasTex.createView() }, { binding: 2, resource: sampler }] });
  }

  setCards(specs: CardSpec[], dpr = 1, compact = false): void {
    this.dpr = dpr; this.compact = compact;
    const s = this.st, titlePx = s.titlePx * dpr, bodyPx = s.bodyPx * dpr, pad = s.padPx * dpr, gap = s.gapPx * dpr, maxT = s.maxTextPx * dpr;
    const sw = Math.round(titlePx), btnH = Math.round(bodyPx + 10 * dpr), btnGap = 4 * dpr, btnInnerPad = 8 * dpr;
    // compact mini card: smaller name-only tag (no terminology), tighter padding — used when many segments
    const miniPx = Math.max(9 * dpr, Math.round(titlePx * 0.72)), miniSw = Math.round(miniPx);
    const miniPad = Math.round(pad * 0.55), miniGap = Math.round(gap * 0.7);
    const num = (n: number) => n.toLocaleString("en-US");

    this.cards = specs.map((spec) => {
      // head (collapsed content)
      const titleL = layoutText(this.font, spec.title, { pxSize: titlePx, maxWidthPx: maxT - sw - gap });
      const subL = spec.subtitle ? layoutText(this.font, spec.subtitle, { pxSize: bodyPx, maxWidthPx: maxT }) : null;
      const titleX = pad + (spec.swatch ? sw + gap : 0);
      const row1H = Math.max(titleL.height, spec.swatch ? sw : 0);
      const headBottom = pad + row1H + (subL ? gap + subL.height : 0);   // y after head content
      const headContentW = Math.max(titleX - pad + titleL.width, subL ? subL.width : 0);
      const head: PreparedCard["head"] = {
        runs: [{ quads: offset(titleL.quads, titleX, pad), color: BLACK }],
        swatch: spec.swatch ? { x: pad, y: pad, w: sw, h: sw, color: [spec.swatch[0], spec.swatch[1], spec.swatch[2], 1] } : undefined,
      };
      if (subL) head.runs.push({ quads: offset(subL.quads, pad, pad + row1H + gap), color: GREY });
      const cw = Math.ceil(headContentW + pad * 2), ch = Math.ceil(headBottom + pad);

      // mini (compact) content: colour swatch + name only, smaller
      const nameL = layoutText(this.font, spec.title, { pxSize: miniPx, maxWidthPx: maxT });
      const mRow = Math.max(nameL.height, spec.swatch ? miniSw : 0);
      const mTitleX = miniPad + (spec.swatch ? miniSw + miniGap : 0);
      const miniHead: PreparedCard["head"] = {
        runs: [{ quads: offset(nameL.quads, mTitleX, miniPad + (mRow - nameL.height) / 2), color: BLACK }],
        swatch: spec.swatch ? { x: miniPad, y: miniPad + (mRow - miniSw) / 2, w: miniSw, h: miniSw, color: [spec.swatch[0], spec.swatch[1], spec.swatch[2], 1] } : undefined,
      };
      const mw = Math.ceil(mTitleX + nameL.width + miniPad), mh = Math.ceil(mRow + miniPad * 2);

      // extra (revealed on expand): stat lines + stacked buttons, below the head
      const lines: string[] = [];
      if (spec.stat) {
        lines.push(`${num(spec.stat.voxels)} voxels`);
        lines.push(`${spec.stat.volumeCc.toFixed(1)} cc`);
        if (spec.stat.hu) lines.push(`${spec.stat.hu.mean.toFixed(0)} ± ${spec.stat.hu.std.toFixed(0)} HU`);
      }
      const lineLs = lines.map((t) => layoutText(this.font, t, { pxSize: bodyPx, maxWidthPx: maxT }));
      const btnLabels = BUTTONS.map((b) => layoutText(this.font, b.label, { pxSize: bodyPx, maxWidthPx: maxT }));
      const contentW = Math.max(headContentW, ...lineLs.map((l) => l.width), ...btnLabels.map((l) => l.width + btnInnerPad * 2));
      const ew = Math.ceil(contentW + pad * 2), btnW = ew - pad * 2;
      const extra: PreparedCard["extra"] = { runs: [], buttons: [] };
      let y = headBottom + gap;
      for (const l of lineLs) { extra.runs.push({ quads: offset(l.quads, pad, y), color: BLACK }); y += l.height + gap * 0.6; }
      y += gap * 0.4;
      for (let k = 0; k < BUTTONS.length; k++) {
        const lab = btnLabels[k], lx = pad + (btnW - lab.width) / 2, ly = y + (btnH - lab.height) / 2;
        extra.buttons.push({ x: pad, y, w: btnW, h: btnH, part: BUTTONS[k].part, label: { quads: offset(lab.quads, lx, ly), color: BLACK } });
        y += btnH + btnGap;
      }
      const eh = Math.ceil(y - btnGap + pad);
      return { spec, cw, ch, ew, eh: Math.max(eh, ch), mw, mh, miniHead, head, extra, expanded: false };
    });
    this.seeded = false;
  }

  private size(c: PreparedCard): { w: number; h: number } {
    if (c.expanded) return { w: c.ew, h: c.eh };
    if (this.compact) return { w: c.mw, h: c.mh };
    return { w: c.cw, h: c.ch };
  }

  hitTest(px: number, py: number): HitResult | null {
    for (let i = this.cards.length - 1; i >= 0; i--) {
      if (!this.lastVisible[i]) continue;
      const b = this.bodies[i], c = this.cards[i], sz = this.size(c);
      if (px < b.x - sz.w / 2 || px > b.x + sz.w / 2 || py < b.y - sz.h / 2 || py > b.y + sz.h / 2) continue;
      if (c.expanded) {
        const lx = px - (b.x - sz.w / 2), ly = py - (b.y - sz.h / 2);
        for (const bt of c.extra.buttons) if (lx >= bt.x && lx <= bt.x + bt.w && ly >= bt.y && ly <= bt.y + bt.h) return { index: i, action: bt.part };
      }
      return { index: i, action: "toggle" };
    }
    return null;
  }
  toggle(index: number): void { const c = this.cards[index]; if (c) c.expanded = !c.expanded; }
  spec(index: number): CardSpec | undefined { return this.cards[index]?.spec; }
  cardCenter(index: number): { x: number; y: number } | null { const b = this.bodies[index]; return b ? { x: b.x, y: b.y } : null; }
  buttonCenter(index: number, part: CardAction): { x: number; y: number } | null {
    const b = this.bodies[index], c = this.cards[index]; if (!b || !c) return null;
    const bt = c.extra.buttons.find((x) => x.part === part); if (!bt) return null;
    const sz = this.size(c);
    return { x: b.x - sz.w / 2 + bt.x + bt.w / 2, y: b.y - sz.h / 2 + bt.y + bt.h / 2 };
  }

  /** Run the force layout for one frame WITHOUT drawing (the CardField path renders via the ray-march).
   *  Updates card body positions + visibility. Returns true while still moving. */
  layout(camera: VtkCamera, vp: Viewport, dtSec: number, keepOuts?: { x: number; y: number; radius: number }[], extra?: LayoutExtra): boolean {
    if (!this.cards.length) return false;
    const anchors = this.cards.map((c) => camera.worldToDisplay(c.spec.anchorRAS, vp.w, vp.h));
    this.lastVisible = anchors.map((a) => a.depth > 0);
    const anchorsPx = anchors.map((a) => ({ x: a.x, y: a.y }));
    const sizes = this.cards.map((c) => this.size(c));
    if (!this.seeded || this.bodies.length !== this.cards.length) { this.bodies = seedCards(anchorsPx, sizes); this.seeded = true; }
    else for (let i = 0; i < this.bodies.length; i++) { this.bodies[i].w = sizes[i].w; this.bodies[i].h = sizes[i].h; }
    layoutStep(this.bodies, anchorsPx, { w: vp.w, h: vp.h }, dtSec, { keepOuts, boundary: extra?.boundary, ringGap: extra?.ringGap });
    return !this.settled();
  }
  /** Card body (screen centre + size) for index — for the CardField billboard. */
  body(index: number): { x: number; y: number; w: number; h: number } | null { const b = this.bodies[index]; return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null; }
  visible(index: number): boolean { return !!this.lastVisible[index]; }
  count(): number { return this.cards.length; }
  expanded(index: number): boolean { return !!this.cards[index]?.expanded; }

  render(view: GPUTextureView, camera: VtkCamera, vp: Viewport, dtSec: number, keepOuts?: { x: number; y: number; radius: number }[], extra?: LayoutExtra): void {
    if (!this.cards.length) return;
    const anchors = this.cards.map((c) => camera.worldToDisplay(c.spec.anchorRAS, vp.w, vp.h));
    this.lastVisible = anchors.map((a) => a.depth > 0);
    const anchorsPx = anchors.map((a) => ({ x: a.x, y: a.y }));
    const sizes = this.cards.map((c) => this.size(c));
    if (!this.seeded || this.bodies.length !== this.cards.length) { this.bodies = seedCards(anchorsPx, sizes); this.seeded = true; }
    else for (let i = 0; i < this.bodies.length; i++) { this.bodies[i].w = sizes[i].w; this.bodies[i].h = sizes[i].h; }
    const _t0 = performance.now();
    layoutStep(this.bodies, anchorsPx, { w: vp.w, h: vp.h }, dtSec, { keepOuts, boundary: extra?.boundary, ringGap: extra?.ringGap });
    this.perf.layoutMs = performance.now() - _t0;
    let ms = 0; for (const b of this.bodies) ms = Math.max(ms, Math.hypot(b.vx, b.vy)); this.maxSpeed = ms;
    const _t1 = performance.now();

    const shape: number[] = [], text: number[] = [];
    const rect = (cx: number, cy: number, hw: number, hh: number, radius: number, border: number, fill: RGBA, brd: RGBA) => {
      const x0 = cx - hw, x1 = cx + hw, y0 = cy - hh, y1 = cy + hh;
      for (const [px, py] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) shape.push(px, py, cx, cy, hw, hh, radius, border, 0, 0, ...fill, ...brd);
    };
    const line = (ax: number, ay: number, bx: number, by: number, width: number, col: RGBA) => {
      let dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = -dy * width / 2, ny = dx * width / 2;
      for (const [px, py] of [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax + nx, ay + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]) shape.push(px, py, 0, 0, -1, -1, 0, 0, 1, 0, ...col, 0, 0, 0, 0);
    };
    const glyphs = (runs: TextRun[], ox: number, oy: number) => {
      for (const run of runs) for (const q of run.quads) {
        const x0 = ox + q.x, x1 = ox + q.x + q.w, y0 = oy + q.y, y1 = oy + q.y + q.h, co = run.color;
        for (const [px, py, uu, vv] of [[x0, y0, q.u0, q.v0], [x1, y0, q.u1, q.v0], [x1, y1, q.u1, q.v1], [x0, y0, q.u0, q.v0], [x1, y1, q.u1, q.v1], [x0, y1, q.u0, q.v1]]) text.push(px, py, uu, vv, ...co);
      }
    };

    for (let i = 0; i < this.cards.length; i++) {
      if (!this.lastVisible[i]) continue;
      const c = this.cards[i], b = this.bodies[i], a = anchorsPx[i], sz = this.size(c);
      const hw = sz.w / 2, hh = sz.h / 2, ox = b.x - hw, oy = b.y - hh;
      const edge = boxEdgeToward(b.x, b.y, hw, hh, a.x, a.y);
      line(edge.x, edge.y, a.x, a.y, this.st.leaderPx * this.dpr, this.st.leaderRGBA);
      if (this.compact && !c.expanded) {
        // MINI card: colour swatch + name only (no terminology) — the full card opens on click.
        rect(b.x, b.y, hw, hh, this.st.radiusPx * this.dpr, this.st.borderPx * this.dpr, this.st.glassRGBA, this.st.borderRGBA);
        if (c.miniHead.swatch) { const w2 = c.miniHead.swatch; rect(ox + w2.x + w2.w / 2, oy + w2.y + w2.h / 2, w2.w / 2, w2.h / 2, 2 * this.dpr, 1.25 * this.dpr, w2.color, BLACK); }
        glyphs(c.miniHead.runs, ox, oy);
        continue;
      }
      rect(b.x, b.y, hw, hh, this.st.radiusPx * this.dpr, this.st.borderPx * this.dpr, this.st.glassRGBA, this.st.borderRGBA);
      if (c.head.swatch) { const w2 = c.head.swatch; rect(ox + w2.x + w2.w / 2, oy + w2.y + w2.h / 2, w2.w / 2, w2.h / 2, 2 * this.dpr, 1.5 * this.dpr, w2.color, BLACK); }
      glyphs(c.head.runs, ox, oy);
      if (c.expanded) {
        for (const bt of c.extra.buttons) rect(ox + bt.x + bt.w / 2, oy + bt.y + bt.h / 2, bt.w / 2, bt.h / 2, 4 * this.dpr, 1 * this.dpr, this.st.buttonRGBA, BLACK);
        glyphs(c.extra.runs, ox, oy);
        glyphs(c.extra.buttons.map((bt) => bt.label), ox, oy);
      }
    }

    this.perf.buildMs = performance.now() - _t1;
    const _t2 = performance.now();
    this.dev.queue.writeBuffer(this.vpBuf, 0, new Float32Array([vp.w, vp.h, vp.dpr, 0]));
    const shapeArr = new Float32Array(shape), textArr = new Float32Array(text);
    this.shapeBuf = this.ensure(this.shapeBuf, shapeArr.byteLength, "shape"); if (shapeArr.length) this.dev.queue.writeBuffer(this.shapeBuf, 0, shapeArr);
    this.textBuf = this.ensure(this.textBuf, textArr.byteLength, "text"); if (textArr.length) this.dev.queue.writeBuffer(this.textBuf, 0, textArr);

    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
    if (shapeArr.length) { pass.setPipeline(this.shapePipe); pass.setBindGroup(0, this.shapeBind); pass.setVertexBuffer(0, this.shapeBuf); pass.draw(shapeArr.length / 18); }
    if (textArr.length) { pass.setPipeline(this.textPipe); pass.setBindGroup(0, this.textBind); pass.setVertexBuffer(0, this.textBuf); pass.draw(textArr.length / 8); }
    pass.end();
    this.dev.queue.submit([enc.finish()]);
    this.perf.submitMs = performance.now() - _t2;
  }

  private ensure(buf: GPUBuffer | undefined, bytes: number, tag: string): GPUBuffer {
    const need = Math.max(64, bytes);
    if (buf && (tag === "shape" ? this.shapeCap : this.textCap) >= need) return buf;
    buf?.destroy();
    const nb = this.dev.createBuffer({ size: need, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (tag === "shape") this.shapeCap = need; else this.textCap = need;
    return nb;
  }
  /** Current card size (device px) for the given index. */
  cardSize(index: number): { w: number; h: number } | null { const c = this.cards[index]; return c ? this.size(c) : null; }

  /** Bake ONE card's INK (border + swatch + buttons + text; NO glass fill) into an RGBA texture in
   *  card-local coordinates, for use as a CardField's front-face content. Glass transparent (a=0). */
  bakeCard(index: number, ss = 2): { tex: GPUTexture; w: number; h: number } | null {
    const c = this.cards[index]; if (!c) return null;
    const sz = this.size(c), w = Math.max(2, Math.ceil(sz.w * ss)), h = Math.max(2, Math.ceil(sz.h * ss));
    const dpr = this.dpr;
    const tex = this.dev.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });

    const shape: number[] = [], text: number[] = [];
    const rect = (cx: number, cy: number, hw: number, hh: number, radius: number, border: number, fill: RGBA, brd: RGBA) => {
      const x0 = cx - hw, x1 = cx + hw, y0 = cy - hh, y1 = cy + hh;
      for (const [px, py] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) shape.push(px, py, cx, cy, hw, hh, radius, border, 0, 0, ...fill, ...brd);
    };
    const glyphs = (runs: TextRun[], ox: number, oy: number) => {
      for (const run of runs) for (const q of run.quads) {
        const x0 = ox + q.x * ss, x1 = ox + (q.x + q.w) * ss, y0 = oy + q.y * ss, y1 = oy + (q.y + q.h) * ss, co = run.color;
        for (const [px, py, uu, vv] of [[x0, y0, q.u0, q.v0], [x1, y0, q.u1, q.v0], [x1, y1, q.u1, q.v1], [x0, y0, q.u0, q.v0], [x1, y1, q.u1, q.v1], [x0, y1, q.u0, q.v1]]) text.push(px, py, uu, vv, ...co);
      }
    };
    // border only (fill transparent → interior stays glass); swatch/buttons/text as ink
    const transparent: RGBA = [0, 0, 0, 0];
    rect(sz.w / 2 * ss, sz.h / 2 * ss, sz.w / 2 * ss, sz.h / 2 * ss, this.st.radiusPx * dpr * ss, this.st.borderPx * dpr * ss, transparent, this.st.borderRGBA);
    if (c.head.swatch) { const w2 = c.head.swatch; rect((w2.x + w2.w / 2) * ss, (w2.y + w2.h / 2) * ss, w2.w / 2 * ss, w2.h / 2 * ss, 2 * dpr * ss, 1.5 * dpr * ss, w2.color, BLACK); }
    glyphs(c.head.runs, 0, 0);
    if (c.expanded) {
      for (const bt of c.extra.buttons) rect((bt.x + bt.w / 2) * ss, (bt.y + bt.h / 2) * ss, bt.w / 2 * ss, bt.h / 2 * ss, 4 * dpr * ss, 1 * dpr * ss, this.st.buttonRGBA, BLACK);
      glyphs(c.extra.runs, 0, 0);
      glyphs(c.extra.buttons.map((bt) => bt.label), 0, 0);
    }

    this.dev.queue.writeBuffer(this.vpBuf, 0, new Float32Array([w, h, dpr, 0]));
    const sArr = new Float32Array(shape), tArr = new Float32Array(text);
    const sBuf = this.dev.createBuffer({ size: Math.max(64, sArr.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const tBuf = this.dev.createBuffer({ size: Math.max(64, tArr.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (sArr.length) this.dev.queue.writeBuffer(sBuf, 0, sArr);
    if (tArr.length) this.dev.queue.writeBuffer(tBuf, 0, tArr);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    if (sArr.length) { pass.setPipeline(this.shapePipe); pass.setBindGroup(0, this.shapeBind); pass.setVertexBuffer(0, sBuf); pass.draw(sArr.length / 18); }
    if (tArr.length) { pass.setPipeline(this.textPipe); pass.setBindGroup(0, this.textBind); pass.setVertexBuffer(0, tBuf); pass.draw(tArr.length / 8); }
    pass.end();
    this.dev.queue.submit([enc.finish()]);
    sBuf.destroy(); tBuf.destroy();
    return { tex, w, h };
  }

  dispose(): void { this.atlasTex.destroy(); this.vpBuf.destroy(); this.shapeBuf?.destroy(); this.textBuf?.destroy(); }
}

function offset(quads: GlyphQuad[], dx: number, dy: number): GlyphQuad[] { return quads.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })); }

/** Point on the AABB (centre±half) boundary along the ray toward (tx,ty) — where a leader line leaves. */
function boxEdgeToward(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity, sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}
