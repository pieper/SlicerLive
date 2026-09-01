// Anatomy label cards — a WebGPU overlay that draws museum-exhibit tags over the 3D scene: each card is a
// ground-glass panel (segment name + terminology) tethered by a leader line ("thread") to a pin at the
// segment's location. Cards are screen-facing; a force-directed layout (render/label-layout.ts) keeps ≤12
// of them legible and non-overlapping and glides them as the camera/specimen move. Text is rendered from
// the SDF atlas (render/sdf-text.ts) → crisp at any size. Two pipelines share a viewport uniform: a
// rounded-rect/line "shape" pass (card backgrounds, borders, leader lines, pins) and an SDF "text" pass.
// Ground glass is approximated here (translucent white + thin black border); a true backdrop blur is a
// follow-up (render the scene to an offscreen texture and sample it under the card).
//
// Screen space throughout is DEVICE pixels (canvas drawing-buffer). Draw AFTER the scene into the same
// view with loadOp:"load".

import type { Gpu } from "./device.ts";
import type { Vec3 } from "./mat4.ts";
import type { VtkCamera } from "./vtk-camera.ts";
import { type FontAtlas, layoutText } from "./sdf-text.ts";
import { type CardBody, layoutStep, seedCards } from "./label-layout.ts";

export interface CardSpec { anchorRAS: Vec3; title: string; body?: string; accent?: [number, number, number] }
export interface Viewport { w: number; h: number; dpr: number }

interface PreparedCard {
  spec: CardSpec;
  quads: { x: number; y: number; w: number; h: number; u0: number; v0: number; u1: number; v1: number; color: [number, number, number, number] }[];
  w: number; h: number;     // card size (device px)
}

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
  let inner = 1.0 - smoothstep(0.0, 1.0, d + i.params.y);   // 1 well inside, 0 in the border band
  var col = mix(i.border, i.fill, inner);
  col.a = col.a * cov;
  return vec4<f32>(col.rgb * col.a, col.a);                 // premultiplied
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
  return vec4<f32>(i.color.rgb * a, a);                      // premultiplied
}`;

const PREMUL_BLEND: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

export interface CardStyle {
  titlePx?: number; bodyPx?: number; padPx?: number; gapPx?: number; maxTextPx?: number;
  radiusPx?: number; borderPx?: number; glassRGBA?: [number, number, number, number];
  borderRGBA?: [number, number, number, number]; leaderRGBA?: [number, number, number, number]; leaderPx?: number;
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
  private style: Required<CardStyle>;

  private shapeBuf?: GPUBuffer; private shapeCap = 0;
  private textBuf?: GPUBuffer; private textCap = 0;

  private cards: PreparedCard[] = [];
  private bodies: CardBody[] = [];
  private seeded = false;

  constructor(gpu: Gpu, format: GPUTextureFormat, font: FontAtlas, style: CardStyle = {}) {
    this.dev = gpu.device;
    this.font = font;
    this.style = {
      titlePx: style.titlePx ?? 15, bodyPx: style.bodyPx ?? 12, padPx: style.padPx ?? 10, gapPx: style.gapPx ?? 4,
      maxTextPx: style.maxTextPx ?? 220, radiusPx: style.radiusPx ?? 6, borderPx: style.borderPx ?? 1.25,
      glassRGBA: style.glassRGBA ?? [1, 1, 1, 0.8], borderRGBA: style.borderRGBA ?? [0, 0, 0, 0.9],
      leaderRGBA: style.leaderRGBA ?? [0.05, 0.05, 0.05, 0.85], leaderPx: style.leaderPx ?? 1.5,
    };

    // atlas texture (r8unorm SDF)
    this.atlasTex = this.dev.createTexture({ size: [font.atlasW, font.atlasH], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.dev.queue.writeTexture({ texture: this.atlasTex }, font.data, { bytesPerRow: font.atlasW, rowsPerImage: font.atlasH }, [font.atlasW, font.atlasH]);
    const sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

    this.vpBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const shapeMod = this.dev.createShaderModule({ code: SHAPE_WGSL });
    this.shapePipe = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: shapeMod, entryPoint: "vs", buffers: [{
        arrayStride: 72,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" },
          { shaderLocation: 2, offset: 16, format: "float32x2" }, { shaderLocation: 3, offset: 24, format: "float32x4" },
          { shaderLocation: 4, offset: 40, format: "float32x4" }, { shaderLocation: 5, offset: 56, format: "float32x4" },
        ],
      }] },
      fragment: { module: shapeMod, entryPoint: "fs", targets: [{ format, blend: PREMUL_BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    const textMod = this.dev.createShaderModule({ code: TEXT_WGSL });
    this.textPipe = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: textMod, entryPoint: "vs", buffers: [{
        arrayStride: 32,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32x4" }],
      }] },
      fragment: { module: textMod, entryPoint: "fs", targets: [{ format, blend: PREMUL_BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    this.shapeBind = this.dev.createBindGroup({ layout: this.shapePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.vpBuf } }] });
    this.textBind = this.dev.createBindGroup({ layout: this.textPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.vpBuf } }, { binding: 1, resource: this.atlasTex.createView() }, { binding: 2, resource: sampler }] });
  }

  /** Lay out title+body per card at the given device-pixel scale; compute card sizes. Call on data change
   *  or when dpr changes; positions re-seed on the next render. */
  setCards(specs: CardSpec[], dpr = 1): void {
    const s = this.style;
    const titlePx = s.titlePx * dpr, bodyPx = s.bodyPx * dpr, pad = s.padPx * dpr, gap = s.gapPx * dpr, maxT = s.maxTextPx * dpr;
    this.cards = specs.map((spec) => {
      const accent = spec.accent ?? [0.1, 0.1, 0.12];
      const title = layoutText(this.font, spec.title, { pxSize: titlePx, maxWidthPx: maxT });
      const body = spec.body ? layoutText(this.font, spec.body, { pxSize: bodyPx, maxWidthPx: maxT }) : null;
      const contentW = Math.max(title.width, body?.width ?? 0);
      const contentH = title.height + (body ? gap + body.height : 0);
      const w = Math.ceil(contentW + pad * 2), h = Math.ceil(contentH + pad * 2);
      const quads: PreparedCard["quads"] = [];
      const titleCol: [number, number, number, number] = [accent[0], accent[1], accent[2], 1];
      for (const q of title.quads) quads.push({ ...q, x: q.x + pad, y: q.y + pad, color: titleCol });
      if (body) { const by = pad + title.height + gap; const bodyCol: [number, number, number, number] = [0.25, 0.25, 0.28, 1]; for (const q of body.quads) quads.push({ ...q, x: q.x + pad, y: q.y + by, color: bodyCol }); }
      return { spec, quads, w, h };
    });
    this.seeded = false;
  }

  /** Project anchors, step the layout, and draw the cards over `view` (must be loaded, not cleared). */
  render(view: GPUTextureView, camera: VtkCamera, vp: Viewport, dtSec: number): void {
    if (!this.cards.length) return;
    const anchors = this.cards.map((c) => camera.worldToDisplay(c.spec.anchorRAS, vp.w, vp.h));
    const visible = anchors.map((a) => a.depth > 0 && a.x > -vp.w && a.x < 2 * vp.w && a.y > -vp.h && a.y < 2 * vp.h);
    const anchorsPx = anchors.map((a) => ({ x: a.x, y: a.y }));
    const sizes = this.cards.map((c) => ({ w: c.w, h: c.h }));
    if (!this.seeded || this.bodies.length !== this.cards.length) { this.bodies = seedCards(anchorsPx, sizes); this.seeded = true; }
    else for (let i = 0; i < this.bodies.length; i++) { this.bodies[i].w = sizes[i].w; this.bodies[i].h = sizes[i].h; }
    layoutStep(this.bodies, anchorsPx, { w: vp.w, h: vp.h }, dtSec);

    // ---- build shape verts (leader lines first so cards paint over them, then card bg, then pins) ----
    const shape: number[] = [];
    const pushRect = (cx: number, cy: number, hw: number, hh: number, radius: number, border: number, fill: number[], brd: number[], mode = 0) => {
      const x0 = cx - hw, x1 = cx + hw, y0 = cy - hh, y1 = cy + hh;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]];
      for (const [px, py] of corners) shape.push(px, py, cx, cy, hw, hh, radius, border, mode, 0, fill[0], fill[1], fill[2], fill[3], brd[0], brd[1], brd[2], brd[3]);
    };
    const pushLine = (ax: number, ay: number, bx: number, by: number, width: number, col: number[]) => {
      let dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = -dy * width / 2, ny = dx * width / 2;
      const p = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax + nx, ay + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
      for (const [px, py] of p) shape.push(px, py, 0, 0, -1, -1, 0, 0, 1, 0, col[0], col[1], col[2], col[3], 0, 0, 0, 0);
    };
    const s = this.style, dpr = vp.dpr;
    // leader lines: card edge → anchor
    for (let i = 0; i < this.cards.length; i++) {
      if (!visible[i]) continue;
      const c = this.bodies[i], a = anchorsPx[i];
      const edge = boxEdgeToward(c.x, c.y, c.w / 2, c.h / 2, a.x, a.y);
      pushLine(edge.x, edge.y, a.x, a.y, s.leaderPx * dpr, s.leaderRGBA);
    }
    // card backgrounds (ground glass + border)
    for (let i = 0; i < this.cards.length; i++) {
      if (!visible[i]) continue;
      const c = this.bodies[i];
      pushRect(c.x, c.y, c.w / 2, c.h / 2, s.radiusPx * dpr, s.borderPx * dpr, s.glassRGBA, s.borderRGBA, 0);
    }
    // pins at the anchors (small filled dots = circle via radius==half)
    for (let i = 0; i < this.cards.length; i++) {
      if (!visible[i]) continue;
      const a = anchorsPx[i]; const r = 3 * dpr;
      pushRect(a.x, a.y, r, r, r, 0, s.borderRGBA, s.borderRGBA, 0);
    }

    // ---- build glyph verts (offset by each card's current top-left) ----
    const text: number[] = [];
    for (let i = 0; i < this.cards.length; i++) {
      if (!visible[i]) continue;
      const c = this.bodies[i], card = this.cards[i];
      const ox = c.x - card.w / 2, oy = c.y - card.h / 2;
      for (const q of card.quads) {
        const x0 = ox + q.x, y0 = oy + q.y, x1 = x0 + q.w, y1 = oy + q.y + q.h;
        const co = q.color;
        const v = [[x0, y0, q.u0, q.v0], [x1, y0, q.u1, q.v0], [x1, y1, q.u1, q.v1], [x0, y0, q.u0, q.v0], [x1, y1, q.u1, q.v1], [x0, y1, q.u0, q.v1]];
        for (const [px, py, uu, vv] of v) text.push(px, py, uu, vv, co[0], co[1], co[2], co[3]);
      }
    }

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
  }

  private ensure(buf: GPUBuffer | undefined, bytes: number, tag: string): GPUBuffer {
    const need = Math.max(64, bytes);
    const cap = tag === "shape" ? this.shapeCap : this.textCap;
    if (buf && cap >= need) return buf;
    buf?.destroy();
    const nb = this.dev.createBuffer({ size: need, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (tag === "shape") this.shapeCap = need; else this.textCap = need;
    return nb;
  }

  dispose(): void { this.atlasTex.destroy(); this.vpBuf.destroy(); this.shapeBuf?.destroy(); this.textBuf?.destroy(); }
}

/** Point on the AABB (centre±half) boundary along the ray toward (tx,ty) — where a leader line leaves. */
function boxEdgeToward(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity, sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}
