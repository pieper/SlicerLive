// SegmentationLogic — the LOGIC layer that glues an editable segmentation (algorithms/) to the
// renderer (render/), so neither engine imports the other (docs/ALGORITHMS.md). Slicer-idiomatic
// naming: a "Logic" mediates between model/data and its display, exactly as a vtkSlicerModuleLogic
// wires MRML to displayable managers.
//
//   EditableSegmentation.masterTexture()  (r32uint, algorithms/, effects write)
//        │
//        ├─ renderMode "sdf"     : JfaSdfBaker → colorized signed-distance (rgba16float: rgb=label
//        │                         colour, a=signed mm) → SegmentField mode "sdf" (crisp, terrace-
//        │                         free, MULTI-LABEL surface).                              [render/]
//        └─ renderMode "surface" : ColorizeBaker (σ Gaussian) → rgb=label colour, a=presence →
//                                   SegmentField "surface" (gradient-opacity, multi-label).  [render/]
//
// A per-label PALETTE (label id → colour) makes both paths multi-label: one merged surface shows each
// region in its own colour, with a colour seam where different-label neighbours meet. It subscribes to
// EditableSegmentation.onDirty: every edit re-derives the render texture in place (identity stable →
// bind group stays valid, no rebuild, no flash), then notifies listeners. This is the ONLY module
// that depends on both `algorithms/` and `render/`.

import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { ColorizeBaker } from "../render/bake.ts";
import { JfaSdfBaker } from "../render/sdf-bake.ts";
import { SegmentField } from "../render/fields.ts";

export interface SegmentationLogicOpts {
  renderMode?: "sdf" | "surface";            // sdf = crisp terrace-free (default); surface = Gaussian gradient-opacity
  sigmaVoxels?: number;                       // presence smoothing (surface mode only; default 1.0)
  bandMm?: number;                            // shell half-thickness (sdf mode; default = 1 voxel)
  color?: [number, number, number];           // colour for label 1 (single-label convenience; use setLabelColor for more)
  opacity?: number;                           // segment 3D opacity (default 1)
  refineDelayMs?: number;                     // debounce before the settle-refine (capability-tuned; default 180)
}

export class SegmentationLogic {
  readonly renderMode: "sdf" | "surface";
  private sdf?: JfaSdfBaker;                   // sdf path
  private baker?: ColorizeBaker;               // surface path
  private presenceTex?: GPUTexture;
  private sigma: number;
  private bandMm?: number;
  private opacity: number;
  private palette = new Float32Array(256 * 4);      // label id → (r,g,b, opacity); shared by both paths
  private modePalette = new Float32Array(256 * 4);  // label id → (.x = shading mode: 0 surface / 1 volume) — sdf only
  private segField?: SegmentField;
  private redrawCbs: Array<() => void> = [];
  private unsubDirty: () => void;
  private refineTimer?: ReturnType<typeof setTimeout>;
  private refineDelayMs: number;             // quiescence before the settle-refine (sdf mode; capability-tuned)

  constructor(device: GPUDevice, private seg: EditableSegmentation, opts: SegmentationLogicOpts = {}) {
    this.renderMode = opts.renderMode ?? "sdf";
    this.sigma = opts.sigmaVoxels ?? 1.0;
    this.bandMm = opts.bandMm;
    this.opacity = opts.opacity ?? 1.0;
    this.refineDelayMs = opts.refineDelayMs ?? 180;
    this.setLabelColor(1, opts.color ?? [0.30, 0.85, 0.55]);   // single-label convenience default

    if (this.renderMode === "sdf") {
      this.sdf = new JfaSdfBaker(device, seg.masterTexture(), seg.dims, seg.ijkToRAS);
    } else {
      this.baker = new ColorizeBaker(device, seg.masterTexture(), seg.dims);
      this.presenceTex = this.baker.output();
    }

    this.rebake();
    this.scheduleRefine();   // the initial content is static → refine shortly
    // Two-phase (sdf): every edit does a FAST bake for live feedback, then a settle-refine (JFA+2,
    // tighter distance blur, colour-seam blur) after quiescence, so a static labelmap renders crisp
    // and cheap while orbiting. Surface mode has no refine (ColorizeBaker is already fast+smooth).
    this.unsubDirty = seg.onDirty(() => { this.rebake(); for (const cb of this.redrawCbs) cb(); this.scheduleRefine(); });
  }

  /** Assign a display colour to a label id (0..255). Keeps the current opacity (defaults to 1 =
   *  opaque). Takes effect on the next rebake. */
  setLabelColor(id: number, rgb: [number, number, number]) {
    if (id < 1 || id > 255) return;
    const o = id * 4;
    this.palette[o] = rgb[0]; this.palette[o + 1] = rgb[1]; this.palette[o + 2] = rgb[2];
    if (this.palette[o + 3] === 0) this.palette[o + 3] = 1;   // first definition → opaque
  }

  /** Per-segment opacity (0 = hidden, 1 = opaque) — palette alpha. Enables translucent surface-model
   *  rendering (see through outer segments to inner ones). Rebake/refine to apply. */
  setLabelOpacity(id: number, opacity: number) {
    if (id < 1 || id > 255) return;
    this.palette[id * 4 + 3] = Math.max(0, Math.min(1, opacity));
  }

  /** Per-segment shading (sdf mode): "surface" = crisp SDF shell (surface model), "volume" = DVR fill
   *  of the interior (translucent cloud). Rebake/refine to apply. */
  setLabelShading(id: number, shading: "surface" | "volume") {
    if (id < 1 || id > 255) return;
    this.modePalette[id * 4] = shading === "volume" ? 1 : 0;
  }

  /** Re-derive the render texture from the current master + palette (FAST, in place). */
  private rebake() {
    if (this.sdf) { this.sdf.setPalette(this.palette); this.sdf.setModePalette(this.modePalette); this.sdf.bake(); }
    else this.baker!.bakeInto(this.presenceTex!, this.palette, this.sigma);
  }

  /** Schedule the settle-refine after quiescence (debounced; sdf mode only). */
  private scheduleRefine() {
    if (!this.sdf) return;
    if (this.refineTimer !== undefined) clearTimeout(this.refineTimer);
    this.refineTimer = setTimeout(() => { this.refineTimer = undefined; this.refineNow(); }, this.refineDelayMs);
  }

  /** Run the settle-refine now (JFA+2 + tighter distance blur + colour-seam blur), then redraw.
   *  Public so a test — or an app that knows the edit is done — can force the high-quality bake. */
  refineNow() {
    if (this.refineTimer !== undefined) { clearTimeout(this.refineTimer); this.refineTimer = undefined; }
    if (this.sdf) { this.sdf.setPalette(this.palette); this.sdf.setModePalette(this.modePalette); this.sdf.refine(); for (const cb of this.redrawCbs) cb(); }
  }

  /** A SegmentField bound to the shared render texture — hand this to the SceneRenderer once; edits
   *  update it in place. Colour comes from the texture (per-label); the uniform supplies opacity. */
  field(): SegmentField {
    if (!this.segField) {
      const tex = this.sdf ? this.sdf.sdfTexture() : this.presenceTex!;
      // sdf: a tight shell band (≈0.65 voxel) gives a crisp edge on the smooth SDF without under-
      // smoothing (which would re-facet). Kept above the ray-march step (~0.7·voxel) to avoid holes.
      const voxelMm = Math.min(...this.seg.spacingMm());
      const band = this.bandMm ?? (this.renderMode === "sdf" ? 0.65 * voxelMm : undefined);
      this.segField = new SegmentField(tex, this.seg.dims, [1, 1, 1], {
        color: [1, 1, 1], opacity: this.opacity, ijkToRAS: this.seg.ijkToRAS,
        mode: this.renderMode === "sdf" ? "sdf" : "surface", colorFromTexture: true, bandMm: band, clippable: false,
        attrTexture: this.sdf ? this.sdf.attrTexture() : undefined,   // per-segment opacity (sdf)
      });
    }
    return this.segField;
  }

  /** Notified after every edit (post-rebake) so the app can redraw. */
  onRedraw(cb: () => void) { this.redrawCbs.push(cb); }

  destroy() {
    if (this.refineTimer !== undefined) clearTimeout(this.refineTimer);
    this.unsubDirty(); this.sdf?.destroy(); this.baker?.destroy(); this.presenceTex?.destroy();
  }
}
