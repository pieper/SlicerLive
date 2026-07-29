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
import { lutFromTransferFunctions, lutFromWindowLevel } from "./scene-volume.ts";
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

/** Mirrors a volume-rendered image: builds an ImageField from the streamed image node
 *  (fetching content-addressed zarr chunks over HTTP) and re-LUTs live when the transfer
 *  function or window/level changes — no volume re-fetch. */
export class VolumeRenderingDisplayableManager implements DisplayableManager {
  interestedTypes = ["image", "volumeRenderingDisplay", "scalarVolumeDisplay", "transferFunction"];
  private image?: MrsonNode;
  private tf?: MrsonNode;
  private scalarDisp?: MrsonNode;
  private zv?: ZarrVolume;

  constructor(
    private dev: GPUDevice,
    private onVolume: (m: VolumeMeta) => void,
    private onBytes?: (n: number) => void,
  ) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    if (node.type === "image") { if (!this.image) this.image = node; }  // lock onto the first volume
    else if (node.type === "transferFunction") this.tf = node;
    else if (node.type === "scalarVolumeDisplay") this.scalarDisp = node;
    await this.rebuild();
  }
  onEvent() {/* TF/display changes arrive as NodeAdded upserts, handled above */}

  private buildLUT(range: [number, number]): { lut: Uint8Array; clim: [number, number]; shade: [number, number, number, number] } {
    const cs = this.tf?.colorStops as { value: number; rgba: number[] }[] | undefined;
    const os = this.tf?.scalarOpacity as { value: number; opacity: number }[] | undefined;
    if (cs?.length && os?.length) {
      const colorTF = cs.map((s) => [s.value, s.rgba[0], s.rgba[1], s.rgba[2]]);
      const opac = os.map((s) => [s.value, s.opacity]);
      const clim: [number, number] = [colorTF[0][0], colorTF[colorTF.length - 1][0]];
      return { lut: lutFromTransferFunctions(colorTF, opac, clim), clim, shade: this.tf?.shade ? [0.25, 0.75, 0.5, 24] : [1, 0, 0, 1] };
    }
    const win = (this.scalarDisp?.window as number) ?? (range[1] - range[0]);
    const lev = (this.scalarDisp?.level as number) ?? (range[0] + range[1]) / 2;
    return { lut: lutFromWindowLevel(), clim: [lev - win / 2, lev + win / 2], shade: [0.25, 0.75, 0.5, 24] };
  }

  private async rebuild(): Promise<void> {
    if (!this.image?.zarr) return;
    if (!this.zv) this.zv = await fetchZarrVolume(this.blobBaseHref, this.image.zarr as ZarrDesc, this.onBytes);
    const { lut, clim, shade } = this.buildLUT(this.zv.range);
    const ijkToRAS = this.image.ijkToRAS as number[];
    const field = new ImageField(this.dev, this.zv.data, this.zv.dims, [1, 1, 1], lut, { clim, ijkToRAS, shade });
    const [lo, hi] = field.aabb();
    const center: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    this.onVolume({ field, dims: this.zv.dims, ijkToRAS, range: this.zv.range, center, radius, name: this.image.name ?? "volume" });
  }

  // set by LiveScene right before the first onNodeAdded via a tiny shim
  blobBaseHref = "";
}
