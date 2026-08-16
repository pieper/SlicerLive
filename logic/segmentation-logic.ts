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
  boundaryMode?: "outer" | "all";             // sdf: "outer" = shell only at segment↔background (default; crisp separated segments). "all" = shell at ANY label change (multi-material interface field) so EMBEDDED/NESTED labels surface too — islands within islands — without one SDF per segment.
  clippable?: boolean;                        // let scene clip boxes crop the shell (default false — Slicer's ROI crops the volume, not the segmentation; spine-compare's extent control opts in)
}

function invertAffine(m: number[]): number[] {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  const i = [
    (r[4] * r[8] - r[5] * r[7]) / det, (r[2] * r[7] - r[1] * r[8]) / det, (r[1] * r[5] - r[2] * r[4]) / det,
    (r[5] * r[6] - r[3] * r[8]) / det, (r[0] * r[8] - r[2] * r[6]) / det, (r[2] * r[3] - r[0] * r[5]) / det,
    (r[3] * r[7] - r[4] * r[6]) / det, (r[1] * r[6] - r[0] * r[7]) / det, (r[0] * r[4] - r[1] * r[3]) / det,
  ];
  const t = [m[3], m[7], m[11]];
  return [
    i[0], i[1], i[2], -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2]),
    i[3], i[4], i[5], -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2]),
    i[6], i[7], i[8], -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2]),
    0, 0, 0, 1,
  ];
}

export class SegmentationLogic {
  readonly renderMode: "sdf" | "surface";
  private clippable: boolean;
  private attrSettleTimer?: number;
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
  private boundaryMode: "outer" | "all";

  constructor(device: GPUDevice, private seg: EditableSegmentation, opts: SegmentationLogicOpts = {}) {
    this.renderMode = opts.renderMode ?? "sdf";
    this.sigma = opts.sigmaVoxels ?? 1.0;
    this.bandMm = opts.bandMm;
    this.opacity = opts.opacity ?? 1.0;
    this.refineDelayMs = opts.refineDelayMs ?? 180;
    this.boundaryMode = opts.boundaryMode ?? "outer";
    this.clippable = opts.clippable ?? false;
    this.setLabelColor(1, opts.color ?? [0.30, 0.85, 0.55]);   // single-label convenience default

    if (this.renderMode === "sdf") {
      this.sdf = new JfaSdfBaker(device, seg.masterTexture(), seg.dims, seg.ijkToRAS, 1.0, 2, this.boundaryMode);
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

  /** FAST per-segment opacity refresh: attr-only rebake (no JFA re-sweep) — for visibility
   *  toggles where the labelmap and colours are unchanged.
   *
   *  With `regionRAS` (the bbox of the labels whose opacity changed): the finalize AND the
   *  seam blur run region-limited in one shot — full settled quality lands immediately, no
   *  two-phase. Without it: full-volume fast pass + a debounced full-volume seam blur. */
  /** RAS bbox → padded-SDF-grid ijk bbox with an M-voxel margin (shell band + blur radii). */
  private regionToIjk(regionRAS: { lo: [number, number, number]; hi: [number, number, number] }, M = 8) {
    const inv = invertAffine(this.sdf!.sdfIjkToRAS());
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const x of [regionRAS.lo[0], regionRAS.hi[0]]) for (const y of [regionRAS.lo[1], regionRAS.hi[1]]) for (const z of [regionRAS.lo[2], regionRAS.hi[2]]) {
      const i = inv[0] * x + inv[1] * y + inv[2] * z + inv[3];
      const j = inv[4] * x + inv[5] * y + inv[6] * z + inv[7];
      const k = inv[8] * x + inv[9] * y + inv[10] * z + inv[11];
      lo[0] = Math.min(lo[0], i); lo[1] = Math.min(lo[1], j); lo[2] = Math.min(lo[2], k);
      hi[0] = Math.max(hi[0], i); hi[1] = Math.max(hi[1], j); hi[2] = Math.max(hi[2], k);
    }
    return {
      lo: [Math.floor(lo[0]) - M, Math.floor(lo[1]) - M, Math.floor(lo[2]) - M] as [number, number, number],
      hi: [Math.ceil(hi[0]) + M, Math.ceil(hi[1]) + M, Math.ceil(hi[2]) + M] as [number, number, number],
    };
  }

  /** REGION-LIMITED settle-refine after a labelmap edit confined to `regionRAS` (e.g. a
   *  per-vertebra visibility flip written via EditableSegmentation.writeLabelRegion): the full
   *  refine quality — JFA re-flood, finalize, seam blurs — over just the region, immediately.
   *  Small regions bake in ~ms, so stepping through per-label visibility stays real-time. */
  rebakeShellRegion(regionRAS: { lo: [number, number, number]; hi: [number, number, number] }) {
    if (!this.sdf) { this.rebake(); return; }
    if (this.refineTimer !== undefined) { clearTimeout(this.refineTimer); this.refineTimer = undefined; }
    this.sdf.setPalette(this.palette);
    this.sdf.setModePalette(this.modePalette);
    this.sdf.refineRegion(this.regionToIjk(regionRAS));
    for (const cb of this.redrawCbs) cb();
  }

  refreshOpacity(regionRAS?: { lo: [number, number, number]; hi: [number, number, number] }) {
    if (!this.sdf) { this.rebake(); return; }
    this.sdf.setPalette(this.palette);
    if (regionRAS) {
      this.sdf.rebakeAttr(true, this.regionToIjk(regionRAS));   // finalize + seam blur, region-limited: settled instantly
      for (const cb of this.redrawCbs) cb();
      return;
    }
    this.sdf.rebakeAttr(false);               // instant, crisp (unblurred attr)
    for (const cb of this.redrawCbs) cb();
    if (this.attrSettleTimer !== undefined) clearTimeout(this.attrSettleTimer);
    this.attrSettleTimer = setTimeout(() => {
      this.attrSettleTimer = undefined;
      if (this.sdf) { this.sdf.blurAttrOnly(); for (const cb of this.redrawCbs) cb(); }
    }, 600);
  }

  /** A SegmentField bound to the shared render texture — hand this to the SceneRenderer once; edits
   *  update it in place. Colour comes from the texture (per-label); the uniform supplies opacity. */
  field(): SegmentField {
    if (!this.segField) {
      const tex = this.sdf ? this.sdf.sdfTexture() : this.presenceTex!;
      // sdf: a tight shell band (≈0.65 voxel) gives a crisp edge on the smooth SDF without under-
      // smoothing (which would re-facet). Kept above the ray-march step (~0.7·voxel) to avoid holes.
      const voxelMm = Math.min(...this.seg.spacingMm());
      // "all" (multi-material interface) mode uses a wider band: its distance is blurred for a smooth,
      // facet-free normal, which rounds the unsigned V-bottom up — a wider band keeps thin structures
      // from dropping out of the shell. "outer" stays tight (0.65 vox) for crisp separated surfaces.
      const interfaceMode = this.renderMode === "sdf" && this.boundaryMode === "all";
      const band = this.bandMm ?? (this.renderMode === "sdf" ? (interfaceMode ? 1.5 : 0.65) * voxelMm : undefined);
      // sdf textures live on the baker's PADDED grid (larger than the labelmap), so the field must use
      // the padded dims + ijkToRAS; the surface (presence) path stays on the label grid.
      const fdims = this.sdf ? this.sdf.sdfDims() : this.seg.dims;
      const fijk = this.sdf ? this.sdf.sdfIjkToRAS() : this.seg.ijkToRAS;
      this.segField = new SegmentField(tex, fdims, [1, 1, 1], {
        color: [1, 1, 1], opacity: this.opacity, ijkToRAS: fijk,
        mode: this.renderMode === "sdf" ? "sdf" : "surface", colorFromTexture: true, bandMm: band, clippable: this.clippable,
        attrTexture: this.sdf ? this.sdf.attrTexture() : undefined,   // per-segment opacity (sdf)
        interfaceMode,
      });
    }
    return this.segField;
  }

  /** Live GLOBAL segmentation opacity (0..1) — the field-level multiplier over every segment's own
   *  opacity. Caller does scene.syncUniforms() + redraw. */
  setGlobalOpacity(o: number) { this.opacity = o; this.segField?.setOpacity(o); }

  /** Notified after every edit (post-rebake) so the app can redraw. */
  onRedraw(cb: () => void) { this.redrawCbs.push(cb); }

  destroy() {
    if (this.refineTimer !== undefined) clearTimeout(this.refineTimer);
    this.unsubDirty(); this.sdf?.destroy(); this.baker?.destroy(); this.presenceTex?.destroy();
  }
}
