// CineFilmstrip — converge every cine frame ONCE, cache the finished image, then play back
// from the cache.
//
// Why this exists: the temporal accumulator (SceneRenderer.renderAccum) averages successive
// traces of the SAME view. During cine playback the volume changes underneath it, so the
// running mean blends phase N into phase N+1 and the heart SMEARS. Resetting accumulation on
// every frame change avoids the smear but then each displayed frame is a single jittered
// sample — visibly speckled, which is exactly what a DVR of a small volume looks like at
// n=1. Neither is acceptable for an animation.
//
// So: render each frame offscreen to full convergence, copyTextureToTexture it into a
// per-frame cache, and present cached frames during playback. Every displayed frame is a
// fully converged still, and playback costs one texture copy. The cache is invalidated by
// anything that changes what a frame looks like — camera, transfer function, size.
//
// Presenting is a raw copy rather than a blit pass, so the destination canvas must be
// configured with COPY_DST:
//   ctx.configure({ device, format, viewFormats: [srgb], alphaMode: "opaque",
//                   usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST })

import type { Gpu } from "./device.ts";
import type { SceneRenderer } from "./scene-renderer.ts";

export interface FilmstripProgress {
  /** Frames fully converged and cached so far. */
  ready: number;
  /** Total frames. */
  total: number;
  /** true once every frame is cached. */
  done: boolean;
  /** Frame currently being converged (−1 when done). */
  building: number;
}

export class CineFilmstrip {
  private dev: GPUDevice;
  private tex: (GPUTexture | null)[];
  private cached: boolean[];
  private w = 0;
  private h = 0;
  private buildFrame = 0;
  private buildN = 0;

  constructor(
    gpu: Gpu,
    private format: GPUTextureFormat,      // canvas format, e.g. "bgra8unorm"
    private viewFormat: GPUTextureFormat,  // the srgb view the SceneRenderer pipeline targets
    readonly frames: number,
    /** Accumulated samples per frame. 24 matches the adaptive loop's idle convergence target. */
    readonly samples = 24,
  ) {
    this.dev = gpu.device;
    this.tex = new Array(frames).fill(null);
    this.cached = new Array(frames).fill(false);
  }

  /** (Re)allocate for a new canvas size. A size change invalidates every cached frame. */
  ensureSize(w: number, h: number): void {
    if (w === this.w && h === this.h && this.tex[0]) return;
    this.w = w; this.h = h;
    for (let i = 0; i < this.frames; i++) {
      this.tex[i]?.destroy();
      this.tex[i] = this.dev.createTexture({
        size: [w, h], format: this.format,
        viewFormats: [this.viewFormat],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
    }
    this.invalidate();
  }

  /** Throw away every converged frame — camera moved, preset changed, scene rebuilt. */
  invalidate(): void {
    this.cached.fill(false);
    this.buildFrame = 0;
    this.buildN = 0;
  }

  isReady(i: number): boolean { return !!this.cached[i]; }
  get complete(): boolean { return this.cached.every(Boolean); }
  progress(): FilmstripProgress {
    const ready = this.cached.reduce((n, c) => n + (c ? 1 : 0), 0);
    return { ready, total: this.frames, done: ready === this.frames, building: ready === this.frames ? -1 : this.buildFrame };
  }

  /** Advance the build by up to `chunk` accumulation samples. Call once per animation frame
   *  so the page stays responsive while the strip fills in. `select(i)` must point the
   *  CineField at frame i and refresh the scene's bindings/uniforms; the caller must have
   *  already set the camera for (w, h). Returns the frame that just COMPLETED, or -1. */
  step(scene: SceneRenderer, select: (i: number) => void, chunk = 4): number {
    if (this.complete || !this.w) return -1;
    while (this.cached[this.buildFrame]) this.buildFrame = (this.buildFrame + 1) % this.frames;
    const i = this.buildFrame;
    const view = this.tex[i]!.createView({ format: this.viewFormat });
    if (this.buildN === 0) select(i);
    const n = Math.min(chunk, this.samples - this.buildN);
    for (let k = 0; k < n; k++) {
      scene.renderAccum(view, this.w, this.h, this.buildN === 0 && k === 0);
      this.buildN++;
    }
    if (this.buildN >= this.samples) {
      this.cached[i] = true;
      this.buildN = 0;
      this.buildFrame = (i + 1) % this.frames;
      return i;
    }
    return -1;
  }

  /** Copy a cached converged frame straight into the canvas texture (no shader pass). */
  present(i: number, dest: GPUTexture): boolean {
    if (!this.cached[i] || !this.tex[i]) return false;
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToTexture({ texture: this.tex[i]! }, { texture: dest }, [this.w, this.h, 1]);
    this.dev.queue.submit([enc.finish()]);
    return true;
  }

  destroy(): void {
    for (const t of this.tex) t?.destroy();
    this.tex.fill(null);
    this.cached.fill(false);
  }
}
