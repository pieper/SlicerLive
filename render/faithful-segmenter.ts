// FaithfulSegmenter — drives nnLive's FAITHFUL 192³ path (image-only trunk encode +
// perclick decode, the distilled nnInteractive port) exactly as the deployed nnLive
// demo does: global z-score, 192³ crop, EDT-ball prompts with decay, autoregressive
// prev_seg, and auto-zoom ×1.5→×4 when the mask hits the patch border. The proven
// runtime (wgpu-net.js + pathA-faithful-worker.js) and encoder (faithful-enc.js +
// edt-ball.js) are vendored under live/webgpu/nnlive/ and reused verbatim — this class
// is only the glue + state machine (ported from the deployed index.html), so the
// segmentation is bit-for-bit the faithful model, not a reimplementation.
//
// All coordinates here are VOXEL indices in (z,y,x)=(k,j,i) order, matching the volume's
// C-order layout data[(z*Y+y)*X+x]. The caller converts an anatomically-correct click
// (via the RAS-aware SliceRenderer) into that index before calling clickPredict.

const P = 192, MAX_ZOOM = 4, BORDER_ABS = 1200;

interface EncMod {
  Interactions: new (Z: number, Y: number, X: number) => {
    addPoint(z: number, y: number, x: number, sign: number): void;
    clear(): void;
    prev: Uint8Array | null;
    buildInter(center: number[], ps: number, zoom: number): Float32Array;
  };
  extractCrop(vol: Float32Array, Z: number, Y: number, X: number, center: number[], ps: number, zoom: number, mean: number, std: number): Float32Array;
  globalStats(vol: Float32Array): { mean: number; std: number };
  boxOrigin(center: number[], ps: number, zoom: number): [number, number, number];
}

export interface FaithfulOpts {
  workerUrl: string;   // URL of pathA-faithful-worker.js (vendored)
  encUrl: string;      // URL of faithful-enc.js (vendored)
  base: string;        // model base URL (trunk8/perclick graphs), e.g. .../models/pathA/faithful/
  weights: string;     // perclick_192.weights.bin URL (CORS bucket)
  onStatus?: (msg: string) => void;
}

export class FaithfulSegmenter {
  readonly patch = P;
  private worker!: Worker;
  private enc!: EncMod;
  private opts: FaithfulOpts;
  private Z = 0; private Y = 0; private X = 0;
  private vol!: Float32Array;
  private stats = { mean: 0, std: 1 };
  private inter!: InstanceType<EncMod["Interactions"]>;
  private _labelmap!: Uint8Array;
  lastMs = 0;
  lastZoom = 1;

  // per-predict state machine
  private center: number[] = [0, 0, 0];
  private zoom = 1;
  private settle: ((m: Uint8Array) => void) | null = null;

  constructor(opts: FaithfulOpts) { this.opts = opts; }

  get labelmap(): Uint8Array { return this._labelmap; }

  async init(): Promise<void> {
    this.enc = await import(this.opts.encUrl) as unknown as EncMod;
    this.worker = new Worker(this.opts.workerUrl, { type: "module" });
    await new Promise<void>((resolve, reject) => {
      const onFirst = (e: MessageEvent) => {
        const d = e.data;
        if (d.type === "progress") {
          if (d.what === "tune") this.opts.onStatus?.("autotuning GPU convolutions (one-time)…");
          else if (d.cached) this.opts.onStatus?.("model weights cached — initializing…");
          else if (d.total) this.opts.onStatus?.(`downloading nnLive weights ${(d.loaded / 1e6).toFixed(0)}/${(d.total / 1e6).toFixed(0)} MB (${Math.round(100 * d.loaded / d.total)}%) · compiling shaders…`);
          else this.opts.onStatus?.("loading nnLive model + compiling shaders…");
        } else if (d.type === "ready") {
          this.worker.removeEventListener("message", onFirst); this.wire();
          this.opts.onStatus?.(`nnLive faithful 192³ ready · ~${d.ms} ms/click on this GPU · loaded in ${(d.loadMs / 1000).toFixed(1)}s — click an organ to segment`);
          resolve();
        } else if (d.type === "error") { this.worker.removeEventListener("message", onFirst); reject(new Error(d.msg)); }
      };
      this.worker.addEventListener("message", onFirst);
      this.worker.onerror = (e) => reject(e);
      this.worker.postMessage({ type: "init", res: P, base: this.opts.base, perclickWeights: this.opts.weights });
    });
  }

  private wire() {
    this.worker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data;
      if (d.type === "encoded") {
        this.opts.onStatus?.(`encoded 192³ in ${d.ms} ms · decoding (perclick)…`);
        const i7 = this.inter.buildInter(this.center, P, this.zoom);
        this.worker.postMessage({ type: "infer", inter: i7.buffer }, [i7.buffer]);
      } else if (d.type === "result") {
        const m = new Uint8Array(d.mask);
        this.lastMs = d.ms;
        const bc = this.borderCount(m);
        if (this.zoom < MAX_ZOOM && bc > BORDER_ABS) {   // mask hit the FOV border -> zoom out and re-encode
          this.zoom = Math.min(MAX_ZOOM, this.zoom * 1.5);
          this.opts.onStatus?.(`auto-zoom ×${this.zoom.toFixed(1)} (mask exceeds FOV)…`);
          this.encode();
          return;
        }
        this.pasteMask(m, this.center, this.zoom);
        this.lastZoom = this.zoom;
        const done = this.settle; this.settle = null;
        done?.(this._labelmap);
      } else if (d.type === "error") {
        const done = this.settle; this.settle = null;
        this.opts.onStatus?.("inference error: " + d.msg);
        done?.(this._labelmap);
      }
    });
  }

  /** Load the CT (raw voxels, (z,y,x) C-order) + dims=[X,Y,Z]. Resets interactions. */
  setVolume(voxels: Float32Array, dims: [number, number, number]) {
    this.vol = voxels; this.X = dims[0]; this.Y = dims[1]; this.Z = dims[2];
    this.inter = new this.enc.Interactions(this.Z, this.Y, this.X);
    this.stats = this.enc.globalStats(voxels);
    this._labelmap = new Uint8Array(this.X * this.Y * this.Z);
  }

  reset() { this.inter.clear(); this._labelmap.fill(0); }

  /** Add a point (voxel coords z=k,y=j,x=i; sign +1 fg / -1 bg) and run a faithful
   *  encode+decode (+ auto-zoom). Resolves with the updated full-volume labelmap. */
  clickPredict(z: number, y: number, x: number, sign: 1 | -1): Promise<Uint8Array> {
    this.inter.addPoint(z, y, x, sign);
    this.center = [z, y, x];
    this.zoom = 1;
    return new Promise((resolve) => { this.settle = resolve; this.encode(); });
  }

  private encode() {
    this.opts.onStatus?.(`encoding 192³ (trunk)${this.zoom > 1 ? ` · zoom ×${this.zoom.toFixed(1)}` : ""}…`);
    const crop = this.enc.extractCrop(this.vol, this.Z, this.Y, this.X, this.center, P, this.zoom, this.stats.mean, this.stats.std);
    this.worker.postMessage({ type: "encode", image: crop.buffer, ctr: this.center, zoom: this.zoom }, [crop.buffer]);
  }

  private borderCount(m: Uint8Array): number {
    let n = 0; const F = P - 1;
    for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) {
      if (m[(0 * P + a) * P + b]) n++; if (m[(F * P + a) * P + b]) n++;
      if (m[(a * P + 0) * P + b]) n++; if (m[(a * P + F) * P + b]) n++;
      if (m[(a * P + b) * P + 0]) n++; if (m[(a * P + b) * P + F]) n++;
    }
    return n;
  }

  private pasteMask(m: Uint8Array, ctr: number[], zoom: number) {
    const size = Math.round(P * zoom);
    const [oz, oy, ox] = this.enc.boxOrigin(ctr, P, zoom);
    const { Z, Y, X } = this;
    const mask = this._labelmap;
    for (let z = 0; z < size; z++) {
      const zz = oz + z; if (zz < 0 || zz >= Z) continue; const pz = Math.min(P - 1, Math.floor(z / zoom));
      for (let y = 0; y < size; y++) {
        const yy = oy + y; if (yy < 0 || yy >= Y) continue; const py = Math.min(P - 1, Math.floor(y / zoom));
        const vrow = (zz * Y + yy) * X, mrow = (pz * P + py) * P;
        for (let x = 0; x < size; x++) {
          const xx = ox + x; if (xx < 0 || xx >= X) continue; const px = Math.min(P - 1, Math.floor(x / zoom));
          mask[vrow + xx] = m[mrow + px];
        }
      }
    }
    this.inter.prev = mask;   // autoregressive: running prediction feeds the next decode
  }

  dispose() { this.worker?.terminate(); }
}
