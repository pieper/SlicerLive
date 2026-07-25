// Browser entry for the REAL-scene 4-up demo: loads a live SlicerLive scene
// (zarr volume streamed from the JS2 bucket, gunzipped in-browser) and renders
// three orthogonal MPR planes (real windowed grayscale) + a 3D volume-render —
// all with the SAME TS/WebGPU code the headless Deno tests run. Bundled to
// live/webgpu/real.js. Scroll a slice to scrub; drag the 3D view to orbit, wheel to zoom.
import { initDevice } from "../device.ts";
import { buildRealScene } from "./real-scene.ts";
import { slicerDefaultOffset01 } from "../slice-renderer.ts";
import { VtkCamera } from "../vtk-camera.ts";
import { CameraInteractor } from "../vtk-interactor.ts";
import { SliceInteractor, mmToOffset01, offset01ToMm } from "../slice-interactor.ts";
import type { Vec3 } from "../mat4.ts";
import { installIntrospection } from "../introspect.ts";

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLCanvasElement;

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const sceneUrl = new URLSearchParams(location.search).get("scene") ??
    "https://pieper.github.io/live/legacy/scenes/MRHead.json";

  status("initializing WebGPU…");
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "coronal", "sagittal", "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = el("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  let mb = 0;
  status("streaming volume from the bucket…");
  const rs = await buildRealScene(gpu, sceneUrl, srgb, (n) => { mb += n; status(`streaming volume… ${(mb / 1e6).toFixed(1)} MB`); });

  // Each MPR canvas renders its own anatomical (RAS) plane — the reslice is
  // intrinsically anatomical, so no IJK-axis mapping is needed.
  const planes = [
    { cell: "axial", orient: "axial" },
    { cell: "coronal", orient: "coronal" },
    { cell: "sagittal", orient: "sagittal" },
  ] as const;
  // Slicer parity: slices default to the snapped voxel-centre plane, not the bbox centre.
  const [rasLo0, rasHi0] = rs.sv.field.aabb();
  const off: Record<string, number> = {
    axial: slicerDefaultOffset01("axial", rs.sv.dims, rs.sv.ijkToRAS, rasLo0, rasHi0),
    coronal: slicerDefaultOffset01("coronal", rs.sv.dims, rs.sv.ijkToRAS, rasLo0, rasHi0),
    sagittal: slicerDefaultOffset01("sagittal", rs.sv.dims, rs.sv.ijkToRAS, rasLo0, rasHi0),
  };

  // Slicer's DEFAULT 3D camera (vtkMRMLCameraNode): position (0,500,0), focalPoint at the
  // RAS ORIGIN (not the volume centre), viewUp +S, viewAngle 30. Slicer does not refit the
  // camera when a volume is loaded, so parity means adopting the same fixed default.
  const camera = VtkCamera.slicerDefault();
  const interactor = new CameraInteractor(camera, () => draw3d());

  const shown = (n: string) => cv[n].width > 0 && cv[n].height > 0;   // a maximized-away cell has 0 size
  const drawPlane = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }) => {
    if (!shown(p.cell)) return;
    rs.slice.setPlane(p.orient, off[p.cell]);
    rs.slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    if (!shown("threeD")) return;
    rs.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
    rs.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  const drawAll = () => { for (const p of planes) drawPlane(p); draw3d(); status(`${rs.sv.name} · real ${rs.sv.dims.join("×")} · left-drag a slice to scroll · double-click to maximize · drag 3D to orbit`); };

  // Cells now fill the page (non-square). Size the drawing buffer to each canvas's actual
  // client rect; a hidden (maximized-away) cell reports 0 and is left at 0 so we skip it.
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) {
      cv[n].width = Math.floor(cv[n].clientWidth * dpr);
      cv[n].height = Math.floor(cv[n].clientHeight * dpr);
    }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);

  // --- double-click a view to MAXIMIZE it (fill the 4-up), double-click again to restore.
  // The layout is a CSS grid of separate canvases, so maximize is a class toggle + resize.
  // Detected from pointerdown timing (slice drags preventDefault, which suppresses dblclick).
  const grid = document.getElementById("grid")!;
  const cellDiv = (cell: string) => grid.querySelector<HTMLElement>(`.cell[data-cell="${cell}"]`)!;
  let maxCell: string | null = null;
  const toggleMax = (cell: string) => {
    maxCell = maxCell === cell ? null : cell;
    for (const n of names) cellDiv(n).classList.toggle("max", n === maxCell);
    grid.classList.toggle("has-max", maxCell !== null);
    requestAnimationFrame(resize);   // let the grid re-layout, then re-size the buffers
  };
  let lastDown: { t: number; x: number; y: number; cell: string } | null = null;
  const isDoubleClick = (cell: string, e: PointerEvent): boolean => {
    const dbl = !!lastDown && lastDown.cell === cell && (e.timeStamp - lastDown.t) < 350 &&
      Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
    lastDown = dbl ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY, cell };
    if (dbl) { e.preventDefault(); e.stopPropagation(); toggleMax(cell); }
    return dbl;
  };

  // Slice-view stepping — Slicer's vtkMRMLSliceIntersectionWidget semantics:
  // wheel fwd / f / Right / Up = increment by the volume spacing along the slice normal;
  // back / b / Left / Down = decrement; steps outside the slice bounds are rejected.
  const sliceIx = new SliceInteractor({ ijkToRAS: rs.sv.ijkToRAS, rasLo: rasLo0, rasHi: rasHi0 });
  let focusedCell: "axial" | "coronal" | "sagittal" | null = null;
  // left-drag over a slice = scroll it (Slicer's standalone-4up default): up/right = forward,
  // down/left = back, one step per SCROLL_PX. Wheel + keys still work as before.
  const SCROLL_PX = 7;
  let sliceDrag: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal"; x: number; y: number; acc: number } | null = null;
  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => {
      e.preventDefault();
      off[p.cell] = sliceIx.wheel(p.orient, off[p.cell], e.deltaY < 0);   // deltaY<0 = MouseWheelForward
      drawPlane(p);
      hook?.logEvent("sliceStep", { cell: p.cell, via: "wheel", forward: e.deltaY < 0, offsetMm: offset01ToMm(p.orient, off[p.cell], rasLo0, rasHi0) });
    }, { passive: false });
    cv[p.cell].addEventListener("pointerdown", (e) => {
      if (isDoubleClick(p.cell, e)) return;                // double-click -> maximize/restore
      if (e.button !== 0) return;                          // left = scroll
      e.preventDefault();
      sliceDrag = { cell: p.cell, orient: p.orient, x: e.clientX, y: e.clientY, acc: 0 };
      cv[p.cell].setPointerCapture(e.pointerId);
    });
    cv[p.cell].addEventListener("pointermove", (e) => {
      if (!sliceDrag || sliceDrag.cell !== p.cell) return;
      sliceDrag.acc += (e.clientX - sliceDrag.x) - (e.clientY - sliceDrag.y);   // right/up = forward
      sliceDrag.x = e.clientX; sliceDrag.y = e.clientY;
      while (Math.abs(sliceDrag.acc) >= SCROLL_PX) {
        const fwd = sliceDrag.acc > 0;
        off[p.cell] = sliceIx.wheel(p.orient, off[p.cell], fwd);
        sliceDrag.acc -= fwd ? SCROLL_PX : -SCROLL_PX;
      }
      drawPlane(p);
    });
    const endDrag = (e: PointerEvent) => { if (sliceDrag?.cell === p.cell) { sliceDrag = null; try { cv[p.cell].releasePointerCapture(e.pointerId); } catch { /* already released */ } } };
    cv[p.cell].addEventListener("pointerup", endDrag);
    cv[p.cell].addEventListener("pointercancel", endDrag);
    // Slicer routes keys to the view under the pointer
    cv[p.cell].addEventListener("pointerenter", () => { focusedCell = p.cell; });
    cv[p.cell].addEventListener("pointerleave", () => { if (focusedCell === p.cell) focusedCell = null; });
  }
  globalThis.addEventListener("keydown", (e) => {
    if (!focusedCell || !SliceInteractor.isStepKey(e.key)) return;
    const p = planes.find((q) => q.cell === focusedCell);
    if (!p) return;
    e.preventDefault();
    off[p.cell] = sliceIx.key(p.orient, off[p.cell], e.key);
    drawPlane(p);
    hook?.logEvent("sliceStep", { cell: p.cell, via: "key", key: e.key, offsetMm: offset01ToMm(p.orient, off[p.cell], rasLo0, rasHi0) });
  });
  // 3D view interaction — Slicer's vtkMRMLCameraWidget bindings, verbatim:
  //   left=rotate · left+shift / middle=pan · right / left+shift+ctrl=zoom · left+ctrl=spin
  const viewSize = () => ({ w: cv.threeD.clientWidth, h: cv.threeD.clientHeight });
  const localXY = (e: PointerEvent | MouseEvent) => {
    const r = cv.threeD.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  cv.threeD.addEventListener("contextmenu", (e) => e.preventDefault());  // right-drag = zoom
  cv.threeD.addEventListener("pointerdown", (e) => {
    if (isDoubleClick("threeD", e)) return;   // double-click -> maximize/restore
    const { x, y } = localXY(e), { h } = viewSize();
    interactor.start(e.button as 0 | 1 | 2, x, y, h, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
    cv.threeD.setPointerCapture(e.pointerId);
    hook?.logEvent("cameraStart", { action: interactor.action, x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
  });
  cv.threeD.addEventListener("pointerup", (e) => { interactor.end(); cv.threeD.releasePointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointermove", (e) => {
    if (interactor.action === "none") return;
    const { x, y } = localXY(e), { w, h } = viewSize();
    interactor.move(x, y, w, h);
  });
  cv.threeD.addEventListener("wheel", (e) => {
    e.preventDefault();
    interactor.wheel(e.deltaY < 0);   // browser: deltaY<0 = scroll away = VTK MouseWheelForward = zoom in
    hook?.logEvent("cameraWheel", { deltaY: e.deltaY, distance: camera.distance });
  }, { passive: false });

  // --- automation/introspection hook for the Slicer A/B harness ----------------
  const [rasLo, rasHi] = rs.sv.field.aabb();
  const hook = installIntrospection({
    getCamera: () => ({
      azimuth: 0, elevation: 0, distance: camera.distance,   // orbit params retired; vtkCamera state is authoritative
      position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3,
      viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle,
    }),
    setCamera: (p) => {
      if (p.position) camera.position = [...p.position] as Vec3;
      if (p.focalPoint) camera.focalPoint = [...p.focalPoint] as Vec3;
      if (p.viewUp) camera.viewUp = [...p.viewUp] as Vec3;
      if (p.viewAngle !== undefined) camera.viewAngle = p.viewAngle;
      draw3d();
    },
    getPlanes: () => {
      const out: Record<string, { orient: string; offset01: number; offsetMm: number; rasMm: number; spanMm: number; spacing: number; bounds: [number, number] }> = {};
      const nAxis: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
      for (const p of planes) {
        const a = nAxis[p.orient];
        out[p.cell] = { orient: p.orient, offset01: off[p.cell], offsetMm: offset01ToMm(p.orient, off[p.cell], rasLo, rasHi), rasMm: rasLo[a] + off[p.cell] * (rasHi[a] - rasLo[a]), spanMm: rs.slice.spanMmFor(p.orient), spacing: sliceIx.spacing(p.orient), bounds: sliceIx.bounds(p.orient) };
      }
      return out;
    },
    setPlane: (cell, offset01) => {
      off[cell] = Math.max(0, Math.min(1, offset01));
      const p = planes.find((q) => q.cell === cell);
      if (p) drawPlane(p);
    },
    getVolume: () => ({
      name: rs.sv.name, dims: rs.sv.dims, ijkToRAS: rs.sv.ijkToRAS,
      rasLo, rasHi, window: rs.sv.win, level: rs.sv.lev,
    }),
    viewToVoxel: (cell, u, v) => {
      const p = planes.find((q) => q.cell === cell);
      if (!p) throw new Error("unknown cell " + cell);
      rs.slice.setPlane(p.orient, off[cell]);
      const t = rs.slice.viewToTex(u, v);
      const [X, Y, Z] = rs.sv.dims;
      return [
        Math.max(0, Math.min(X - 1, Math.round(t[0] * X - 0.5))),
        Math.max(0, Math.min(Y - 1, Math.round(t[1] * Y - 0.5))),
        Math.max(0, Math.min(Z - 1, Math.round(t[2] * Z - 0.5))),
      ];
    },
    stepSlice: (cell: string, forward: boolean) => {
      const p = planes.find((q) => q.cell === cell);
      if (!p) throw new Error("unknown cell " + cell);
      off[p.cell] = sliceIx.wheel(p.orient, off[p.cell], forward);
      drawPlane(p);
      return offset01ToMm(p.orient, off[p.cell], rasLo, rasHi);
    },
    keySlice: (cell: string, key: string) => {
      const p = planes.find((q) => q.cell === cell);
      if (!p) throw new Error("unknown cell " + cell);
      off[p.cell] = sliceIx.key(p.orient, off[p.cell], key);
      drawPlane(p);
      return offset01ToMm(p.orient, off[p.cell], rasLo, rasHi);
    },
    setSliceOffsetMm: (cell: string, mm: number) => {
      const p = planes.find((q) => q.cell === cell);
      if (!p) throw new Error("unknown cell " + cell);
      off[p.cell] = mmToOffset01(p.orient, mm, rasLo, rasHi);
      drawPlane(p);
      return offset01ToMm(p.orient, off[p.cell], rasLo, rasHi);
    },
    render: () => drawAll(),
  });
  // log every interaction so the harness can prove WHICH binding fired
  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => hook.logEvent("wheel", { cell: p.cell, deltaY: e.deltaY, offset01: off[p.cell] }), { passive: true });
    cv[p.cell].addEventListener("pointerdown", (e) => hook.logEvent("pointerdown", { cell: p.cell, x: e.offsetX, y: e.offsetY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }));
  }
  cv.threeD.addEventListener("pointerdown", (e) => hook.logEvent("pointerdown", { cell: "threeD", x: e.offsetX, y: e.offsetY, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey }));
  cv.threeD.addEventListener("wheel", (e) => hook.logEvent("wheel", { cell: "threeD", deltaY: e.deltaY, distance: camera.distance }), { passive: true });

  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
