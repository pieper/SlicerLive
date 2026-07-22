// MPR slice renderer — crisp 2D orthographic reslice of a scalar volume with a
// colored segmentation overlay. Texture-space slicing (axis-aligned IJK planes;
// world-oriented reslice is a later refinement). One draw = one plane; the 4-up
// uses three of these (axial/sagittal/coronal) + the 3D DVR SceneRenderer.

import type { Gpu } from "./device.ts";

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";

const SHADER = /* wgsl */ `
struct U { a : vec4<f32>, b : vec4<f32> };  // a: axis, offset, win, lev ; b: overlayOpacity, sizeX, sizeY, _
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var t_scalar : texture_3d<f32>;
@group(0) @binding(3) var t_overlay : texture_3d<f32>;

struct V { @builtin(position) position : vec4<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> V {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : V; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92; let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
@fragment
fn fs_main(v : V) -> @location(0) vec4<f32> {
  let uv = v.position.xy / vec2<f32>(u.b.y, u.b.z);      // [0,1] within this view
  let s = u.a.y;
  let axis = u32(u.a.x);
  var tex : vec3<f32>;
  if (axis == 0u) { tex = vec3<f32>(s, uv.x, uv.y); }        // sagittal (fix X)
  else if (axis == 1u) { tex = vec3<f32>(uv.x, s, uv.y); }   // coronal  (fix Y)
  else { tex = vec3<f32>(uv.x, uv.y, s); }                    // axial    (fix Z)
  let val = textureSampleLevel(t_scalar, s_lin, tex, 0.0).r;
  let win = max(u.a.z, 1e-6);
  let g = clamp((val - (u.a.w - win * 0.5)) / win, 0.0, 1.0);
  var col = vec3<f32>(g);
  let ov = textureSampleLevel(t_overlay, s_lin, tex, 0.0);
  col = mix(col, ov.rgb, clamp(ov.a * u.b.x, 0.0, 1.0));
  return vec4<f32>(srgb2physical(col), 1.0);
}
`;

export class SliceRenderer {
  private dev: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private ubuf: GPUBuffer;
  private u = new Float32Array(8);  // a(4) + b(4)
  private bind?: GPUBindGroup;
  private scalar?: GPUTexture;
  private overlay?: GPUTexture;

  constructor(gpu: Gpu, format: GPUTextureFormat = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    const m = this.dev.createShaderModule({ code: SHADER });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs_main" },
      fragment: { module: m, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.ubuf = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.setWindowLevel(255, 127);
    this.setSlice(2, 0.5);
    this.setOverlayOpacity(0.55);
  }

  setTextures(scalar: GPUTexture, overlay: GPUTexture) {
    this.scalar = scalar; this.overlay = overlay;
    this.bind = this.dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: scalar.createView() },
        { binding: 3, resource: overlay.createView() },
      ],
    });
  }

  setSlice(axis: 0 | 1 | 2, offset01: number) { this.u[0] = axis; this.u[1] = Math.max(0, Math.min(1, offset01)); }
  setWindowLevel(win: number, lev: number) { this.u[2] = win; this.u[3] = lev; }
  setOverlayOpacity(o: number) { this.u[4] = o; }

  private drawInto(view: GPUTextureView, w: number, h: number) {
    this.u[5] = w; this.u[6] = h;
    this.dev.queue.writeBuffer(this.ubuf, 0, this.u);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind!); pass.draw(3); pass.end();
    this.dev.queue.submit([enc.finish()]);
  }

  renderToView(view: GPUTextureView, w: number, h: number) { this.drawInto(view, w, h); }

  async renderToRGBA(w: number, h: number): Promise<Uint8Array> {
    const target = this.dev.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.drawInto(target.createView(), w, h);
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, [w, h]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(padded.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }
}
