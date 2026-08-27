// mountLiveViews — a SlicerLive 4-up (red/yellow/green/3D) driven by LiveScene displayable managers
// over the mrson channel, for use as the *view area* of a streamed legacy app. Local interaction
// (slice scroll/pan/zoom, 3D orbit) is written back to LiveScene as ops so the legacy app follows —
// the views are SlicerLive's, the state is shared. Trimmed from render/demos/mirror-browser.ts
// (no replay/timeline/chrome). TODO(DRY): mirror-browser should mount this too.
import type { Gpu } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import type { Field, ImageField } from "../fields.ts";
import { mountAdaptive3d } from "../demos/accum-loop.ts";
import { LiveSync } from "../livesync.ts";
import { WsTransport } from "../transport.ts";
import { CameraInteractor } from "../vtk-interactor.ts";
import { attachSliceControls } from "../demos/slice-control.ts";
import {
  CameraDisplayableManager, type CameraState, LayoutDisplayableManager, LiveScene, MarkupsDisplayableManager,
  type MirrorView, RoiCropDisplayableManager, SegmentationDisplayableManager, SliceDisplayableManager,
  type SlicePlane, type Vec3, VolumeRenderingDisplayableManager,
} from "../livescene.ts";

const CELLS = ["red", "yellow", "green", "threeD"] as const;
const SLICE_CELLS = ["red", "yellow", "green"] as const;
type Cell = typeof CELLS[number];
const CELL_ORIENT: Record<string, "axial" | "coronal" | "sagittal"> = { red: "axial", green: "coronal", yellow: "sagittal" };
const LAYOUTS: Record<string, Cell[]> = {
  fourUp: ["red", "yellow", "green", "threeD"], conventional: ["red", "yellow", "green", "threeD"],
  conventionalWidescreen: ["red", "yellow", "green", "threeD"], fourByThree: ["red", "yellow", "green", "threeD"],
  oneUp3D: ["threeD"], dual3D: ["threeD"], oneUpRed: ["red"], oneUpYellow: ["yellow"], oneUpGreen: ["green"],
};

export interface ViewCellRect { id: string; kind: string; name: string; view: { x: number; y: number; w: number; h: number } }
export interface LiveViews { live: LiveScene; sync: LiveSync; resize(): void; setCells(cells: ViewCellRect[]): void }

export function mountLiveViews(gpu: Gpu, grid: HTMLElement, cfg: { httpBase: string; wsUrl: string; onStatus?: (s: string) => void }): LiveViews {
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {}, cellEl: Record<string, HTMLElement> = {};
  grid.style.display = "grid"; grid.style.gap = "2px";
  let placedByCells = false;   // once the app reports view-cell rects, cells are positioned absolutely (the app is the layout engine)
  for (const c of CELLS) {
    const cell = document.createElement("div"); cell.className = "lv-cell"; cell.style.cssText = "position:relative;min-width:0;min-height:0";
    const lab = document.createElement("div"); lab.textContent = c === "threeD" ? "3D" : c[0].toUpperCase() + c.slice(1);
    lab.style.cssText = `position:absolute;top:4px;left:6px;font:700 11px system-ui;pointer-events:none;opacity:.85;color:${{ red: "#f05a5a", yellow: "#f0d24a", green: "#5ad07a", threeD: "#9fb3d0" }[c]}`;
    const canvas = document.createElement("canvas"); canvas.style.cssText = "width:100%;height:100%;display:block;background:#000;touch-action:none";
    cell.append(canvas, lab); grid.appendChild(cell);
    cv[c] = canvas; cellEl[c] = cell;
    cx[c] = canvas.getContext("webgpu") as GPUCanvasContext;
    cx[c].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const resizeAll = () => { for (const c of CELLS) { cv[c].width = Math.max(1, Math.round(cv[c].clientWidth * dpr)); cv[c].height = Math.max(1, Math.round(cv[c].clientHeight * dpr)); } };

  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;
  const fields3d = new Map<string, Field>();
  let volumeField: ImageField | null = null, volumeShown3D = false, volumeReady = false;
  let clip: { lo: Vec3; hi: Vec3 } | null = null;
  const slice = new SliceRenderer(gpu, srgb);
  let segOverlay: GPUTexture | null = null, segFill = 0.5, segOutline = 1.0;
  const planes: Record<string, SlicePlane | undefined> = {};
  const visible = new Set<string>(CELLS);

  const clearCanvas = (c: string) => {
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: cx[c].getCurrentTexture().createView({ format: srgb }), clearValue: { r: 0.02, g: 0.024, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.end(); gpu.device.queue.submit([enc.finish()]);
  };
  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => cx.threeD.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: visible.has("threeD") ? cv.threeD.width : 0, h: cv.threeD.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu, movingScaleCap: 0.4, target: 8,
  });
  const renderSlice = (c: string) => {
    if (c === "threeD" || !visible.has(c)) return;
    const pl = planes[c];
    if (!volumeReady || !pl) { clearCanvas(c); return; }
    const [lo, hi] = volumeField!.aabb();
    const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
    const off01 = Math.max(0, Math.min(1, (pl.posMm - lo[axis]) / Math.max(hi[axis] - lo[axis], 1e-6)));
    if (pl.centerRAS && pl.fovX && pl.fovY) slice.setMirrorFrame(pl.orient, pl.centerRAS as Vec3, pl.fovX, pl.fovY); else slice.resetView(pl.orient);
    slice.setPlane(pl.orient, off01);
    slice.renderToView(cx[c].getCurrentTexture().createView({ format: srgb }), cv[c].width, cv[c].height);
  };
  const renderSlices = () => { for (const c of SLICE_CELLS) renderSlice(c); };
  const rebuild3d = () => {
    const fs = [...fields3d.values()];
    if (volumeShown3D && volumeField) fs.unshift(volumeField);
    if (fs.length === 0) { scene = null; clearCanvas("threeD"); return; }
    if (!scene) scene = new SceneRenderer(gpu, srgb);
    scene.build(fs);
    if (clip) scene.setClipBox(clip.lo, clip.hi);
    a3d.draw();
  };
  const applyLayout = (name: string) => {
    if (placedByCells) return;                    // cell placement comes from the app's layout engine
    const cells = LAYOUTS[name] ?? LAYOUTS.fourUp;
    visible.clear(); for (const c of cells) visible.add(c);
    grid.style.gridTemplateColumns = cells.length === 1 ? "1fr" : "1fr 1fr";
    grid.style.gridTemplateRows = cells.length === 1 ? "1fr" : "1fr 1fr";
    for (const c of CELLS) cellEl[c].style.display = visible.has(c) ? "" : "none";
    resizeAll(); renderSlices(); a3d.draw();
  };

  const view: MirrorView = {
    setField(k, f) { fields3d.set(k, f); rebuild3d(); },
    removeField(k) { if (fields3d.delete(k)) rebuild3d(); },
    redraw() { scene?.syncUniforms(); a3d.draw(); },
    setCamera(c: CameraState) {
      if (cam3d.action !== "none") return;                       // we are orbiting: our pose is being written to Slicer
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
        volumeReady = true; renderSlices();
      } else { volumeReady = false; for (const c of SLICE_CELLS) clearCanvas(c); }
      rebuild3d();
    },
    showVolume3D(show) { volumeShown3D = show; rebuild3d(); },
    setSlicePlane(cell, pl) { planes[cell] = pl; renderSlice(cell); },
    setLayout(name) { applyLayout(name); },
    setSegmentationOverlay(tex, fillOpacity, outlineOpacity) {
      segOverlay = tex; segFill = fillOpacity; segOutline = outlineOpacity;
      if (volumeField) { slice.setTextures(volumeField.volumeTexture(), tex ?? undefined); slice.setOverlayOpacity(tex ? fillOpacity : 0); slice.setOutlineOpacity(tex ? outlineOpacity : 0); }
      renderSlices();
    },
  };

  const live = new LiveScene(cfg.httpBase, [
    new LayoutDisplayableManager(), new CameraDisplayableManager(), new VolumeRenderingDisplayableManager(gpu.device),
    new SliceDisplayableManager(), new SegmentationDisplayableManager(gpu.device, 1.5), new MarkupsDisplayableManager(), new RoiCropDisplayableManager(),
  ]);
  live.view = view;
  const sync = new LiveSync(live, new WsTransport(cfg.wsUrl));
  sync.onStatus = (s) => cfg.onStatus?.(s.state === "connected" ? "mirroring Slicer" : s.state === "connecting" ? "connecting…" : "connection lost — retrying");

  // ── local interaction → ops (Slicer follows) ──
  const nodeIdFor = (pred: (n: Record<string, unknown>) => boolean): string | null => {
    for (const [id, n] of (live as unknown as { nodes: Map<string, Record<string, unknown>> }).nodes) if (pred(n)) return id;
    return null;
  };
  const cam3d = new CameraInteractor(camera, () => { a3d.draw(); pushCamera(); });
  const pushCamera = () => {
    const id = nodeIdFor((n) => n.type === "camera");
    if (id) live.write({ op: "cmd", id, cmd: "setCameraPose", args: { position: camera.position, focalPoint: camera.focalPoint, viewUp: camera.viewUp } });
  };
  const xy3d = (e: PointerEvent) => { const r = cv.threeD.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.threeD.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.threeD.addEventListener("pointerdown", (e) => { const { x, y } = xy3d(e); cam3d.start(e.button as 0 | 1 | 2, x, y, cv.threeD.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }); cv.threeD.setPointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointermove", (e) => { if (cam3d.action === "none") return; const { x, y } = xy3d(e); cam3d.move(x, y, cv.threeD.clientWidth, cv.threeD.clientHeight); });
  const end3d = (e: PointerEvent) => { if (cam3d.action !== "none") { cam3d.end(); pushCamera(); sync.flush(); try { cv.threeD.releasePointerCapture(e.pointerId); } catch { /* */ } } };
  cv.threeD.addEventListener("pointerup", end3d); cv.threeD.addEventListener("pointercancel", end3d);
  cv.threeD.addEventListener("wheel", (e) => { e.preventDefault(); cam3d.wheel(e.deltaY < 0); pushCamera(); }, { passive: false });
  for (const c of SLICE_CELLS) {
    const layoutName = c[0].toUpperCase() + c.slice(1);
    attachSliceControls(cv[c], {
      orient: CELL_ORIENT[c], getSlice: () => slice,
      step: (fwd) => {
        const pl = planes[c]; if (!pl || !volumeField) return;
        const [lo, hi] = volumeField.aabb();
        const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
        pl.posMm = Math.max(lo[axis], Math.min(hi[axis], pl.posMm + (hi[axis] - lo[axis]) * 0.02 * (fwd ? -1 : 1)));
        const id = nodeIdFor((n) => n.type === "view" && n.kind === "slice" && n.layoutName === layoutName);
        if (id) live.write({ op: "patch", id, path: "#/offset", value: pl.posMm });   // Slicer's slice follows (parity-proven path)
      },
      redraw: () => renderSlice(c),
    });
  }
  addEventListener("resize", () => { resizeAll(); renderSlices(); a3d.draw(); });
  Object.assign(globalThis, { __live: live, __sync: sync });
  sync.connect();
  // Place the four cells at the rects the app laid out (window coords, relative to `grid`'s origin).
  // Names: Red/Yellow/Green slice views and 3D view "1"; other cells (Compare slices, 3D #2/#3) wait for
  // MirrorView v2 and are reported as unsupported.
  const NAME_TO_CELL: Record<string, Cell> = { Red: "red", Yellow: "yellow", Green: "green", "1": "threeD" };
  const setCells = (cells: ViewCellRect[]) => {
    placedByCells = true;
    grid.style.display = "block";
    const origin = grid.getBoundingClientRect();
    const shown = new Set<Cell>();
    for (const c of cells) {
      const cell = c.kind === "3d" || c.kind === "slice" ? NAME_TO_CELL[c.name] : undefined;
      if (!cell) { if (c.kind === "slice" || c.kind === "3d") console.warn("live-views: unsupported view cell", c.kind, c.name); continue; }
      const el = cellEl[cell];
      el.style.cssText = `position:absolute;left:${c.view.x - origin.left}px;top:${c.view.y - origin.top}px;width:${c.view.w}px;height:${c.view.h}px`;
      shown.add(cell);
    }
    visible.clear();
    for (const c of CELLS) { if (shown.has(c)) visible.add(c); else cellEl[c].style.display = "none"; }
    resizeAll(); renderSlices(); a3d.draw();
  };
  return { live, sync, resize() { resizeAll(); renderSlices(); a3d.draw(); }, setCells };
}
