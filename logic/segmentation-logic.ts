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
}

export class SegmentationLogic {
  readonly renderMode: "sdf" | "surface";
  private sdf?: JfaSdfBaker;                   // sdf path
  private baker?: ColorizeBaker;               // surface path
  private presenceTex?: GPUTexture;
  private sigma: number;
  private bandMm?: number;
  private opacity: number;
  private palette = new Float32Array(256 * 4); // label id → (r,g,b, 1 = defined); shared by both paths
  private segField?: SegmentField;
  private redrawCbs: Array<() => void> = [];
  private unsubDirty: () => void;

  constructor(device: GPUDevice, private seg: EditableSegmentation, opts: SegmentationLogicOpts = {}) {
    this.renderMode = opts.renderMode ?? "sdf";
    this.sigma = opts.sigmaVoxels ?? 1.0;
    this.bandMm = opts.bandMm;
    this.opacity = opts.opacity ?? 1.0;
    this.setLabelColor(1, opts.color ?? [0.30, 0.85, 0.55]);   // single-label convenience default

    if (this.renderMode === "sdf") {
      this.sdf = new JfaSdfBaker(device, seg.masterTexture(), seg.dims, seg.ijkToRAS);
    } else {
      this.baker = new ColorizeBaker(device, seg.masterTexture(), seg.dims);
      this.presenceTex = this.baker.output();
    }

    this.rebake();
    this.unsubDirty = seg.onDirty(() => { this.rebake(); for (const cb of this.redrawCbs) cb(); });
  }

  /** Assign a display colour to a label id (0..255). Takes effect on the next rebake. */
  setLabelColor(id: number, rgb: [number, number, number]) {
    if (id < 1 || id > 255) return;
    const o = id * 4;
    this.palette[o] = rgb[0]; this.palette[o + 1] = rgb[1]; this.palette[o + 2] = rgb[2]; this.palette[o + 3] = 1;
  }

  /** Re-derive the render texture from the current master + palette (in place). */
  private rebake() {
    if (this.sdf) { this.sdf.setPalette(this.palette); this.sdf.bake(); }
    else this.baker!.bakeInto(this.presenceTex!, this.palette, this.sigma);
  }

  /** A SegmentField bound to the shared render texture — hand this to the SceneRenderer once; edits
   *  update it in place. Colour comes from the texture (per-label); the uniform supplies opacity. */
  field(): SegmentField {
    if (!this.segField) {
      const tex = this.sdf ? this.sdf.sdfTexture() : this.presenceTex!;
      this.segField = new SegmentField(tex, this.seg.dims, [1, 1, 1], {
        color: [1, 1, 1], opacity: this.opacity, ijkToRAS: this.seg.ijkToRAS,
        mode: this.renderMode === "sdf" ? "sdf" : "surface", colorFromTexture: true, bandMm: this.bandMm, clippable: false,
      });
    }
    return this.segField;
  }

  /** Notified after every edit (post-rebake) so the app can redraw. */
  onRedraw(cb: () => void) { this.redrawCbs.push(cb); }

  destroy() { this.unsubDirty(); this.sdf?.destroy(); this.baker?.destroy(); this.presenceTex?.destroy(); }
}
