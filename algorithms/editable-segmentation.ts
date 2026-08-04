// EditableSegmentation — the editable segmentation MODEL/buffer, pure `algorithms/`: it owns the
// master labelmap on the GPU and the editing operations that mutate it, and imports NOTHING from
// `render/`. Rendering is wired separately by the logic layer (logic/segmentation-logic.ts), which
// reads masterTexture() and subscribes to onDirty() — so the editing engine and the render engine
// stay independent (docs/ALGORITHMS.md).
//
//   master labelTex (r32uint, STORAGE)   ← effects write (compute); values 0..255 = segment id
//        │  onDirty()  →  the logic layer smooths this into a presence texture the renderer reads
//        ▼
//
// NB on the format: docs/ALGORITHMS.md calls the master "r8uint" (8-bit, ≤255 ids). WebGPU core has
// NO writable r8uint storage format, so a GPU-writable master must be r32uint. We keep the r8uint
// SEMANTICS (ids 0..255, one layer). Multiple layers = a later step (A-6).

import { spacingFromIjkToRAS, type Vec3 } from "./geom.ts";

export interface EditableSegmentationOpts {
  ijkToRAS: number[];                       // row-major 4x4 voxel-center → RAS (real geometry)
}

export class EditableSegmentation {
  readonly dims: Vec3;
  readonly ijkToRAS: number[];
  readonly device: GPUDevice;               // effects (algorithms/effects/*) build their own pipelines against this

  private labelTex: GPUTexture;             // master (r32uint, STORAGE) — the shared buffer effects write
  private dirtyCbs: Array<() => void> = [];

  constructor(device: GPUDevice, dims: Vec3, opts: EditableSegmentationOpts) {
    this.device = device;
    this.dims = dims;
    this.ijkToRAS = Array.from(opts.ijkToRAS);
    // Master: r32uint storage. TEXTURE_BINDING (logic-layer baker reads) | STORAGE_BINDING (effects
    // write) | COPY_DST (CPU loadLabelmap) | COPY_SRC (serialize to zarr, A-7).
    this.labelTex = device.createTexture({
      size: dims as [number, number, number], dimension: "3d", format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
  }

  /** The master labelmap (r32uint storage). The logic layer reads it (to derive a presence texture);
   *  editing effects write it on-GPU (A-1+). */
  masterTexture(): GPUTexture { return this.labelTex; }

  /** Register a callback fired after any edit — the logic layer rebakes + redraws. Returns an
   *  unsubscribe (so a logic can be swapped/disposed without leaking a stale rebake). */
  onDirty(cb: () => void): () => void {
    this.dirtyCbs.push(cb);
    return () => { const i = this.dirtyCbs.indexOf(cb); if (i >= 0) this.dirtyCbs.splice(i, 1); };
  }

  /** Signal that the master was edited (effects call this after writing the label texture on-GPU). */
  markDirty() { for (const cb of this.dirtyCbs) cb(); }

  /** Voxel spacing (mm) from the geometry — for mm↔voxel effect params. */
  spacingMm(): Vec3 { return spacingFromIjkToRAS(this.ijkToRAS); }

  /** Load a full labelmap (ids 0..255) from CPU into the master, then notify. */
  loadLabelmap(data: Uint8Array | Uint32Array) {
    const [dx, dy, dz] = this.dims;
    const u32 = data instanceof Uint32Array ? data : Uint32Array.from(data);
    this.device.queue.writeTexture({ texture: this.labelTex }, u32, { bytesPerRow: dx * 4, rowsPerImage: dy }, [dx, dy, dz]);
    this.markDirty();
  }

  /** Read the master labelmap back to CPU (ids per voxel, x-fastest). Handles WebGPU's 256-byte
   *  bytesPerRow alignment. For tests + zarr serialization (A-7); not on the interactive path. */
  async readLabelmap(): Promise<Uint32Array> {
    const [dx, dy, dz] = this.dims;
    const bpr = Math.ceil((dx * 4) / 256) * 256;   // padded row stride (bytes)
    const rowU32 = bpr / 4;
    const buf = this.device.createBuffer({ size: bpr * dy * dz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.labelTex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: dy }, [dx, dy, dz]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint32Array(buf.getMappedRange());
    const out = new Uint32Array(dx * dy * dz);
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) {
      const src = (z * dy + y) * rowU32, dst = (z * dy + y) * dx;
      for (let x = 0; x < dx; x++) out[dst + x] = padded[src + x];
    }
    buf.unmap(); buf.destroy();
    return out;
  }

  destroy() { this.labelTex.destroy(); }
}
