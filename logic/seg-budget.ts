// SegBudget — capability-based tuning for the segmentation SDF pipeline, measured from the REAL
// machine (not hard-coded), mirroring how the renderer's budget-controller adapts the ray march.
// A one-time micro-benchmark times an SDF refine at a small size → a device tier that drives:
//   • sdfMaxDim()      — the SDF grid resolution cap for large volumes (phone small, high-end big /
//                        microCT), the biggest memory + time lever.
//   • refineDelayMs()  — how soon after an edit the settle-refine fires: fast devices refine almost
//                        immediately (feels dynamic), slow devices wait longer so the refine never
//                        stutters an in-progress stroke.
//   • refineDuringStroke() — whether a high-end GPU can afford to refine live, not just on settle.
//   • useEdt()         — reserve the (future) exact-EDT tier for devices fast enough to run it.
//
// Lives in `logic/` because it bridges device capability (render) to the seg pipeline policy; it uses
// a throwaway EditableSegmentation + JfaSdfBaker to measure.

import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { JfaSdfBaker } from "../render/sdf-bake.ts";

export type SegTier = "low" | "mid" | "high";

export class SegBudget {
  private constructor(readonly tier: SegTier, readonly refineMsAt64: number) {}

  /** Measure the device by timing an SDF refine at `probeDim`³ (default 64), then classify. Cheap:
   *  one warm bake + a few refines behind a single GPU sync. */
  static async probe(device: GPUDevice, probeDim = 64): Promise<SegBudget> {
    const D = probeDim;
    const dims: [number, number, number] = [D, D, D];
    const s = 2;
    const ijkToRAS = [s, 0, 0, -D, 0, s, 0, -D, 0, 0, s, -D, 0, 0, 0, 1];
    const seg = new EditableSegmentation(device, dims, { ijkToRAS });
    const lab = new Uint8Array(D * D * D);
    const c = D / 2, r = D * 0.35;
    for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
      const dx = x - c, dy = y - c, dz = z - c;
      if (dx * dx + dy * dy + dz * dz <= r * r) lab[(z * D + y) * D + x] = 1;
    }
    const baker = new JfaSdfBaker(device, seg.masterTexture(), dims, ijkToRAS);
    const pal = new Float32Array(256 * 4); pal[4] = 1; pal[5] = 1; pal[6] = 1; pal[7] = 1;  // label 1 → white/opaque
    baker.setPalette(pal);
    const mode = new Float32Array(256 * 4);
    baker.setModePalette(mode);

    let refineMs = 8;   // safe default if timing is unavailable
    try {
      device.pushErrorScope?.("validation");
      seg.loadLabelmap(lab);
      baker.bake();
      await device.queue.onSubmittedWorkDone();   // warm (shader compile / first alloc)
      const N = 3, t0 = performance.now();
      for (let i = 0; i < N; i++) baker.refine();
      await device.queue.onSubmittedWorkDone();
      refineMs = (performance.now() - t0) / N;
      await device.popErrorScope?.();
    } catch {
      // keep the default
    } finally {
      baker.destroy(); seg.destroy();
    }

    // Thresholds at 64³ refine (JFA+2 + blurs). A recent desktop dGPU is well under a couple ms; a
    // ~6-year-old phone lands in the tens of ms. Conservative buckets; degrades gracefully if off.
    const tier: SegTier = refineMs < 3.5 ? "high" : refineMs < 14 ? "mid" : "low";
    return new SegBudget(tier, refineMs);
  }

  /** A fixed mid-tier budget without probing (SSR/headless/opt-out). */
  static fixed(tier: SegTier = "mid"): SegBudget { return new SegBudget(tier, tier === "high" ? 2 : tier === "mid" ? 8 : 20); }

  /** SDF grid cap per axis for large volumes (SEGRoulette / microCT). */
  sdfMaxDim(): number { return this.tier === "high" ? 384 : this.tier === "mid" ? 256 : 128; }

  /** Debounce before the settle-refine fires (ms). Fast → near-immediate (dynamic); slow → patient. */
  refineDelayMs(): number { return this.tier === "high" ? 40 : this.tier === "mid" ? 150 : 320; }

  /** High-end only: refine live during a stroke rather than only on settle. */
  refineDuringStroke(): boolean { return this.tier === "high"; }

  /** Reserve the exact-EDT refinement tier (when built) for capable devices. */
  useEdt(): boolean { return this.tier !== "low"; }

  summary(): string { return `${this.tier} (${this.refineMsAt64.toFixed(1)} ms/refine@64³ → sdf≤${this.sdfMaxDim()}, refine@${this.refineDelayMs()}ms)`; }
}
