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
import { fitFovToVolume } from "../../logic/slice-logic.ts";
import { broadcastSlice, type LinkSliceState, type SliceLinkFlag } from "../../logic/link.ts";
import { reformatSliceToRAS } from "../../logic/slice-logic.ts";
import { placeClick, removeControlPointOp } from "../../logic/markups/placer.ts";
import { measurementsFor, polygonArea, polylineLength, type MarkupType } from "../../logic/markups/measurements.ts";
import { interpolateCurve } from "../../logic/markups/curve.ts";
import { VtkCamera } from "../vtk-camera.ts";
import type { Field, ImageField } from "../fields.ts";
import { SlicePlaneField } from "../slice-plane-field.ts";
import { mountAdaptive3d } from "../demos/accum-loop.ts";
import { LiveSync } from "../livesync.ts";
import { WsTransport } from "../transport.ts";
import { CameraInteractor } from "../vtk-interactor.ts";
import { attachSliceControls, type SliceControls } from "../demos/slice-control.ts";
import { attachDoubleClick } from "../demos/view-grid.ts";
import { mountSliceController, type SliceController } from "../demos/slice-controller.ts";
import "./view-cmds.ts";   // registers setCursor / setSliceFrame / viewContextMenu client handlers
import {
  CameraDisplayableManager, type CameraState, LayoutDisplayableManager, LiveScene, MarkupsDisplayableManager,
  type MirrorView, type OverlayItem, RoiCropDisplayableManager, SegmentationDisplayableManager, SliceDisplayableManager,
  type SceneMeshData, type SlicePlane, type SliceLayers, type ThreeDChrome, ModelDisplayableManager, ThreeDViewDisplayableManager, TransformDisplayableManager, type Vec3, ViewStateDisplayableManager, type ViewState, VolumeLayersDisplayableManager, VolumeRenderingDisplayableManager, ModuleRegistryDisplayableManager } from "../livescene.ts";

export interface ViewCellRect { id: string; kind: string; name: string; view: { x: number; y: number; w: number; h: number } }
export interface LiveViews { live: LiveScene; sync: LiveSync; resize(): void; setCells(cells: ViewCellRect[]): void; camera(): { position: Vec3; focalPoint: Vec3; viewUp: Vec3; viewAngle: number }; cells(): string[]; fitVolume(rasLo: Vec3, rasHi: Vec3, ijkToRAS: number[]): void }

const SLAB_MM = 1.5;                  // overlay items within this distance of the plane are "in plane"
const CELL_COLORS: Record<string, string> = { Red: "#f05a5a", Yellow: "#f0d24a", Green: "#5ad07a" };

interface SliceCell {
  name: string; el: HTMLElement; canvas: HTMLCanvasElement; ctx: GPUCanvasContext; overlay: HTMLCanvasElement;
  slice: SliceRenderer;          // per-cell reslicer: its own layer stack, basis, pan/zoom
  layers?: SliceLayers;          // from the app's slice composite node (absent → legacy shared volume)
  plane?: SlicePlane; controls?: SliceControls; orientKey: Orientation;
  branched?: boolean;   // a local pan/zoom is in progress: keep the local frame until it is written back
}

export function mountLiveViews(gpu: Gpu, root: HTMLElement, cfg: { httpBase: string; wsUrl: string; peers?: string[]; onStatus?: (s: string) => void; onFrame?: () => void; onNativePaint?: (segId: string, segment: number, points: Vec3[], mode: "add" | "remove", radiusMm: number, sphere: boolean, normal: Vec3) => void; onNativePaintCommit?: (segId: string) => void; connect?: boolean }): LiveViews {
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  root.style.display = "block";

  const makeCanvas = (parent: HTMLElement, css: string) => { const c = document.createElement("canvas"); c.style.cssText = css; parent.appendChild(c); return c; };
  const makeCell = (name: string, label: string, color: string) => {
    const el = document.createElement("div"); el.className = "lv-cell"; el.dataset.cell = name;
    el.style.cssText = "position:absolute;display:none;overflow:hidden;background:#0a0b10";
    const canvas = makeCanvas(el, "position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;touch-action:none");
    const lab = document.createElement("div"); lab.textContent = label; lab.className = "lv-cell-label";
    lab.style.cssText = `position:absolute;top:4px;left:6px;font:700 11px system-ui;pointer-events:none;opacity:.85;color:${color}`;
    el.appendChild(lab); root.appendChild(el);
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
    ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    return { el, canvas, ctx };
  };

  // ── 3D cell (view "1") ──
  const three = makeCell("3D", "3D", "#9fb3d0");
  const threeOverlay = makeCanvas(three.el, "position:absolute;inset:0;width:100%;height:100%;pointer-events:none");
  let chrome3d: ThreeDChrome | undefined;
  const AXIS_LABELS: [Vec3, string][] = [[[1, 0, 0], "R"], [[-1, 0, 0], "L"], [[0, 1, 0], "A"], [[0, -1, 0], "P"], [[0, 0, 1], "S"], [[0, 0, -1], "I"]];
  /** vtkMRMLViewDisplayableManager chrome: the scene bounding box, R/A/S/L/P/I labels, orientation marker. */
  const drawThreeOverlay = () => {
    const ov = threeOverlay, g = ov.getContext("2d")!;
    if (ov.width !== three.canvas.width || ov.height !== three.canvas.height) { ov.width = three.canvas.width; ov.height = three.canvas.height; }
    g.clearRect(0, 0, ov.width, ov.height);
    if (!threeVisible || !chrome3d) return;
    const w = ov.width, h = ov.height;
    const proj = (p: Vec3) => camera.worldToDisplay(p, w, h);
    // bounds: union of volume + mesh AABBs, else the default 100 mm box
    let lo: Vec3 = [-100, -100, -100], hi: Vec3 = [100, 100, 100];
    if (volumeField) [lo, hi] = volumeField.aabb().map((v) => [...v] as Vec3) as [Vec3, Vec3];
    for (const m of meshes) { const b = m.positions; for (let i = 0; i < b.length; i += 3) { lo = [Math.min(lo[0], b[i]), Math.min(lo[1], b[i + 1]), Math.min(lo[2], b[i + 2])]; hi = [Math.max(hi[0], b[i]), Math.max(hi[1], b[i + 1]), Math.max(hi[2], b[i + 2])]; } if (b.length > 3000) break; }
    if (chrome3d.boxVisible) {
      g.strokeStyle = "rgba(255,255,255,0.75)"; g.lineWidth = 1 * dpr; g.beginPath();
      const cs: Vec3[] = []; for (let i = 0; i < 8; i++) cs.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
      const P = cs.map(proj);
      for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) { const j = i | bit; if (j !== i && P[i].depth > 0 && P[j].depth > 0) { g.moveTo(P[i].x, P[i].y); g.lineTo(P[j].x, P[j].y); } }
      g.stroke();
    }
    if (chrome3d.axisLabelsVisible) {
      const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const half: Vec3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
      g.font = `bold ${13 * dpr}px system-ui`; g.textAlign = "center"; g.textBaseline = "middle";
      for (const [d, label] of AXIS_LABELS) {
        const p = proj([c[0] + d[0] * half[0] * 1.08, c[1] + d[1] * half[1] * 1.08, c[2] + d[2] * half[2] * 1.08]);
        if (p.depth <= 0) continue;
        g.fillStyle = "rgba(0,0,0,0.6)"; g.beginPath(); g.arc(p.x, p.y, 10 * dpr, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#fff"; g.fillText(label, p.x, p.y);
      }
    }
    if (chrome3d.orientationMarkerType > 0) drawOrientationMarker(g, w, h, (p: Vec3) => { const q = camera.worldToDisplay([camera.focalPoint[0] + p[0], camera.focalPoint[1] + p[1], camera.focalPoint[2] + p[2]], w, h); const f = camera.worldToDisplay(camera.focalPoint, w, h); return { dx: q.x - f.x, dy: q.y - f.y }; }, 1);
  };
  /** Corner orientation marker (axes glyph): world direction -> screen delta supplied by the caller. */
  const drawOrientationMarker = (g: CanvasRenderingContext2D, w: number, h: number, dir: (p: Vec3) => { dx: number; dy: number }, scaleMm: number) => {
    const size = 36 * dpr, cx = w - size - 10 * dpr, cy = h - size - 10 * dpr;
    const axes: [Vec3, string, string][] = [[[1, 0, 0], "R", "#ff6b6b"], [[0, 1, 0], "A", "#6bff8f"], [[0, 0, 1], "S", "#6b9bff"]];
    g.lineWidth = 2 * dpr; g.font = `bold ${11 * dpr}px system-ui`; g.textAlign = "center"; g.textBaseline = "middle";
    for (const [d, label, col] of axes) {
      const v = dir([d[0] * scaleMm, d[1] * scaleMm, d[2] * scaleMm]);
      const l = Math.hypot(v.dx, v.dy) || 1; const ex = cx + (v.dx / l) * size * 0.8, ey = cy + (v.dy / l) * size * 0.8;
      g.strokeStyle = col; g.beginPath(); g.moveTo(cx, cy); g.lineTo(ex, ey); g.stroke();
      g.fillStyle = col; g.fillText(label, cx + (v.dx / l) * size, cy + (v.dy / l) * size);
    }
  };
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
    onFrame: () => { drawThreeOverlay(); cfg.onFrame?.(); },
  });
  let meshes: SceneMeshData[] = [];
  const rebuild3d = () => {
    const fs = [...fields3d.values()];
    if (volumeShown3D && volumeField) fs.unshift(volumeField);
    if (fs.length === 0 && meshes.length === 0) { scene = null; if (threeVisible) clearCanvas(three.ctx); return; }
    if (!scene) scene = new SceneRenderer(gpu, srgb);
    scene.build(fs);
    scene.setMeshes(meshes);
    if (clip) scene.setClipBox(clip.lo, clip.hi);
    a3d.draw();
  };

  // ── slice cells (dynamic, keyed by the app's layout names), one SliceRenderer each ──
  const cells = new Map<string, SliceCell>();
  const sliceChangeListeners = new Set<() => void>();   // controller bars re-read offset/range after any slice render
  let segOverlay: GPUTexture | null = null, segFill = 0.5, segOutline = 1.0;
  const overlays = new Map<string, OverlayItem[]>();   // layer -> items (cell "*")
  const viewStateDM = new ViewStateDisplayableManager();  // interaction / selection / crosshair / segmentEditor nodes
  const viewState: ViewState = viewStateDM.state;         // read the manager's state directly (never a stale copy)
  // Read app-level state straight from the model (live.nodes): the single source of truth, never a stale copy.
  const stateNode = (type: string) => live.find(type);
  const interactionMode = () => (stateNode("interaction")?.mode as string | undefined) ?? "viewTransform";
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
    const sr = new SliceRenderer(gpu, srgb);
    if (volumeField) { const [lo, hi] = volumeField.aabb(); sr.setVolume(volumeField.patientToTexture(), lo, hi); sr.setTextures(volumeField.volumeTexture(), segOverlay ?? undefined); }
    c = { name, ...made, overlay, orientKey, slice: sr };
    cells.set(name, c);
    attachInteraction(c);
    return c;
  };
  const fieldNames = new WeakMap<object, string>();
  const imageName = (f: object) => fieldNames.get(f) ?? "";
  /** The background volume a cell reslices: its composite's background layer, else the legacy shared volume. */
  const bgField = (c: SliceCell): ImageField | null => c.layers?.background?.field ?? volumeField;
  /** Push a cell's layer stack (or the legacy shared volume) into its renderer. */
  const applyLayers = (c: SliceCell) => {
    const L = c.layers, sr = c.slice, bg = bgField(c);
    if (!bg) return;
    const [lo, hi] = bg.aabb();
    sr.setVolume(bg.patientToTexture(), lo, hi);
    sr.setTextures(bg.volumeTexture(), segOverlay ?? undefined);
    if (L?.background) sr.setWindowLevel(L.background.win, L.background.lev); else if (legacyWL) sr.setWindowLevel(legacyWL.win, legacyWL.lev);
    sr.setLayerLUTs(L?.background?.lut ?? null, L?.foreground?.lut ?? null);
    if (L?.foreground) sr.setForeground(L.foreground.field.volumeTexture(), L.foreground.field.patientToTexture(), L.foreground.win, L.foreground.lev, L.foreground.opacity, L.foreground.compositing);
    else sr.setForeground(null, null, 0, 0, 0);
    if (L?.label) sr.setLabelLayer(L.label.field.volumeTexture(), L.label.field.patientToTexture(), L.label.table, L.label.opacity);
    else sr.setLabelLayer(null, null, null, 0);
    sr.setOverlayOpacity(segOverlay ? segFill : 0); sr.setOutlineOpacity(segOverlay ? segOutline : 0);
  };
  let legacyWL: { win: number; lev: number } | undefined;

  const planeOffset01 = (c: SliceCell): number => {
    const pl = c.plane!;
    if (pl.basis) return c.slice.offset01Along(c.orientKey, [pl.basis.nDir[0] * pl.posMm, pl.basis.nDir[1] * pl.posMm, pl.basis.nDir[2] * pl.posMm]);
    const [lo, hi] = bgField(c)!.aabb();
    const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
    return Math.max(0, Math.min(1, (pl.posMm - lo[axis]) / Math.max(hi[axis] - lo[axis], 1e-6)));
  };
  const applyPlane = (c: SliceCell) => {
    const pl = c.plane!, slice = c.slice;
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
    if (!bgField(c) || !c.plane) return;
    const off = planeOffset01(c), aspect = ov.width / ov.height;
    const proj = (ras: Vec3) => { const r = c.slice.rasToView(c.orientKey, off, ras, aspect); return { x: r.u * ov.width, y: r.v * ov.height, d: r.distMm }; };
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
    // ── slice intersection lines: where every OTHER slice plane cuts THIS plane (Slicer's coloured localizers) ──
    if (sliceIntersections) {
      const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const scl = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
      const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      const normalOf = (cc: SliceCell): Vec3 => cc.plane?.basis ? cc.plane.basis.nDir : cc.orientKey === "axial" ? [0, 0, 1] : cc.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
      const nc = normalOf(c), dc = c.plane.posMm;
      for (const o of cells.values()) {
        if (o === c || o.el.style.display === "none" || !o.plane) continue;
        const no = normalOf(o), doff = o.plane.posMm;
        const dir = crossV(nc, no), dd = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
        if (dd < 1e-9) continue;                                    // parallel planes: no intersection line
        // a point on both planes: p0 = (dc (no×dir) + doff (dir×nc)) / |dir|^2  (standard two-plane intersection)
        const p0 = scl(add3(scl(crossV(no, dir), dc), scl(crossV(dir, nc), doff)), 1 / dd);
        const L = 1e4;
        const a = proj(add3(p0, scl(dir, L))), b = proj(add3(p0, scl(dir, -L)));
        g.strokeStyle = (CELL_COLORS[o.name] ?? "#c0c8d8"); g.globalAlpha = 0.85; g.lineWidth = 1.5 * dpr;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.globalAlpha = 1;
      }
    }

    // ── slice-view chrome: orientation marker, ruler, corner annotations (DataProbe's SliceViewAnnotations) ──
    const chrome = c.plane.chrome;
    if (chrome?.orientationMarkerType) drawOrientationMarker(g, ov.width, ov.height, (p) => { const o = c.slice.rasToView(c.orientKey, off, [0, 0, 0], aspect); const q = c.slice.rasToView(c.orientKey, off, p, aspect); return { dx: (q.u - o.u) * ov.width, dy: (q.v - o.v) * ov.height }; }, 10);
    if (chrome?.rulerType) {
      const f = c.slice.mirrorFrame(c.orientKey, aspect);          // mm across the view width
      const mmPerPx = f.fovX / (ov.width / dpr);
      const steps = [1, 2, 5, 10, 20, 50, 100, 200]; const targetPx = (ov.width / dpr) * 0.25;
      const mm = steps.reduce((best, sMm) => Math.abs(sMm / mmPerPx - targetPx) < Math.abs(best / mmPerPx - targetPx) ? sMm : best, steps[0]);
      const px = (mm / mmPerPx) * dpr, x0 = ov.width / 2 - px / 2, y = ov.height - 14 * dpr;
      g.strokeStyle = "#fff"; g.lineWidth = (chrome.rulerType === 2 ? 3 : 1.5) * dpr; g.beginPath();
      g.moveTo(x0, y); g.lineTo(x0 + px, y); g.moveTo(x0, y - 5 * dpr); g.lineTo(x0, y + 5 * dpr); g.moveTo(x0 + px, y - 5 * dpr); g.lineTo(x0 + px, y + 5 * dpr); g.stroke();
      g.fillStyle = "#fff"; g.font = `${10 * dpr}px system-ui`; g.textAlign = "center"; g.textBaseline = "bottom"; g.fillText(mm >= 10 ? `${mm / 10} cm` : `${mm} mm`, x0 + px / 2, y - 3 * dpr);
    }
    {   // corner annotations: background/foreground names (top-left), offset + W/L (bottom-left)
      const L = c.layers; const bgName = L?.background ? imageName(L.background.field) : (volumeField ? "volume" : "");
      g.font = `${11 * dpr}px system-ui`; g.textAlign = "left"; g.textBaseline = "top"; g.fillStyle = "rgba(255,255,255,0.85)";
      let y = 22 * dpr;
      if (bgName) { g.fillText("B: " + bgName, 6 * dpr, y); y += 13 * dpr; }
      if (L?.foreground) { g.fillText("F: " + imageName(L.foreground.field), 6 * dpr, y); y += 13 * dpr; }
      if (L?.label) { g.fillText("L: " + imageName(L.label.field), 6 * dpr, y); }
      g.textBaseline = "bottom";
      const wl = L?.background ? `W:${L.background.win.toFixed(0)} L:${L.background.lev.toFixed(0)}` : legacyWL ? `W:${legacyWL.win.toFixed(0)} L:${legacyWL.lev.toFixed(0)}` : "";
      g.fillText(`${c.plane.orient === "axial" ? "S" : c.plane.orient === "coronal" ? "A" : "R"}: ${c.plane.posMm.toFixed(1)} mm  ${wl}`, 6 * dpr, ov.height - 6 * dpr);
    }
    // ── segment editor feedback: brush circle at the cursor + the stroke being painted (until the labelmap echo lands) ──
    if (brushEffect() && (brushCursor?.cell === c || brushStroke?.cell === c)) {
      const f = c.slice.mirrorFrame(c.orientKey, aspect); const pxPerMm = ov.width / f.fovX;
      const rPx = (brushDiameterMm() / 2) * pxPerMm;
      const col = brushEffect() === "remove" ? "rgba(255,80,80,0.9)" : "rgba(255,255,80,0.9)";
      if (brushStroke?.cell === c && brushStroke.points.length) {
        g.strokeStyle = brushEffect() === "remove" ? "rgba(255,80,80,0.35)" : "rgba(255,255,80,0.35)"; g.lineWidth = rPx * 2; g.lineCap = "round"; g.lineJoin = "round"; g.beginPath();
        brushStroke.points.forEach((p, i) => { const q = proj(p); if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y); });
        if (brushStroke.points.length === 1) { const q = proj(brushStroke.points[0]); g.lineTo(q.x + 0.01, q.y); }
        g.stroke(); g.lineCap = "butt"; g.lineJoin = "miter";
      }
      if (brushCursor?.cell === c) { const q = proj(brushCursor.ras); g.strokeStyle = col; g.lineWidth = 1.5 * dpr; g.beginPath(); g.arc(q.x, q.y, rPx, 0, Math.PI * 2); g.stroke(); }
    }
    const ch = stateNode("crosshair");
    if (ch && (ch.mode as number) && ch.crosshairRAS) {           // full-view cross lines (Slicer's crosshair modes)
      const p = proj(ch.crosshairRAS as Vec3);
      g.strokeStyle = "rgba(255,255,80,0.8)"; g.lineWidth = ((ch.thickness as number) || 1) * dpr; g.beginPath();
      g.moveTo(0, p.y); g.lineTo(ov.width, p.y); g.moveTo(p.x, 0); g.lineTo(p.x, ov.height); g.stroke();
    }
  };
  const renderSlice = (c: SliceCell) => {
    if (c.el.style.display === "none") return;
    if (!bgField(c) || !c.plane) { clearCanvas(c.ctx); drawOverlay(c); cfg.onFrame?.(); return; }   // an empty cell still renders a frame
    applyLayers(c);
    applyPlane(c);
    c.slice.renderToView(c.ctx.getCurrentTexture().createView({ format: srgb }), c.canvas.width, c.canvas.height);
    drawOverlay(c);
    cfg.onFrame?.();                                   // slice frames count as frames (tests' settle/ready signal)
    for (const l of sliceChangeListeners) l();
  };
  const renderSlices = () => { for (const c of cells.values()) renderSlice(c); };
  const resizeAll = () => { sizeCanvas(three.canvas); for (const c of cells.values()) sizeCanvas(c.canvas); };

  // ── MirrorView ──
  const crosshairOverlay = () => {
    const ch = stateNode("crosshair");
    const mode = (ch?.mode as number) ?? 0, ras = ch?.crosshairRAS as Vec3 | undefined;
    if (!mode || !ras) { overlays.delete("crosshair"); return; }
    // Slicer draws the crosshair through crosshairRAS as lines spanning the view; two long polylines per
    // cell in the plane's own axes are what the projection produces. Represent as an in-plane cross of
    // 1e4 mm arms along the cell basis — drawn per cell in drawOverlay via the "cross" hint.
    overlays.set("crosshair", [{ kind: "point", ras, color: [1, 1, 0.3, 1], radiusPx: 3, label: "" }]);
  };
  const view: MirrorView & { setViewState?: (st: ViewState) => void } = {
    setViewState(_st) { crosshairOverlay(); for (const c of cells.values()) drawOverlay(c); },
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
    setSliceLayers(cell, layers) {
      const c = sliceCell(cell); c.layers = layers;
      for (const l of [layers.background, layers.foreground, layers.label]) if (l && !fieldNames.has(l.field)) fieldNames.set(l.field, (l as { name?: string }).name ?? "");
      renderSlice(c);
    },
    setViewChrome(ch) { chrome3d = ch; if (scene) scene.setBackground?.(ch.backgroundColor[0], ch.backgroundColor[1], ch.backgroundColor[2]); drawThreeOverlay(); a3d.draw(); },
    setMeshes(list) { meshes = list; if (scene) { scene.setMeshes(meshes); a3d.draw(); } else rebuild3d(); },
    setVolumeField(f, wl) {
      volumeField = f; legacyWL = wl;
      volumeReady = !!f;
      renderSlices(); rebuild3d();
    },
    showVolume3D(show) { volumeShown3D = show; rebuild3d(); },
    setSlicePlane(cell, pl) { const c = sliceCell(cell); c.plane = pl; renderSlice(c); },
    setLayout(_name) { /* the app's layout engine places cells (setCells) */ },
    setSegmentationOverlay(tex, fillOpacity, outlineOpacity) {
      segOverlay = tex; segFill = fillOpacity; segOutline = outlineOpacity;
      renderSlices();
    },
  };

  const markupsDM = new MarkupsDisplayableManager();
  const moduleRegistry = new ModuleRegistryDisplayableManager();   // S11: union of every peer's `module` nodes
  const live = new LiveScene(cfg.httpBase, [
    new LayoutDisplayableManager(), new CameraDisplayableManager(), new VolumeRenderingDisplayableManager(gpu.device), new VolumeLayersDisplayableManager(gpu.device),
    new SliceDisplayableManager(), new SegmentationDisplayableManager(gpu.device, 1.5), markupsDM, new RoiCropDisplayableManager(),
    viewStateDM, new TransformDisplayableManager(), new ModelDisplayableManager(), new ThreeDViewDisplayableManager(), moduleRegistry,
  ]);
  live.view = view;
  const hub = (cfg.peers?.length ?? 0) > 0;
  const sync = new LiveSync(live, new WsTransport(cfg.wsUrl), { peerId: "app", relay: hub });
  // Additional ModuleServers (registry entries): the page is the hub — each peer gets everything that
  // did not originate from it, as put/del. Other servers' outputs arrive as ordinary nodes.
  const peers: LiveSync[] = (cfg.peers ?? []).map((url, i) => new LiveSync(live, new WsTransport(url), { peerId: "peer" + (i + 1), relay: true }));
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
  // 3D standard anatomical views (Slicer's reset-to-view: look from R/A/S/L/P/I toward the volume centre) + ortho
  const volumeCenterRadius = (): { center: Vec3; radius: number } => {
    let lo: Vec3 | null = null, hi: Vec3 | null = null;
    const consider = (f: { aabb(): [Vec3, Vec3] } | null | undefined) => { if (!f) return; const [a, b] = f.aabb(); if (!lo) { lo = [...a]; hi = [...b]; } else for (let i = 0; i < 3; i++) { lo![i] = Math.min(lo![i], a[i]); hi![i] = Math.max(hi![i], b[i]); } };
    if (volumeField) consider(volumeField); else for (const c of cells.values()) consider(bgField(c));
    if (!lo || !hi) return { center: camera.focalPoint, radius: Math.max(1, camera.distance / 2.6) };
    const L = lo as Vec3, H = hi as Vec3;
    return { center: [(L[0] + H[0]) / 2, (L[1] + H[1]) / 2, (L[2] + H[2]) / 2], radius: Math.max(1, Math.hypot(H[0] - L[0], H[1] - L[1], H[2] - L[2]) / 2) };
  };
  const VIEW_DIRS: Record<string, { dir: Vec3; up: Vec3 }> = {
    R: { dir: [1, 0, 0], up: [0, 0, 1] }, L: { dir: [-1, 0, 0], up: [0, 0, 1] },
    A: { dir: [0, 1, 0], up: [0, 0, 1] }, P: { dir: [0, -1, 0], up: [0, 0, 1] },
    S: { dir: [0, 0, 1], up: [0, 1, 0] }, I: { dir: [0, 0, -1], up: [0, 1, 0] },
  };
  const resetCamera3D = (which: string) => {
    const v = VIEW_DIRS[which]; if (!v) return;
    const { center, radius } = volumeCenterRadius(), dist = radius * 2.6;
    camera.focalPoint = [...center] as Vec3;
    camera.position = [center[0] + v.dir[0] * dist, center[1] + v.dir[1] * dist, center[2] + v.dir[2] * dist];
    camera.viewUp = [...v.up] as Vec3; camera.orthogonalizeViewUp();
    camera.parallelScale = radius;
    a3d.draw(); pushCamera(); sync.flush();
  };
  const setOrthographic = (on: boolean) => { camera.parallelProjection = on; if (on) camera.parallelScale = volumeCenterRadius().radius; a3d.draw(); pushCamera(); };

  // 3D controller bar: look-from buttons (R/A/S/L/P/I) + orthographic toggle (Slicer's 3D view controller)
  {
    const bar = document.createElement("div"); bar.className = "sl-3d-bar";
    for (const k of ["R", "A", "S", "L", "P", "I"]) { const b = document.createElement("button"); b.textContent = k; b.title = `Look from ${k}`; b.addEventListener("click", () => resetCamera3D(k)); bar.appendChild(b); }
    const ortho = document.createElement("button"); ortho.textContent = "⬚"; ortho.title = "Orthographic projection";
    ortho.addEventListener("click", () => { const on = !camera.parallelProjection; setOrthographic(on); ortho.setAttribute("aria-pressed", String(on)); });
    bar.appendChild(ortho);
    three.el.appendChild(bar);
  }

  const xy3d = (e: PointerEvent) => { const r = three.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  three.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  three.canvas.addEventListener("pointerdown", (e) => { const { x, y } = xy3d(e); cam3d.start(e.button as 0 | 1 | 2, x, y, three.canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }); three.canvas.setPointerCapture(e.pointerId); });
  three.canvas.addEventListener("pointermove", (e) => { if (cam3d.action === "none") return; const { x, y } = xy3d(e); cam3d.move(x, y, three.canvas.clientWidth, three.canvas.clientHeight); });
  const end3d = (e: PointerEvent) => { if (cam3d.action !== "none") { cam3d.end(); pushCamera(); sync.flush(); try { three.canvas.releasePointerCapture(e.pointerId); } catch { /* */ } } };
  three.canvas.addEventListener("pointerup", end3d); three.canvas.addEventListener("pointercancel", end3d);
  three.canvas.addEventListener("wheel", (e) => { e.preventDefault(); cam3d.wheel(e.deltaY < 0); pushCamera(); }, { passive: false });

  const sliceNodeId = (name: string) => nodeIdFor((nd) => nd.type === "view" && nd.kind === "slice" && nd.layoutName === name);
  const scalarDisplayId = () => nodeIdFor((nd) => nd.type === "scalarVolumeDisplay");
  /** The display node of a cell's BACKGROUND volume (what Slicer's W/L drag adjusts): the cell's
   *  sliceComposite -> background image -> refs.display[0]; falls back to any scalar display. */
  const bgDisplayId = (c: SliceCell): string | undefined => {
    const comp = [...live.nodes.values()].find((n) => n.type === "sliceComposite" && n.layoutName === c.name);
    const imgId = ((comp?.refs as Record<string, string[]> | undefined)?.background ?? [])[0];
    const img = imgId ? live.nodes.get(imgId) : undefined;
    const did = ((img?.refs as Record<string, string[]> | undefined)?.display ?? [])[0];
    return did ?? scalarDisplayId() ?? undefined;
  };
  const crosshairId = () => stateNode("crosshair")?.id ?? null;
  /** RAS of a cell pixel (u,v in [0,1]) on the cell's current plane. */
  const cellRas = (c: SliceCell, u: number, v: number): Vec3 => { applyPlane(c); return c.slice.viewToRas(c.orientKey, planeOffset01(c), u, v, c.canvas.width / c.canvas.height); };
  /** Nearest markup control point to a cell pixel within `px`, among in-plane points. */
  const pickMarkup = (c: SliceCell, u: number, v: number, w: number, h: number, px = 12) => {
    applyPlane(c);
    const off = planeOffset01(c), aspect = w / h;
    let best: { id: string; index: number; ras: Vec3 } | null = null, bestD = px * dpr;
    for (const hd of markupsDM.handles()) {
      if (live.nodes.get(hd.id)?.locked) continue;                       // locked markups aren't grabbable
      const r = c.slice.rasToView(c.orientKey, off, hd.ras, aspect);
      if (Math.abs(r.distMm) > SLAB_MM) continue;
      const d = Math.hypot((r.u - u) * w, (r.v - v) * h);
      if (d < bestD) { bestD = d; best = { id: hd.id, index: hd.index, ras: hd.ras }; }
    }
    return best;
  };
  let sliceDrag: { id: string; index: number } | null = null;
  // ── segment editor: brush cursor + strokes sent to the app (Paint / Erase active in the streamed editor) ──
  const brushEffect = (): "add" | "remove" | null => {
    const e = ((stateNode("segmentEditor")?.activeEffect as string) ?? "").toLowerCase();
    return e === "paint" ? "add" : e === "erase" ? "remove" : null;
  };
  const brushDiameterMm = (): number => {
    const P = (stateNode("segmentEditor")?.params as Record<string, string> | undefined) ?? {};
    const abs = parseFloat(P.BrushAbsoluteDiameter ?? "");
    return Number.isFinite(abs) && abs > 0 ? abs : 5;
  };
  let brushStroke: { cell: SliceCell; points: Vec3[]; seq: number; lastSent: number; lastPt: Vec3 } | null = null;
  let strokeSeq = 0;
  let brushCursor: { cell: SliceCell; ras: Vec3 } | null = null;
  let paintCommitTimer: number | undefined;
  const localSegForEditor = (): { segId: string; segment: number } | null => {
    const se = stateNode("segmentEditor"); if (!se) return null;
    const segId = ((se.refs as Record<string, string[]> | undefined)?.segmentation ?? [])[0];
    const seg = segId ? live.nodes.get(segId) : undefined;
    if (!seg || !(seg.origin as { local?: boolean } | undefined)?.local) return null;   // peer segmentation -> use the cmd path
    return { segId, segment: Number(se.selectedSegmentId ?? 1) || 1 };
  };
  const sendStroke = (final = false) => {
    if (!brushStroke) return;
    const id = stateNode("segmentEditor")?.id; if (!id) return;
    const pts = brushStroke.points.slice(brushStroke.lastSent);
    if (pts.length === 0) return;
    const send = brushStroke.lastSent > 0 ? [brushStroke.lastPt, ...pts] : pts;   // overlap with the previous batch
    const pl = brushStroke.cell.plane!;
    const normal: Vec3 = pl.basis ? pl.basis.nDir : pl.orient === "axial" ? [0, 0, 1] : pl.orient === "coronal" ? [0, 1, 0] : [1, 0, 0];
    const P = (stateNode("segmentEditor")?.params as Record<string, string> | undefined) ?? {};
    const local = localSegForEditor();
    if (local && cfg.onNativePaint) {                                 // standalone: paint the resident labelmap
      cfg.onNativePaint(local.segId, local.segment, send, brushEffect() ?? "add", brushDiameterMm() / 2, P.BrushSphere === "1", normal);
      clearTimeout(paintCommitTimer);
      if (final) cfg.onNativePaintCommit?.(local.segId);
      else paintCommitTimer = setTimeout(() => cfg.onNativePaintCommit?.(local.segId), 120) as unknown as number;
    } else {
      live.write({ op: "cmd", id, cmd: "segPaint", args: { points: send, mode: brushEffect() ?? "add", diameterMm: brushDiameterMm(), sphere: P.BrushSphere === "1", normal, seq: ++strokeSeq, index: strokeSeq } });
      if (final) sync.flush();
    }
    brushStroke.lastSent = brushStroke.points.length; brushStroke.lastPt = pts[pts.length - 1];
  };
  const pushSliceFrame = (c: SliceCell) => {
    const id = sliceNodeId(c.name); const pl = c.plane; if (!id || !pl) return;
    const f = c.slice.mirrorFrame(c.orientKey, c.canvas.width / c.canvas.height);
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
      orient: c.orientKey, getSlice: () => c.slice,
      step: (fwd) => {
        // one slice per wheel notch, through the NATIVE-node path (setSliceOffset -> patchNativeOffset keeps
        // sliceToRAS AND offset in sync). Before: step() patched only #/offset, so the DM re-pushed the plane
        // from the stale sliceToRAS and the slice snapped back -> jitter (worst on the 1.3mm sagittal axis).
        const cur = getSliceOffset(c.name); const range = sliceOffsetRange(c.name);
        if (cur == null || !range) return;
        const stepMm = range.step > 0 ? range.step : 1;
        setSliceOffset(c.name, cur + stepMm * (fwd ? -1 : 1));
      },
      redraw: () => renderSlice(c),
      // Slicer's AdjustWindowLevel mouse mode: gated by the interaction node streamed from the app
      wl: {
        enabled: () => { const m = stateNode("interaction"); return m ? (m.mode === "adjustWindowLevel") : !!bgDisplayId(c); },   // Slicer default 2D mouse mode
        get: () => { const d = live.nodes.get(bgDisplayId(c) ?? ""); return [(d?.window as number) ?? 100, (d?.level as number) ?? 50]; },
        set: (win, lev) => { const id = bgDisplayId(c); if (!id) return; live.write({ op: "patch", id, path: "#/window", value: win }); live.write({ op: "patch", id, path: "#/level", value: lev }); live.write({ op: "patch", id, path: "#/autoWindowLevel", value: false }); c.slice.setWindowLevel(win, lev); renderSlice(c); },
        range: () => bgField(c) ? bgField(c)!.getClim() : [0, 1],
      },
      hooks: {
        onZoom: () => branch(c),
        onLeftGrab: (u, v, w, h) => {
          if (brushEffect()) {                                          // Segment Editor Paint/Erase: stroke in this cell
            brushStroke = { cell: c, points: [cellRas(c, u, v)], seq: 0, lastSent: 0, lastPt: cellRas(c, u, v) };
            sendStroke();                                               // the initial dab paints immediately
            return true;
          }
          if (interactionMode() === "place") {                          // Slicer's Place mode: a click places
            const ras = cellRas(c, u, v);
            if (placeAtNative(ras)) return true;                          // native placer (standalone)
            const id = stateNode("interaction")?.id; if (!id) return true;
            live.write({ op: "cmd", id, cmd: "placeAt", args: { ras, view: c.name } });   // peer path
            sync.flush();
            return true;                                                  // consume: no scroll-drag starts
          }
          const hit = pickMarkup(c, u, v, w, h);
          if (!hit) return false;
          sliceDrag = { id: hit.id, index: hit.index }; markupsDM.touch(hit.id, hit.index); return true;
        },
        onLeftDrag: (u, v) => {
          if (brushStroke) {
            const ras = cellRas(c, u, v); brushStroke.points.push(ras); brushCursor = { cell: c, ras };
            const now = performance.now();
            if (now - (brushStroke as { t?: number }).t! > 60 || !(brushStroke as { t?: number }).t) { (brushStroke as { t?: number }).t = now; sendStroke(); }
            drawOverlay(c); return;
          }
          if (!sliceDrag) return;
          const ras = cellRas(c, u, v);
          markupsDM.moveLocal(sliceDrag.id, sliceDrag.index, ras, live);   // optimistic
          markupsDM.touch(sliceDrag.id, sliceDrag.index);
          live.write({ op: "cmd", id: sliceDrag.id, cmd: "setControlPoint", args: { index: sliceDrag.index, position: ras } });
          storeMeasurements(sliceDrag.id);
        },
        onLeftDrop: () => { if (brushStroke) { sendStroke(true); brushStroke = null; drawOverlay(c); } if (sliceDrag) { sync.flush(); sliceDrag = null; } },
        onHover: (u, v, w, h) => {
          // cursor -> the app's crosshair cursor (DataProbe follows); shift-move -> crosshair position too
          const id = crosshairId(); if (!id) return;
          const ras = cellRas(c, u, v);
          live.write({ op: "cmd", id, cmd: "setCursor", args: { ras, view: c.name } });
          if (shiftHeld) { live.write({ op: "patch", id, path: "#/crosshairRAS", value: ras }); jumpLocal(ras); }
          if (brushEffect()) { brushCursor = { cell: c, ras }; c.canvas.style.cursor = "none"; drawOverlay(c); }
          else c.canvas.style.cursor = interactionMode() === "place" ? "crosshair" : pickMarkup(c, u, v, w, h) ? "grab" : "default";
        },
      },
    });
    attachDoubleClick(c.canvas, () => toggleMaximize(c.name));
    const lbl = c.el.querySelector(".lv-cell-label") as HTMLElement | null; if (lbl) lbl.style.display = "none";
    // slice controller bar (orientation + offset slider + fit) over this cell, node/peer-agnostic via the adapter
    (c as SliceCell & { controller?: SliceController }).controller = mountSliceController(c.el, c.name, {
      orientation: () => c.orientKey, offset: () => getSliceOffset(c.name), range: () => sliceOffsetRange(c.name),
      setOffset: (mm) => setSliceOffset(c.name, mm), fit: () => fitCell(c.name),
      setOrientation: (o: "axial" | "coronal" | "sagittal") => reformatCell(c.name, o),
      toggle3D: () => setSliceIn3D(c.name, !sliceIn3D.has(c.name)),
      in3D: () => sliceIn3D.has(c.name),
      onChange: (cb) => { sliceChangeListeners.add(cb); return () => sliceChangeListeners.delete(cb); },
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
  let sliceIntersections = true;
  let shiftHeld = false;
  addEventListener("keydown", (e) => { if (e.key === "Shift") shiftHeld = true; }, true);
  addEventListener("keyup", (e) => { if (e.key === "Shift") shiftHeld = false; }, true);

  let lastRects: ViewCellRect[] = [];
  let maximizedCell: string | null = null;
  const applyCells = () => {
    const origin = root.getBoundingClientRect();
    // when a cell is maximized (double-click, like the MPR demos' attachViewGrid), show only it, full area
    const rects = maximizedCell
      ? lastRects.filter((r) => r.name === maximizedCell).map((r) => ({ ...r, view: { x: origin.left, y: origin.top, w: origin.width, h: origin.height } }))
      : lastRects;
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
  const setCells = (rects: ViewCellRect[]) => { lastRects = rects; if (maximizedCell && !rects.some((r) => r.name === maximizedCell)) maximizedCell = null; applyCells(); };
  /** Double-click a cell to maximize/restore (reuses the MPR demos' behaviour, systematized here). */
  const toggleMaximize = (name: string) => { maximizedCell = maximizedCell === name ? null : name; applyCells(); };
  attachDoubleClick(three.canvas, () => toggleMaximize("1"));
  // Native sliceView nodes (standalone, no Slicer peer): the SliceDisplayableManager consumes `view`/slice
  // nodes (sliceToRAS + fieldOfView) and pushes a plane to each cell, so a locally loaded volume renders and
  // jump/offset persist (the node owns the plane). One per anatomical cell; the same setSlicePlane path a peer
  // uses. Red=Axial, Yellow=Sagittal, Green=Coronal.
  const NATIVE_SLICE: Record<string, { orientation: string; axis: 0 | 1 | 2; transIdx: 3 | 7 | 11; mat: (c: Vec3) => number[] }> = {
    Red: { orientation: "Axial", axis: 2, transIdx: 11, mat: (c) => [1, 0, 0, c[0], 0, 1, 0, c[1], 0, 0, 1, c[2], 0, 0, 0, 1] },
    Yellow: { orientation: "Sagittal", axis: 0, transIdx: 3, mat: (c) => [0, 0, 1, c[0], 1, 0, 0, c[1], 0, 1, 0, c[2], 0, 0, 0, 1] },
    Green: { orientation: "Coronal", axis: 1, transIdx: 7, mat: (c) => [1, 0, 0, c[0], 0, 0, 1, c[1], 0, 1, 0, c[2], 0, 0, 0, 1] },
  };
  const nativeSliceId = (cell: string) => `nativeSlice-${cell}`;
  const ensureNativeSlices = (rasLo: Vec3, rasHi: Vec3, ijkToRAS: number[], center: Vec3) => {
    for (const [cell, def] of Object.entries(NATIVE_SLICE)) {
      const c = cells.get(cell); if (!c || c.el.style.display === "none") continue;
      const w = c.canvas.width || 1, h = c.canvas.height || 1;
      const [fovX, fovY, slab] = fitFovToVolume(c.orientKey, rasLo, rasHi, ijkToRAS, w, h);
      const id = nativeSliceId(cell);
      live.write({ op: "put", id, node: { type: "view", kind: "slice", id, name: cell, layoutName: cell, orientation: def.orientation, sliceToRAS: def.mat(center), fieldOfView: [fovX, fovY, slab], offset: center[def.axis], source: { local: true } } });
    }
    renderSlices();
  };
  /** Slicer SliceLink: is this cell's composite linkedControl on? (the toggle sets all composites together). */
  const compositeLinked = (cell: string): boolean => {
    const comp = [...live.nodes.values()].find((n) => n.type === "sliceComposite" && n.layoutName === cell);
    return !!comp?.linkedControl;
  };
  const linkStateOf = (cell: string): LinkSliceState | null => {
    const n = live.nodes.get(nativeSliceId(cell)); if (!n) return null;
    return { name: cell, sliceToRAS: n.sliceToRAS as number[], fieldOfView: (n.fieldOfView as [number, number, number]) ?? [250, 250, 1], viewGroup: 0 };
  };
  const normalOfMatrix = (m: number[]): Vec3 => { const v: Vec3 = [m[2], m[6], m[10]]; const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
  /** Propagate a change in `sourceCell` to linked native slice cells (vtkMRMLSliceLinkLogic rules). */
  const propagateLink = (sourceCell: string, flags: SliceLinkFlag[]): void => {
    if (!compositeLinked(sourceCell)) return;
    const src = linkStateOf(sourceCell); if (!src) return;
    const others = [...cells.keys()].map(linkStateOf).filter((x): x is LinkSliceState => !!x && x.name !== sourceCell);
    const updates = broadcastSlice(src, others, flags);
    for (const [cell, u] of updates) {
      const id = nativeSliceId(cell); if (!live.nodes.has(id)) continue;
      if (u.sliceToRAS) {
        live.write({ op: "patch", id, path: "#/sliceToRAS", value: u.sliceToRAS });
        const n = normalOfMatrix(u.sliceToRAS);                                   // keep the redundant offset field consistent
        live.write({ op: "patch", id, path: "#/offset", value: u.sliceToRAS[3] * n[0] + u.sliceToRAS[7] * n[1] + u.sliceToRAS[11] * n[2] });
      }
      if (u.fieldOfView) live.write({ op: "patch", id, path: "#/fieldOfView", value: u.fieldOfView });
    }
    renderSlices();
  };

  /** Move a native slice node's plane to offset `mm` along its CURRENT normal (works for reformatted cells
   *  whose orientation differs from the cell's original axis). Node-owned, persists, links to same-orientation
   *  views. Offset = signed distance of the plane origin along the normal (Slicer's convention). */
  const patchNativeOffset = (cell: string, mm: number): boolean => {
    const id = nativeSliceId(cell); const node = live.nodes.get(id); if (!node) return false;
    const m = (node.sliceToRAS as number[]).slice();
    const n = normalOfMatrix(m);
    const t: Vec3 = [m[3], m[7], m[11]];
    const cur = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    const d = mm - cur;
    m[3] = t[0] + d * n[0]; m[7] = t[1] + d * n[1]; m[11] = t[2] + d * n[2];
    live.write({ op: "patch", id, path: "#/sliceToRAS", value: m });
    live.write({ op: "patch", id, path: "#/offset", value: mm });
    propagateLink(cell, ["SliceToRAS"]);                                          // linked same-orientation views follow
    return true;   // the #/sliceToRAS upsert on the _changes feed hot-updates any dropped slice in 3D
  };

  // ── Slice Model / Drop-Slice (show a slice as a plane at its RAS location in 3D; hot-updates on scroll) ──
  const sliceIn3D = new Map<string, SlicePlaneField>();
  const unit = (v: Vec3): Vec3 => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
  /** Plane geometry + W/L for a cell's dropped slice, from its native slice node + background volume. */
  const slicePlaneOpts = (c: SliceCell) => {
    const bg = bgField(c); const node = live.nodes.get(nativeSliceId(c.name)); const m = node?.sliceToRAS as number[] | undefined;
    if (!bg || !m) return null;
    const origin: Vec3 = [m[3], m[7], m[11]];
    const normal = unit([m[2], m[6], m[10]]), uAxis = unit([m[0], m[4], m[8]]), vAxis = unit([m[1], m[5], m[9]]);
    const [lo, hi] = bg.aabb();
    let hu = 0, hv = 0;                                        // half-extents = the volume's in-plane reach from the origin
    for (const sx of [lo[0], hi[0]]) for (const sy of [lo[1], hi[1]]) for (const sz of [lo[2], hi[2]]) {
      const r: Vec3 = [sx - origin[0], sy - origin[1], sz - origin[2]];
      hu = Math.max(hu, Math.abs(r[0] * uAxis[0] + r[1] * uAxis[1] + r[2] * uAxis[2]));
      hv = Math.max(hv, Math.abs(r[0] * vAxis[0] + r[1] * vAxis[1] + r[2] * vAxis[2]));
    }
    const d = live.nodes.get(bgDisplayId(c) ?? "");
    const cr = bg.getClim(); const win = (d?.window as number) ?? (cr[1] - cr[0]); const lev = (d?.level as number) ?? (cr[0] + cr[1]) / 2;
    return { p2t: bg.patientToTexture(), origin, normal, uAxis, vAxis, halfExtU: hu, halfExtV: hv, clim: [lev - win / 2, lev + win / 2] as [number, number], halfThick: Math.max(0.25, (bg as { stepMm?: number }).stepMm ? (bg as { stepMm?: number }).stepMm! / 2 : 0.5), normScale: bg.normScaleOf() };
  };
  const sliceFieldKey = (cell: string) => "slice3d:" + cell;
  /** Toggle a cell's slice model in the 3D view. */
  const setSliceIn3D = (cell: string, on: boolean) => {
    const c = cells.get(cell); if (!c) return;
    if (!on) { if (sliceIn3D.delete(cell)) { fields3d.delete(sliceFieldKey(cell)); rebuild3d(); } return; }
    const opts = slicePlaneOpts(c); const bg = bgField(c); if (!opts || !bg) return;
    const f = new SlicePlaneField(bg.volumeTexture(), opts);
    sliceIn3D.set(cell, f); fields3d.set(sliceFieldKey(cell), f); rebuild3d();
    const node = live.nodes.get(nativeSliceId(cell)); if (node) live.write({ op: "patch", id: node.id, path: "#/visibleIn3D", value: true });
  };
  /** Hot-update every dropped slice's plane (called after an offset/geometry change) without a pipeline rebuild. */
  const refreshSlicesIn3D = () => {
    if (!sliceIn3D.size) return;
    for (const [cell, f] of sliceIn3D) { const c = cells.get(cell); const o = c ? slicePlaneOpts(c) : null; if (o) f.setPlane(o); }
    scene?.syncUniforms(); a3d.draw();
  };
  // A dropped slice is just another VIEW of the same nodes, so — like a Slicer displayable manager — it
  // re-derives from GRANULAR LiveScene changes rather than from hand-placed calls at each mutation site.
  // Everything a plane depends on (W/L + LUT on the display node, the background ref on the composite, the
  // volume geometry, a transform, the slice node's offset/orientation) arrives as a node upsert on the
  // _changes feed and hot-updates the plane. This is why W/L now reaches the plane with no extra wiring.
  const SLICE3D_DEPS = new Set(["scalarVolumeDisplay", "labelMapDisplay", "sliceComposite", "image", "transform", "colorTable", "view"]);
  live.subscribe((ch) => { if (sliceIn3D.size && (ch.kind === "reset" || (ch.type != null && SLICE3D_DEPS.has(ch.type)))) refreshSlicesIn3D(); });

  /** Reformat a native slice cell to a standard orientation through its current centre
   *  (vtkMRMLSliceNode::SetOrientation): rebuild the plane, update the cell's orientation so fit/offset math
   *  follow, re-render, and broadcast to linked views. */
  const reformatCell = (cell: string, orientation: Orientation): boolean => {
    const id = nativeSliceId(cell); const node = live.nodes.get(id); if (!node) return false;
    const m = node.sliceToRAS as number[]; const center: Vec3 = [m[3], m[7], m[11]];
    const nm = reformatSliceToRAS(orientation, center);
    const nrm = normalOfMatrix(nm);
    const c = cells.get(cell); if (c) c.orientKey = orientation;
    live.write({ op: "patch", id, path: "#/sliceToRAS", value: nm });
    live.write({ op: "patch", id, path: "#/orientation", value: orientation[0].toUpperCase() + orientation.slice(1) });
    live.write({ op: "patch", id, path: "#/offset", value: center[0] * nrm[0] + center[1] * nrm[1] + center[2] * nrm[2] });
    if (c) { const bg = bgField(c); if (bg) { const [lo, hi] = bg.aabb(); const w = c.canvas.width || 1, h = c.canvas.height || 1; const [fx, fy] = fitFovToVolume(orientation, lo, hi, [], w, h); c.slice.setMirrorFrame(orientation, center, fx, fy); c.branched = false; } }
    propagateLink(cell, ["Orientation"]);
    renderSlices();   // the slice-node upserts above hot-update any dropped slice in 3D via the _changes feed
    return true;
  };

  const NORMAL_OF = (c: SliceCell): Vec3 => c.plane?.basis ? c.plane.basis.nDir : c.orientKey === "axial" ? [0, 0, 1] : c.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
  /** A slice cell's current offset (mm along its normal), its [min,max,step] range, and a setter — the
   *  slice controller bar's data source. Works for native (node-owned) and peer (patched) cells. */
  const getSliceOffset = (cell: string): number | null => { const c = cells.get(cell); return c?.plane ? c.plane.posMm : null; };
  const sliceOffsetRange = (cell: string): { min: number; max: number; step: number } | null => {
    const c = cells.get(cell); const bg = c ? bgField(c) : null; if (!c || !bg) return null;
    const [lo, hi] = bg.aabb(), n = NORMAL_OF(c);
    const a = lo[0] * n[0] + lo[1] * n[1] + lo[2] * n[2], b = hi[0] * n[0] + hi[1] * n[1] + hi[2] * n[2];
    // step = the spacing along the normal (Slicer's GetSliceOffsetRangeResolution): the voxel size of the
    // volume axis most parallel to the slice normal (so a 1.3mm sagittal steps 1.3mm, a 1mm axial steps 1mm).
    let step = (bg as { stepMm?: number }).stepMm ?? 1;
    const comp = [...live.nodes.values()].find((nd) => nd.type === "sliceComposite" && nd.layoutName === c.name);
    const imgId = ((comp?.refs as Record<string, string[]> | undefined)?.background ?? [])[0];
    const m = imgId ? (live.nodes.get(imgId)?.ijkToRAS as number[] | undefined) : undefined;
    if (m) { let bestDot = 0; for (let ax = 0; ax < 3; ax++) { const dx = m[ax], dy = m[4 + ax], dz = m[8 + ax]; const sp = Math.hypot(dx, dy, dz) || 1; const dot = Math.abs((dx * n[0] + dy * n[1] + dz * n[2]) / sp); if (dot > bestDot) { bestDot = dot; step = sp; } } }
    return { min: Math.min(a, b), max: Math.max(a, b), step: step || 1 };
  };
  const fitCell = (cell: string): void => {
    const c = cells.get(cell), bg = c ? bgField(c) : null; if (!c || !bg) return;
    const [lo, hi] = bg.aabb();
    const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const w = c.canvas.width || 1, h = c.canvas.height || 1;
    const [fx, fy] = fitFovToVolume(c.orientKey, lo, hi, [], w, h);
    patchNativeOffset(cell, center[c.orientKey === "axial" ? 2 : c.orientKey === "coronal" ? 1 : 0]);
    c.slice.setMirrorFrame(c.orientKey, center, fx, fy); c.branched = false; renderSlice(c);
  };
  const setSliceOffset = (cell: string, mm: number): void => {
    const c = cells.get(cell); if (!c) return;
    if (patchNativeOffset(cell, mm)) return;                       // node-owned: sticks + re-renders via the DM
    if (!c.plane) return;
    c.plane.posMm = mm;
    const id = sliceNodeId(cell);
    if (id) live.write({ op: "patch", id, path: "#/offset", value: mm });   // peer follows
    renderSlice(c);
  };

  /** Jump every slice cell to a RAS point (Slicer's crosshair jump) — the native half of shift-move, so a
   *  standalone scene jumps without a Slicer peer. Sets each cell's out-of-plane position to ras·normal. */
  const jumpLocal = (ras: Vec3) => {
    for (const c of cells.values()) {
      if (c.el.style.display === "none") continue;
      const n: Vec3 = c.plane?.basis ? c.plane.basis.nDir : c.orientKey === "axial" ? [0, 0, 1] : c.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
      const mm = ras[0] * n[0] + ras[1] * n[1] + ras[2] * n[2];
      if (patchNativeOffset(c.name, mm)) continue;                                  // node-owned: sticks + re-renders via the DM
      if (!c.plane) continue;
      c.plane.posMm = mm;
      const id = sliceNodeId(c.name);
      if (id) live.write({ op: "patch", id, path: "#/offset", value: mm });         // peer's slices follow (transient)
      renderSlice(c);
    }
  };
  // ── native markups placement (W4): the interaction node + placer state machine drive put/patch ops ──
  let markupSeq = 0;
  const nextMarkupId = () => `local-markup-${++markupSeq}`;
  const INTERACTION_ID = "local-interaction";
  const ensureInteraction = () => {
    if (!live.nodes.has(INTERACTION_ID)) live.write({ op: "put", id: INTERACTION_ID, node: { type: "interaction", id: INTERACTION_ID, name: "Interaction", mode: "viewTransform", placeNodeId: "", markupType: "", placeModePersistence: false, source: { mrmlClass: "vtkMRMLInteractionNode" }, origin: { local: true } } });
    return live.nodes.get(INTERACTION_ID)!;
  };
  /** Start Slicer Place mode for a markup type (the markups panel calls this). */
  const startPlace = (markupType: MarkupType, persistent = false) => {
    ensureInteraction();
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/mode", value: "place" });
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/markupType", value: markupType });
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeModePersistence", value: persistent });
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: "" });
  };
  const endPlace = () => { if (live.nodes.has(INTERACTION_ID)) { live.write({ op: "patch", id: INTERACTION_ID, path: "#/mode", value: "viewTransform" }); live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: "" }); } };
  /** Store the type's measurements on a markup node (so the panel + annotations can show them). */
  const storeMeasurements = (id: string) => {
    const n = live.nodes.get(id); if (!n || n.type !== "markup") return;
    const t = n.markupType as MarkupType;
    const cps = ((n.controlPoints as { position: Vec3 }[] | undefined) ?? []).map((c) => c.position);
    if ((t === "curve" || t === "closedCurve") && cps.length >= 2) {
      const closed = t === "closedCurve";
      const lp = interpolateCurve(cps, closed);                          // Slicer's Cardinal-spline curve points
      live.write({ op: "patch", id, path: "#/linePoints", value: lp });  // DM renders the smooth spline
      const ms = closed
        ? [{ name: "length", value: polylineLength(lp, false), units: "mm" }, { name: "area", value: polygonArea(lp), units: "mm2" }]
        : [{ name: "length", value: polylineLength(lp, false), units: "mm" }];
      live.write({ op: "patch", id, path: "#/measurements", value: ms });
      return;
    }
    const ms = measurementsFor(t, cps, n.size as Vec3 | undefined);
    if (ms.length) live.write({ op: "patch", id, path: "#/measurements", value: ms });
  };
  /** Native placement click: create/extend the markup via the placer, update the interaction node. */
  const placeAtNative = (ras: Vec3): boolean => {
    const inter = live.nodes.get(INTERACTION_ID); if (!inter || inter.mode !== "place" || !inter.markupType) return false;
    const markupType = inter.markupType as MarkupType;
    const placeId = (inter.placeNodeId as string) || "";
    const node = placeId ? live.nodes.get(placeId) ?? null : null;
    const newId = placeId || nextMarkupId();
    const r = placeClick(markupType, node, ras, newId);
    for (const op of r.ops) live.write(op);
    storeMeasurements(r.nodeId);
    if (r.complete) {
      live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: "" });
      if (!inter.placeModePersistence) live.write({ op: "patch", id: INTERACTION_ID, path: "#/mode", value: "viewTransform" });
    } else {
      live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: r.nodeId });
    }
    renderSlices();
    return true;
  };
  addEventListener("resize", () => { resizeAll(); renderSlices(); a3d.draw(); });
  Object.assign(globalThis, { __live: live, __sync: sync, __cells: () => [...cells.keys()], __overlays: () => Object.fromEntries(overlays), __viewState: () => viewState, __brush: () => ({ effect: brushEffect(), diam: brushDiameterMm() }),
    __layers: () => Object.fromEntries([...cells].map(([k, c]) => [k, { bg: !!c.layers?.background, fg: c.layers?.foreground ? [c.layers.foreground.opacity, c.layers.foreground.compositing] : null, label: c.layers?.label ? c.layers.label.opacity : null, bgLut: !!c.layers?.background?.lut }])) });
  if (cfg.connect !== false) { sync.connect(); for (const p of peers) p.connect(); }   // peer connect is opt-in (native-first); standalone by default
  Object.assign(globalThis, {
    __peers: peers, __modules: () => [...moduleRegistry.modules.values()],
    // local (not node) slice-plane offsets per cell — the truth of a native jump/scroll (a peer-owned view
    // node can be re-asserted by the peer; pl.posMm is what the renderer actually shows)
    __cellPlanes: () => Object.fromEntries([...cells].filter(([, c]) => c.plane).map(([k, c]) => [k, c.plane!.posMm])),
    __jumpTo: (ras: Vec3) => jumpLocal(ras),
    // Reformat (W2): set a native slice cell to a standard orientation (vtkMRMLSliceNode::SetOrientation).
    __reformatCell: (cell: string, orientation: "axial" | "sagittal" | "coronal") => reformatCell(cell, orientation),
    // Slice linking (W2): toggle linkedControl on every sliceComposite (Slicer's link button), and read a
    // native slice node's plane/offset for tests.
    __setLinked: (on: boolean) => { for (const n of live.nodes.values()) if (n.type === "sliceComposite") live.write({ op: "patch", id: n.id, path: "#/linkedControl", value: on }); },
    __isLinked: () => [...live.nodes.values()].some((n) => n.type === "sliceComposite" && n.linkedControl),
    __sliceNode: (cell: string) => { const n = live.nodes.get(nativeSliceId(cell)); return n ? { orientation: n.orientation, offset: n.offset, sliceToRAS: n.sliceToRAS } : null; },
    __setSliceOffset: (cell: string, mm: number) => setSliceOffset(cell, mm),
    __setSliceIn3D: (cell: string, on: boolean) => setSliceIn3D(cell, on),
    __sliceIn3D: () => [...sliceIn3D.keys()],
    __sliceZoom: (cell: string) => { const c = cells.get(cell); return c ? c.slice.zoom(c.orientKey) : null; },
    // Markups (W4): place mode, list, delete a control point, and read a node's measurements.
    __startPlace: (markupType: MarkupType, persistent = false) => startPlace(markupType, persistent),
    __endPlace: () => endPlace(),
    __placeState: () => { const i = live.nodes.get("local-interaction"); return i ? { mode: i.mode, markupType: i.markupType, persistent: i.placeModePersistence, placeNodeId: i.placeNodeId } : null; },
    __markups: () => [...live.nodes.values()].filter((n) => n.type === "markup").map((n) => ({ id: n.id, markupType: n.markupType, name: n.name, points: ((n.controlPoints as { position: Vec3 }[] | undefined) ?? []).length, measurements: n.measurements ?? [], visible: n.visible !== false, locked: !!n.locked })),
    __removeControlPoint: (id: string, index: number) => { const n = live.nodes.get(id); if (!n) return false; const op = removeControlPointOp(n, index); if (op) { live.write(op); storeMeasurements(id); renderSlices(); return true; } live.write({ op: "del", id }); renderSlices(); return true; },
    __deleteMarkup: (id: string) => { if (live.nodes.has(id)) { live.write({ op: "del", id }); renderSlices(); return true; } return false; },
    __setMarkupProp: (id: string, prop: "visible" | "locked", value: boolean) => { if (live.nodes.has(id)) { live.write({ op: "patch", id, path: `#/${prop}`, value }); renderSlices(); return true; } return false; },
    __setGlyphScale: (scale: number) => { for (const n of live.nodes.values()) if (n.type === "markup") live.write({ op: "patch", id: n.id, path: "#/glyphScale", value: scale }); renderSlices(); },
    __glyphScale: () => { const m = [...live.nodes.values()].find((n) => n.type === "markup"); return (m?.glyphScale as number) ?? 3; },
  });
  return {
    live, sync, resize() { resizeAll(); renderSlices(); a3d.draw(); }, setCells,
    // W2: frame a volume in every slice cell (vtkMRMLSliceLogic::FitSliceToVolumes) — used on a native load
    // and by the controller "fit" button; the mirrored plane path (setMirrorFrame) still wins when a Slicer
    // peer streams a slice frame, so this only takes effect for standalone/native scenes.
    fitVolume(rasLo: Vec3, rasHi: Vec3, ijkToRAS: number[]) {
      const center: Vec3 = [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2];
      if (!sync.transport.isOpen) { ensureNativeSlices(rasLo, rasHi, ijkToRAS, center); return; }   // standalone: node-owned planes
      for (const c of cells.values()) {                                                             // peer: transient mirror frame
        if (c.el.style.display === "none") continue;
        const w = c.canvas.width || 1, h = c.canvas.height || 1;
        const [fovX, fovY] = fitFovToVolume(c.orientKey, rasLo, rasHi, ijkToRAS, w, h);
        c.slice.setMirrorFrame(c.orientKey, center, fovX, fovY);
      }
      renderSlices();
    },
    // numeric state for tests (render/introspect.ts): the 3D camera as a vtkCamera-comparable pose
    camera: () => ({ position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3, viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle }),
    cells: () => [...cells.keys()],
    getSliceOffset, setSliceOffset, sliceOffsetRange, setSliceIn3D, sliceIn3D: () => [...sliceIn3D.keys()],
    setSliceIntersections: (on: boolean) => { sliceIntersections = on; renderSlices(); },
    resetCamera3D, setOrthographic, isOrthographic: () => camera.parallelProjection,
    sliceIntersectionLines: (cell: string) => {
      const c = cells.get(cell); if (!c || !c.plane) return [];
      const ov = c.overlay, off = planeOffset01(c), aspect = ov.width / ov.height;
      const normalOf = (cc: SliceCell): Vec3 => cc.plane?.basis ? cc.plane.basis.nDir : cc.orientKey === "axial" ? [0, 0, 1] : cc.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
      const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const nc = normalOf(c), dc = c.plane.posMm; const out: { cell: string; a: [number, number]; b: [number, number] }[] = [];
      for (const o of cells.values()) {
        if (o === c || o.el.style.display === "none" || !o.plane) continue;
        const no = normalOf(o), dd0 = crossV(nc, no); const dd = dd0[0] ** 2 + dd0[1] ** 2 + dd0[2] ** 2; if (dd < 1e-9) continue;
        const co1 = crossV(no, dd0), co2 = crossV(dd0, nc);
        const p0: Vec3 = [(co1[0] * dc + co2[0] * o.plane.posMm) / dd, (co1[1] * dc + co2[1] * o.plane.posMm) / dd, (co1[2] * dc + co2[2] * o.plane.posMm) / dd];
        const pa = c.slice.rasToView(c.orientKey, off, [p0[0] + dd0[0] * 1e4, p0[1] + dd0[1] * 1e4, p0[2] + dd0[2] * 1e4], aspect);
        const pb = c.slice.rasToView(c.orientKey, off, [p0[0] - dd0[0] * 1e4, p0[1] - dd0[1] * 1e4, p0[2] - dd0[2] * 1e4], aspect);
        out.push({ cell: o.name, a: [pa.u, pa.v], b: [pb.u, pb.v] });
      }
      return out;
    },
    orientationOf: (cell: string) => cells.get(cell)?.orientKey ?? null,
    fitCell,
  };
}
