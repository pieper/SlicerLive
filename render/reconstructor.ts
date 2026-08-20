// Reconstructor — the client half of the unified renderer (docs/UNIFIED-RENDERING-PLAN.md §2). Takes
// TRACED SAMPLES (premultiplied rgba8, pre-background) — from the local Producer OR streamed from a
// remote Deno renderer — and assembles the displayed image: Catmull-Rom upsample of the (possibly
// low-res) sample grid + composite over the background. This is the SAME reconstruction the local
// SceneRenderer.renderUpscaled does; here it consumes an EXTERNAL sample buffer so local and remote
// share one assembly path. (M5 will add temporal accumulation/reprojection here.)
import type { Gpu } from "./device.ts";

const WGSL = /* wgsl */ `
@group(0) @binding(0) var t_sample : texture_2d<f32>;
@group(0) @binding(1) var s_lin : sampler;
// size = (sampleW, sampleH, _, _); rect = (originX, originY, spanW, spanH) in DESTINATION pixels —
// the region this present writes. A full frame is (0, 0, viewW, viewH); a PATCH is its dirty rect.
struct SR { size : vec4<f32>, rect : vec4<f32> };
@group(0) @binding(2) var<uniform> u_sr : SR;
@group(0) @binding(3) var<uniform> u_bg : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
// Catmull-Rom via 9 bilinear taps (Sigg/Hadwiger).
fn cr(uv : vec2<f32>, texSize : vec2<f32>) -> vec4<f32> {
  let sp = uv * texSize;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let off12 = w2 / w12;
  let inv = 1.0 / texSize;
  let p0 = (tp1 - 1.0) * inv;
  let p3 = (tp1 + 2.0) * inv;
  let p12 = (tp1 + off12) * inv;
  var r = vec4<f32>(0.0);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p0.x,  p0.y),  0.0) * (w0.x  * w0.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p12.x, p0.y),  0.0) * (w12.x * w0.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p3.x,  p0.y),  0.0) * (w3.x  * w0.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p0.x,  p12.y), 0.0) * (w0.x  * w12.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p12.x, p12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p3.x,  p12.y), 0.0) * (w3.x  * w12.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p0.x,  p3.y),  0.0) * (w0.x  * w3.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p12.x, p3.y),  0.0) * (w12.x * w3.y);
  r += textureSampleLevel(t_sample, s_lin, vec2<f32>(p3.x,  p3.y),  0.0) * (w3.x  * w3.y);
  return r;
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs(v : RV) -> @location(0) vec4<f32> {
  let uv = (v.position.xy - u_sr.rect.xy) / u_sr.rect.zw;
  let s = cr(uv, u_sr.size.xy);
  let a = clamp(s.a, 0.0, 1.0);
  let bg = srgb2physical(u_bg.rgb);
  return vec4<f32>(mix(bg, s.rgb, a), 1.0);
}`;

export class Reconstructor {
  private dev: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private srBuf: GPUBuffer;   // SR { size, rect }
  private bgBuf: GPUBuffer;   // background rgb
  private tex?: GPUTexture;
  private bind?: GPUBindGroup;
  private tw = 0;
  private th = 0;

  constructor(gpu: Gpu, format: GPUTextureFormat) {
    this.dev = gpu.device;
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.srBuf = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bgBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = this.dev.createShaderModule({ code: WGSL });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.bgBuf && this.dev.queue.writeBuffer(this.bgBuf, 0, new Float32Array([0.05, 0.06, 0.09, 1]));
  }

  setBackground(r: number, g: number, b: number) {
    this.dev.queue.writeBuffer(this.bgBuf, 0, new Float32Array([r, g, b, 1]));
  }

  private ensureTex(w: number, h: number) {
    if (this.tex && this.tw === w && this.th === h) return;
    this.tex?.destroy();
    this.tex = this.dev.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.tw = w; this.th = h;
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.tex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.srBuf } },
        { binding: 3, resource: { buffer: this.bgBuf } },
      ],
    });
  }

  /** Upload `samples` (sampleW×sampleH premultiplied rgba8) and reconstruct to `view` (viewW×viewH).
   *  With `rect`, this is a PATCH: only those destination pixels are written (scissor + load), so
   *  everything already in `view` survives — the transport can then re-send just a dirty region. */
  present(view: GPUTextureView, samples: Uint8Array, sampleW: number, sampleH: number, viewW: number, viewH: number, rect?: { x: number; y: number; w: number; h: number }) {
    this.ensureTex(sampleW, sampleH);
    this.dev.queue.writeTexture({ texture: this.tex! }, samples, { bytesPerRow: sampleW * 4, rowsPerImage: sampleH }, [sampleW, sampleH]);
    const r = rect ?? { x: 0, y: 0, w: viewW, h: viewH };
    this.dev.queue.writeBuffer(this.srBuf, 0, new Float32Array([sampleW, sampleH, 0, 0, r.x, r.y, r.w, r.h]));
    const enc = this.dev.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: rect ? "load" : "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    p.setPipeline(this.pipeline); p.setBindGroup(0, this.bind!);
    if (rect) p.setScissorRect(r.x, r.y, r.w, r.h);
    p.draw(3); p.end();
    this.dev.queue.submit([enc.finish()]);
  }
}
