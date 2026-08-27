// mountLiveViews — SlicerLive slice/3D cells driven by LiveScene displayable managers over the mrson
// channel, used as the *view area* of a streamed legacy app. The app is the layout engine: cells are
// created and placed from the AppServer's view-cell rects (any number of slice cells, keyed by the
// app's layout names — Red/Green/Yellow, Compare's Slice4.., Red+ ...), one 3D cell for view "1"
// (multi-3D waits for per-view scene renderers). Each slice cell carries a 2D overlay canvas that
// projects OverlayItems (markups, later crosshair / intersections / annotations) onto its plane.
// Local interaction (slice scroll/pan/zoom, 3D orbit) is written back to LiveScene as ops so the
// legacy app follows — the views are SlicerLive's, the state is shared.
// Trimmed from render/demos/mirror-browser.ts (no replay/timeline). TODO(DRY): mirror-browser should mount this too.
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { type Orientation, SliceRenderer } from "../slice-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import type { Field, ImageField } from "../fields.ts";
import { mountAdaptive3d } from "../demos/accum-loop.ts";
import { LiveSync } from "../livesync.ts";
import { WsTransport } from "../transport.ts";
import { CameraInteractor } from "../vtk-interactor.ts";
import { attachSliceControls, type SliceControls } from "../demos/slice-control.ts";
import "./view-cmds.ts";   // registers setCursor / setSliceFrame / viewContextMenu client handlers
import {
  CameraDisplayableManager, type CameraState, LayoutDisplayableManager, LiveScene, MarkupsDisplayableManager,
  type MirrorView, type OverlayItem, RoiCropDisplayableManager, SegmentationDisplayableManager, SliceDisplayableManager,
  type SlicePlane, type Vec3, ViewStateDisplayableManager, type ViewState, VolumeRenderingDisplayableManager,
} from "../livescene.ts";

export interface ViewCellRect { id: string; kind: string; name: string; view: { x: number; y: number; w: number; h: number } }
export interface LiveViews { live: LiveScene; sync: LiveSync; resize(): void; setCells(cells: ViewCellRect[]): void }

const SLAB_MM = 1.5;                  // overlay items within this distance of the plane are "in plane"
const CELL_COLORS: Record<string, string> = { Red: "#f05a5a", Yellow: "#f0d24a", Green: "#5ad07a" };

interface SliceCell {
  name: string; el: HTMLElement; canvas: HTMLCanvasElement; ctx: GPUCanvasContext; overlay: HTMLCanvasElement;
  plane?: SlicePlane; controls?: SliceControls; orientKey: Orientation;
  branched?: boolean;   // a local pan/zoom is in progress: keep the local frame until it is written back
}

export function mountLiveViews(gpu: Gpu, root: HTMLElement, cfg: { httpBase: string; wsUrl: string; onStatus?: (s: string) => void }): LiveViews {
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  root.style.display = "block";

  const makeCanvas = (parent: HTMLElement, css: string) => { const c = document.createElement("canvas"); c.style.cssText = css; parent.appendChild(c); return c; };
  const makeCell = (name: string, label: string, color: string) => {
    const el = document.createElement("div"); el.className = "lv-cell"; el.dataset.cell = name;
    el.style.cssText = "position:absolute;display:none;overflow:hidden;background:#0a0b10";
    const canvas = makeCanvas(el, "position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;touch-action:none");
    const lab = document.createElement("div"); lab.textContent = label;
    lab.style.cssText = `position:absolute;top:4px;left:6px;font:700 11px system-ui;pointer-events:none;opacity:.85;color:${color}`;
    el.appendChild(lab); root.appendChild(el);
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
    ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    return { el, canvas, ctx };
  };

  // ── 3D cell (view "1") ──
  const three = makeCell("3D", "3D", "#9fb3d0");
  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;
  const fields3d = new Map<string, Field>();
  let volumeField: ImageField | null = null, volumeShown3D = false, volumeReady = false;
  let clip: { lo: Vec3; hi: Vec3 } | null = null;
  let threeVisible = false;
  const sizeCanvas = (c: HTMLCanvasElement) => { c.width = Math.max(1, Math.round(c.clientWidth * dpr)); c.height = Math.max(1, Math.round(c.clientHeight * dpr)); };
  const clearCanvas = (ctx: GPUCanvasContext) => {
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView({ format: srgb }), clearValue: { r: 0.02, g: 0.024, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.end(); gpu.device.queue.submit([enc.finish()]);
  };
  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => three.ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: threeVisible ? three.canvas.width : 0, h: three.canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu, movingScaleCap: 0.4, target: 8,
  });
  const rebuild3d = () => {
    const fs = [...fields3d.values()];
    if (volumeShown3D && volumeField) fs.unshift(volumeField);
    if (fs.length === 0) { scene = null; if (threeVisible) clearCanvas(three.ctx); return; }
    if (!scene) scene = new SceneRenderer(gpu, srgb);
    scene.build(fs);
    if (clip) scene.setClipBox(clip.lo, clip.hi);
    a3d.draw();
  };

  // ── slice cells (dynamic, keyed by the app's layout names) ──
  const slice = new SliceRenderer(gpu, srgb);
  const cells = new Map<string, SliceCell>();
  let segOverlay: GPUTexture | null = null, segFill = 0.5, segOutline = 1.0;
  const overlays = new Map<string, OverlayItem[]>();   // layer -> items (cell "*")
  let viewState: ViewState = {};                          // interaction / selection / crosshair nodes
  const interactionMode = () => (viewState.interaction?.mode as string | undefined) ?? "viewTransform";
  let nextOrient = 0;
  const ORIENTS: Orientation[] = ["axial", "coronal", "sagittal"];

  const sliceCell = (name: string): SliceCell => {
    let c = cells.get(name);
    if (c) return c;
    const made = makeCell(name, name, CELL_COLORS[name] ?? "#c0c8d8");
    const overlay = makeCanvas(made.el, "position:absolute;inset:0;width:100%;height:100%;pointer-events:none");
    // Each SliceRenderer orientation slot holds ONE basis/plane; cells beyond the anatomical trio share
    // slots round-robin until the renderer gets per-cell state (S6). Red/Green/Yellow map to their presets.
    const orientKey: Orientation = name === "Red" ? "axial" : name === "Green" ? "coronal" : name === "Yellow" ? "sagittal" : ORIENTS[nextOrient++ % 3];
    c = { name, ...made, overlay, orientKey };
    cells.set(name, c);
    attachInteraction(c);
    return c;
  };

  const planeOffset01 = (c: SliceCell): number => {
    const pl = c.plane!;
    if (pl.basis) return slice.offset01Along(c.orientKey, [pl.basis.nDir[0] * pl.posMm, pl.basis.nDir[1] * pl.posMm, pl.basis.nDir[2] * pl.posMm]);
    const [lo, hi] = volumeField!.aabb();
    const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
    return Math.max(0, Math.min(1, (pl.posMm - lo[axis]) / Math.max(hi[axis] - lo[axis], 1e-6)));
  };
  const applyPlane = (c: SliceCell) => {
    const pl = c.plane!;
    slice.setBasis(c.orientKey, pl.basis ? { uDir: pl.basis.uDir, vDir: pl.basis.vDir, nDir: pl.basis.nDir } : null);
    if (!c.branched) {   // while a local pan/zoom is in flight the renderer's own viewState is the truth
      if (pl.centerRAS && pl.fovX && pl.fovY) slice.setMirrorFrame(c.orientKey, pl.centerRAS as Vec3, pl.fovX, pl.fovY); else slice.resetView(c.orientKey);
    }
    slice.setPlane(c.orientKey, planeOffset01(c));
  };
  const drawOverlay = (c: SliceCell) => {
    const ov = c.overlay, g = ov.getContext("2d")!;
    if (ov.width !== c.canvas.width || ov.height !== c.canvas.height) { ov.width = c.canvas.width; ov.height = c.canvas.height; }
    g.clearRect(0, 0, ov.width, ov.height);
    if (!volumeReady || !c.plane) return;
    const off = planeOffset01(c), aspect = ov.width / ov.height;
    const proj = (ras: Vec3) => { const r = slice.rasToView(c.orientKey, off, ras, aspect); return { x: r.u * ov.width, y: r.v * ov.height, d: r.distMm }; };
    const rgba = (col: number[], a = 1) => `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},${a})`;
    g.lineWidth = 2 * dpr; g.font = `${11 * dpr}px system-ui`;
    for (const items of overlays.values()) {
      for (const it of items) {
        if (it.kind === "point") {
          const p = proj(it.ras); const inPlane = Math.abs(p.d) <= SLAB_MM;
          g.beginPath(); g.arc(p.x, p.y, (it.radiusPx ?? 5) * dpr * (inPlane ? 1 : 0.7), 0, Math.PI * 2);
          if (inPlane) { g.fillStyle = rgba(it.color); g.fill(); } else { g.strokeStyle = rgba(it.color, 0.6); g.stroke(); }
          if (it.label) { g.fillStyle = rgba(it.color, inPlane ? 1 : 0.6); g.fillText(it.label, p.x + 7 * dpr, p.y - 7 * dpr); }
        } else if (it.kind === "polyline") {
          g.strokeStyle = rgba(it.color, 0.9); g.lineWidth = (it.widthPx ?? 2) * dpr; g.beginPath();
          const pts = it.points.map(proj);
          for (let i = 0; i + 1 < pts.length; i++) { if (Math.abs(pts[i].d) <= SLAB_MM && Math.abs(pts[i + 1].d) <= SLAB_MM) { g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[i + 1].x, pts[i + 1].y); } }
          if (it.closed && pts.length > 2) { const a = pts[pts.length - 1], b = pts[0]; if (Math.abs(a.d) <= SLAB_MM && Math.abs(b.d) <= SLAB_MM) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); } }
          g.stroke();
        } else if (it.kind === "text") {
          const p = proj(it.ras); g.fillStyle = rgba(it.color); g.fillText(it.text, p.x, p.y);
        }
      }
    }
    const ch = viewState.crosshair;
    if (ch && (ch.mode as number) && ch.crosshairRAS) {           // full-view cross lines (Slicer's crosshair modes)
      const p = proj(ch.crosshairRAS as Vec3);
      g.strokeStyle = "rgba(255,255,80,0.8)"; g.lineWidth = ((ch.thickness as number) || 1) * dpr; g.beginPath();
      g.moveTo(0, p.y); g.lineTo(ov.width, p.y); g.moveTo(p.x, 0); g.lineTo(p.x, ov.height); g.stroke();
    }
  };
  const renderSlice = (c: SliceCell) => {
    if (c.el.style.display === "none") return;
    if (!volumeReady || !c.plane) { clearCanvas(c.ctx); drawOverlay(c); return; }
    applyPlane(c);
    slice.renderToView(c.ctx.getCurrentTexture().createView({ format: srgb }), c.canvas.width, c.canvas.height);
    drawOverlay(c);
  };
  const renderSlices = () => { for (const c of cells.values()) renderSlice(c); };
  const resizeAll = () => { sizeCanvas(three.canvas); for (const c of cells.values()) sizeCanvas(c.canvas); };

  // ── MirrorView ──
  const crosshairOverlay = () => {
    const ch = viewState.crosshair;
    const mode = (ch?.mode as number) ?? 0, ras = ch?.crosshairRAS as Vec3 | undefined;
    if (!mode || !ras) { overlays.delete("crosshair"); return; }
    // Slicer draws the crosshair through crosshairRAS as lines spanning the view; two long polylines per
    // cell in the plane's own axes are what the projection produces. Represent as an in-plane cross of
    // 1e4 mm arms along the cell basis — drawn per cell in drawOverlay via the "cross" hint.
    overlays.set("crosshair", [{ kind: "point", ras, color: [1, 1, 0.3, 1], radiusPx: 3, label: "" }]);
  };
  const view: MirrorView & { setViewState?: (st: ViewState) => void } = {
    setViewState(st) { viewState = st; crosshairOverlay(); for (const c of cells.values()) drawOverlay(c); },
    setOverlay(_cell, layer, items) { if (items.length) overlays.set(layer, items); else overlays.delete(layer); for (const c of cells.values()) drawOverlay(c); },
    setField(k, f) { fields3d.set(k, f); rebuild3d(); },
    removeField(k) { if (fields3d.delete(k)) rebuild3d(); },
    redraw() { scene?.syncUniforms(); a3d.draw(); },
    setCamera(c: CameraState) {
      if (cam3d.action !== "none") return;
      camera.position = c.position as Vec3; camera.focalPoint = c.focalPoint as Vec3; camera.viewUp = c.viewUp as Vec3;
      if (c.viewAngle) camera.viewAngle = c.viewAngle;
      a3d.draw();
    },
    setClipBox(lo, hi) { clip = lo ? { lo, hi: hi! } : null; if (scene) { if (clip) scene.setClipBox(clip.lo, clip.hi); else scene.setClipPlanes([]); } a3d.draw(); },
    setVolumeField(f, wl) {
      volumeField = f;
      if (f) {
        const [lo, hi] = f.aabb();
        slice.setVolume(f.patientToTexture(), lo, hi);
        slice.setTextures(f.volumeTexture(), segOverlay ?? undefined);
        if (wl) slice.setWindowLevel(wl.win, wl.lev);
        slice.setOverlayOpacity(segOverlay ? segFill : 0); slice.setOutlineOpacity(segOverlay ? segOutline : 0);
        volumeReady = true;
      } else volumeReady = false;
      renderSlices(); rebuild3d();
    },
    showVolume3D(show) { volumeShown3D = show; rebuild3d(); },
    setSlicePlane(cell, pl) { const c = sliceCell(cell); c.plane = pl; renderSlice(c); },
    setLayout(_name) { /* the app's layout engine places cells (setCells) */ },
    setSegmentationOverlay(tex, fillOpacity, outlineOpacity) {
      segOverlay = tex; segFill = fillOpacity; segOutline = outlineOpacity;
      if (volumeField) { slice.setTextures(volumeField.volumeTexture(), tex ?? undefined); slice.setOverlayOpacity(tex ? fillOpacity : 0); slice.setOutlineOpacity(tex ? outlineOpacity : 0); }
      renderSlices();
    },
  };

  const markupsDM = new MarkupsDisplayableManager();
  const live = new LiveScene(cfg.httpBase, [
    new LayoutDisplayableManager(), new CameraDisplayableManager(), new VolumeRenderingDisplayableManager(gpu.device),
    new SliceDisplayableManager(), new SegmentationDisplayableManager(gpu.device, 1.5), markupsDM, new RoiCropDisplayableManager(),
    new ViewStateDisplayableManager(),
  ]);
  live.view = view;
  const sync = new LiveSync(live, new WsTransport(cfg.wsUrl));
  sync.onStatus = (s) => cfg.onStatus?.(s.state === "connected" ? "mirroring Slicer" : s.state === "connecting" ? "connecting…" : "connection lost — retrying");

  // ── local interaction → ops (the app follows) ──
  const nodeIdFor = (pred: (n: Record<string, unknown>) => boolean): string | null => {
    for (const [id, n] of (live as unknown as { nodes: Map<string, Record<string, unknown>> }).nodes) if (pred(n)) return id;
    return null;
  };
  const cam3d = new CameraInteractor(camera, () => { a3d.draw(); pushCamera(); });
  const pushCamera = () => {
    const id = nodeIdFor((n) => n.type === "camera");
    if (id) live.write({ op: "cmd", id, cmd: "setCameraPose", args: { position: camera.position, focalPoint: camera.focalPoint, viewUp: camera.viewUp } });
  };
  const xy3d = (e: PointerEvent) => { const r = three.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  three.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  three.canvas.addEventListener("pointerdown", (e) => { const { x, y } = xy3d(e); cam3d.start(e.button as 0 | 1 | 2, x, y, three.canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }); three.canvas.setPointerCapture(e.pointerId); });
  three.canvas.addEventListener("pointermove", (e) => { if (cam3d.action === "none") return; const { x, y } = xy3d(e); cam3d.move(x, y, three.canvas.clientWidth, three.canvas.clientHeight); });
  const end3d = (e: PointerEvent) => { if (cam3d.action !== "none") { cam3d.end(); pushCamera(); sync.flush(); try { three.canvas.releasePointerCapture(e.pointerId); } catch { /* */ } } };
  three.canvas.addEventListener("pointerup", end3d); three.canvas.addEventListener("pointercancel", end3d);
  three.canvas.addEventListener("wheel", (e) => { e.preventDefault(); cam3d.wheel(e.deltaY < 0); pushCamera(); }, { passive: false });

  const sliceNodeId = (name: string) => nodeIdFor((nd) => nd.type === "view" && nd.kind === "slice" && nd.layoutName === name);
  const scalarDisplayId = () => nodeIdFor((nd) => nd.type === "scalarVolumeDisplay");
  const crosshairId = () => viewState.crosshair?.id ?? null;
  /** RAS of a cell pixel (u,v in [0,1]) on the cell's current plane. */
  const cellRas = (c: SliceCell, u: number, v: number): Vec3 => { applyPlane(c); return slice.viewToRas(c.orientKey, planeOffset01(c), u, v, c.canvas.width / c.canvas.height); };
  /** Nearest markup control point to a cell pixel within `px`, among in-plane points. */
  const pickMarkup = (c: SliceCell, u: number, v: number, w: number, h: number, px = 12) => {
    applyPlane(c);
    const off = planeOffset01(c), aspect = w / h;
    let best: { id: string; index: number; ras: Vec3 } | null = null, bestD = px * dpr;
    for (const hd of markupsDM.handles()) {
      const r = slice.rasToView(c.orientKey, off, hd.ras, aspect);
      if (Math.abs(r.distMm) > SLAB_MM) continue;
      const d = Math.hypot((r.u - u) * w, (r.v - v) * h);
      if (d < bestD) { bestD = d; best = { id: hd.id, index: hd.index, ras: hd.ras }; }
    }
    return best;
  };
  let sliceDrag: { id: string; index: number } | null = null;
  const pushSliceFrame = (c: SliceCell) => {
    const id = sliceNodeId(c.name); const pl = c.plane; if (!id || !pl) return;
    const f = slice.mirrorFrame(c.orientKey, c.canvas.width / c.canvas.height);
    const n: Vec3 = pl.basis ? pl.basis.nDir : pl.orient === "axial" ? [0, 0, 1] : pl.orient === "coronal" ? [0, 1, 0] : [1, 0, 0];
    // keep the out-of-plane position: replace the centre's component along the normal with posMm
    const along = f.centerRAS[0] * n[0] + f.centerRAS[1] * n[1] + f.centerRAS[2] * n[2];
    const center: Vec3 = [f.centerRAS[0] + (pl.posMm - along) * n[0], f.centerRAS[1] + (pl.posMm - along) * n[1], f.centerRAS[2] + (pl.posMm - along) * n[2]];
    live.write({ op: "cmd", id, cmd: "setSliceFrame", args: { center, fov: [f.fovX, f.fovY] } });   // the app keeps its slab thickness
    pl.centerRAS = center; pl.fovX = f.fovX; pl.fovY = f.fovY;
    c.branched = false;
  };
  let frameTimer: number | undefined;
  const branch = (c: SliceCell) => { c.branched = true; clearTimeout(frameTimer); frameTimer = setTimeout(() => pushSliceFrame(c), 200) as unknown as number; };
  function attachInteraction(c: SliceCell) {
    c.controls = attachSliceControls(c.canvas, {
      orient: c.orientKey, getSlice: () => slice,
      step: (fwd) => {
        const pl = c.plane; if (!pl || !volumeField) return;
        const n: Vec3 = pl.basis ? pl.basis.nDir : pl.orient === "axial" ? [0, 0, 1] : pl.orient === "coronal" ? [0, 1, 0] : [1, 0, 0];
        const [lo, hi] = volumeField.aabb();
        const ext = Math.abs(n[0]) * (hi[0] - lo[0]) + Math.abs(n[1]) * (hi[1] - lo[1]) + Math.abs(n[2]) * (hi[2] - lo[2]);
        pl.posMm += ext * 0.02 * (fwd ? -1 : 1);
        const id = sliceNodeId(c.name);
        if (id) live.write({ op: "patch", id, path: "#/offset", value: pl.posMm });   // the app's slice follows (parity-proven)
      },
      redraw: () => renderSlice(c),
      // Slicer's AdjustWindowLevel mouse mode: gated by the interaction node streamed from the app
      wl: {
        enabled: () => interactionMode() === "adjustWindowLevel",
        get: () => { const d = viewState ? live.nodes.get(scalarDisplayId() ?? "") : undefined; return [(d?.window as number) ?? 100, (d?.level as number) ?? 50]; },
        set: (win, lev) => { const id = scalarDisplayId(); if (!id) return; live.write({ op: "patch", id, path: "#/window", value: win }); live.write({ op: "patch", id, path: "#/level", value: lev }); slice.setWindowLevel(win, lev); renderSlice(c); },
        range: () => volumeField ? volumeField.getClim() : [0, 1],
      },
      hooks: {
        onZoom: () => branch(c),
        onLeftGrab: (u, v, w, h) => {
          const hit = pickMarkup(c, u, v, w, h);
          if (!hit) return false;
          sliceDrag = { id: hit.id, index: hit.index }; markupsDM.touch(hit.id, hit.index); return true;
        },
        onLeftDrag: (u, v) => {
          if (!sliceDrag) return;
          const ras = cellRas(c, u, v);
          markupsDM.moveLocal(sliceDrag.id, sliceDrag.index, ras, live);   // optimistic
          markupsDM.touch(sliceDrag.id, sliceDrag.index);
          live.write({ op: "cmd", id: sliceDrag.id, cmd: "setControlPoint", args: { index: sliceDrag.index, position: ras } });
        },
        onLeftDrop: () => { if (sliceDrag) { sync.flush(); sliceDrag = null; } },
        onHover: (u, v, w, h) => {
          // cursor -> the app's crosshair cursor (DataProbe follows); shift-move -> crosshair position too
          const id = crosshairId(); if (!id) return;
          const ras = cellRas(c, u, v);
          live.write({ op: "cmd", id, cmd: "setCursor", args: { ras, view: c.name } });
          if (shiftHeld) live.write({ op: "patch", id, path: "#/crosshairRAS", value: ras });
          c.canvas.style.cursor = pickMarkup(c, u, v, w, h) ? "grab" : "default";
        },
      },
    });
    // pan (middle / shift+left drag) and right-drag zoom have no hooks: branch on the press that starts
    // them (capture phase, before the control handles it) and write the frame back on release
    c.canvas.addEventListener("pointerdown", (e) => { if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) c.branched = true; }, true);
    c.canvas.addEventListener("pointerup", () => { if (c.branched && !sliceDrag) pushSliceFrame(c); });
    c.canvas.addEventListener("pointerleave", () => { const id = crosshairId(); if (id) live.write({ op: "cmd", id, cmd: "setCursor", args: { ras: null, view: c.name } }); });
    c.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = sliceNodeId(c.name); if (!id) return;
      const r = c.canvas.getBoundingClientRect();
      const ras = cellRas(c, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      live.write({ op: "cmd", id, cmd: "viewContextMenu", args: { ras, x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) } });
      sync.flush();
    });
  }
  let shiftHeld = false;
  addEventListener("keydown", (e) => { if (e.key === "Shift") shiftHeld = true; }, true);
  addEventListener("keyup", (e) => { if (e.key === "Shift") shiftHeld = false; }, true);

  const setCells = (rects: ViewCellRect[]) => {
    const origin = root.getBoundingClientRect();
    const shownSlices = new Set<string>();
    threeVisible = false;
    for (const r of rects) {
      const css = `position:absolute;overflow:hidden;background:#0a0b10;left:${r.view.x - origin.left}px;top:${r.view.y - origin.top}px;width:${r.view.w}px;height:${r.view.h}px;display:block`;
      if (r.kind === "slice") { const c = sliceCell(r.name); c.el.style.cssText = css; shownSlices.add(r.name); }
      else if (r.kind === "3d") { if (r.name === "1") { three.el.style.cssText = css; threeVisible = true; } else console.warn("live-views: second 3D view not yet supported:", r.name); }
    }
    for (const [name, c] of cells) if (!shownSlices.has(name)) c.el.style.display = "none";
    if (!threeVisible) three.el.style.display = "none";
    resizeAll(); renderSlices(); if (threeVisible) a3d.draw();
  };
  addEventListener("resize", () => { resizeAll(); renderSlices(); a3d.draw(); });
  Object.assign(globalThis, { __live: live, __sync: sync, __cells: () => [...cells.keys()], __overlays: () => Object.fromEntries(overlays) });
  sync.connect();
  return { live, sync, resize() { resizeAll(); renderSlices(); a3d.draw(); }, setCells };
}
