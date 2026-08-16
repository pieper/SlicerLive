// SegEditDisplayableManager — the "seged" displayable manager: mirrors a Slicer segmentation, but the
// EDITS are reproduced on-GPU from the streamed SegEdit *intents* (SegEditDriver → WebGPU effects),
// NOT fetched from Slicer's authoritative labelmap. So seged shows what the WebGPU pipeline computes
// for the same human input, and any disparity vs Slicer's own view is visible side by side.
//
// It plugs into the same LiveScene/MirrorView as the mirror's SegmentationDisplayableManager (drop-in
// replacement in seged mode). It lives in logic/ because it wires algorithms/ (EditableSegmentation +
// SegEditDriver) to render/ (SegmentationLogic + ColorizeBaker + the view) — the one layer allowed to
// depend on both (docs/ALGORITHMS.md).
//
// Flow:
//   1. FIRST segmentation node  → seed an EditableSegmentation from Slicer's initial labelmap.
//   2. each SegEdit intent event → SegEditDriver.applyEdit → effect writes the master → markDirty →
//      SegmentationLogic re-bakes the 3D field in place → onRedraw re-bakes the 2D overlay + redraws.
//   3. later authoritative labelmap echoes for the SAME id are IGNORED (seged stays intent-driven);
//      only display changes (colour / visibility / opacity) are applied.
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { SegEditDriver } from "../algorithms/seg-edit-driver.ts";
import type { Vec3 } from "../algorithms/geom.ts";
import { SegmentationLogic } from "./segmentation-logic.ts";
import { ColorizeBaker } from "../render/bake.ts";
import { fetchZarrVolume, type ZarrDesc } from "../render/zarr.ts";
import type { DisplayableManager, LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";

type Seg = { id?: string; labelValue: number; color: number[]; visible?: boolean };

/** Effective [fill, outline] slice opacities — mirrors Slicer's Opacity * {Opacity2DFill,Opacity2DOutline}. */
function slice2DOpacities(node: Record<string, unknown>, visible: boolean): [number, number] {
  if (!visible) return [0, 0];
  const overall = typeof node.opacity === "number" ? (node.opacity as number) : 1;
  const f = node.fill2D as { visible?: boolean; opacity?: number } | undefined;
  const o = node.outline2D as { visible?: boolean; opacity?: number } | undefined;
  const fill = (f?.visible ?? true) ? overall * (f?.opacity ?? 0.5) : 0;
  const outline = (o?.visible ?? true) ? overall * (o?.opacity ?? 1) : 0;
  return [fill, outline];
}

export interface SegEditManagerOpts {
  sigma?: number;                                   // 3D bake smoothing (SegmentationLogic surface σ; sdf ignores)
  imageTexForSeeds?: () => GPUTexture | undefined;  // source volume for grow-from-seeds (optional; paint doesn't need it)
  onEdit?: (kind: string) => void;                  // notified after each applied intent (for a HUD/log)
}

export class SegEditDisplayableManager implements DisplayableManager {
  // "segmentation" routes the initial labelmap + SegEdit events (routed by the event's sourceId type);
  // "segEdit" is not a node type — it's in the subscription union so the Slicer live server starts the
  // stroke-intent capture (mrson_live: `if "segEdit" in types`). It never matches in interested().
  interestedTypes = ["segmentation", "segEdit"];
  // We reproduce the labelmap on-GPU from SegEdit intents, so the peer needn't re-stream the heavy
  // authoritative labelmap on every edit — we only need the INITIAL snapshot (geometry + start).
  localBulkTypes = ["segmentation"];
  private seg?: EditableSegmentation;
  private driver?: SegEditDriver;
  private logic?: SegmentationLogic;
  private overlayBaker?: ColorizeBaker;
  private overlayTex?: GPUTexture;
  private segId?: string;
  private dims?: Vec3;
  private labelForId = new Map<string, number>();   // Slicer segment id → master label value
  private overlayPalette = new Float32Array(256 * 4);
  private added = false;
  private visible = true;
  private fill = 0.5;
  private outline = 1.0;
  private palKey = "";        // colours+visibility signature — re-bake the palette only when it changes
  private dispKey = "";       // visibility/fill/outline signature — re-push to the view only when it changes

  constructor(private dev: GPUDevice, private opts: SegEditManagerOpts = {}) {}

  private building = false;

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    if (node.type !== "segmentation") return;
    if (this.seg) { this.applyDisplay(node as unknown as Record<string, unknown>, scene); return; }  // echo → display only
    await this.ensureBuilt(node, scene);
  }

  /** Build the WebGPU segmentation from a seg node's GEOMETRY (dims + ijkToRAS). seged is intent-driven
   *  and the labelmap bulk is suppressed (localBulk), so an ABSENT/empty labelmap is the normal case —
   *  seed from the initial zarr if present, else zeros. Geometry alone is enough to reproduce edits. */
  private async ensureBuilt(node: MrsonNode, scene: LiveScene): Promise<boolean> {
    if (this.seg) return true;
    if (this.building) return false;
    const dims = node.dims as Vec3 | undefined;
    const ijk = node.ijkToRAS as number[] | undefined;
    if (!dims || dims[0] < 1 || dims[1] < 1 || dims[2] < 1 || !ijk) { this.opts.onEdit?.("no geometry yet"); return false; }
    this.building = true;
    const n = dims[0] * dims[1] * dims[2];
    let lab = new Uint8Array(n);
    if (node.zarr) {
      try { const zv = await fetchZarrVolume(scene.blobBase(), node.zarr as ZarrDesc); if (zv.data.length === n) lab = Uint8Array.from(zv.data); }
      catch { /* labelmap bulk unavailable → start empty; intents rebuild it */ }
    }
    this.segId = node.id;
    this.dims = dims;
    this.updateLabelMap(node.segments as Seg[] | undefined);
    this.seg = new EditableSegmentation(this.dev, dims, { ijkToRAS: ijk });
    this.seg.loadLabelmap(lab);
    this.driver = new SegEditDriver(this.seg, {
      labelForSegment: (id) => this.labelForId.get(id) ?? 1,
      imageTex: this.opts.imageTexForSeeds,
      onUnhandled: (k) => this.opts.onEdit?.("unhandled:" + k),
    });
    this.logic = new SegmentationLogic(this.dev, this.seg, { renderMode: "sdf", boundaryMode: "all", opacity: 1 });
    this.overlayBaker = new ColorizeBaker(this.dev, this.seg.masterTexture(), dims);
    this.overlayTex = this.overlayBaker.output();
    scene.view?.setField("seged:" + this.segId, this.logic.field());
    this.added = true;
    // Every edit: SegmentationLogic re-bakes the 3D field, then fires onRedraw → re-bake the 2D overlay
    // + push the current display to the view (one place both textures + the view state stay in sync).
    this.logic.onRedraw(() => { this.bakeOverlay(); this.pushToView(scene); });
    this.building = false;
    this.opts.onEdit?.(`built ${dims[0]}×${dims[1]}×${dims[2]}`);
    this.applyDisplay(node as unknown as Record<string, unknown>, scene);   // colours + display + first push
    return true;
  }

  async onEvent(ev: Record<string, unknown>, scene: LiveScene): Promise<void> {
    if (ev.event === "SegEdit") {
      // Lazy build: an intent can arrive for a seg we haven't built yet (empty-start; the labelmap bulk
      // is suppressed). Build from the node's geometry (still in the model) so no stroke is lost.
      if (!this.seg) { const n = scene.nodes.get(ev.sourceId as string); if (n) await this.ensureBuilt(n, scene); }
      if (this.driver && ev.sourceId === this.segId) {
        const kind = (SegEditDriver.unwrap(ev)?.kind) ?? "?";
        await this.driver.applyEdit(ev);        // effect writes master → markDirty → logic re-bake → onRedraw
        this.opts.onEdit?.("✏ " + kind);
      } else {
        this.opts.onEdit?.("intent dropped (no seg)");
      }
      return;
    }
    if (ev.event === "SegmentationDisplayModified" && ev.sourceId === this.segId) {
      this.applyDisplay((ev.display as Record<string, unknown>) ?? ev, scene);
    }
  }

  onNodeRemoved(id: string, scene: LiveScene) { if (id === this.segId) this.reset(scene); }
  onSceneClosed(scene: LiveScene) { this.reset(scene); }

  /** Debug: current segment-id→label map + the non-zero palette colours actually applied. */
  diag() {
    const pal: Record<number, number[]> = {};
    for (let lv = 1; lv < 256; lv++) { const o = lv * 4; if (this.overlayPalette[o + 3] > 0) pal[lv] = [+this.overlayPalette[o].toFixed(3), +this.overlayPalette[o + 1].toFixed(3), +this.overlayPalette[o + 2].toFixed(3)]; }
    return { built: !!this.seg, segId: this.segId, labelForId: Object.fromEntries(this.labelForId), palette: pal, palKey: this.palKey };
  }

  // ── palette / display ──────────────────────────────────────────────────────
  /** MERGE segment-id → label-value from any node/display carrying ids. Must stay current as segments
   *  are ADDED in Slicer (a new segment's stroke would otherwise fall back to label 1 = the wrong
   *  colour). Display events now carry `id` too (serialize_mrson), so this updates on segment add. */
  private updateLabelMap(segs?: Seg[]) {
    for (const s of segs ?? []) if (s.id) this.labelForId.set(s.id, s.labelValue);
  }
  /** Set per-label colour/opacity on the logic (3D) and the overlay palette (2D), then re-bake — but
   *  ONLY when the palette actually changed. A paint stroke's authoritative labelmap echo carries the
   *  SAME palette, so without this guard every stroke would trigger a full (expensive) SDF refineNow(),
   *  which competes with rendering and reads as lag. */
  private applyPalette(disp: Record<string, unknown>): boolean {
    const segs = (disp.segments as Seg[] | undefined) ?? [];
    this.updateLabelMap(segs);   // keep segment-id → label current (a newly added segment maps correctly)
    const key = segs.map((s) => `${s.labelValue}:${s.color.map((x) => x.toFixed(3)).join(",")}:${s.visible !== false}`).join("|");
    if (key === this.palKey) return false;
    this.palKey = key;
    this.overlayPalette.fill(0);
    for (const s of segs) {
      const lv = s.labelValue, on = s.visible !== false;
      if (lv > 0 && lv < 256) {
        this.logic?.setLabelColor(lv, [s.color[0], s.color[1], s.color[2]]);
        this.logic?.setLabelOpacity(lv, on ? 1 : 0);
        if (on) { const o = lv * 4; this.overlayPalette[o] = s.color[0]; this.overlayPalette[o + 1] = s.color[1]; this.overlayPalette[o + 2] = s.color[2]; this.overlayPalette[o + 3] = 1; }
      }
    }
    this.logic?.refineNow();   // applies the palette to the 3D SDF (fires onRedraw → bakeOverlay + pushToView)
    return true;
  }
  /** A display change (visibility / opacity / colour) from Slicer — no labelmap touch. No-op when
   *  nothing changed (so a per-stroke labelmap echo doesn't re-bake or re-render). */
  private applyDisplay(disp: Record<string, unknown>, scene: LiveScene) {
    const vis = disp.visible !== false;
    const [f, o] = slice2DOpacities(disp, vis);
    const paletteChanged = disp.segments ? this.applyPalette(disp) : false;
    const dispKey = `${vis}:${f.toFixed(3)}:${o.toFixed(3)}`;
    if (dispKey !== this.dispKey) { this.visible = vis; this.fill = f; this.outline = o; this.dispKey = dispKey; this.pushToView(scene); }
    else if (paletteChanged) this.pushToView(scene);   // colours changed but not visibility → still re-push
  }
  private bakeOverlay() { if (this.overlayBaker && this.overlayTex) this.overlayBaker.bakeInto(this.overlayTex, this.overlayPalette, 0); }
  private pushToView(scene: LiveScene) {
    scene.view?.setSegmentationOverlay(this.visible ? this.overlayTex! : null, this.fill, this.outline);
    if (this.visible) {
      if (!this.added && this.logic) { scene.view?.setField("seged:" + this.segId, this.logic.field()); this.added = true; }
      else scene.view?.redraw();
    } else if (this.added) {
      scene.view?.removeField("seged:" + this.segId!); this.added = false;
    }
  }

  private reset(scene: LiveScene) {
    if (this.segId) scene.view?.removeField("seged:" + this.segId);   // unconditional — the 3D field must go on close
    scene.view?.setSegmentationOverlay(null, 0, 0);
    this.logic?.destroy(); this.driver?.destroy(); this.overlayBaker?.destroy(); this.overlayTex?.destroy(); this.seg?.destroy();
    this.seg = undefined; this.driver = undefined; this.logic = undefined;
    this.overlayBaker = undefined; this.overlayTex = undefined; this.segId = undefined; this.added = false;
    this.building = false; this.labelForId.clear(); this.palKey = ""; this.dispKey = "";
  }
}
