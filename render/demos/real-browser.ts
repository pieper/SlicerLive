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
import { lookAt, multiply, perspectiveZO, type Vec3 } from "../mat4.ts";
import { installIntrospection } from "../introspect.ts";
import { attachScenePick, attachSlicePick, createCrosshair, drawCross, rasToScreen3D } from "./crosshair.ts";

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

  // Slice stepping model (also gives per-plane voxel spacing for the markup slab test below).
  const sliceIx = new SliceInteractor({ ijkToRAS: rs.sv.ijkToRAS, rasLo: rasLo0, rasHi: rasHi0 });

  // --- markups: draw the scene's control points on the slices (2D overlay) + in 3D,
  // drag one to move it, or click it (2D or 3D) to jump all slices to it. ---
  const markups = rs.sv.markups;
  let draggingMarkup: typeof markups[number] | null = null;
  let hoverMarkup: typeof markups[number] | null = null;
  // rebuild the 3D control-point spheres from the (possibly edited) markup list + re-upload
  // uniforms (Tier-A syncUniforms — no pipeline rebuild), then re-render the 3D view.
  const refreshMarkups3D = () => {
    if (!rs.markupField) return;
    rs.markupField.setSpheres(markups.map((m) => ({ center: m.ras, radius: 9, color: [m.color[0], m.color[1], m.color[2], 1] })));
    rs.scene.syncUniforms();
    draw3d();
  };
  const nAxisOf: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
  // one transparent 2D canvas over each slice cell (pointer-events:none -> clicks fall through)
  const ovc: Record<string, HTMLCanvasElement> = {};
  const ov2d: Record<string, CanvasRenderingContext2D> = {};
  for (const p of [...planes, { cell: "threeD" as const }]) {   // +1 overlay over the 3D view for its crosshair
    const o = document.createElement("canvas");
    o.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:5px;background:transparent;";
    cv[p.cell].parentElement!.appendChild(o);
    ovc[p.cell] = o; ov2d[p.cell] = o.getContext("2d")!;
  }
  // Shared crosshair (SHIFT+move pick): set on a slice via viewToRas, in 3D via SceneRenderer.pick.
  const crosshair = createCrosshair(true);
  // Slicer parity (vtkSlicerMarkupsWidgetRepresentation2D): a control point is drawn on a
  // slice ONLY when it falls within that slice's slab — Slicer uses ±0.5mm for a 1-unit
  // slice; our slices snap to voxel planes, so the slab half is half the plane's voxel
  // spacing (the point belongs to exactly the slice that contains it). NO distance fade,
  // NO projection rings. The glyph is a filled disc in the markup colour, sized in screen
  // pixels like Slicer's default Sphere3D at GlyphScale=3 (diameter ≈ view-diagonal · 0.03).
  const slabHalfMm = (orient: "axial" | "coronal" | "sagittal") => Math.max(0.5, 0.5 * sliceIx.spacing(orient));
  const glyphRadiusPx = (w: number, h: number) => Math.max(5, Math.hypot(w, h) * 0.015);
  const drawOverlay = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }) => {
    const o = ovc[p.cell], ctx = ov2d[p.cell];
    const w = cv[p.cell].clientWidth, h = cv[p.cell].clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (o.width !== Math.floor(w * dpr)) { o.width = Math.floor(w * dpr); o.height = Math.floor(h * dpr); }
    ctx.setTransform(o.width / w, 0, 0, o.height / h, 0, 0);   // draw in CSS px
    ctx.clearRect(0, 0, w, h);
    const slab = slabHalfMm(p.orient), R = glyphRadiusPx(w, h);
    for (const m of markups) {
      const { u, v, distMm } = rs.slice.rasToView(p.orient, off[p.cell], m.ras, w / h);
      if (Math.abs(distMm) >= slab) continue;                   // only on the slice it belongs to
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const x = u * w, y = v * h;
      const active = m === draggingMarkup || m === hoverMarkup;
      ctx.fillStyle = `rgb(${m.color.map((c) => Math.round(c * 255)).join(",")})`;
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = active ? "#ffffff" : "rgba(0,0,0,0.6)";
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
    }
    if (crosshair.visible && crosshair.ras) {                   // the shared crosshair, projected onto this slice
      const c = rs.slice.rasToView(p.orient, off[p.cell], crosshair.ras, w / h);
      if (c.u >= 0 && c.u <= 1 && c.v >= 0 && c.v <= 1) drawCross(ctx, c.u * w, c.v * h);
    }
  };
  // the 3D crosshair, projected with the same view·proj the scene draws with
  const draw3dOverlay = () => {
    const o = ovc.threeD, ctx = ov2d.threeD;
    const w = cv.threeD.clientWidth, h = cv.threeD.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (o.width !== Math.floor(w * dpr)) { o.width = Math.floor(w * dpr); o.height = Math.floor(h * dpr); }
    ctx.setTransform(o.width / w, 0, 0, o.height / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (crosshair.visible && crosshair.ras) {
      const s = rasToScreen3D(camera, crosshair.ras, w, h);
      if (s) drawCross(ctx, s.x * w, s.y * h);
    }
  };
  // nearest markup on this slice to a click (u,v in [0,1]); Slicer picks within
  // ControlPointSize/2 + tolerance. Only points within the slab are pickable.
  const markupAtSlice = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }, u: number, v: number, w: number, h: number) => {
    const slab = slabHalfMm(p.orient);
    let best: typeof markups[number] | null = null, bestD = glyphRadiusPx(w, h) + 4;
    for (const m of markups) {
      const pr = rs.slice.rasToView(p.orient, off[p.cell], m.ras, w / h);
      if (Math.abs(pr.distMm) >= slab) continue;
      const d = Math.hypot((pr.u - u) * w, (pr.v - v) * h);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  };
  const jumpAll = (ras: Vec3) => {
    for (const q of planes) {
      const a = nAxisOf[q.orient];
      off[q.cell] = Math.max(0, Math.min(1, (ras[a] - rasLo0[a]) / (rasHi0[a] - rasLo0[a])));
      drawPlane(q);
    }
    draw3d();
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
    drawOverlay(p);   // markup glyphs on top
  };
  const draw3d = () => {
    if (!shown("threeD")) return;
    rs.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
    rs.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
    draw3dOverlay();   // crosshair on top
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
  // (sliceIx is constructed above so the markup slab test can read its per-plane spacing.)
  let focusedCell: "axial" | "coronal" | "sagittal" | null = null;
  // left-drag over a slice = scroll it (Slicer's standalone-4up default): up/right = forward,
  // down/left = back, one step per SCROLL_PX. Wheel + keys still work as before.
  const SCROLL_PX = 7;
  let sliceDrag: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal"; x: number; y: number; acc: number; moved: number } | null = null;
  // grab-or-bubble: a pointerdown on a control-point glyph GRABS it (drag = move the point,
  // in-plane, onto this slice; a tiny move = click = jump-all). Otherwise it falls through to
  // slice scroll. A moved markup re-appears/disappears across the other slices as it crosses them.
  let markDrag: { cell: "axial" | "coronal" | "sagittal"; moved: number } | null = null;
  // Slicer-style view navigation: middle-drag (or shift+left-drag) PANS, right-drag ZOOMS
  // (drag up = in), ctrl/⌘+wheel zooms about the cursor. Left-drag stays slice scroll.
  let viewDrag: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal"; mode: "pan" | "zoom"; x: number; y: number; pu: number; pv: number } | null = null;
  const cellUV = (cell: string, e: PointerEvent) => {
    const r = cv[cell].getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  };
  for (const p of planes) {
    cv[p.cell].addEventListener("contextmenu", (e) => e.preventDefault());   // right-drag = zoom
    cv[p.cell].addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {                        // ctrl/⌘ + wheel = zoom about the cursor
        const { u, v, w, h } = cellUV(p.cell, e);
        rs.slice.zoomAbout(p.orient, Math.exp(-e.deltaY * 0.0015), u, v, w, h);
        drawPlane(p);
        hook?.logEvent("sliceZoom", { cell: p.cell, via: "wheel", zoom: rs.slice.zoom(p.orient) });
        return;
      }
      off[p.cell] = sliceIx.wheel(p.orient, off[p.cell], e.deltaY < 0);   // deltaY<0 = MouseWheelForward
      drawPlane(p);
      hook?.logEvent("sliceStep", { cell: p.cell, via: "wheel", forward: e.deltaY < 0, offsetMm: offset01ToMm(p.orient, off[p.cell], rasLo0, rasHi0) });
    }, { passive: false });
    cv[p.cell].addEventListener("pointerdown", (e) => {
      if (e.button === 0 && isDoubleClick(p.cell, e)) return;   // double-click left -> maximize/restore
      const wantPan = e.button === 1 || (e.button === 0 && e.shiftKey);
      const wantZoom = e.button === 2;
      if (wantPan || wantZoom) {                           // pan / zoom the view
        e.preventDefault();
        const { u, v } = cellUV(p.cell, e);
        viewDrag = { cell: p.cell, orient: p.orient, mode: wantZoom ? "zoom" : "pan", x: e.clientX, y: e.clientY, pu: u, pv: v };
        cv[p.cell].style.cursor = wantZoom ? "ns-resize" : "grabbing";
        cv[p.cell].setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;                          // left = move a markup, else scroll
      e.preventDefault();
      const { u, v, w, h } = cellUV(p.cell, e);
      const grab = markups.length ? markupAtSlice(p, u, v, w, h) : null;
      if (grab) {                                          // GRAB the control point
        draggingMarkup = grab; hoverMarkup = grab; markDrag = { cell: p.cell, moved: 0 };
        cv[p.cell].style.cursor = "grabbing"; drawOverlay(p);
      } else {                                             // fall through to slice scroll
        sliceDrag = { cell: p.cell, orient: p.orient, x: e.clientX, y: e.clientY, acc: 0, moved: 0 };
      }
      cv[p.cell].setPointerCapture(e.pointerId);
    });
    cv[p.cell].addEventListener("pointermove", (e) => {
      if (viewDrag && viewDrag.cell === p.cell) {          // pan / zoom drag
        const dx = e.clientX - viewDrag.x, dy = e.clientY - viewDrag.y;
        const r = cv[p.cell].getBoundingClientRect();
        if (viewDrag.mode === "pan") rs.slice.panByPixels(p.orient, dx, dy, r.width, r.height);
        else rs.slice.zoomAbout(p.orient, Math.exp(dy * 0.006), viewDrag.pu, viewDrag.pv, r.width, r.height);   // drag DOWN = zoom in (pull toward you), matching the 3D view
        viewDrag.x = e.clientX; viewDrag.y = e.clientY;
        drawPlane(p);
        return;
      }
      if (draggingMarkup && markDrag?.cell === p.cell) {   // move the grabbed point onto this slice
        markDrag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
        const { u, v, w, h } = cellUV(p.cell, e);
        draggingMarkup.ras = rs.slice.viewToRas(p.orient, off[p.cell], u, v, w / h);
        for (const q of planes) drawOverlay(q);            // may cross into/out of other slices
        refreshMarkups3D();
        return;
      }
      if (sliceDrag && sliceDrag.cell === p.cell) {
        sliceDrag.moved += Math.abs(e.clientX - sliceDrag.x) + Math.abs(e.clientY - sliceDrag.y);
        sliceDrag.acc += (e.clientX - sliceDrag.x) - (e.clientY - sliceDrag.y);   // right/up = forward
        sliceDrag.x = e.clientX; sliceDrag.y = e.clientY;
        while (Math.abs(sliceDrag.acc) >= SCROLL_PX) {
          const fwd = sliceDrag.acc > 0;
          off[p.cell] = sliceIx.wheel(p.orient, off[p.cell], fwd);
          sliceDrag.acc -= fwd ? SCROLL_PX : -SCROLL_PX;
        }
        drawPlane(p);
        return;
      }
      if (e.buttons === 0 && markups.length) {             // idle hover -> highlight + grab cursor
        const { u, v, w, h } = cellUV(p.cell, e);
        const m = markupAtSlice(p, u, v, w, h);
        if (m !== hoverMarkup) { hoverMarkup = m; cv[p.cell].style.cursor = m ? "grab" : "default"; drawOverlay(p); }
      }
    });
    const endDrag = (e: PointerEvent) => {
      try { cv[p.cell].releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (viewDrag?.cell === p.cell) { viewDrag = null; cv[p.cell].style.cursor = "default"; return; }
      if (draggingMarkup && markDrag?.cell === p.cell) {   // finish a markup grab
        const wasClick = markDrag.moved < 5, m = draggingMarkup;
        draggingMarkup = null; markDrag = null; cv[p.cell].style.cursor = "grab";
        if (wasClick) { jumpAll(m.ras); hook?.logEvent("markupJump", { from: p.cell, ras: m.ras, label: m.label }); }
        else { hook?.logEvent("markupMove", { cell: p.cell, ras: m.ras, label: m.label }); for (const q of planes) drawOverlay(q); }
        return;
      }
      if (sliceDrag?.cell === p.cell) sliceDrag = null;
    };
    cv[p.cell].addEventListener("pointerup", endDrag);
    cv[p.cell].addEventListener("pointercancel", endDrag);
    // Slicer routes keys to the view under the pointer
    cv[p.cell].addEventListener("pointerenter", () => { focusedCell = p.cell; });
    cv[p.cell].addEventListener("pointerleave", () => { if (focusedCell === p.cell) focusedCell = null; });
  }
  globalThis.addEventListener("keydown", (e) => {
    if (!focusedCell) return;
    const p = planes.find((q) => q.cell === focusedCell);
    if (!p) return;
    if (e.key === "r" || e.key === "R") {                 // reset pan/zoom of the focused slice
      e.preventDefault();
      rs.slice.resetView(p.orient); drawPlane(p);
      hook?.logEvent("sliceResetView", { cell: p.cell });
      return;
    }
    if (!SliceInteractor.isStepKey(e.key)) return;
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
  // Nearest markup to a 3D-view click (client px), via the same view·proj the scene draws.
  const markupAt3D = (clientX: number, clientY: number) => {
    if (!markups.length) return null;
    const r = cv.threeD.getBoundingClientRect();
    const vp = multiply(perspectiveZO((camera.viewAngle * Math.PI) / 180, r.width / r.height, 1, 100000), lookAt(camera.position, camera.focalPoint, camera.viewUp));
    let best: typeof markups[number] | null = null, bestD = 16;
    for (const m of markups) {
      const p = m.ras;
      const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (cw <= 0) continue;
      const sx = r.left + ((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / cw * 0.5 + 0.5) * r.width;
      const sy = r.top + (1 - ((vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / cw * 0.5 + 0.5)) * r.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  };
  // Camera basis + world-per-pixel at a given RAS point (perspective) — for 3D markup drag.
  const camBasis = () => {
    const e = camera.position, f = camera.focalPoint, u0 = camera.viewUp;
    const fwd: Vec3 = [f[0] - e[0], f[1] - e[1], f[2] - e[2]];
    const fl = Math.hypot(...fwd) || 1; const fw: Vec3 = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
    const rt: Vec3 = [fw[1] * u0[2] - fw[2] * u0[1], fw[2] * u0[0] - fw[0] * u0[2], fw[0] * u0[1] - fw[1] * u0[0]];
    const rl = Math.hypot(...rt) || 1; const r: Vec3 = [rt[0] / rl, rt[1] / rl, rt[2] / rl];
    const up: Vec3 = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
    return { eye: e, fwd: fw, right: r, up };
  };
  const worldPerPx = (pt: Vec3, b: { eye: Vec3; fwd: Vec3 }, viewH: number) => {
    const dist = (pt[0] - b.eye[0]) * b.fwd[0] + (pt[1] - b.eye[1]) * b.fwd[1] + (pt[2] - b.eye[2]) * b.fwd[2];
    return 2 * Math.tan((camera.viewAngle * Math.PI) / 180 / 2) * Math.max(dist, 1) / viewH;
  };

  cv.threeD.addEventListener("contextmenu", (e) => e.preventDefault());  // right-drag = zoom
  let threeDDown: { x: number; y: number; moved: number } | null = null;
  let markDrag3D: typeof markups[number] | null = null;
  let hoverIdx3D = -1;   // hovered 3D markup index -> ghost full-opacity (setActive)
  const setActive3D = (idx: number) => {   // ghost: raise the hovered/dragged glyph to full opacity
    if (!rs.markupField || idx === hoverIdx3D) return;
    hoverIdx3D = idx; rs.markupField.setActive(idx); rs.scene.syncUniforms(); draw3d();
  };
  cv.threeD.addEventListener("pointerdown", (e) => {
    if (isDoubleClick("threeD", e)) return;   // double-click -> maximize/restore
    const { x, y } = localXY(e), { h } = viewSize();
    threeDDown = { x: e.clientX, y: e.clientY, moved: 0 };
    // GRAB a control point (left button) before handing the drag to the camera interactor
    const grab = e.button === 0 ? markupAt3D(e.clientX, e.clientY) : null;
    if (grab) { markDrag3D = grab; hoverMarkup = grab; setActive3D(markups.indexOf(grab)); }
    else interactor.start(e.button as 0 | 1 | 2, x, y, h, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
    cv.threeD.setPointerCapture(e.pointerId);
    hook?.logEvent("cameraStart", { action: markDrag3D ? "markupDrag" : interactor.action, x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
  });
  cv.threeD.addEventListener("pointerup", (e) => {
    interactor.end(); try { cv.threeD.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (markDrag3D) {                                             // finish a 3D markup grab
      const wasClick = !!threeDDown && threeDDown.moved < 5, m = markDrag3D;
      markDrag3D = null;
      if (wasClick) { jumpAll(m.ras); hook?.logEvent("markupJump", { from: "threeD", ras: m.ras, label: m.label }); }
      else hook?.logEvent("markupMove", { from: "threeD", ras: m.ras, label: m.label });
    }
    threeDDown = null;
  });
  cv.threeD.addEventListener("pointermove", (e) => {
    if (threeDDown) threeDDown.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (markDrag3D) {                                             // move the point in the camera plane
      const b = camBasis(), { h } = viewSize(), s = worldPerPx(markDrag3D.ras, b, h);
      const dx = e.movementX * s, dy = e.movementY * s;           // screen-down = -up
      markDrag3D.ras = [
        markDrag3D.ras[0] + b.right[0] * dx - b.up[0] * dy,
        markDrag3D.ras[1] + b.right[1] * dx - b.up[1] * dy,
        markDrag3D.ras[2] + b.right[2] * dx - b.up[2] * dy,
      ];
      refreshMarkups3D();
      for (const q of planes) drawOverlay(q);
      return;
    }
    if (interactor.action === "none") {
      // idle: hover-highlight the nearest 3D markup (ghost -> full opacity on hover)
      if (rs.markupField && markups.length && e.buttons === 0) {
        const m = markupAt3D(e.clientX, e.clientY);
        setActive3D(m ? markups.indexOf(m) : -1);
        cv.threeD.style.cursor = m ? "grab" : "default";
      }
      return;
    }
    const { x, y } = localXY(e), { w, h } = viewSize();
    interactor.move(x, y, w, h);
  });
  cv.threeD.addEventListener("pointerleave", () => setActive3D(-1));   // clear ghost hover
  cv.threeD.addEventListener("wheel", (e) => {
    e.preventDefault();
    interactor.wheel(e.deltaY < 0);   // browser: deltaY<0 = scroll away = VTK MouseWheelForward = zoom in
    hook?.logEvent("cameraWheel", { deltaY: e.deltaY, distance: camera.distance });
  }, { passive: false });

  // SHARED shift-move crosshair pick (identical in every demo): 3D via SceneRenderer.pick, each
  // slice via viewToRas; both jump all views to the RAS. jumpAll redraws slices + 3D (+overlays).
  attachScenePick(cv.threeD, rs.scene, crosshair, jumpAll);
  for (const p of planes) attachSlicePick(cv[p.cell], rs.slice, { orient: p.orient, offset: () => off[p.cell] }, crosshair, jumpAll);

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

  // markup harness hook: control points + a 3D-view projector so a test can click one
  (globalThis as unknown as { __realDbg: unknown }).__realDbg = {
    markups: () => markups.map((m) => ({ ras: m.ras, label: m.label })),
    offsets: () => Object.fromEntries(planes.map((p) => [p.cell, off[p.cell]])),
    slabHalfMm: (cell: "axial" | "coronal" | "sagittal") => slabHalfMm(cell),
    zoom: (cell: "axial" | "coronal" | "sagittal") => rs.slice.zoom(cell),
    markupActive: () => rs.markupField?.activeIndex ?? -1,   // hovered 3D glyph index (ghost full-opacity)
    crosshair: () => crosshair.ras,                          // shared shift-move crosshair RAS (null if unset)
    pick3D: (u: number, v: number) => rs.scene.pick(u, v),   // direct 3D pick (RAS at >=50% opacity)
    // count of glyphs actually drawn on a slice at its current offset (only on-slab points)
    drawnOn: (cell: "axial" | "coronal" | "sagittal") => {
      const p = planes.find((q) => q.cell === cell)!;
      const r = cv[cell].getBoundingClientRect();
      return markups.filter((m) => {
        const pr = rs.slice.rasToView(p.orient, off[cell], m.ras, r.width / r.height);
        return Math.abs(pr.distMm) < slabHalfMm(cell) && pr.u >= 0 && pr.u <= 1 && pr.v >= 0 && pr.v <= 1;
      }).length;
    },
    // client-px position + signed plane distance of a RAS point in a slice cell (for drag tests)
    sliceProject: (cell: "axial" | "coronal" | "sagittal", ras: Vec3) => {
      const p = planes.find((q) => q.cell === cell)!;
      const r = cv[cell].getBoundingClientRect();
      const pr = rs.slice.rasToView(p.orient, off[cell], ras, r.width / r.height);
      return { x: r.left + pr.u * r.width, y: r.top + pr.v * r.height, distMm: pr.distMm };
    },
    project3D: (ras: Vec3) => {
      const r = cv.threeD.getBoundingClientRect();
      const vp = multiply(perspectiveZO((camera.viewAngle * Math.PI) / 180, r.width / r.height, 1, 100000), lookAt(camera.position, camera.focalPoint, camera.viewUp));
      const cw = vp[3] * ras[0] + vp[7] * ras[1] + vp[11] * ras[2] + vp[15];
      return {
        x: r.left + ((vp[0] * ras[0] + vp[4] * ras[1] + vp[8] * ras[2] + vp[12]) / cw * 0.5 + 0.5) * r.width,
        y: r.top + (1 - ((vp[1] * ras[0] + vp[5] * ras[1] + vp[9] * ras[2] + vp[13]) / cw * 0.5 + 0.5)) * r.height,
      };
    },
  };
  resize();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
