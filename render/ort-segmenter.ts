// OrtWorkerSegmenter — the browser inference backend for the LiveSegmenter: wraps
// the ORT-Web nnLive worker (webgpu/nnlive-worker.js) behind the Segmenter interface.
// Browser-only (uses Worker); headless tests use SyntheticSegmenter instead.
import type { Segmenter } from "./live-segmenter.ts";

export interface OrtSegmenterOpts {
  workerUrl: string;   // URL of nnlive-worker.js
  modelUrl: string;    // URL of the .onnx model (e.g. the CORS bucket)
  patch?: number;      // P (default 64)
  onStatus?: (msg: string) => void;
}

export class OrtWorkerSegmenter implements Segmenter {
  readonly patch: number;
  private worker: Worker;
  private modelUrl: string;
  private onStatus?: (msg: string) => void;
  private seq = 0;
  private readyPromise: Promise<void>;
  private pending = new Map<number, (m: Uint8Array) => void>();
  lastRunMs = 0;

  constructor(opts: OrtSegmenterOpts) {
    this.patch = opts.patch ?? 64;
    this.modelUrl = opts.modelUrl;
    this.onStatus = opts.onStatus;
    this.worker = new Worker(opts.workerUrl, { type: "module" });
    let resolveReady!: () => void, rejectReady!: (e: unknown) => void;
    this.readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    this.worker.onmessage = (e: MessageEvent) => {
      const { type, data } = e.data;
      if (type === "ready") {
        this.onStatus?.(`model ready · load ${(data.loadMs / 1000).toFixed(1)}s · warmup ${(data.warmMs / 1000).toFixed(1)}s`);
        resolveReady();
      } else if (type === "result") {
        this.lastRunMs = data.runMs;
        const cb = this.pending.get(data.seq);
        if (cb) { this.pending.delete(data.seq); cb(new Uint8Array(data.mask)); }
      } else if (type === "error") {
        rejectReady(new Error(data));
        for (const cb of this.pending.values()) cb(new Uint8Array(this.patch ** 3)); // unblock with empty
        this.pending.clear();
        this.onStatus?.("inference error: " + data);
      }
    };
    this.worker.onerror = (e) => rejectReady(e);
  }

  ready(): Promise<void> {
    this.worker.postMessage({ type: "init", modelUrl: this.modelUrl, patch: this.patch });
    return this.readyPromise;
  }

  infer(input: Float32Array): Promise<Uint8Array> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(seq, resolve);
      // copy so we can transfer the buffer without detaching the caller's array
      const buf = input.slice().buffer;
      this.worker.postMessage({ type: "infer", input: buf, lo: [0, 0, 0], seq }, [buf]);
    });
  }

  dispose() { this.worker.terminate(); }
}
