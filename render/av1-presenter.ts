// Client side of the hardware-codec path: decode AV1 intra frames (WebCodecs VideoDecoder) and
// draw them into the view texture at the patch rect, exactly where the gzip path calls
// Reconstructor.present. The server already composited over the background (video has no alpha), so
// this only samples and scales — no compositing, no upsample shader.
//
// The sidecar encodes at a coded size = sample dims rounded up to a grid (AV1_GRID), padding the
// edge; the decoded VideoFrame is that coded size, so we sample only its top-left sample-sized
// region and stretch it across the destination rect (browser bilinear via a filtering sampler).
import type { Gpu } from "./device.ts";
import { AV1_GRID } from "./codec.ts";

const codedSize = (w: number, h: number): [number, number] => [
  Math.ceil(w / AV1_GRID) * AV1_GRID,
  Math.ceil(h / AV1_GRID) * AV1_GRID,
];

const WGSL = /* wgsl */ `
@group(0) @binding(0) var t : texture_external;
@group(0) @binding(1) var s : sampler;
// (u0,v0,u1,v1) — the sub-rect of the external texture to sample (crops the coded-size padding).
@group(0) @binding(2) var<uniform> uv : vec4<f32>;
struct V { @builtin(position) p : vec4<f32>, @location(0) t : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> V {
  // a full-viewport triangle; the scissor rect (set by the caller) limits it to the patch.
  let x = select(-1.0, 3.0, i == 1u);
  let y = select(-1.0, 3.0, i == 2u);
  var o : V; o.p = vec4<f32>(x, y, 0.0, 1.0); o.t = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5); return o;
}
@fragment fn fs(v : V) -> @location(0) vec4<f32> {
  // map this fragment's position within the DEST rect to the sampled sub-rect of the source.
  let src = mix(uv.xy, uv.zw, v.t);
  return vec4<f32>(textureSampleBaseClampToEdge(t, s, src).rgb, 1.0);
}`;

export class Av1Presenter {
  #gpu: Gpu;
  #pipeline: GPURenderPipeline;
  #sampler: GPUSampler;
  #uni: GPUBuffer;
  #decoder: VideoDecoder | null = null;
  #cw = 0;
  #ch = 0;
  #pending: ((f: VideoFrame) => void) | null = null;
  #fail: ((e: Error) => void) | null = null;

  constructor(gpu: Gpu, format: GPUTextureFormat) {
    this.#gpu = gpu;
    const mod = gpu.device.createShaderModule({ code: WGSL });
    this.#pipeline = gpu.device.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.#sampler = gpu.device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.#uni = gpu.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  static get supported(): boolean {
    return typeof VideoDecoder !== "undefined";
  }

  /** Decode one AV1 intra frame (single self-contained key chunk) to a VideoFrame. Keeps a
   *  persistent decoder, reconfiguring only when the coded size changes. */
  async decode(av1: Uint8Array, sw: number, sh: number): Promise<VideoFrame> {
    const [cw, ch] = codedSize(sw, sh);
    if (!this.#decoder || this.#cw !== cw || this.#ch !== ch) {
      if (this.#decoder) { try { this.#decoder.close(); } catch { /* */ } }
      this.#cw = cw; this.#ch = ch;
      this.#decoder = new VideoDecoder({
        output: (f) => { const cb = this.#pending; this.#pending = null; this.#fail = null; cb?.(f); },
        error: (e) => { const cb = this.#fail; this.#pending = null; this.#fail = null; cb?.(new Error(e.message)); },
      });
      this.#decoder.configure({ codec: "av01.0.04M.08", codedWidth: cw, codedHeight: ch, optimizeForLatency: true });
    }
    const dec = this.#decoder;
    const frame = new Promise<VideoFrame>((res, rej) => { this.#pending = res; this.#fail = rej; });
    dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: av1 }));
    // intra keyframe with optimizeForLatency emits without an explicit flush; flush() bounds it.
    await dec.flush().catch(() => {});
    return frame;
  }

  /** Draw a decoded frame (whose real content is sw×sh in its top-left) into `dst` at the view
   *  rect (x,y,w,h). Everything already in `dst` outside the rect is preserved (scissor + load). */
  present(dst: GPUTextureView, frame: VideoFrame, sw: number, sh: number, rect: { x: number; y: number; w: number; h: number }, format: GPUTextureFormat) {
    const [cw, ch] = codedSize(sw, sh);
    this.#gpu.device.queue.writeBuffer(this.#uni, 0, new Float32Array([0, 0, sw / cw, sh / ch]));
    const ext = this.#gpu.device.importExternalTexture({ source: frame });
    const bind = this.#gpu.device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: ext },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#uni } },
      ],
    });
    const enc = this.#gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(this.#pipeline);
    pass.setScissorRect(rect.x, rect.y, rect.w, rect.h);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.#gpu.device.queue.submit([enc.finish()]);
    void format;
  }
}
