// LiveScene — the SlicerLive client that mirrors a live Slicer scene the way Slicer's own
// displayable managers do. A view creates DisplayableManagers; each declares the mrson node
// `types` it cares about. LiveScene opens a WebSocket to the LiveStory mrson live server,
// subscribes with the union of those types, and routes the streamed mrson events to the
// interested managers. The initial burst is a snapshot (NodeAdded per node = a static
// declaration); afterwards it's an adaptive stream of change notifications.
//
// Same code runs in the browser and in Deno (both have global WebSocket + fetch).

import { ImageField } from "./fields.ts";
import { fetchZarrVolume, type ZarrDesc, type ZarrVolume } from "./zarr.ts";
import { lutFromTransferFunctions } from "./scene-volume.ts";
import type { MrsonNode } from "./mrson.ts";

export interface DisplayableManager {
  interestedTypes: string[];
  onNodeAdded?(node: MrsonNode, scene: LiveScene): void | Promise<void>;
  onNodeRemoved?(id: string, scene: LiveScene): void;
  onEvent?(ev: Record<string, unknown>, scene: LiveScene): void | Promise<void>;
}

export class LiveScene {
  nodes = new Map<string, MrsonNode>();
  ws?: WebSocket;
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
  constructor(private onCamera: (c: CameraState) => void) {}
  private apply(n: Record<string, unknown>) {
    this.last = {
      position: n.position as number[], focalPoint: n.focalPoint as number[],
      viewUp: n.viewUp as number[], viewAngle: n.viewAngle as number, parallelScale: n.parallelScale as number,
    };
    this.onCamera(this.last);
  }
  onNodeAdded(node: MrsonNode) { this.apply(node as unknown as Record<string, unknown>); }
  onEvent(ev: Record<string, unknown>) { if (ev.event === "CameraModified") this.apply(ev); }
}

// ── Volume rendering ─────────────────────────────────────────────────────────

export interface VolumeMeta {
  field: ImageField; dims: [number, number, number]; ijkToRAS: number[];
  range: [number, number]; center: [number, number, number]; radius: number; name: string;
}

/** Mirrors a volume-rendered image: builds the ImageField ONCE (fetching content-addressed
 *  zarr chunks over HTTP), then re-LUTs IN PLACE when the transfer function or window/level
 *  changes — no field/renderer recreation, so no texture churn or black flashes. `clim` is
 *  the fixed data range and the transfer function is sampled across it (matching Slicer's
 *  direct value->TF mapping). onVolume fires once; onLutChanged fires on each TF change. */
export class VolumeRenderingDisplayableManager implements DisplayableManager {
  interestedTypes = ["image", "volumeRenderingDisplay", "scalarVolumeDisplay", "transferFunction"];
  private image?: MrsonNode;
  private tf?: MrsonNode;
  private scalarDisp?: MrsonNode;
  private zv?: ZarrVolume;
  private field?: ImageField;
  private built = false;
  private blobBaseHref = "";

  constructor(
    private dev: GPUDevice,
    private onVolume: (m: VolumeMeta) => void,
    private onLutChanged?: () => void,
    private onBytes?: (n: number) => void,
  ) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    if (node.type === "image") { if (!this.image) this.image = node; }  // lock onto the first volume
    else if (node.type === "transferFunction") this.tf = node;
    else if (node.type === "scalarVolumeDisplay") this.scalarDisp = node;
    if (!this.built) await this.buildOnce();
    else if (node.type === "transferFunction" || node.type === "scalarVolumeDisplay") this.updateLUT();
  }
  onEvent() {/* TF/display changes arrive as NodeAdded upserts, handled above */}

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

  private async buildOnce(): Promise<void> {
    if (this.built || !this.image?.zarr) return;
    if (!this.zv) this.zv = await fetchZarrVolume(this.blobBaseHref, this.image.zarr as ZarrDesc, this.onBytes);
    const shade: [number, number, number, number] = this.tf?.shade ? [0.25, 0.75, 0.5, 24] : [0.25, 0.75, 0.5, 24];
    const ijkToRAS = this.image.ijkToRAS as number[];
    this.field = new ImageField(this.dev, this.zv.data, this.zv.dims, [1, 1, 1], this.buildLUT(this.zv.range), { clim: this.zv.range, ijkToRAS, shade });
    this.built = true;
    const [lo, hi] = this.field.aabb();
    const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    this.onVolume({ field: this.field, dims: this.zv.dims, ijkToRAS, range: this.zv.range, center, radius, name: this.image.name ?? "volume" });
  }

  private updateLUT(): void {
    if (!this.field || !this.zv) return;
    this.field.setLUT(this.buildLUT(this.zv.range));   // in place — no rebuild
    this.onLutChanged?.();
  }
}
