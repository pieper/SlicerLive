// SegmentationLogic — the LOGIC layer that glues an editable segmentation (algorithms/) to the
// renderer (render/), so neither engine imports the other (docs/ALGORITHMS.md). Slicer-idiomatic
// naming: a "Logic" mediates between model/data and its display, exactly as a vtkSlicerModuleLogic
// wires MRML to displayable managers.
//
//   EditableSegmentation.masterTexture()  (r32uint, algorithms/, effects write)
//        │
//        ├─ renderMode "sdf"     : JfaSdfBaker → signed-distance texture → SegmentField mode "sdf"
//        │                         (crisp, terrace-free "surface model" look — the default)   [render/]
//        └─ renderMode "surface" : ColorizeBaker (σ Gaussian) → presence → SegmentField "surface"
//                                   (gradient-opacity, softer; the earlier path)               [render/]
//
// It subscribes to EditableSegmentation.onDirty: every edit re-derives the render texture in place
// (identity stable → the SceneRenderer bind group stays valid, no rebuild, no flash), then notifies
// listeners (the app redraws). This is the ONLY module that depends on both `algorithms/` and
// `render/`.

import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { ColorizeBaker } from "../render/bake.ts";
import { JfaSdfBaker } from "../render/sdf-bake.ts";
import { SegmentField } from "../render/fields.ts";

export interface SegmentationLogicOpts {
  renderMode?: "sdf" | "surface";            // sdf = crisp terrace-free (default); surface = Gaussian gradient-opacity
  sigmaVoxels?: number;                       // presence smoothing (surface mode only; default 1.0)
  bandMm?: number;                            // shell half-thickness (sdf mode; default = 1 voxel)
  color?: [number, number, number];           // display colour
  opacity?: number;                           // segment 3D opacity (default 1)
}

export class SegmentationLogic {
  readonly renderMode: "sdf" | "surface";
  // sdf path
  private sdf?: JfaSdfBaker;
  // surface path
  private baker?: ColorizeBaker;
  private presenceTex?: GPUTexture;
  private presencePalette?: Float32Array;
  private sigma: number;

  private bandMm?: number;
  private color: [number, number, number];
  private opacity: number;
  private segField?: SegmentField;
  private redrawCbs: Array<() => void> = [];
  private unsubDirty: () => void;

  constructor(device: GPUDevice, private seg: EditableSegmentation, opts: SegmentationLogicOpts = {}) {
    this.renderMode = opts.renderMode ?? "sdf";
    this.sigma = opts.sigmaVoxels ?? 1.0;
    this.bandMm = opts.bandMm;
    this.color = opts.color ?? [0.30, 0.85, 0.55];
    this.opacity = opts.opacity ?? 1.0;

    if (this.renderMode === "sdf") {
      this.sdf = new JfaSdfBaker(device, seg.masterTexture(), seg.dims, seg.ijkToRAS);
    } else {
      this.baker = new ColorizeBaker(device, seg.masterTexture(), seg.dims);
      this.presenceTex = this.baker.output();
      this.presencePalette = new Float32Array(256 * 4);
      for (let i = 1; i < 256; i++) this.presencePalette[i * 4 + 3] = 1;   // any nonzero id → present
    }

    this.rebake();
    // Wire the model → render sync: an edit re-derives the render texture, then the app redraws.
    this.unsubDirty = seg.onDirty(() => { this.rebake(); for (const cb of this.redrawCbs) cb(); });
  }

  /** Re-derive the render texture from the current master (in place). */
  private rebake() {
    if (this.sdf) this.sdf.bake();
    else this.baker!.bakeInto(this.presenceTex!, this.presencePalette!, this.sigma);
  }

  /** A SegmentField bound to the shared render texture — hand this to the SceneRenderer once; edits
   *  update it in place (no rebuild). */
  field(): SegmentField {
    if (!this.segField) {
      const tex = this.sdf ? this.sdf.sdfTexture() : this.presenceTex!;
      this.segField = new SegmentField(tex, this.seg.dims, [1, 1, 1], {
        color: this.color, opacity: this.opacity, ijkToRAS: this.seg.ijkToRAS,
        mode: this.renderMode === "sdf" ? "sdf" : "surface", bandMm: this.bandMm, clippable: false,
      });
    }
    return this.segField;
  }

  /** Notified after every edit (post-rebake) so the app can redraw. */
  onRedraw(cb: () => void) { this.redrawCbs.push(cb); }

  destroy() { this.unsubDirty(); this.sdf?.destroy(); this.baker?.destroy(); this.presenceTex?.destroy(); }
}
