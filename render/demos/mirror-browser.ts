// SlicerLive mirror — mirrors the live Slicer scene over the mrson live channel into a
// Four-Up layout (3 MPR slice cells + a 3D cell). LiveScene subscribes over WebSocket; its
// displayable managers drive a MirrorView: the volume manager builds the shared volume field
// (slices reslice it on load; the 3D cell shows it when VR is enabled), the slice manager sets
// each cell's reslice plane, the layout manager arranges the cells, camera/markups/ROI as before.
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import type { Field, ImageField } from "../fields.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import { LiveSync, type LiveStatus } from "../livesync.ts";
import { WsTransport } from "../transport.ts";
import type { Op } from "../liveops.ts";
import { installChrome, type VizControl } from "./sl-chrome.ts";
import {
  CameraDisplayableManager,
  type CameraState,
  LayoutDisplayableManager,
  LiveScene,
  MarkupsDisplayableManager,
  type MirrorView,
  RoiCropDisplayableManager,
  SegmentationDisplayableManager,
  SliceDisplayableManager,
  type SlicePlane,
  type Vec3,
  VolumeRenderingDisplayableManager,
} from "../livescene.ts";

const status = (m: string) => { const e = document.getElementById("status-text"); if (e) e.textContent = m; };
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;

const CELLS = ["red", "yellow", "green", "threeD"] as const;
const SLICE_CELLS = ["red", "yellow", "green"] as const;
type Cell = typeof CELLS[number];

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available"); return; }
  const p = new URLSearchParams(location.search);
  const host = p.get("host") ?? "localhost";
  const wsUrl = p.get("ws") ?? `ws://${host}:2132/`;
  const httpBase = p.get("http") ?? `http://${host}:2131/mrson/`;

  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const c of CELLS) {
    cv[c] = el("c-" + c);
    cx[c] = cv[c].getContext("webgpu") as GPUCanvasContext;
    cx[c].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }
  const dpr = Math.min(2, (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1);
  const resizeAll = () => { for (const c of CELLS) { cv[c].width = Math.max(1, Math.round(cv[c].clientWidth * dpr)); cv[c].height = Math.max(1, Math.round(cv[c].clientHeight * dpr)); } };
  resizeAll();

  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;
  const fields3d = new Map<string, Field>();
  let volumeField: ImageField | null = null;
  let volumeShown3D = false;
  let clip: { lo: Vec3; hi: Vec3 } | null = null;

  const slice = new SliceRenderer(gpu, srgb);
  let volumeReady = false;
  let segOverlay: GPUTexture | null = null;
  let segFill = 0.5;
  let segOutline = 1.0;
  const planes: Record<string, SlicePlane | undefined> = {};
  const visible = new Set<string>(CELLS);

  const clearCanvas = (c: string) => {
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: cx[c].getCurrentTexture().createView({ format: srgb }), clearValue: { r: 0.02, g: 0.024, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.end();
    gpu.device.queue.submit([enc.finish()]);
  };

  const a3d = mountAdaptive3d({
    scene: () => scene,
    view: () => cx.threeD.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: visible.has("threeD") ? cv.threeD.width : 0, h: cv.threeD.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
    movingScaleCap: 0.4,   // heavy segmentation DVR: ~0.4x res while moving -> ~60fps interactive (measured 16ms @0.33)
    target: 8,             // converge AA in ~0.8s after motion stops (not ~2.8s)

  });

  const renderSlice = (c: string) => {
    if (c === "threeD" || !visible.has(c)) return;
    if (!volumeReady) { clearCanvas(c); return; }
    const pl = planes[c];
    if (!pl) { clearCanvas(c); return; }
    const [lo, hi] = volumeField!.aabb();
    const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
    const off01 = Math.max(0, Math.min(1, (pl.posMm - lo[axis]) / Math.max(hi[axis] - lo[axis], 1e-6)));
    // mirror Slicer's pan + zoom when the slice node carries them, else the fitted view
    if (pl.centerRAS && pl.fovX && pl.fovY) slice.setMirrorFrame(pl.orient, pl.centerRAS as Vec3, pl.fovX, pl.fovY);
    else slice.resetView(pl.orient);
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

  const LAYOUTS: Record<string, Cell[]> = {
    fourUp: ["red", "yellow", "green", "threeD"], conventional: ["red", "yellow", "green", "threeD"],
    conventionalWidescreen: ["red", "yellow", "green", "threeD"], fourByThree: ["red", "yellow", "green", "threeD"],
    oneUp3D: ["threeD"], dual3D: ["threeD"], oneUpRed: ["red"], oneUpYellow: ["yellow"], oneUpGreen: ["green"],
  };
  const applyLayout = (name: string) => {
    const cells = LAYOUTS[name] ?? LAYOUTS.fourUp;
    visible.clear();
    for (const c of cells) visible.add(c);
    const grid = document.getElementById("grid")!;
    grid.style.gridTemplateColumns = cells.length === 1 ? "1fr" : "1fr 1fr";
    grid.style.gridTemplateRows = cells.length === 1 ? "1fr" : "1fr 1fr";
    for (const c of CELLS) document.getElementById("cell-" + c)!.classList.toggle("hidden", !visible.has(c));
    resizeAll();
    renderSlices();
    a3d.draw();
  };

  const view: MirrorView = {
    setField(k, f) { fields3d.set(k, f); rebuild3d(); },
    removeField(k) { if (fields3d.delete(k)) rebuild3d(); },
    // A field changed IN PLACE (markup point moved, colours, etc.): re-pack the material uniforms
    // (sphere/segment positions live there) so the change reaches the GPU — the render's flush()
    // then uploads it. Without this, redraw re-renders STALE uniforms and the glyph never moves.
    redraw() { scene?.syncUniforms(); a3d.draw(); },
    setCamera(c: CameraState) {
      camera.position = c.position as Vec3;
      camera.focalPoint = c.focalPoint as Vec3;
      camera.viewUp = c.viewUp as Vec3;
      if (c.viewAngle) camera.viewAngle = c.viewAngle;
      a3d.draw();
    },
    setClipBox(lo, hi) {
      clip = lo ? { lo, hi: hi! } : null;
      if (scene) { if (clip) scene.setClipBox(clip.lo, clip.hi); else scene.setClipPlanes([]); }
      a3d.draw();
    },
    setVolumeField(f, wl) {
      volumeField = f;
      if (f) {
        const [lo, hi] = f.aabb();
        slice.setVolume(f.patientToTexture(), lo, hi);
        slice.setTextures(f.volumeTexture(), segOverlay ?? undefined);
        if (wl) slice.setWindowLevel(wl.win, wl.lev);
        slice.setOverlayOpacity(segOverlay ? segFill : 0);
        slice.setOutlineOpacity(segOverlay ? segOutline : 0);
        volumeReady = true;
        renderSlices();
      } else {
        volumeReady = false;
        for (const c of SLICE_CELLS) clearCanvas(c);
      }
      rebuild3d();
    },
    showVolume3D(show) { volumeShown3D = show; rebuild3d(); },
    setSlicePlane(cell, pl) { planes[cell] = pl; renderSlice(cell); },
    setLayout(name) { applyLayout(name); },
    setSegmentationOverlay(tex, fillOpacity, outlineOpacity) {
      segOverlay = tex;
      segFill = fillOpacity;
      segOutline = outlineOpacity;
      if (volumeField) {
        slice.setTextures(volumeField.volumeTexture(), tex ?? undefined);
        slice.setOverlayOpacity(tex ? fillOpacity : 0);
        slice.setOutlineOpacity(tex ? outlineOpacity : 0);
      }
      renderSlices();
    },
  };

  addEventListener("resize", () => { resizeAll(); renderSlices(); a3d.draw(); });

  const markupsDM = new MarkupsDisplayableManager();
  const live = new LiveScene(httpBase, [
    new LayoutDisplayableManager(),
    new CameraDisplayableManager(),
    new VolumeRenderingDisplayableManager(gpu.device),
    new SliceDisplayableManager(),
    new SegmentationDisplayableManager(gpu.device, 1.5),   // σ=1.5 = the existing SlicerLive bake (repro Andrey's artifact)
    markupsDM,
    new RoiCropDisplayableManager(),
  ]);
  live.view = view;
  // LiveSync owns the wire: LiveScene is the pure data model; the WebSocket transport + outbound
  // coalescing + reconnect all live in LiveSync (ARCHITECTURE-2026-08-02 §2).
  const sync = new LiveSync(live, new WsTransport(wsUrl));

  // First LiveInterface Control: the SlicerLive logo popup toggles (ported from SegRoulette's chrome).
  // Each is a VizControl bound to a LiveScene node property — get() reads the model, set() does a
  // scene.write() (an mrson patch → LiveSync → Slicer MRML → the Qt GUI updates). The reverse: a
  // Slicer-side change lands on the _changes feed → chrome.refresh() flips the switch. This is a
  // Control (the DOM dual of a qMRML widget), bidirectional by construction.
  const nodeVisible = (type: string) => { const n = live.find(type); return !!(n && n.visible !== false); };
  const setNodeVisible = (type: string, on: boolean) => {
    const n = live.find(type);
    if (n) live.write({ op: "patch", id: n.id, path: "#/visible", value: on });
  };
  const controls: VizControl[] = [
    { label: "Volume rendering", disabled: () => !live.find("volumeRenderingDisplay"),
      get: () => nodeVisible("volumeRenderingDisplay"), set: (on) => setNodeVisible("volumeRenderingDisplay", on) },
    { label: "Segmentation", disabled: () => !live.find("segmentation"),
      get: () => nodeVisible("segmentation"), set: (on) => setNodeVisible("segmentation", on) },
  ];
  const chrome = installChrome({ controls, anchor: cv.threeD });
  live.subscribe((c) => { if (c.type === "volumeRenderingDisplay" || c.type === "segmentation") chrome.refresh(); });
  Object.assign(globalThis, { __live: live, __sync: sync });   // debug hook

  // Markup drag (SlicerLive -> Slicer): grab a 3D control-point glyph and move it in the plane
  // perpendicular to the view at its own depth. The local glyph follows the cursor immediately
  // (optimistic, every frame); the setControlPoint op is COALESCED (latest-wins per control point)
  // onto the wire by LiveSync — impedance matching between the pointer's rate and the transport.
  // pointer-up forces the authoritative final flush.
  let drag: { id: string; index: number; depth: number } | null = null;
  const HIT_PX = 16;
  const evPx = (e: PointerEvent) => ({ sx: e.offsetX * dpr, sy: e.offsetY * dpr });
  const pick = (sx: number, sy: number): typeof drag => {
    let best: typeof drag = null, bestD = HIT_PX * dpr;
    for (const hd of markupsDM.handles()) {
      const pr = camera.worldToDisplay(hd.ras, cv.threeD.width, cv.threeD.height);
      if (pr.depth <= 0) continue;
      const d = Math.hypot(pr.x - sx, pr.y - sy);
      if (d < bestD) { bestD = d; best = { id: hd.id, index: hd.index, depth: pr.depth }; }
    }
    return best;
  };
  const opFor = (sx: number, sy: number): { ras: number[]; op: Op } => {
    const ras = camera.displayToWorldAtDepth(sx, sy, drag!.depth, cv.threeD.width, cv.threeD.height);
    return { ras, op: { op: "cmd", id: drag!.id, cmd: "setControlPoint", args: { index: drag!.index, position: ras } } };
  };
  cv.threeD.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!visible.has("threeD")) return;
    const { sx, sy } = evPx(e);
    const h = pick(sx, sy);
    if (h) { drag = h; markupsDM.touch(h.id, h.index); cv.threeD.setPointerCapture(e.pointerId); cv.threeD.style.cursor = "grabbing"; e.preventDefault(); }
  });
  cv.threeD.addEventListener("pointermove", (e: PointerEvent) => {
    const { sx, sy } = evPx(e);
    if (!drag) { cv.threeD.style.cursor = pick(sx, sy) ? "grab" : "default"; return; }
    const { ras, op } = opFor(sx, sy);
    markupsDM.moveLocal(drag.id, drag.index, ras as Vec3, live);   // optimistic — every frame
    markupsDM.touch(drag.id, drag.index);                          // extend echo-suppression window
    sync.sendOps([op]);                                            // coalesced onto the wire by LiveSync
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    const { id, index } = drag;
    const { sx, sy } = evPx(e);
    sync.sendOps([opFor(sx, sy).op]);
    sync.flush();                                                  // authoritative final position, now
    markupsDM.touch(id, index);                                    // suppression auto-expires ~250ms later
    try { cv.threeD.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    cv.threeD.style.cursor = "default";
    drag = null;
  };
  cv.threeD.addEventListener("pointerup", endDrag);
  cv.threeD.addEventListener("pointercancel", endDrag);
  // Connection feedback + Gmail-style reconnect UI. LiveSync reconnects on its own (exponential
  // backoff) after a drop (e.g. laptop sleep); here we render the state and let "Try now" force it.
  const retryBtn = document.getElementById("status-retry") as HTMLButtonElement | null;
  const statusBar = document.getElementById("status");
  retryBtn?.addEventListener("click", () => sync.reconnectNow());
  let countdown: number | undefined;
  const stopCountdown = () => { if (countdown !== undefined) { clearInterval(countdown); countdown = undefined; } };
  const renderStatus = (s: LiveStatus) => {
    stopCountdown();
    if (s.state === "connected") {
      status("mirroring Slicer");
      statusBar?.classList.remove("down");
      if (retryBtn) retryBtn.hidden = true;
    } else if (s.state === "connecting") {
      status(s.attempt > 0 ? "reconnecting…" : "connecting to Slicer live channel…");
      statusBar?.classList.toggle("down", s.attempt > 0);
      if (retryBtn) retryBtn.hidden = true;
    } else {   // waiting — count down to the next automatic retry
      statusBar?.classList.add("down");
      if (retryBtn) retryBtn.hidden = false;
      const tick = () => {
        const secs = Math.max(0, Math.ceil((s.nextRetryAt - Date.now()) / 1000));
        status(`connection lost — reconnecting in ${secs}s`);
      };
      tick();
      countdown = setInterval(tick, 500) as unknown as number;
    }
  };
  sync.onStatus = renderStatus;
  await sync.connect();
}
main();
