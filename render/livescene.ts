// LiveScene — the SlicerLive client that mirrors a live Slicer scene the way Slicer's own
// displayable managers do. A view creates DisplayableManagers; each declares the mrson node
// `types` it cares about. LiveScene opens a WebSocket to the LiveStory mrson live server,
// subscribes with the union of those types, and routes the streamed mrson events to the
// interested managers. The initial burst is a snapshot (NodeAdded per node = a static
// declaration); afterwards it's an adaptive stream of change notifications.
//
// Same code runs in the browser and in Deno (both have global WebSocket + fetch).

import { type Field, ImageField } from "./fields.ts";
import { FiducialField, type Sphere } from "./fiducial-field.ts";
import { fetchZarrVolume, type ZarrDesc, type ZarrVolume } from "./zarr.ts";
import { lutFromTransferFunctions } from "./scene-volume.ts";
import type { MrsonNode } from "./mrson.ts";

export type Vec3 = [number, number, number];

/** The renderer surface a displayable manager drives — the SlicerLive analogue of the view
 *  a Slicer displayable manager renders into. Managers ADD/REMOVE fields (coarse -> rebuild)
 *  and REDRAW when a field changed in place (fine), per the event-granularity rule. */
export interface MirrorView {
  setField(key: string, field: Field): void;   // add or replace a field -> rebuild
  removeField(key: string): void;               // -> rebuild
  redraw(): void;                                // an existing field changed in place
  setCamera(c: CameraState): void;
  setClipBox(lo: Vec3 | null, hi?: Vec3): void;  // null clears the crop
}

export interface DisplayableManager {
  interestedTypes: string[];
  onNodeAdded?(node: MrsonNode, scene: LiveScene): void | Promise<void>;
  onNodeRemoved?(id: string, scene: LiveScene): void;
  onEvent?(ev: Record<string, unknown>, scene: LiveScene): void | Promise<void>;
  onSceneClosed?(scene: LiveScene): void;   // scene-level reset (Slicer EndCloseEvent)
}

export class LiveScene {
  nodes = new Map<string, MrsonNode>();
  ws?: WebSocket;
  view?: MirrorView;                                  // the renderer surface managers drive
  private queue: Promise<void> = Promise.resolve();   // serialize event handling in arrival order

  constructor(
    public wsUrl: string,     // ws://host:2132/
    public httpBase: string,  // http://host:2131/mrson/
    public managers: DisplayableManager[],
  ) {}

  blobBase(): string { return new URL("blobs/", this.httpBase).href; }
  find(type: string): MrsonNode | undefined {
    for (const n of this.nodes.values()) if (n.type === type) return n;
    return undefined;
  }

  private types(): string[] {
    return [...new Set(this.managers.flatMap((m) => m.interestedTypes))];
  }
  private interested(type: string | undefined): DisplayableManager[] {
    return type ? this.managers.filter((m) => m.interestedTypes.includes(type)) : [];
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => { ws.send(JSON.stringify({ op: "subscribe", types: this.types() })); resolve(); };
      ws.onerror = (e) => reject(e);
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data as string);
        this.queue = this.queue.then(() => this.handle(ev));   // process in order, never overlapping
      };
    });
  }
  close(): void { this.ws?.close(); }

  private async handle(ev: Record<string, unknown>): Promise<void> {
    const e = ev.event as string;
    if (e === "NodeAdded" && ev.node) {
      const node = ev.node as MrsonNode;
      this.nodes.set(node.id, node);                       // upsert
      for (const m of this.interested(node.type)) await m.onNodeAdded?.(node, this);
    } else if (e === "NodeRemoved") {
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      this.nodes.delete(id);
      for (const m of this.interested(node?.type)) m.onNodeRemoved?.(id, this);
    } else if (e === "SnapshotComplete") {
      /* managers already received their snapshot nodes */
    } else if (e === "SceneClosed") {
      this.nodes.clear();                                 // wholesale reset (Slicer closed the scene)
      for (const m of this.managers) m.onSceneClosed?.(this);
    } else {
      const t = this.nodes.get(ev.sourceId as string)?.type ?? (e === "CameraModified" ? "camera" : undefined);
      for (const m of this.interested(t)) await m.onEvent?.(ev, this);
    }
  }
}

// ── Camera ──────────────────────────────────────────────────────────────────

export interface CameraState {
  position: number[]; focalPoint: number[]; viewUp: number[];
  viewAngle?: number; parallelScale?: number;
}

/** Mirrors the active camera: applies snapshot + live CameraModified to the view. */
export class CameraDisplayableManager implements DisplayableManager {
  interestedTypes = ["camera"];
  last?: CameraState;
  private apply(n: Record<string, unknown>, scene: LiveScene) {
    this.last = {
      position: n.position as number[], focalPoint: n.focalPoint as number[],
      viewUp: n.viewUp as number[], viewAngle: n.viewAngle as number, parallelScale: n.parallelScale as number,
    };
    scene.view?.setCamera(this.last);
  }
  onNodeAdded(node: MrsonNode, scene: LiveScene) { this.apply(node as unknown as Record<string, unknown>, scene); }
  onEvent(ev: Record<string, unknown>, scene: LiveScene) { if (ev.event === "CameraModified") this.apply(ev, scene); }
}

/** Mirrors Markups point lists (fiducials/lines/curves) as rendered glyphs. Aggregates the
 *  control points of every markup node into one FiducialField; adds it once (coarse) and
 *  updates points in place (fine) on live moves. ROI markups are handled by RoiCropDM. */
export class MarkupsDisplayableManager implements DisplayableManager {
  interestedTypes = ["markup"];
  private points = new Map<string, Sphere[]>();  // markup id -> its glyphs
  private field?: FiducialField;

  private spheresFor(node: MrsonNode): Sphere[] {
    const col = (node.color as number[]) ?? [1, 0.85, 0.2, 1];
    const cps = (node.controlPoints as { position: number[] }[] | undefined) ?? [];
    return cps.map((cp) => ({ center: cp.position as Vec3, radius: 9, color: [col[0], col[1], col[2], 1] }));
  }
  private allSpheres(): Sphere[] {
    const out: Sphere[] = [];
    for (const s of this.points.values()) out.push(...s);
    return out;
  }

  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.markupType === "roi") return;                 // ROI crop is RoiCropDM's job
    const first = !this.field;
    this.points.set(node.id, this.spheresFor(node));
    if (!this.field) this.field = new FiducialField(this.allSpheres(), { screenSpace: true, ghost: true, shininess: 60 });
    else this.field.setSpheres(this.allSpheres());          // in place (fine)
    if (first) scene.view?.setField("markups", this.field); // add once (coarse -> rebuild)
    else scene.view?.redraw();
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    if (!this.points.delete(id) || !this.field) return;
    this.field.setSpheres(this.allSpheres());
    scene.view?.redraw();
  }
  onSceneClosed(scene: LiveScene) {
    this.points.clear();
    this.field = undefined;
    scene.view?.removeField("markups");
  }
}

/** Mirrors a Markups ROI volume crop the way Slicer does: crop is active only when the
 *  volume-rendering display has cropping ENABLED and references an ROI (not merely because an
 *  ROI node exists). Tracks the VR display's crop state and the ROI geometry independently and
 *  recomputes the clip box; toggling crop in Slicer clears/re-applies it. */
export class RoiCropDisplayableManager implements DisplayableManager {
  interestedTypes = ["volumeRenderingDisplay", "markup"];
  private crop: { enabled: boolean; roiId?: string } = { enabled: false };
  private rois = new Map<string, { center: Vec3; size: Vec3 }>();

  private recompute(scene: LiveScene) {
    const r = this.crop.enabled && this.crop.roiId ? this.rois.get(this.crop.roiId) : undefined;
    if (r) {
      const c = r.center, s = r.size;
      scene.view?.setClipBox(
        [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2],
        [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2],
      );
    } else {
      scene.view?.setClipBox(null);
    }
  }
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "volumeRenderingDisplay") {
      this.crop = { enabled: !!node.cropEnabled, roiId: (node.refs?.roi as string[] | undefined)?.[0] };
      this.recompute(scene);
    } else if (node.markupType === "roi" && node.center && node.size) {
      this.rois.set(node.id, { center: node.center as Vec3, size: node.size as Vec3 });
      this.recompute(scene);
    }
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    let changed = this.rois.delete(id);
    if (this.crop.roiId === id) { this.crop.roiId = undefined; changed = true; }
    if (changed) this.recompute(scene);
  }
  onSceneClosed(scene: LiveScene) {
    this.crop = { enabled: false };
    this.rois.clear();
    scene.view?.setClipBox(null);
  }
}

// ── Volume rendering ─────────────────────────────────────────────────────────

/** Mirrors a volume-rendered image: builds the ImageField ONCE (fetching content-addressed
 *  zarr chunks over HTTP) and adds it via view.setField (coarse), then re-LUTs IN PLACE on
 *  transfer-function / window-level changes and view.redraw()s (fine) — no field/renderer
 *  recreation, so no texture churn or flashing. `clim` is the fixed data range and the
 *  transfer function is sampled across it (matching Slicer's direct value->TF mapping). */
export class VolumeRenderingDisplayableManager implements DisplayableManager {
  interestedTypes = ["image", "volumeRenderingDisplay", "scalarVolumeDisplay", "transferFunction"];
  private image?: MrsonNode;
  private tf?: MrsonNode;
  private scalarDisp?: MrsonNode;
  private vrDisplayId?: string;
  private vrVisible = false;      // is a volume-rendering display ON in Slicer?
  private zv?: ZarrVolume;
  private field?: ImageField;
  private shown = false;          // is the field currently in the scene?
  private building = false;
  private blobBaseHref = "";
  private view?: MirrorView;

  constructor(private dev: GPUDevice, private onBytes?: (n: number) => void) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    this.view = scene.view;
    if (node.type === "image") { if (!this.image) this.image = node; }   // lock onto the first volume
    else if (node.type === "volumeRenderingDisplay") { this.vrDisplayId = node.id; this.vrVisible = !!node.visible; }
    else if (node.type === "transferFunction") { this.tf = node; if (this.shown) this.updateLUT(); }
    else if (node.type === "scalarVolumeDisplay") { this.scalarDisp = node; if (this.shown) this.updateLUT(); }
    await this.sync(scene);
  }
  onEvent() {/* changes arrive as NodeAdded upserts, handled above */}
  onNodeRemoved(id: string, scene: LiveScene) {
    if (id === this.image?.id) { this.reset(scene); return; }
    if (id === this.vrDisplayId) { this.vrVisible = false; this.vrDisplayId = undefined; void this.sync(scene); }
  }
  onSceneClosed(scene: LiveScene) { this.reset(scene); }
  private reset(scene: LiveScene) {
    this.image = this.tf = this.scalarDisp = undefined;
    this.zv = this.field = undefined;
    this.vrVisible = false;
    this.vrDisplayId = undefined;
    this.shown = false;
    scene.view?.removeField("volume");
  }

  /** Show the volume iff Slicer has a VISIBLE volume-rendering display for it — matching
   *  Slicer's own timing: loading a volume does NOT render it in 3D until VR is enabled. */
  private async sync(scene: LiveScene): Promise<void> {
    const want = !!(this.image?.zarr && this.vrVisible);
    if (want && !this.field && !this.building) await this.build(scene);
    else if (want && this.field && !this.shown) { scene.view?.setField("volume", this.field); this.shown = true; }
    else if (!want && this.shown) { scene.view?.removeField("volume"); this.shown = false; }
  }

  // 256-entry rgba8 LUT sampled across the DATA RANGE (clim is fixed to that range).
  private buildLUT(range: [number, number]): Uint8Array {
    const cs = this.tf?.colorStops as { value: number; rgba: number[] }[] | undefined;
    const os = this.tf?.scalarOpacity as { value: number; opacity: number }[] | undefined;
    if (cs?.length && os?.length) {
      const colorTF = cs.map((s) => [s.value, s.rgba[0], s.rgba[1], s.rgba[2]]);
      const opac = os.map((s) => [s.value, s.opacity]);
      return lutFromTransferFunctions(colorTF, opac, range);   // sample TF across the data range
    }
    // window/level grayscale, positioned within the data range
    const win = (this.scalarDisp?.window as number) ?? (range[1] - range[0]);
    const lev = (this.scalarDisp?.level as number) ?? (range[0] + range[1]) / 2;
    const lo = lev - win / 2, hi = lev + win / 2;
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = range[0] + (i / 255) * (range[1] - range[0]);
      const g = Math.max(0, Math.min(1, (v - lo) / Math.max(hi - lo, 1e-6)));
      lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = Math.round(g * 255);
      lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (g - 0.15) / 0.85)) * 200);
    }
    return lut;
  }

  private async build(scene: LiveScene): Promise<void> {
    if (!this.image?.zarr) return;
    this.building = true;
    if (!this.zv) this.zv = await fetchZarrVolume(this.blobBaseHref, this.image.zarr as ZarrDesc, this.onBytes);
    const shade: [number, number, number, number] = [0.25, 0.75, 0.5, 24];
    const ijkToRAS = this.image.ijkToRAS as number[];
    this.field = new ImageField(this.dev, this.zv.data, this.zv.dims, [1, 1, 1], this.buildLUT(this.zv.range), { clim: this.zv.range, ijkToRAS, shade });
    this.building = false;
    scene.view?.setField("volume", this.field);
    this.shown = true;
  }

  private updateLUT(): void {
    if (!this.field || !this.zv) return;
    this.field.setLUT(this.buildLUT(this.zv.range));   // in place — fine
    this.view?.redraw();
  }
}
