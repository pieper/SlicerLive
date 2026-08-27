// LiveScene — the SlicerLive client that mirrors a live Slicer scene the way Slicer's own
// displayable managers do. A view creates DisplayableManagers; each declares the mrson node
// `types` it cares about. LiveScene opens a WebSocket to the LiveStory mrson live server,
// subscribes with the union of those types, and routes the streamed mrson events to the
// interested managers. The initial burst is a snapshot (NodeAdded per node = a static
// declaration); afterwards it's an adaptive stream of change notifications.
//
// Same code runs in the browser and in Deno (both have global WebSocket + fetch).

import { type Field, ImageField, RGBAVolumeField } from "./fields.ts";
import { FiducialField, type Sphere } from "./fiducial-field.ts";
import { CapsuleField, type Segment as LineSegment } from "./capsule-field.ts";
import { ColorizeBaker } from "./bake.ts";
import { fetchZarrVolume, type ZarrDesc, type ZarrVolume } from "./zarr.ts";
import { lutFromTransferFunctions } from "./scene-volume.ts";
import type { MrsonNode } from "./mrson.ts";
import { applyOp, type ApplyResult, type Op } from "./liveops.ts";

export type Vec3 = [number, number, number];

/** The renderer surface a displayable manager drives — the SlicerLive analogue of the view
 *  a Slicer displayable manager renders into. Managers ADD/REMOVE fields (coarse -> rebuild)
 *  and REDRAW when a field changed in place (fine), per the event-granularity rule. */
export interface SlicePlane {
  orient: "axial" | "coronal" | "sagittal";   // nearest anatomical preset (display convention + fallback)
  posMm: number;                               // out-of-plane position: RAS coordinate along `orient`'s axis, or along basis.nDir
  /** Oblique / Reformat: the slice node's actual (u, v, n) RAS basis from sliceToRAS. Absent for the
   *  anatomical presets. When present, posMm is the signed distance along nDir. */
  basis?: { uDir: Vec3; vDir: Vec3; nDir: Vec3 };
  // Slicer's in-plane navigation, mirrored: the slice centre (RAS) + field of view (mm).
  // Present when the slice node carries them → the view matches Slicer's pan + zoom; absent →
  // the fitted (FitSliceToBackground) view.
  centerRAS?: number[];
  fovX?: number;
  fovY?: number;
}

/** A 2D overlay primitive in RAS — the DOM/canvas analogue of Slicer's slice-view displayable
 *  managers' actors (markup glyphs and lines, crosshair, slice intersections, annotations).
 *  Each slice cell projects these onto its plane (rasToView) and draws what lies within `slabMm`. */
export type OverlayItem =
  | { kind: "point"; ras: Vec3; color: number[]; radiusPx?: number; label?: string; projected?: boolean }
  | { kind: "polyline"; points: Vec3[]; color: number[]; widthPx?: number; closed?: boolean }
  | { kind: "text"; ras: Vec3; text: string; color: number[] };

export interface ScalarLayer { field: ImageField; win: number; lev: number; lut?: Uint8Array; interpolate?: boolean }
export interface SliceLayers {
  background?: ScalarLayer;
  foreground?: ScalarLayer & { opacity: number; compositing: number };
  label?: { field: ImageField; table: Uint8Array; opacity: number };
  linked?: boolean;
}

export interface MirrorView {
  /** Per-view 2D overlays (optional): `cell` = a slice cell name or "*" for every slice cell;
   *  `layer` namespaces one producer (e.g. "markups"); [] clears the layer. */
  setOverlay?(cell: string, layer: string, items: OverlayItem[]): void;
  /** Per-slice-view layer stack (optional): Slicer's slice composite — background / foreground / label
   *  volumes with their own geometry, W/L, colour LUTs, opacities and compositing. Absent layers = none. */
  setSliceLayers?(cell: string, layers: SliceLayers): void;
  setField(key: string, field: Field): void;   // add or replace a 3D field -> rebuild
  removeField(key: string): void;               // -> rebuild
  redraw(): void;                                // an existing field changed in place
  setCamera(c: CameraState): void;
  setClipBox(lo: Vec3 | null, hi?: Vec3): void;  // null clears the crop
  // volume resource shared by the slice views and the 3D view
  setVolumeField(field: ImageField | null, wl?: { win: number; lev: number }): void;
  showVolume3D(show: boolean): void;             // include the volume in the 3D view (VR gating)
  // slice/MPR views and layout
  setSlicePlane(cell: string, plane: SlicePlane): void;
  setLayout(name: string): void;
  // segmentation: a crisp labelmap overlay for the slice views (fill + boundary outline,
  // each with its own opacity — mirrors Slicer's 2D fill/outline display settings)
  setSegmentationOverlay(tex: GPUTexture | null, fillOpacity: number, outlineOpacity: number): void;
}

export interface DisplayableManager {
  interestedTypes: string[];
  /** Node types whose BULK-DATA UPDATES this manager reproduces LOCALLY (it holds the same deterministic
   *  op/filter), so the peer can skip re-streaming their bulk on change. The initial snapshot still
   *  carries the bulk. Optional; declared e.g. by the seged manager (it recomputes the labelmap from
   *  SegEdit intents). LiveSync sends the union on subscribe. */
  localBulkTypes?: string[];
  onNodeAdded?(node: MrsonNode, scene: LiveScene): void | Promise<void>;
  onNodeRemoved?(id: string, scene: LiveScene): void;
  onEvent?(ev: Record<string, unknown>, scene: LiveScene): void | Promise<void>;
  onSceneClosed?(scene: LiveScene): void;   // scene-level reset (Slicer EndCloseEvent)
}

/** One record on the LiveScene `_changes` feed. Inbound remote events and local writes both
 *  normalize into this, so DisplayableManagers, Controls, and LiveSync consume ONE stream — the
 *  CouchDB `_changes` shape (ARCHITECTURE-2026-08-02 §2). */
export interface Change {
  id: string;
  type?: string;
  kind: "upsert" | "remove" | "reset";
  origin: string;      // "local" (this place) or a peer's origin id
  v: number;           // monotonic sequence for this LiveScene
  node?: MrsonNode;    // present on upsert
  op?: Op;             // the originating op, present only for LOCAL writes → LiveSync replicates it out
}

export class LiveScene {
  nodes = new Map<string, MrsonNode>();
  view?: MirrorView;                                  // the renderer surface managers drive

  /** This place's origin id — stamps local writes and drives echo suppression. */
  origin = "local";
  private seq = 0;                                     // monotonic _changes sequence
  private changeSubs = new Set<(c: Change) => void>();

  // LiveScene is the pure data model — no wire. A LiveSync (render/livesync.ts) owns the transport,
  // reconnect, coalescing, and echo suppression; it drives this model via receiveEvent()/applyRemote()
  // and observes it via subscribe(). httpBase stays only so managers can resolve blob URLs (blobBase).
  constructor(
    public httpBase: string,  // http://host:2131/mrson/
    public managers: DisplayableManager[],
  ) {}

  blobBase(): string { return new URL("blobs/", this.httpBase).href; }
  find(type: string): MrsonNode | undefined {
    for (const n of this.nodes.values()) if (n.type === type) return n;
    return undefined;
  }

  /** The union of node types the DisplayableManagers care about; LiveSync subscribes the peer to
   *  these on (re)connect. Public because LiveSync — not the model — owns the wire. */
  subscribedTypes(): string[] {
    return [...new Set(this.managers.flatMap((m) => m.interestedTypes))];
  }
  /** Union of node types the managers reproduce locally — the peer skips re-streaming their bulk updates
   *  (ARCHITECTURE: consumer-declared local authority over deterministic bulk). LiveSync sends it on subscribe. */
  localBulk(): string[] {
    return [...new Set(this.managers.flatMap((m) => m.localBulkTypes ?? []))];
  }
  private interested(type: string | undefined): DisplayableManager[] {
    return type ? this.managers.filter((m) => m.interestedTypes.includes(type)) : [];
  }

  // ── local authority + the _changes feed (ARCHITECTURE-2026-08-02) ───────────

  /** Observe the `_changes` feed. Controls use it to reflect current node state; LiveSync uses it to
   *  replicate out. Returns an unsubscribe function. */
  subscribe(cb: (c: Change) => void): () => void {
    this.changeSubs.add(cb);
    return () => { this.changeSubs.delete(cb); };
  }

  private feed(c: Change): void {
    for (const cb of this.changeSubs) {
      try { cb(c); } catch { /* a subscriber must never break the feed */ }
    }
  }

  /** LOCAL authoritative write — how a Control or Interactor changes the scene. Applies the op to the
   *  model IMMEDIATELY (optimistic), notifies displayers, emits on the `_changes` feed, and — if the
   *  op is locally-originated — queues it for sync. Standalone and connected run the identical path;
   *  "connected" only adds a LiveSync peer downstream. Echo suppression is by construction: only
   *  local-origin ops are sent out, and an inbound remote op is applied via `applyRemote`, never here. */
  write(op: Op): void {
    const stamped = { ...op, origin: op.origin ?? this.origin, v: op.v ?? ++this.seq, role: op.role ?? "human" } as Op;
    const r = applyOp(this.nodes, stamped);
    if (r.changed) this.applied(r, stamped.origin as string, stamped.v as number, stamped);
    // No send here — LiveScene is the model. The op rides the _changes feed (Change.op); LiveSync, if
    // connected, coalesces + sends it. Standalone: applied locally, nothing to send. Identical path.
  }

  writeMany(ops: Op[]): void { for (const o of ops) this.write(o); }

  /** Apply an op that arrived from a peer (inbound remote). Same mutation + notify as a local write,
   *  but NOT re-sent (echo suppression). Not yet on the wire path (inbound is still event-shaped in
   *  `handle`); present so Controls/tests exercise the symmetric remote path. */
  applyRemote(op: Op): void {
    const r = applyOp(this.nodes, op);
    if (r.changed) this.applied(r, (op.origin as string) ?? "remote", (op.v as number) ?? ++this.seq);
  }

  /** Fan a completed op mutation out to displayers + the `_changes` feed. `op` is set only for LOCAL
   *  writes so LiveSync replicates them (echo suppression: remote/event changes carry no op). */
  private applied(r: ApplyResult, origin: string, v: number, op?: Op): void {
    if (r.kind === "del") {
      for (const m of this.managers) m.onNodeRemoved?.(r.id, this);   // type gone → offer to all (they no-op)
      this.feed({ id: r.id, kind: "remove", origin, v, op });
      return;
    }
    const node = this.nodes.get(r.id);
    if (!node) return;
    for (const m of this.interested(node.type)) m.onNodeAdded?.(node, this);   // re-deliver the updated node
    this.feed({ id: r.id, type: node.type, kind: "upsert", origin, v, node, op });
  }

  // ── replay (SceneRecorder) ──────────────────────────────────────────────────
  // When applyView is false the model + _changes feed still update on every inbound event (so a
  // SceneRecorder keeps a LOSSLESS record of the live session), but the DISPLAYABLE MANAGERS are NOT
  // driven — the view is under replay control via applySnapshot(). Resuming live re-attaches the view
  // to the current model. This is the DVR head advancing while you scrub the past.
  applyView = true;

  /** Enter/leave replay mode. Leaving does NOT itself repaint — the caller reconciles the view to the
   *  desired node map (present or a seeked past) with applySnapshot(). */
  setLive(on: boolean): void { this.applyView = on; }

  /** Drive the displayable managers so the VIEW reflects `target` (a full node map — the live model, or
   *  a SceneRecorder.seek(t) reconstruction), reconciling from `from` (what the view currently shows).
   *  Emits nothing on the _changes feed and does NOT mutate this.nodes — replay must not pollute the
   *  recording nor the authoritative model. Removes gone nodes, (re)adds new/changed ones (JSON-diff);
   *  heavy GPU resources keyed by id are reused by the managers, so scrubbing is cheap after the first
   *  fetch. */
  async applySnapshot(
    target: Map<string, MrsonNode>,
    from: Map<string, MrsonNode>,
    opts?: { force?: (n: MrsonNode) => boolean },
  ): Promise<void> {
    for (const [id, node] of from) {
      if (!target.has(id)) for (const m of this.interested(node.type)) m.onNodeRemoved?.(id, this);
    }
    for (const [id, node] of target) {
      const prev = from.get(id);
      // `force` re-delivers a node even when its value is unchanged — used to SNAP the view (camera,
      // slice offsets) back to the recorded state after the user branched off with local interaction
      // (which mutates the view but not the model node, so a plain diff would skip it).
      if (!prev || JSON.stringify(prev) !== JSON.stringify(node) || opts?.force?.(node)) {
        for (const m of this.interested(node.type)) await m.onNodeAdded?.(node, this);
      }
    }
  }

  /** Apply one inbound event from a peer (via LiveSync). Slicer sends event-shaped changes (NodeAdded
   *  upsert / NodeRemoved / CameraModified / SceneClosed); each mutates the model, notifies displayers
   *  (unless replay froze the view), and emits on the `_changes` feed with a remote origin so Controls
   *  and the SceneRecorder reflect it. */
  /** A node this place created with a provisional id (put) now has the peer's real id: move it. */
  aliasNode(clientId: string, realId: string): void {
    if (clientId === realId) return;
    const node = this.nodes.get(clientId);
    if (!node) return;
    this.nodes.delete(clientId);
    node.id = realId;
    this.nodes.set(realId, node);
    if (this.applyView) for (const m of this.interested(node.type)) { m.onNodeRemoved?.(clientId, this); m.onNodeAdded?.(node, this); }
    this.feed({ id: clientId, type: node.type, kind: "remove", origin: "remote", v: ++this.seq });
    this.feed({ id: realId, type: node.type, kind: "upsert", origin: "remote", v: ++this.seq, node });
  }

  async receiveEvent(ev: Record<string, unknown>): Promise<void> {
    const e = ev.event as string;
    const live = this.applyView;   // drive managers only when the view is attached to the live model
    if (e === "NodeAdded" && ev.node) {
      const node = ev.node as MrsonNode;
      if (typeof ev.clientId === "string") this.aliasNode(ev.clientId, node.id);   // our own put, now with its real id
      this.nodes.set(node.id, node);                       // upsert
      if (live) for (const m of this.interested(node.type)) await m.onNodeAdded?.(node, this);
      this.feed({ id: node.id, type: node.type, kind: "upsert", origin: "remote", v: ++this.seq, node });
    } else if (e === "NodeRemoved") {
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      this.nodes.delete(id);
      if (live) for (const m of this.interested(node?.type)) m.onNodeRemoved?.(id, this);
      this.feed({ id, type: node?.type, kind: "remove", origin: "remote", v: ++this.seq });
    } else if (e === "SnapshotComplete") {
      /* managers already received their snapshot nodes */
    } else if (e === "SceneClosed") {
      this.nodes.clear();                                 // wholesale reset (Slicer closed the scene)
      if (live) for (const m of this.managers) m.onSceneClosed?.(this);
      this.feed({ id: "", kind: "reset", origin: "remote", v: ++this.seq });
    } else if (e === "SegmentationDisplayModified") {
      // A display-only change from Slicer (visibility / opacity / colour). Keep the MODEL authoritative:
      // merge the display fields into the segmentation node, let the seg manager update the render, then
      // emit on the _changes feed so Controls (the popup switch) reflect it — inbound events must not
      // bypass the model (ARCHITECTURE-2026-08-02 §1).
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      const disp = ev.display as Record<string, unknown> | undefined;
      if (node && disp) {
        for (const k of ["visible", "opacity", "fill2D", "outline2D", "segments"]) {
          if (k in disp) (node as unknown as Record<string, unknown>)[k] = disp[k];
        }
      }
      if (live) for (const m of this.interested("segmentation")) await m.onEvent?.(ev, this);
      if (node) this.feed({ id, type: "segmentation", kind: "upsert", origin: "remote", v: ++this.seq, node });
    } else if (e === "CameraModified") {
      // Live camera pose from Slicer. Keep the MODEL authoritative — merge the pose fields into the
      // camera node (like SegmentationDisplayModified) so Controls/recorders read current state from
      // nodes, not just the CameraDisplayableManager's private copy (ARCHITECTURE-2026-08-02 §1).
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      if (node) {
        for (const k of ["position", "focalPoint", "viewUp", "viewAngle", "parallelScale"]) {
          if (k in ev) (node as unknown as Record<string, unknown>)[k] = ev[k];
        }
      }
      if (live) for (const m of this.interested("camera")) await m.onEvent?.(ev, this);
      if (node) this.feed({ id, type: "camera", kind: "upsert", origin: "remote", v: ++this.seq, node });
    } else {
      const t = this.nodes.get(ev.sourceId as string)?.type;
      if (live) for (const m of this.interested(t)) await m.onEvent?.(ev, this);
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
/** A draggable control-point handle: which markup + control-point index, and its current RAS. */
export interface MarkupHandle { id: string; index: number; ras: Vec3 }

export class MarkupsDisplayableManager implements DisplayableManager {
  interestedTypes = ["markup"];
  private nodes = new Map<string, MrsonNode>();  // markup id -> its full node (points + geometry)
  private field?: FiducialField;                 // control-point glyphs (all markup types)
  private lines?: CapsuleField;                  // connectors: line/angle/curve/plane geometry

  private spheresFor(node: MrsonNode): Sphere[] {
    const col = (node.color as number[]) ?? [1, 0.85, 0.2, 1];
    const cps = (node.controlPoints as { position: number[] }[] | undefined) ?? [];
    return cps.map((cp) => ({ center: cp.position as Vec3, radius: 9, color: [col[0], col[1], col[2], 1] }));
  }
  /** Per-type connector geometry: line/angle connect consecutive control points; curve/closedCurve
   *  use Slicer's interpolated world polyline (closedCurve wraps); plane uses its 4 world corners. */
  private segmentsFor(node: MrsonNode): LineSegment[] {
    const t = node.markupType as string;
    const col = (node.color as number[]) ?? [1, 0.85, 0.2, 1];
    const c: [number, number, number, number] = [col[0], col[1], col[2], 1];
    const cps = ((node.controlPoints as { position: number[] }[] | undefined) ?? []).map((p) => p.position as Vec3);
    let pts: Vec3[] = [];
    let closed = false;
    if (t === "line" || t === "angle") pts = cps;
    else if (t === "curve") pts = (node.linePoints as Vec3[] | undefined) ?? cps;
    else if (t === "closedCurve") { pts = (node.linePoints as Vec3[] | undefined) ?? cps; closed = true; }
    else if (t === "plane") { pts = (node.corners as Vec3[] | undefined) ?? []; closed = true; }
    else return [];   // fiducial (points only), roi (RoiCropDM)
    const segs: LineSegment[] = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i], b: pts[i + 1], radius: 3, color: c });
    if (closed && pts.length > 2) segs.push({ a: pts[pts.length - 1], b: pts[0], radius: 3, color: c });
    return segs;
  }
  private allSpheres(): Sphere[] {
    const out: Sphere[] = [];
    for (const n of this.nodes.values()) out.push(...this.spheresFor(n));
    return out;
  }
  private allSegments(): LineSegment[] {
    const out: LineSegment[] = [];
    for (const n of this.nodes.values()) out.push(...this.segmentsFor(n));
    return out;
  }
  /** 2D overlay items for the slice views: every control point (drawn in-plane or as a projection)
   *  and the connector polylines. Mirrors vtkMRMLMarkupsDisplayableManager's slice-view actors. */
  private overlayItems(): OverlayItem[] {
    const out: OverlayItem[] = [];
    for (const n of this.nodes.values()) {
      const col = (n.color as number[]) ?? [1, 0.85, 0.2, 1];
      const cps = (n.controlPoints as { position: number[]; label?: string }[] | undefined) ?? [];
      for (const cp of cps) out.push({ kind: "point", ras: cp.position as Vec3, color: col, radiusPx: 5, label: cp.label });
      const segs = this.segmentsFor(n);
      if (segs.length) {
        const pts: Vec3[] = [segs[0].a, ...segs.map((sg) => sg.b)];
        out.push({ kind: "polyline", points: pts, color: col, widthPx: 2 });
      }
    }
    return out;
  }
  private refresh(scene: LiveScene, first = false) {
    scene.view?.setOverlay?.("*", "markups", this.overlayItems());
    if (!this.field) this.field = new FiducialField(this.allSpheres(), { screenSpace: true, ghost: true, shininess: 60 });
    else this.field.setSpheres(this.allSpheres());          // in place
    if (!this.lines) this.lines = new CapsuleField(this.allSegments(), { screenSpace: true, ghost: true });
    else this.lines.setSegments(this.allSegments());
    if (first) {
      scene.view?.setField("markups", this.field);           // coarse add once
      scene.view?.setField("markupLines", this.lines);
    } else scene.view?.redraw();
  }

  /** Every draggable control point, in the same order allSpheres() lays them out. */
  handles(): MarkupHandle[] {
    const out: MarkupHandle[] = [];
    for (const n of this.nodes.values()) {
      const cps = (n.controlPoints as { position: number[] }[] | undefined) ?? [];
      cps.forEach((cp, index) => out.push({ id: n.id, index, ras: cp.position as Vec3 }));
    }
    return out;
  }

  /** Optimistic local move of one control point (SlicerLive drag), before Slicer echoes it back.
   *  Keeps the glyph under the cursor with zero round-trip latency. */
  moveLocal(id: string, index: number, ras: Vec3, scene: LiveScene) {
    const n = this.nodes.get(id);
    const cps = n?.controlPoints as { position: number[] }[] | undefined;
    if (!cps || !cps[index]) return;
    cps[index].position = [...ras];
    this.refresh(scene);
  }

  // ORIGIN / echo suppression: while the user drags a control point locally, that point is the
  // authoritative source — suppress the (stale) echo of our OWN move so it can't rubber-band the
  // glyph. AUTO-EXPIRING (a deadline, not a sticky flag): `touch()` on every drag frame extends the
  // window; it lapses ~holdMs after the last move, so a drag that never cleanly releases (pointer
  // left the canvas, JS error) can NEVER permanently freeze a markup's sync. The final flushed op's
  // echo (arriving well within holdMs) then re-syncs to the same value → no jump.
  private heldUntil = new Map<string, number>();   // "id:index" -> perf.now() deadline
  touch(id: string, index: number, holdMs = 250) { this.heldUntil.set(id + ":" + index, performance.now() + holdMs); }
  private isHeld(id: string): boolean {
    const now = performance.now();
    let held = false;
    for (const [k, t] of this.heldUntil) {
      if (t <= now) { this.heldUntil.delete(k); continue; }
      if (k.startsWith(id + ":")) held = true;
    }
    return held;
  }

  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.markupType === "roi") return;                 // ROI crop is RoiCropDM's job
    if (node.visible === false) { this.onNodeRemoved(node.id, scene); return; }
    if (this.isHeld(node.id)) return;                      // keep the local optimistic drag state
    const first = !this.field;
    this.nodes.set(node.id, node);
    this.refresh(scene, first);
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    if (!this.nodes.delete(id) || !this.field) return;
    this.field.setSpheres(this.allSpheres());
    this.lines?.setSegments(this.allSegments());
    scene.view?.setOverlay?.("*", "markups", this.overlayItems());
    scene.view?.redraw();
  }
  onSceneClosed(scene: LiveScene) {
    this.nodes.clear();
    this.field = undefined;
    this.lines = undefined;
    scene.view?.setOverlay?.("*", "markups", []);
    scene.view?.removeField("markupLines");
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

/** Mirrors the slice (MPR) views: each SliceNode becomes a reslice plane in the cell that carries its
 *  layoutName (Red/Green/Yellow, Compare's Slice4.., Red+ ...): the cell set is whatever the app's layout
 *  engine reports, not a fixed trio. Anatomical orientations use SlicerLive's radiological presets; any
 *  other sliceToRAS (Reformat, oblique) is passed through as a basis so the view reslices along it.
 *  Slice scrolls arrive as NodeAdded upserts and just re-set the plane. */
export class SliceDisplayableManager implements DisplayableManager {
  interestedTypes = ["view"];
  private static ORIENT: Record<string, "axial" | "coronal" | "sagittal"> = { Axial: "axial", Coronal: "coronal", Sagittal: "sagittal" };
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type !== "view" || node.kind !== "slice") return;
    const cell = node.layoutName as string | undefined;
    const m = node.sliceToRAS as number[] | undefined;    // row-major 4x4: columns = u, v, n; last column = centre
    if (!cell || !m || m.length < 16) return;
    const col = (c: number): Vec3 => [m[c], m[4 + c], m[8 + c]];
    const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const nDir = norm(col(2)), uDir = norm(col(0)), vDir = norm(col(1));
    const trans: Vec3 = [m[3], m[7], m[11]];
    // nearest anatomical axis of the normal → display preset; exact match → anatomical plane
    const ax = [Math.abs(nDir[0]), Math.abs(nDir[1]), Math.abs(nDir[2])];
    const axis = ax[2] >= ax[0] && ax[2] >= ax[1] ? 2 : ax[1] >= ax[0] ? 1 : 0;
    const orient = SliceDisplayableManager.ORIENT[node.orientation as string] ?? (["sagittal", "coronal", "axial"] as const)[axis];
    const anatomical = ax[axis] > 0.9999 && SliceDisplayableManager.ORIENT[node.orientation as string] !== undefined;
    const plane: SlicePlane = anatomical
      ? { orient, posMm: trans[axis] }
      : { orient, posMm: trans[0] * nDir[0] + trans[1] * nDir[1] + trans[2] * nDir[2], basis: { uDir, vDir, nDir } };
    const fov = node.fieldOfView as number[] | undefined;   // [fovX, fovY, slabThickness] mm — Slicer's zoom
    if (fov && fov.length >= 2 && fov[0] > 0 && fov[1] > 0) { plane.centerRAS = trans; plane.fovX = fov[0]; plane.fovY = fov[1]; }
    scene.view?.setSlicePlane(cell, plane);
  }
}

/** Mirrors the app-level interaction state nodes that gate what a click in a view means:
 *  interaction (viewTransform / place / adjustWindowLevel), selection (what to place, active volumes)
 *  and the crosshair (mode, thickness, cursor + crosshair RAS). Exposes them to the view host via
 *  MirrorView.setViewState (optional) and keeps the latest copies for interaction code to read. */
export interface ViewState { interaction?: MrsonNode; selection?: MrsonNode; crosshair?: MrsonNode }
export class ViewStateDisplayableManager implements DisplayableManager {
  interestedTypes = ["interaction", "selection", "crosshair"];
  state: ViewState = {};
  private push(scene: LiveScene) { (scene.view as MirrorView & { setViewState?: (s: ViewState) => void })?.setViewState?.(this.state); }
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "interaction") this.state.interaction = node;
    else if (node.type === "selection") this.state.selection = node;
    else if (node.type === "crosshair") this.state.crosshair = node;
    this.push(scene);
  }
  onSceneClosed(scene: LiveScene) { this.state = {}; this.push(scene); }
}

/** Mirrors the application layout (which views are shown, and how). */
export class LayoutDisplayableManager implements DisplayableManager {
  interestedTypes = ["layout"];
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "layout") scene.view?.setLayout((node.arrangementName as string) ?? "fourUp");
  }
}

/** Mirrors a volume-based segmentation (labelmap; no surface). Fetches the content-addressed
 *  labelmap, colorizes it with the per-segment palette, sets it as the slice overlay, and adds
 *  a colorized RGBAVolumeField to the 3D view. `sigma` controls the bake smoothing — 0 gives a
 *  crisp (nearest-like) labelmap, matching Slicer's slice display. */
/** Effective [fill, outline] slice opacities from a segmentation node's 2D display settings,
 *  gated by overall visibility — mirrors Slicer's Opacity * {Opacity2DFill, Opacity2DOutline}
 *  with the Visibility2D{Fill,Outline} toggles. Defaults match Slicer (fill 0.5, outline 1.0). */
function slice2DOpacities(node: MrsonNode, visible: boolean): [number, number] {
  if (!visible) return [0, 0];
  const overall = typeof node.opacity === "number" ? node.opacity : 1;
  const f = node.fill2D as { visible?: boolean; opacity?: number } | undefined;
  const o = node.outline2D as { visible?: boolean; opacity?: number } | undefined;
  const fill = (f?.visible ?? true) ? overall * (f?.opacity ?? 0.5) : 0;
  const outline = (o?.visible ?? true) ? overall * (o?.opacity ?? 1) : 0;
  return [fill, outline];
}

type Segment = { labelValue: number; color: number[]; visible?: boolean };

/** 256-entry RGBA palette from the per-segment colours; a hidden segment (visible === false)
 *  gets alpha 0 so it drops out of both the fill and the 3D field. */
function segPalette(segments: Segment[]): Float32Array {
  const p = new Float32Array(256 * 4);
  for (const s of segments ?? []) {
    const lv = s.labelValue;
    if (lv > 0 && lv < 256 && s.visible !== false) { p[lv * 4] = s.color[0]; p[lv * 4 + 1] = s.color[1]; p[lv * 4 + 2] = s.color[2]; p[lv * 4 + 3] = 1; }
  }
  return p;
}
/** Stable key over the colours + per-segment visibility — changes only when a re-bake is needed. */
function paletteKey(segments: Segment[]): string {
  return (segments ?? []).map((s) => `${s.labelValue}:${s.color.map((x) => x.toFixed(3)).join(",")}:${s.visible !== false}`).join("|");
}

export class SegmentationDisplayableManager implements DisplayableManager {
  interestedTypes = ["segmentation"];
  private baker?: ColorizeBaker;     // resident: labelmap uploaded once, re-colorized in place
  private overlayTex?: GPUTexture;   // crisp (σ=0) — 2D slice overlay (reused every re-bake)
  private volTex?: GPUTexture;       // smoothed (σ) — 3D colorized field (reused every re-bake)
  private field?: RGBAVolumeField;
  private segId?: string;
  private blobBaseHref = "";
  private dims?: Vec3;
  private ijkToRAS?: number[];
  private palKey = "";
  private added = false;             // is the 3D field currently in the view?

  constructor(private dev: GPUDevice, private sigma = 1.5, private onBytes?: (n: number) => void) {}

  private zarrSig = "";   // signature of the current labelmap; changes when the segmentation is EDITED

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    if (node.type !== "segmentation" || !node.zarr) return;
    const sig = JSON.stringify(node.zarr);
    if (this.baker && sig === this.zarrSig) { this.apply(node, scene); return; }   // display-only change → keep the bake
    this.blobBaseHref = scene.blobBase();
    const zv = await fetchZarrVolume(this.blobBaseHref, node.zarr as ZarrDesc, this.onBytes);
    const lab = Uint8Array.from(zv.data);   // labels back to u8
    const segments = (node.segments as Segment[]) ?? [];
    const sameDims = !!(this.baker && this.dims && zv.dims[0] === this.dims[0] && zv.dims[1] === this.dims[1] && zv.dims[2] === this.dims[2]);
    if (this.baker && sameDims) {
      // EDITED labelmap (live paint / scrub): re-upload + re-bake into the SAME textures the field
      // already renders — an in-place REPLACE. No removeField/setField, so no dark flash between applies.
      this.zarrSig = sig;
      this.baker.updateLabelmap(lab);
      this.palKey = paletteKey(segments);
      this.recolorize(segPalette(segments));
      this.apply(node, scene);
      return;
    }
    if (this.baker) this.reset(scene);   // first segmentation, or its geometry changed → (re)build
    this.zarrSig = sig;
    this.segId = node.id;
    this.dims = zv.dims;
    this.ijkToRAS = node.ijkToRAS as number[];
    this.baker = new ColorizeBaker(this.dev, lab, zv.dims);
    this.overlayTex = this.baker.output();
    this.volTex = this.baker.output();
    this.palKey = paletteKey(segments);
    this.recolorize(segPalette(segments));
    this.field = new RGBAVolumeField(this.volTex, zv.dims, [1, 1, 1], { ijkToRAS: this.ijkToRAS, shade: [0.3, 0.78, 0.5, 28], clippable: false });
    this.apply(node, scene);
  }

  /** Live display change (opacity/visibility/colour). Re-colorize IN PLACE only when the palette
   *  (colour or per-segment visibility) changed — the bulk labelmap is never re-fetched or
   *  re-uploaded, and the output textures are reused, so the 3D field + slice bind stay valid
   *  (a redraw suffices). Opacity-only changes skip the bake entirely. */
  onEvent(ev: Record<string, unknown>, scene: LiveScene) {
    if (ev.event !== "SegmentationDisplayModified" || ev.sourceId !== this.segId || !this.baker) return;
    const d = ev.display as MrsonNode & { segments?: Segment[] };
    const key = paletteKey(d.segments ?? []);
    if (key !== this.palKey) { this.palKey = key; this.recolorize(segPalette(d.segments ?? [])); }
    this.apply(d, scene);
  }

  /** Push current visibility/opacity to the view. The output textures are stable objects, so an
   *  in-place re-colorize needs only a redraw (no setField / scene rebuild); visibility flips add
   *  or remove the 3D field. */
  private apply(disp: MrsonNode, scene: LiveScene) {
    const visible = disp.visible !== false;
    const [fill, outline] = slice2DOpacities(disp, visible);
    scene.view?.setSegmentationOverlay(visible ? this.overlayTex! : null, fill, outline);
    if (visible) {
      if (!this.added) { scene.view?.setField("seg:" + this.segId, this.field!); this.added = true; }
      else scene.view?.redraw();   // texture content changed in place — just re-render
    } else if (this.added) {
      scene.view?.removeField("seg:" + this.segId!); this.added = false;
    }
  }

  /** Re-colorize the crisp slice overlay (σ=0) + smoothed 3D field (σ) into the resident output
   *  textures from a palette — reuses the baker's uploaded labelmap, pipelines, and scratch. */
  private recolorize(palette: Float32Array) {
    this.baker!.bakeInto(this.overlayTex!, palette, 0);
    this.baker!.bakeInto(this.volTex!, palette, this.sigma);
  }

  onNodeRemoved(id: string, scene: LiveScene) { if (id === this.segId) this.reset(scene); }
  onSceneClosed(scene: LiveScene) { this.reset(scene); }
  private reset(scene: LiveScene) {
    if (this.added && this.segId) scene.view?.removeField("seg:" + this.segId);
    scene.view?.setSegmentationOverlay(null, 0, 0);
    this.baker?.destroy();
    this.overlayTex?.destroy();
    this.volTex?.destroy();
    this.baker = undefined;
    this.overlayTex = undefined;
    this.volTex = undefined;
    this.field = undefined;
    this.segId = undefined;
    this.added = false;
    this.palKey = "";
    this.zarrSig = "";
  }
}

// ── Slice composite layers ───────────────────────────────────────────────────

/** Mirrors vtkMRMLSliceCompositeNode per slice view: resolves the background / foreground / label
 *  volume refs to keyed ImageFields (fetched by content hash on demand), their display nodes (W/L,
 *  colour table) and colour tables, and hands each cell its layer stack. Multiple volumes, different
 *  volumes per view, label maps — the things the singleton VolumeRenderingDM could not express. */
export class VolumeLayersDisplayableManager implements DisplayableManager {
  interestedTypes = ["image", "scalarVolumeDisplay", "labelMapDisplay", "colorTable", "sliceComposite"];
  private images = new Map<string, { node: MrsonNode; field?: ImageField; zv?: ZarrVolume; loading?: boolean }>();
  private displays = new Map<string, MrsonNode>();
  private tables = new Map<string, MrsonNode>();
  private composites = new Map<string, MrsonNode>();   // layoutName -> node
  private blobBaseHref = "";

  constructor(private dev: GPUDevice, private onBytes?: (n: number) => void) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    if (node.type === "image") { const e = this.images.get(node.id); if (e) e.node = node; else this.images.set(node.id, { node }); }
    else if (node.type === "scalarVolumeDisplay" || node.type === "labelMapDisplay") this.displays.set(node.id, node);
    else if (node.type === "colorTable") this.tables.set(node.id, node);
    else if (node.type === "sliceComposite") this.composites.set(node.layoutName as string, node);
    await this.refresh(scene);
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    this.images.delete(id); this.displays.delete(id); this.tables.delete(id);
    for (const [k, c] of this.composites) if (c.id === id) this.composites.delete(k);
    void this.refresh(scene);
  }
  onSceneClosed(scene: LiveScene) {
    this.images.clear(); this.displays.clear(); this.tables.clear();
    for (const k of this.composites.keys()) scene.view?.setSliceLayers?.(k, {});
    this.composites.clear();
  }

  private displayFor(image: MrsonNode): MrsonNode | undefined {
    const ids = ((image.refs as Record<string, string[]> | undefined)?.display) ?? [];
    for (const id of ids) { const d = this.displays.get(id); if (d) return d; }
    return undefined;
  }
  private lutFor(display: MrsonNode | undefined): Uint8Array | undefined {
    const cid = ((display?.refs as Record<string, string[]> | undefined)?.color ?? [])[0];
    const t = cid ? this.tables.get(cid) : undefined;
    const entries = t?.entries as number[][] | undefined;
    if (!entries || entries.length !== 256) return undefined;          // a 256-entry table maps the W/L ramp
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { lut[i * 4] = entries[i][0] * 255; lut[i * 4 + 1] = entries[i][1] * 255; lut[i * 4 + 2] = entries[i][2] * 255; lut[i * 4 + 3] = 255; }
    // Grey is the identity ramp: skip the LUT so the plain grayscale path (and interpolation) is used
    if (entries.every((e, i) => Math.abs(e[0] * 255 - i) < 1 && Math.abs(e[1] * 255 - i) < 1 && Math.abs(e[2] * 255 - i) < 1)) return undefined;
    return lut;
  }
  private labelTableFor(display: MrsonNode | undefined): Uint8Array | undefined {
    const cid = ((display?.refs as Record<string, string[]> | undefined)?.color ?? [])[0];
    const t = cid ? this.tables.get(cid) : undefined;
    const entries = t?.entries as number[][] | undefined;
    if (!entries?.length) return undefined;
    const table = new Uint8Array(entries.length * 4);
    entries.forEach((e, i) => { table[i * 4] = e[0] * 255; table[i * 4 + 1] = e[1] * 255; table[i * 4 + 2] = e[2] * 255; table[i * 4 + 3] = (e[3] ?? 1) * 255; });
    return table;
  }
  private async ensureField(id: string, scene: LiveScene): Promise<ImageField | undefined> {
    const e = this.images.get(id);
    if (!e || !e.node.zarr) return undefined;
    if (e.field) return e.field;
    if (e.loading) return undefined;
    e.loading = true;
    try {
      e.zv = await fetchZarrVolume(this.blobBaseHref, e.node.zarr as ZarrDesc, this.onBytes);
      const lut = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = i; lut[i * 4 + 3] = 255; }
      e.field = new ImageField(this.dev, e.zv.data, e.zv.dims, [1, 1, 1], lut, { clim: e.zv.range, ijkToRAS: e.node.ijkToRAS as number[] });
    } finally { e.loading = false; }
    void this.refresh(scene);      // a layer became available: re-hand the stacks
    return e.field;
  }
  private scalarLayer(id: string | undefined, scene: LiveScene): ScalarLayer | undefined {
    if (!id) return undefined;
    const e = this.images.get(id);
    if (!e) return undefined;
    if (!e.field) { void this.ensureField(id, scene); return undefined; }
    const d = this.displayFor(e.node);
    const range = e.zv?.range ?? [0, 1];
    const win = (d?.window as number) ?? (range[1] - range[0]);
    const lev = (d?.level as number) ?? (range[0] + range[1]) / 2;
    return { field: e.field, win, lev, lut: this.lutFor(d), interpolate: (d?.interpolate as boolean) ?? true };
  }
  private async refresh(scene: LiveScene): Promise<void> {
    const view = scene.view;
    if (!view?.setSliceLayers) return;
    for (const [layoutName, comp] of this.composites) {
      const refs = (comp.refs as Record<string, string[]> | undefined) ?? {};
      const layers: SliceLayers = { linked: !!comp.linkedControl };
      const bg = this.scalarLayer(refs.background?.[0], scene); if (bg) layers.background = bg;
      const fg = this.scalarLayer(refs.foreground?.[0], scene);
      if (fg) layers.foreground = { ...fg, opacity: (comp.foregroundOpacity as number) ?? 0, compositing: (comp.compositing as number) ?? 0 };
      const lid = refs.label?.[0];
      if (lid) {
        const e = this.images.get(lid);
        if (e && !e.field) void this.ensureField(lid, scene);
        const table = this.labelTableFor(e ? this.displayFor(e.node) : undefined);
        if (e?.field && table) layers.label = { field: e.field, table, opacity: (comp.labelOpacity as number) ?? 1 };
      }
      view.setSliceLayers(layoutName, layers);
    }
  }
}

// ── Volume rendering ─────────────────────────────────────────────────────────

/** Mirrors a volume: builds the ImageField when the volume LOADS (so the slice views can
 *  reslice it immediately, matching Slicer showing slices on load) via view.setVolumeField,
 *  and includes it in the 3D view only when a volume-rendering display is VISIBLE
 *  (view.showVolume3D). TF changes re-LUT in place; window/level updates the slice display. */
export class VolumeRenderingDisplayableManager implements DisplayableManager {
  interestedTypes = ["image", "volumeRenderingDisplay", "scalarVolumeDisplay", "transferFunction"];
  private image?: MrsonNode;
  private tf?: MrsonNode;
  private scalarDisp?: MrsonNode;
  private vrDisplayId?: string;
  private vrVisible = false;
  private zv?: ZarrVolume;
  private field?: ImageField;
  private building = false;
  private blobBaseHref = "";
  private view?: MirrorView;

  constructor(private dev: GPUDevice, private onBytes?: (n: number) => void) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    this.view = scene.view;
    if (node.type === "image") { if (!this.image) this.image = node; }
    else if (node.type === "volumeRenderingDisplay") { this.vrDisplayId = node.id; this.vrVisible = !!node.visible; }
    else if (node.type === "transferFunction") { this.tf = node; this.reLUT(); }
    else if (node.type === "scalarVolumeDisplay") { this.scalarDisp = node; this.pushVolume(); }
    await this.ensureField();
    this.view?.showVolume3D(!!(this.field && this.vrVisible));
  }
  onEvent() {/* changes arrive as NodeAdded upserts, handled above */}
  onNodeRemoved(id: string, scene: LiveScene) {
    if (id === this.image?.id) { this.reset(scene); return; }
    if (id === this.vrDisplayId) { this.vrVisible = false; this.vrDisplayId = undefined; scene.view?.showVolume3D(false); }
  }
  onSceneClosed(scene: LiveScene) { this.reset(scene); }
  private reset(scene: LiveScene) {
    this.image = this.tf = this.scalarDisp = undefined;
    this.zv = this.field = undefined;
    this.vrVisible = false;
    this.vrDisplayId = undefined;
    scene.view?.setVolumeField(null);
    scene.view?.showVolume3D(false);
  }

  private wl(): { win: number; lev: number } {
    const range = this.zv?.range ?? [0, 1];
    const win = (this.scalarDisp?.window as number) ?? (range[1] - range[0]);
    const lev = (this.scalarDisp?.level as number) ?? (range[0] + range[1]) / 2;
    return { win, lev };
  }
  private pushVolume() { if (this.field) this.view?.setVolumeField(this.field, this.wl()); }
  private reLUT() { if (this.field && this.zv) { this.field.setLUT(this.buildLUT(this.zv.range)); this.view?.redraw(); } }

  private async ensureField(): Promise<void> {
    if (this.field || this.building || !this.image?.zarr) return;
    this.building = true;
    if (!this.zv) this.zv = await fetchZarrVolume(this.blobBaseHref, this.image.zarr as ZarrDesc, this.onBytes);
    const ijkToRAS = this.image.ijkToRAS as number[];
    this.field = new ImageField(this.dev, this.zv.data, this.zv.dims, [1, 1, 1], this.buildLUT(this.zv.range), { clim: this.zv.range, ijkToRAS, shade: [0.25, 0.75, 0.5, 24] });
    this.building = false;
    this.view?.setVolumeField(this.field, this.wl());   // slices reslice it now; 3D uses it when VR on
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
}
