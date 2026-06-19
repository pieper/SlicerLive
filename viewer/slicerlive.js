/*
 * Desktopia 3D-offload OVERLAY (MRML-level sync). Loaded by the streamed-desktop client (:4434) from the
 * scene server (:2027). Holds a MIRROR of the MRML nodes in the 3D view's reference closure and runs JS
 * "displayable managers" that translate node state -> vtk.js actors -- the same model Slicer uses. Show/
 * hide is a display-node attribute a DM applies (deterministic), not a VTK-call-list diff. Renders on the
 * client GPU and composites over the streamed desktop (key-masked) with native interaction + popup routing.
 *
 * Bundled with vtk.js by build.sh -> offload-bundle.js.
 */
import '@kitware/vtk.js/Rendering/Profiles/All';
import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkOpenGLRenderWindow from '@kitware/vtk.js/Rendering/OpenGL/RenderWindow';
import vtkRenderWindowInteractor from '@kitware/vtk.js/Rendering/Core/RenderWindowInteractor';
import vtkInteractorStyleManipulator from '@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator';
import vtkMouseCameraTrackballRotateManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator';
import vtkMouseCameraTrackballPanManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator';
import vtkMouseCameraTrackballZoomManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator';
import vtkGestureCameraManipulator from '@kitware/vtk.js/Interaction/Manipulators/GestureCameraManipulator';
import vtkCompositeMouseManipulator from '@kitware/vtk.js/Interaction/Manipulators/CompositeMouseManipulator';
import macro from '@kitware/vtk.js/macros';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkImageMapper from '@kitware/vtk.js/Rendering/Core/ImageMapper';   // SlicerLive 4-up: ortho slice display
import vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import vtkImageResliceMapper from '@kitware/vtk.js/Rendering/Core/ImageResliceMapper';   // MPR: reslice CT + labelmap on a world plane
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes';   // segment surfaces from the labelmap
import vtkScalarBarActor from '@kitware/vtk.js/Rendering/Core/ScalarBarActor';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';   // SlicerLive: read .vtp models client-side
import vtkPolyDataReader from '@kitware/vtk.js/IO/Legacy/PolyDataReader';      // SlicerLive: read legacy .vtk models
import { slicerLiveLogo, slicerLiveMark } from './sllogo.js';                 // SlicerLive brand mark (3D Slicer logo + gold fractal lightning)

const OFFLOAD_BUILD = 'slicerlive-v1o idc-clientside 2026-06-15';
window.__offloadBuild = OFFLOAD_BUILD;
console.log('%c[offload] BUILD ' + OFFLOAD_BUILD, 'color:#7fe0a0;font-weight:bold');
try { window.dispatchEvent(new CustomEvent('offload-build', { detail: OFFLOAD_BUILD })); } catch (e) {}
const SCENE = (window.__OFFLOAD_BASE != null) ? window.__OFFLOAD_BASE : `${location.origin}/offload`;   // proxy routes /offload/ -> :2027; the DM-debug harness overrides via window.__OFFLOAD_BASE (same-origin '')
const STANDALONE = !!window.__OFFLOAD_STANDALONE;   // DM-debug harness: render the vtk.js view full-window, no video / no desktop compositor
const SLICERLIVE = !!window.__SLICERLIVE_SCENE_URL || !!window.__IDC_CT || !!window.__SEGROULETTE;  // scene URL, client-side IDC, or SEGRoulette -- no server
const VIEW = 0;
const KEY = [255, 0, 255];   // server keyhole chroma key (keep in sync with _KEYHOLE_RGB)
const KEY_TOL = 70;

// --- compositing layers (unchanged from the VTK-path overlay) -----------------------------------------
const host = document.createElement('div');     // the vtk.js GL canvas: on-screen, opacity:0, INTERACTIVE
host.id = 'offload3d';
host.style.cssText = 'position:fixed; z-index:5; display:none; opacity:0; pointer-events:auto; outline:none;';
host.tabIndex = 0;
document.body.appendChild(host);
const out = document.createElement('canvas');   // VISIBLE masked compositor; pointer-events:none (click-through)
out.id = 'offload3d-out';
out.style.cssText = 'position:fixed; z-index:6; display:none; pointer-events:none;';
document.body.appendChild(out);
const outCtx = out.getContext('2d');
const maskCv = document.createElement('canvas');
const maskCtx = maskCv.getContext('2d', { willReadFrequently: true });
let geom = null, maskHit = null, maskActive = false;

// --- vtk.js render setup (plain render window; DMs add actors/volumes to ONE renderer) ----------------
const renderWindow = vtkRenderWindow.newInstance();
const renderer = vtkRenderer.newInstance({ background: [0, 0, 0] });
renderWindow.addRenderer(renderer);
renderer.createLight();   // create the head-light NOW: else the volume's first render counts 0 lights and compiles a
                          // dark (ambient-only) shader -> VR stays dark until an interaction forces a lit-shader rebuild
const glWindow = vtkOpenGLRenderWindow.newInstance();
glWindow.setContainer(host);
glWindow.get3DContext({ preserveDrawingBuffer: true });   // create ctx now (canvas caches it) so readPixels can read the IDLE/live frame
renderWindow.addView(glWindow);
const interactor = vtkRenderWindowInteractor.newInstance();
interactor.setView(glWindow);
interactor.initialize();
interactor.setCurrentRenderer(renderer);

// Reliable VR test that does NOT use grab() (grab forces a full render, masking the "blank until interaction"
// bug). Renders once, then reads the ACTUAL framebuffer: samples a grid in the 3D quadrant (top-right of the
// 4-up) and counts pixels that differ from the quadrant's background corner -> how much of the volume drew.
window.__vrCheck = (forceRender = true) => {
  try {
    if (forceRender) renderWindow.render();
    const gl = glWindow.get3DContext();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);   // read the PRESENTED default framebuffer, not vtk.js's leftover offscreen FBO
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(4), bg = new Uint8Array(4);
    gl.readPixels(Math.round(W * 0.98), Math.round(H * 0.98), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bg);  // 3D-quadrant bg corner
    let vol = 0, tot = 0;
    for (let fx = 0.55; fx <= 0.97; fx += 0.03) for (let fy = 0.55; fy <= 0.97; fy += 0.03) {
      gl.readPixels(Math.round(W * fx), Math.round(H * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      tot++;
      const d = Math.abs(px[0] - bg[0]) + Math.abs(px[1] - bg[1]) + Math.abs(px[2] - bg[2]);
      if (d > 40) vol++;   // differs from background -> volume drew here
    }
    return JSON.stringify({ volumePixels: vol, total: tot, bg: [bg[0], bg[1], bg[2]], W, H });
  } catch (e) { return 'err:' + (e && e.message || e); }
};
window.__slRW = renderWindow; window.__slGW = glWindow; window.__slRen = renderer;
// Programmatic "mouse nudge" — dispatch a real left-drag in the 3D quadrant so the interactor processes it,
// to validate that __vrCheck distinguishes the buggy (idle) state from the fixed (post-interaction) state.
window.__vrNudge = () => {
  try {
    const r = host.getBoundingClientRect();
    const x = r.left + r.width * 0.75, y = r.top + r.height * 0.25;   // top-right = the 3D view
    const ev = (t, dx, dy, btns) => host.dispatchEvent(new PointerEvent(t,
      { clientX: x + dx, clientY: y + dy, button: 0, buttons: btns, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
    ev('pointerdown', 0, 0, 1);
    for (let i = 1; i <= 6; i++) ev('pointermove', i * 3, i * 2, 1);
    ev('pointerup', 18, 12, 0);
    return 'nudged';
  } catch (e) { return 'err:' + (e && e.message || e); }
};

// Rotate EXACTLY like Slicer's desktop 3D view (vtkMRMLCameraWidget::ProcessRotate) so muscle memory carries over:
// azimuth/elevation about the camera FOCAL POINT, same delta = pixels * -20/size * MotionFactor(10), then
// OrthogonalizeViewUp. vtk.js's camera.azimuth/elevation/orthogonalizeViewUp are direct VTK ports and vtk.js mouse
// positions are y-from-bottom like VTK, so this is bit-for-bit the same camera motion as Slicer. (The stock
// vtkMouseCameraTrackballRotateManipulator instead pivots on model.center, which defaults to the world origin --
// that was the "center of rotation is wrong" bug; setting the focal point did nothing because it ignored it.)
function vtkSlicerRotateManipulator(publicAPI, model) {
  model.classHierarchy.push('vtkSlicerRotateManipulator');
  publicAPI.onButtonDown = (interactor, renderer, position) => { model.prev = position; };
  publicAPI.onMouseMove = (interactor, renderer, position) => {
    if (!position || !model.prev) return;
    const camera = renderer.getActiveCamera();
    const size = interactor.getView().getViewportSize(renderer);     // viewport pixels (the 3D quadrant)
    const dx = position.x - model.prev.x, dy = position.y - model.prev.y;
    if (dx === 0 && dy === 0) { model.prev = position; return; }
    const MotionFactor = 10.0;
    const rxf = dx * (-20.0 / size[0]) * MotionFactor;                // vtkMRMLCameraWidget::ProcessRotate, verbatim
    const ryf = dy * (-20.0 / size[1]) * MotionFactor;
    camera.azimuth(rxf);
    camera.elevation(ryf);
    camera.orthogonalizeViewUp();
    renderer.resetCameraClippingRange();
    if (interactor.getLightFollowCamera()) renderer.updateLightsGeometryToFollowCamera();
    model.prev = position; scene3DDirty = true; markDirty();
  };
}
function extendSlicerRotate(publicAPI, model, initialValues = {}) {
  Object.assign(model, initialValues);
  macro.obj(publicAPI, model);
  vtkCompositeMouseManipulator.extend(publicAPI, model, initialValues);
  vtkSlicerRotateManipulator(publicAPI, model);
}
const newSlicerRotateManipulator = macro.newInstance(extendSlicerRotate, 'vtkSlicerRotateManipulator');

// Zoom EXACTLY like Slicer's desktop 3D view (vtkMRMLCameraWidget::Dolly): camera.dolly(factor) moves the camera
// along the view axis and KEEPS THE FOCAL POINT FIXED, so the center of rotation stays put in world space while
// zooming. The stock vtkMouseCameraTrackballZoomManipulator's drag path instead translates the focal point along
// with the camera -- that slid the rotation center into the scene on a right-drag zoom (the reported bug). Wheel
// uses Slicer's Dolly(pow(1.1, +/-0.2*MotionFactor*MouseWheelMotionFactor)); drag uses ProcessScale, verbatim.
const SLICER_MOTION_FACTOR = 10.0, SLICER_WHEEL_FACTOR = 1.0;
function slicerDolly(renderer, factor) {
  const camera = renderer.getActiveCamera();
  if (camera.getParallelProjection()) camera.setParallelScale(camera.getParallelScale() / factor);
  else { camera.dolly(factor); renderer.resetCameraClippingRange(); }
  scene3DDirty = true; markDirty();
}
function vtkSlicerZoomManipulator(publicAPI, model) {
  model.classHierarchy.push('vtkSlicerZoomManipulator');
  publicAPI.onButtonDown = (interactor, renderer, position) => { model.prev = position; };
  publicAPI.onMouseMove = (interactor, renderer, position) => {              // right-drag = ProcessScale
    if (!position || !model.prev) return;
    const size = interactor.getView().getViewportSize(renderer);
    const dy = position.y - model.prev.y;
    if (dy === 0) { model.prev = position; return; }
    const centerY = size[1] / 2;                                            // Renderer->GetCenter()[1]
    const dyf = SLICER_MOTION_FACTOR * dy / centerY;
    slicerDolly(renderer, Math.pow(1.1, -1.0 * dyf));                       // pull toward you -> closer
    model.prev = position;
  };
  publicAPI.onScroll = (interactor, renderer, delta) => {                   // wheel = Dolly(pow(1.1, +/-2))
    if (!delta) return;
    const dir = delta < 0 ? 1 : -1;                                         // match vtk.js: negative delta = zoom in
    slicerDolly(renderer, Math.pow(1.1, dir * 0.2 * SLICER_MOTION_FACTOR * SLICER_WHEEL_FACTOR));
  };
}
function extendSlicerZoom(publicAPI, model, initialValues = {}) {
  Object.assign(model, initialValues);
  macro.obj(publicAPI, model);
  vtkCompositeMouseManipulator.extend(publicAPI, model, initialValues);
  vtkSlicerZoomManipulator(publicAPI, model);
}
const newSlicerZoomManipulator = macro.newInstance(extendSlicerZoom, 'vtkSlicerZoomManipulator');

const istyle = vtkInteractorStyleManipulator.newInstance();   // Slicer-matched bindings
[
  newSlicerRotateManipulator({ button: 1 }),                   // left-drag = rotate, exactly like Slicer desktop
  vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 }),
  vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1, shift: true }),
  newSlicerZoomManipulator({ button: 3 }),                     // right-drag = zoom, focal point fixed (Slicer Dolly)
  newSlicerZoomManipulator({ scrollEnabled: true, dragEnabled: false }),   // wheel = zoom, focal point fixed (Slicer Dolly)
].forEach((m) => istyle.addMouseManipulator(m));
istyle.addGestureManipulator(vtkGestureCameraManipulator.newInstance());
interactor.setInteractorStyle(istyle);
interactor.onKeyPress((e) => {
  if ((e.key || '').toLowerCase() === 'r') { renderer.resetCamera(); renderWindow.render(); postCamera(); markDirty(); }
});

// ---- compositor scheduling. The per-frame getImageData readback + chroma-key pixel loop (in composite())
// is the main-thread cost that was starving the streamed-video decode/draw -- they share this one JS thread,
// so an unconditional 60 Hz mask+render here makes the WHOLE streamed desktop (esp. the 2D slice views) lag,
// with nothing dropped (the decoder just queues). Fix: only do the expensive work when the 3D actually
// changed (markDirty on any scene/camera edit; the interactor flags live drags), plus a throttled mask
// refresh for popups (which appear at human speed). When the user works in the 2D views the local 3D is
// idle -> composite costs ~nothing -> the video path gets the CPU back.
let scene3DDirty = true, interacting = false, lastMaskAt = 0, pendingRenders = 0;
const MASK_MS = 100;                                  // chroma-key mask cadence (popup tracking); ~10 Hz
// Bump a few render frames on any change: vtk.js volume mappers often need 2+ passes to actually DRAW (the
// first uploads the 3D texture, a later one renders it) + the camera clip range settles after the bounds
// update -- so a single post-load render left the VR blank until a mouse move. Burst a handful of frames, then idle.
const markDirty = () => { scene3DDirty = true; pendingRenders = Math.max(pendingRenders, 8); };
// "interacting" = a live camera/handle drag on the local 3D -> composite at full rate. Driven by DOM
// pointer events on the GL canvas (vtk.js's interaction events aren't exposed in this build).
host.addEventListener('pointerdown', () => { interacting = true; }, true);
window.addEventListener('pointerup', () => { if (interacting) { interacting = false; markDirty(); } }, true);
host.addEventListener('wheel', () => { markDirty(); }, { passive: true });

let bound = false, lastRect = null, threeDActive = true;   // threeDActive=false when the 3D view isn't in the layout (slice maximized)
let appliedVersion = null, pendingVersion = null, syncing = false;
let ws = null, wsOpen = false, lastPong = 0, hbTimer = null;
function connected() { return wsOpen && (Date.now() - lastPong < 6000); }

// =====================================================================================================
//  MRML mirror + content-addressed blob cache + JS displayable managers
// =====================================================================================================
const mirror = new Map();        // nodeId -> node state {id,class,name,refs,attrs,blobs}
const blobCache = new Map();      // content hash -> Promise<TypedArray>
const localBlobs = new Map();     // SlicerLive: hash -> TypedArray parsed from a file (not fetched from /blob)
const DT = {                      // server dtype string -> typed-array constructor
  float32: Float32Array, float64: Float64Array, int32: Int32Array, uint32: Uint32Array,
  int16: Int16Array, uint16: Uint16Array, int8: Int8Array, uint8: Uint8Array,
};
const ZDT = {                     // zarr dtype.str ("<i2") -> typed-array constructor (little-endian assumed)
  '<f4': Float32Array, '<f8': Float64Array, '<i4': Int32Array, '<u4': Uint32Array,
  '<i2': Int16Array, '<u2': Uint16Array, '|i1': Int8Array, '|u1': Uint8Array, '<i1': Int8Array, '<u1': Uint8Array,
};

const zarrCache = new Map();      // "<dir>/<dataset>/" -> Promise<TypedArray> (assembled full volume)
// Fetch an OME-Zarr volume: pull all chunks IN PARALLEL (zlib via DecompressionStream('deflate')) and assemble
// into one typed array. The rotated IJK->RAS geometry comes from the scene json (attrs.ijkToRAS), not zarr.
// onBytes(n) reports each chunk's compressed size (for the download progress bar).
function fetchZarrVolume(node, onBytes) {
  const z = node.attrs && node.attrs.zarr;
  if (!z) return Promise.resolve(null);
  const dir = (window.__SLICERLIVE_BLOB_BASE || '') + z.dir + '/' + z.dataset + '/';
  if (zarrCache.has(dir)) return zarrCache.get(dir);
  const p = (async () => {
    const Ctor = ZDT[z.dtype] || Int16Array;
    const [nz, ny, nx] = z.shape, [cz, cy, cx] = z.chunks, [ncz, ncy, ncx] = z.chunkGrid;
    const out = new Ctor(nz * ny * nx);
    const jobs = [];
    for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) jobs.push([kk, jj, ii]);
    let idx = 0; const CONC = 12;
    const worker = async () => {
      while (idx < jobs.length) {
        const [kk, jj, ii] = jobs[idx++];
        const gz = await fetch(dir + kk + '.' + jj + '.' + ii).then((r) => r.arrayBuffer());
        if (onBytes) onBytes(gz.byteLength);
        const raw = await new Response(new Response(gz).body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        const chunk = new Ctor(raw);                  // (cz,cy,cx) C-order, padded to full chunk shape
        const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
        const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
        for (let zz = 0; zz < zw; zz++) for (let yy = 0; yy < yw; yy++) {
          const src = (zz * cy + yy) * cx;            // chunk row start
          const dst = ((z0 + zz) * ny + (y0 + yy)) * nx + x0;
          out.set(chunk.subarray(src, src + xw), dst);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
    return out;
  })();
  zarrCache.set(dir, p);
  return p;
}
// volume voxels: direct typed array (client-side IDC loader) > zarr (chunked) > single content-addressed blob
function getVolumeScalars(node, onBytes) {
  if (node.__scalars) return Promise.resolve(node.__scalars);
  if (node.attrs && node.attrs.zarr) return fetchZarrVolume(node, onBytes);
  return fetchArray(node.blobs && node.blobs.scalars);
}
function volScalarKey(node) {     // change-detection key for the volume voxels
  if (node.__volKey) return node.__volKey;
  if (node.attrs && node.attrs.zarr) return node.attrs.zarr.dir;
  return node.blobs && node.blobs.scalars && node.blobs.scalars.hash;
}

// fetch a gzipped raw typed-array blob (content-addressed) -> TypedArray. The browser's DecompressionStream
// gunzips natively. Cached by hash so unchanged geometry (incl. a hidden node toggled back on) never refetches.
function fetchArray(meta) {
  if (!meta) return Promise.resolve(null);
  if (localBlobs.has(meta.hash)) return Promise.resolve(localBlobs.get(meta.hash));   // SlicerLive: file-loaded data
  if (!blobCache.has(meta.hash)) {
    blobCache.set(meta.hash, (async () => {
      const url = window.__SLICERLIVE_BLOB_BASE ? (window.__SLICERLIVE_BLOB_BASE + meta.hash) : `${SCENE}/blob?hash=${meta.hash}`;
      const gz = await fetch(url).then((r) => r.arrayBuffer());
      const raw = await new Response(new Response(gz).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      return new (DT[meta.dtype] || Float32Array)(raw);
    })());
  }
  return blobCache.get(meta.hash);
}

// build a vtkPolyData from {points, polys[, normals]} typed-array blobs
async function buildPolyData(b) {
  if (b && b.__pd) return b.__pd;   // SlicerLive: use the reader's vtkPolyData directly (no blob round-trip)
  const [points, polys, normals, scalars] = await Promise.all([
    fetchArray(b.points), fetchArray(b.polys), fetchArray(b.normals), fetchArray(b.scalars)]);
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(points, 3);
  pd.getPolys().setData(polys);
  if (normals) pd.getPointData().setNormals(vtkDataArray.newInstance({ name: 'Normals', numberOfComponents: 3, values: normals }));
  if (scalars) pd.getPointData().setScalars(vtkDataArray.newInstance({ name: 'scalars', numberOfComponents: (b.scalars.comps || 1), values: scalars }));
  return pd;
}

function displayNodeOf(node, predicate) {
  for (const id of node.refs.display || []) {
    const dn = mirror.get(id);
    if (dn && (!predicate || predicate(dn))) return dn;
  }
  return null;
}
const isVR = (dn) => dn.class.includes('VolumeRendering');
const visibleOf = (dn) => !!(dn && dn.attrs.visibility && (dn.attrs.visibility3D === undefined || dn.attrs.visibility3D));

// MRML stores a scalar volume's geometry in its IJK->RAS matrix (image data is unit-spacing IJK). Split it
// like Slicer's offload fix: anisotropic SPACING into the image data + a RIGID (scale-removed) user matrix
// for RAS placement (a non-uniform-scale user matrix distorts vtk.js volume ray-casting).
function volumeGeometry(img, ijkToRAS) {
  const M = ijkToRAS;                              // row-major 4x4
  const get = (r, c) => M[r * 4 + c];
  const sp = [0, 1, 2].map((c) => Math.hypot(get(0, c), get(1, c), get(2, c)) || 1);
  img.setSpacing(sp[0], sp[1], sp[2]);
  img.setOrigin(0, 0, 0);
  img.setDirection(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const mat = [];                                  // column-major rigid matrix for vtk.js setUserMatrix
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    if (r === 3) mat.push(c === 3 ? 1 : 0);
    else if (c === 3) mat.push(get(r, 3));
    else mat.push(get(r, c) / sp[c]);
  }
  return mat;
}

// An oriented ROI box -> 6 clip planes (inward normals keep the interior). The vtk.js volume mapper's
// shader honors clipping planes, so this crops the volume rendering. Center/axes/halfSizes are in RAS.
function roiClipPlanes(roi) {
  const C = roi.center, h = roi.halfSizes, ax = roi.axes;
  if (!C || !h || !ax) return [];
  const planes = [];
  for (let i = 0; i < 3; i++) {
    const u = ax[i], hi = h[i];
    planes.push(vtkPlane.newInstance({ origin: [C[0] + hi * u[0], C[1] + hi * u[1], C[2] + hi * u[2]], normal: [-u[0], -u[1], -u[2]] }));
    planes.push(vtkPlane.newInstance({ origin: [C[0] - hi * u[0], C[1] - hi * u[1], C[2] - hi * u[2]], normal: [u[0], u[1], u[2]] }));
  }
  return planes;
}

// An oriented ROI box -> a wireframe vtkPolyData (8 corners, 12 edges) for the client-rendered ROI widget.
function boxPolyData(C, ax, h) {
  const pts = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    const sx = x ? 1 : -1, sy = y ? 1 : -1, sz = z ? 1 : -1;
    pts.push(
      C[0] + sx * h[0] * ax[0][0] + sy * h[1] * ax[1][0] + sz * h[2] * ax[2][0],
      C[1] + sx * h[0] * ax[0][1] + sy * h[1] * ax[1][1] + sz * h[2] * ax[2][1],
      C[2] + sx * h[0] * ax[0][2] + sy * h[1] * ax[1][2] + sz * h[2] * ax[2][2],
    );
  }
  const id = (x, y, z) => (x * 2 + y) * 2 + z;
  const lines = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    if (!x) lines.push(2, id(0, y, z), id(1, y, z));
    if (!y) lines.push(2, id(x, 0, z), id(x, 1, z));
    if (!z) lines.push(2, id(x, y, 0), id(x, y, 1));
  }
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(Float32Array.from(pts), 3);
  pd.getLines().setData(Uint32Array.from(lines));
  return pd;
}

// axis-aligned wireframe box from bounds [xmin,xmax,ymin,ymax,zmin,zmax] (the Slicer 3D view box)
function axisAlignedBox(b) {
  const pts = [];
  for (const x of [b[0], b[1]]) for (const y of [b[2], b[3]]) for (const z of [b[4], b[5]]) pts.push(x, y, z);
  const id = (i, j, k) => (i * 2 + j) * 2 + k, lines = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    if (!i) lines.push(2, id(0, j, k), id(1, j, k));
    if (!j) lines.push(2, id(i, 0, k), id(i, 1, k));
    if (!k) lines.push(2, id(i, j, 0), id(i, j, 1));
  }
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(Float32Array.from(pts), 3); pd.getLines().setData(Uint32Array.from(lines));
  return pd;
}

// resolve a node's transform-node chain to a COLUMN-major mat4 for actor.setUserMatrix (null if none).
const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul4(A, B) {   // row-major 4x4 A*B
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
}
function transpose4(m) { const o = new Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c]; return o; }
function inv4(m) {       // general 4x4 inverse (row-major); returns identity if singular
  const a = m, inv = new Array(16);
  inv[0]=a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  inv[4]=-a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  inv[8]=a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  inv[12]=-a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  inv[1]=-a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  inv[5]=a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  inv[9]=-a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  inv[13]=a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  inv[2]=a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  inv[6]=-a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  inv[10]=a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  inv[14]=-a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  inv[3]=-a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  inv[7]=a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  inv[11]=-a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  inv[15]=a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  let det = a[0]*inv[0]+a[1]*inv[4]+a[2]*inv[8]+a[3]*inv[12];
  if (!det) return IDENTITY4.slice();
  det = 1.0 / det; for (let i = 0; i < 16; i++) inv[i] *= det; return inv;
}

// ---- SliceDM: client-side 2D slice rendering (the 2D analog of the 3D offload). For each vtkMRMLSliceNode,
// reslice its composite background volume on the slice plane in the GPU compositor (xyToIJK = inv(ijkToRAS) *
// xyToRAS), grayscale window/level, keyholed into that slice view's region on the streamed desktop.
let sliceViewports = {};                  // layoutName -> {x,y,w,h} screen rect (from the server WS state)
let segEdit = null;                       // active Segment Editor effect + params (for the client-drawn brush cursor)

// ---- 2D VECTOR OVERLAY: a full-window transparent canvas for client-drawn vector graphics over the
// keyholed slices (segment-editor brush cursor now; markups / data-probe next). The server's own slice
// feedback is suppressed by the keyhole, so a brush drawn HERE at the mouse is instant (no video round-trip).
const vec2d = document.createElement('canvas');
vec2d.id = 'offload-vec2d';
vec2d.style.cssText = 'position:fixed; left:0; top:0; z-index:8; pointer-events:none;';
document.body.appendChild(vec2d);
const vctx = vec2d.getContext('2d');
let cursor = null;
window.addEventListener('pointermove', (e) => { cursor = { x: e.clientX, y: e.clientY }; drawVectorOverlay(); }, true);

function sliceNodeFor(layoutName) {
  for (const n of mirror.values()) if (n.class === 'vtkMRMLSliceNode' && n.attrs.layoutName === layoutName) return n;
  return null;
}
function brushDiameterMm(se, fov) {
  const a = se.attrs || {};
  if (a.BrushDiameterIsRelative === '1' || a.BrushDiameterIsRelative === 'true')
    return (parseFloat(a.BrushRelativeDiameter || '3') / 100) * Math.min(fov[0], fov[1]);   // % of view -> mm
  return parseFloat(a.BrushAbsoluteDiameter || '0');
}
function mulMatVec(m, v) {   // row-major 4x4 m * v (v=[x,y,z,1]) -> [x',y',z',w']
  return [0, 1, 2, 3].map((r) => m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3] * v[3]);
}
// per-slice projection context: RAS -> viewport-pixel + signed mm distance to the plane, + pixel -> screen.
function sliceProjector(name, m) {
  const r = sliceViewports[name], sn = sliceNodeFor(name);
  if (!r || !sn || !sn.attrs.xyToRAS || !sn.attrs.sliceToRAS) return null;
  const dims = sn.attrs.dimensions, rasToXY = inv4(sn.attrs.xyToRAS), s2r = sn.attrs.sliceToRAS;
  const origin = [s2r[3], s2r[7], s2r[11]];
  let nrm = [s2r[2], s2r[6], s2r[10]]; const nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1; nrm = nrm.map((c) => c / nl);
  const L = m.left + r.x * m.scale, T = m.top + r.y * m.scale, W = r.w * m.scale, H = r.h * m.scale;
  return {
    name, sn, rect: { L, T, W, H },
    project: (P) => {
      const xy = mulMatVec(rasToXY, [P[0], P[1], P[2], 1]);                 // slice viewport px (y up)
      const dist = (P[0] - origin[0]) * nrm[0] + (P[1] - origin[1]) * nrm[1] + (P[2] - origin[2]) * nrm[2];
      return { x: L + (xy[0] / dims[0]) * W, y: T + ((dims[1] - xy[1]) / dims[1]) * H, dist };   // y flip to screen
    },
  };
}
const rgbaStr = (c, a) => `rgba(${Math.round((c[0] || 0) * 255)},${Math.round((c[1] || 0) * 255)},${Math.round((c[2] || 0) * 255)},${a})`;
const NEAR_MM = 4;             // a control point within this of the plane is drawn as a glyph
function isSliceMarkup(node) {
  return node.class.includes('Markups') && !node.class.includes('Display') && !node.class.includes('ROINode');
}
function drawSliceMarkups(m) {
  for (const name in sliceViewports) {
    const pj = sliceProjector(name, m); if (!pj) continue;
    for (const node of mirror.values()) {
      if (!isSliceMarkup(node)) continue;
      const disp = displayNodeOf(node); if (disp && disp.attrs.visibility === 0) continue;
      const color = (disp && (disp.attrs.selectedColor || disp.attrs.color)) || [1, 1, 0];   // MRML SelectedColor
      const cps = node.attrs.controlPoints || [];
      const line = ((node.id !== leasedId && node.attrs.linePoints) || cps).map(pj.project);   // while dragging THIS markup follow local control points (server spline lags); else the spline
      if (node.attrs.connect && line.length > 1) {                          // connecting line where it nears the plane
        vctx.strokeStyle = rgbaStr(color, 0.9); vctx.lineWidth = 2; vctx.beginPath();
        const seg = (a, b) => { if (Math.min(Math.abs(a.dist), Math.abs(b.dist)) < 25 || Math.sign(a.dist) !== Math.sign(b.dist)) { vctx.moveTo(a.x, a.y); vctx.lineTo(b.x, b.y); } };
        for (let i = 0; i < line.length - 1; i++) seg(line[i], line[i + 1]);
        if (node.attrs.closed && line.length > 2) seg(line[line.length - 1], line[0]);
        vctx.stroke();
      }
      for (const P of cps) {                                                // control-point glyphs near the plane
        const p = pj.project(P); if (Math.abs(p.dist) > NEAR_MM) continue;
        vctx.beginPath(); vctx.arc(p.x, p.y, 4.5, 0, 2 * Math.PI);
        vctx.fillStyle = rgbaStr(color, 0.95); vctx.fill();
        vctx.strokeStyle = 'white'; vctx.lineWidth = 1.5; vctx.stroke();
      }
    }
  }
}
function drawBrush(m) {
  if (!cursor) return;
  const eff = segEdit && segEdit.effect;     // segment-editor brush cursor over whichever slice the mouse is in
  if (eff !== 'Paint' && eff !== 'Erase') return;
  for (const name in sliceViewports) {
    const r = sliceViewports[name];
    const L = m.left + r.x * m.scale, T = m.top + r.y * m.scale, W = r.w * m.scale, H = r.h * m.scale;
    if (cursor.x < L || cursor.y < T || cursor.x > L + W || cursor.y > T + H) continue;
    const sn = sliceNodeFor(name); if (!sn) continue;
    const mm = brushDiameterMm(segEdit, sn.attrs.fieldOfView); if (!mm) continue;
    const rad = (mm / 2) * (r.w / sn.attrs.fieldOfView[0]) * m.scale;
    vctx.beginPath(); vctx.arc(cursor.x, cursor.y, rad, 0, 2 * Math.PI);
    vctx.strokeStyle = eff === 'Erase' ? 'rgba(255,90,90,0.9)' : 'rgba(120,200,255,0.95)';
    vctx.lineWidth = 2; vctx.stroke();
    break;
  }
}
function drawVectorOverlay() {
  if (vec2d.width !== window.innerWidth) vec2d.width = window.innerWidth;
  if (vec2d.height !== window.innerHeight) vec2d.height = window.innerHeight;
  vctx.clearRect(0, 0, vec2d.width, vec2d.height);
  if (!connected() || typeof videoMap !== 'function') return;
  const m = videoMap(); if (!m) return;
  drawSliceMarkups(m);
  drawBrush(m);
}
window.__markupDbg = (name) => {   // test hook: projected control points (screen x,y + mm distance) per markup
  const m = videoMap(); const pj = sliceProjector(name, m); if (!pj) return 'no-proj';
  const out = [];
  for (const node of mirror.values()) {
    if (!isSliceMarkup(node)) continue;
    out.push({ name: node.name, rect: pj.rect, cps: (node.attrs.controlPoints || []).map((P) => { const p = pj.project(P); return { x: Math.round(p.x), y: Math.round(p.y), d: Math.round(p.dist * 10) / 10 }; }) });
  }
  return JSON.stringify(out);
};
window.__brushDbg = (effect, mm, name) => {   // test hook: inject a Paint/Erase brush at a slice center, sample the stroke
  const r = sliceViewports[name]; if (!r) return 'no-viewport';
  const sn = sliceNodeFor(name); if (!sn) return 'no-slice';
  segEdit = { effect, attrs: { BrushDiameterIsRelative: '0', BrushAbsoluteDiameter: '' + mm } };
  const mp = videoMap();
  cursor = { x: mp.left + (r.x + r.w / 2) * mp.scale, y: mp.top + (r.y + r.h / 2) * mp.scale };
  drawVectorOverlay();
  const rad = (mm / 2) * (r.w / sn.attrs.fieldOfView[0]) * mp.scale;
  const at = vctx.getImageData(Math.round(cursor.x + rad), Math.round(cursor.y), 1, 1).data;   // on the ring
  const mid = vctx.getImageData(Math.round(cursor.x), Math.round(cursor.y), 1, 1).data;          // inside (empty)
  return JSON.stringify({ rad: Math.round(rad), ringAlpha: at[3], centerAlpha: mid[3] });
};
const sliceVolUploaded = new Set();       // "<volId>:<hash>" already uploaded as a 3D texture
async function ensureVolumeTexture(vol) {
  const meta = vol.blobs && vol.blobs.scalars;
  if (!meta) return false;
  const k = vol.id + ':' + meta.hash;
  if (sliceVolUploaded.has(k)) return true;
  const arr = await fetchArray(meta);
  if (!arr) return false;
  const f = (arr instanceof Float32Array) ? arr : Float32Array.from(arr);
  window.desktopCompositor.setVolume(vol.id, f, vol.attrs.dims);
  sliceVolUploaded.add(k);
  return true;
}
function compositeNodeFor(layoutName) {
  for (const n of mirror.values())
    if (n.class === 'vtkMRMLSliceCompositeNode' && n.attrs.layoutName === layoutName) return n;
  return null;
}
const segLmUploaded = new Set();          // "<segId>:<hash>" merged-labelmap textures already uploaded
async function ensureSegOverlay(segNode) {   // upload labelmap + color texture; returns {id,lmId,dims,ijkToRAS,opacity}
  const meta = segNode.blobs && segNode.blobs.labelmap;
  if (!meta || !segNode.attrs.labelmapDims) return null;
  const lmId = segNode.id + ':lm', k = segNode.id + ':' + meta.hash;
  if (!segLmUploaded.has(k)) {
    const arr = await fetchArray(meta);
    if (!arr) return null;
    window.desktopCompositor.setVolume(lmId, (arr instanceof Float32Array) ? arr : Float32Array.from(arr),
      segNode.attrs.labelmapDims, true);    // nearest: labels must not interpolate
    segLmUploaded.add(k);
  }
  const rgba = new Uint8Array(256 * 4);     // label value -> segment color
  for (const [lv, r, g, b] of (segNode.attrs.segmentColors || [])) {
    const i = (lv & 255) * 4; rgba[i] = r * 255; rgba[i + 1] = g * 255; rgba[i + 2] = b * 255; rgba[i + 3] = 255;
  }
  window.desktopCompositor.setSegColors(segNode.id, rgba);
  return { id: segNode.id, lmId, dims: segNode.attrs.labelmapDims, ijkToRAS: segNode.attrs.labelmapIjkToRAS,
    opacity: segNode.attrs.seg2DOpacity != null ? segNode.attrs.seg2DOpacity : 0.5 };
}
async function syncSlices() {
  const C = window.desktopCompositor;
  if (!C || !C.setSliceLayers) return;
  const segs = [];                          // segmentation overlays (textures uploaded once, drawn in every slice)
  for (const sn of mirror.values()) {
    if (sn.class !== 'vtkMRMLSegmentationNode' || !(sn.blobs && sn.blobs.labelmap)) continue;
    const so = await ensureSegOverlay(sn);
    if (so) segs.push(so);
  }
  const layers = [];
  for (const n of mirror.values()) {
    if (n.class !== 'vtkMRMLSliceNode') continue;
    const layoutName = n.attrs.layoutName;
    const comp = compositeNodeFor(layoutName);
    const bgId = comp && comp.attrs.backgroundVolumeID;
    const vol = bgId ? mirror.get(bgId) : null;
    if (!vol || !(await ensureVolumeTexture(vol))) continue;
    if (!n.attrs.xyToRAS || !vol.attrs.ijkToRAS) continue;
    const xyToIJK = transpose4(mul4(inv4(vol.attrs.ijkToRAS), n.attrs.xyToRAS));   // -> column-major for the uniform
    let win = 255, lev = 127;
    for (const did of vol.refs.display || []) { const d = mirror.get(did); if (d && d.attrs.window != null) { win = d.attrs.window; lev = d.attrs.level; break; } }
    const vp = [n.attrs.dimensions[0], n.attrs.dimensions[1]];
    const overlays = segs.map(so => ({      // per-slice: same labelmap, this slice's plane
      kind: 'seg', labelmapId: so.lmId, colorTexId: so.id, opacity: so.opacity,
      xyToIJK: transpose4(mul4(inv4(so.ijkToRAS), n.attrs.xyToRAS)),
    }));
    layers.push({
      active: () => {                                   // CLINICAL SAFETY: render ONLY when the screen rect's
        const r = sliceViewports[layoutName];           // aspect matches the slice-node dims. During a resize
        if (!r || !r.w || !r.h) return false;           // the two can momentarily disagree -> blank (keyhole)
        const ar = r.w / r.h, avp = vp[0] / vp[1];       // rather than show a distorted (wrong-aspect) image,
        return Math.abs(ar - avp) <= 0.03 * avp;         // which would be clinically misleading.
      },
      rect: () => { const r = sliceViewports[layoutName]; return r ? { sx: r.x, sy: r.y, sw: r.w, sh: r.h } : null; },
      volumeId: () => vol.id, xyToIJK: () => xyToIJK, dims: vol.attrs.dims,
      wl: () => [win, lev], vpDims: () => vp, overlays: () => overlays,
    });
  }
  window.__sliceDbg = { built: layers.length, vp: Object.keys(sliceViewports), uploaded: [...sliceVolUploaded],
    sliceNodes: [...mirror.values()].filter(n => n.class === 'vtkMRMLSliceNode').map(n => n.attrs.layoutName),
    compNodes: [...mirror.values()].filter(n => n.class === 'vtkMRMLSliceCompositeNode').length };
  C.setSliceLayers(layers);
}
function worldMatrixCol(node) {
  let tid = (node.refs.transform || [])[0];
  const mats = [];
  while (tid) { const tn = mirror.get(tid); if (!tn || !tn.attrs.matrixToParent) break; mats.push(tn.attrs.matrixToParent); tid = (tn.refs.transform || [])[0]; }
  if (!mats.length) return null;
  let M = mats[0]; for (let i = 1; i < mats.length; i++) M = mul4(mats[i], M);   // row-major: world = T_root*..*T_direct
  const col = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) col.push(M[r * 4 + c]);   // -> column-major
  return col;
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// one handle = a sphere actor + metadata. type 'face' (resize 1 axis), 'corner' (resize 3), 'center' (translate).
function mkHandle(meta, id) {
  const src = vtkSphereSource.newInstance({ thetaResolution: 16, phiResolution: 16 });
  const m = vtkMapper.newInstance(); m.setInputConnection(src.getOutputPort());
  const act = vtkActor.newInstance(); act.setMapper(m);
  const base = meta.type === 'center' ? [0.4, 1, 0.5]            // ROI center: green (translate)
    : meta.type === 'point' ? [1, 0.5, 0.1]                      // markup control point: orange
      : meta.type === 'taxis' ? [[1, 0.3, 0.3], [0.3, 1, 0.3], [0.4, 0.5, 1]][meta.axis]   // transform X/Y/Z arrow
        : meta.type === 'tcenter' ? [0.9, 0.9, 0.9]              // transform widget center (free translate)
          : [0.35, 0.8, 1];                                      // ROI resize: blue
  act.getProperty().setColor(...base);
  renderer.addActor(act);
  return { ...meta, src, actor: act, baseColor: base, nodeId: id, world: [0, 0, 0] };
}
function handleWorld(h, a) {
  const C = a.center, ax = a.axes, hh = a.halfSizes;
  if (h.type === 'center') return C.slice();
  if (h.type === 'face') { const u = ax[h.axis], s = h.sign, hi = hh[h.axis]; return [C[0] + s * hi * u[0], C[1] + s * hi * u[1], C[2] + s * hi * u[2]]; }
  const w = C.slice();
  for (let i = 0; i < 3; i++) { const u = ax[i], si = h.s[i], hi = hh[i]; w[0] += si * hi * u[0]; w[1] += si * hi * u[1]; w[2] += si * hi * u[2]; }
  return w;
}

function applyVolumeProperty(prop, a) {
  const ctf = vtkColorTransferFunction.newInstance();
  for (const p of a.color || []) ctf.addRGBPoint(p[0], p[1], p[2], p[3]);
  const sof = vtkPiecewiseFunction.newInstance();
  for (const p of a.scalarOpacity || []) sof.addPoint(p[0], p[1]);
  prop.setRGBTransferFunction(0, ctf);
  prop.setScalarOpacity(0, sof);
  prop.setInterpolationTypeToLinear();
  prop.setShade(a.shade ? 1 : 0);
  prop.setAmbient(a.ambient != null ? a.ambient : 0.2);
  prop.setDiffuse(a.diffuse != null ? a.diffuse : 0.7);
  prop.setSpecular(a.specular != null ? a.specular : 0.3);
  if (a.specularPower != null) prop.setSpecularPower(a.specularPower);
  // vtk.js gradient opacity is a min/max RAMP, not a piecewise function (no setGradientOpacity(pf)).
  // Approximate Slicer's gradient-opacity TF by its endpoints; off if absent.
  const g = a.gradientOpacity;
  if (g && g.length >= 2) {
    prop.setUseGradientOpacity(0, true);
    prop.setGradientOpacityMinimumValue(0, g[0][0]); prop.setGradientOpacityMinimumOpacity(0, g[0][1]);
    prop.setGradientOpacityMaximumValue(0, g[g.length - 1][0]); prop.setGradientOpacityMaximumOpacity(0, g[g.length - 1][1]);
  } else {
    prop.setUseGradientOpacity(0, false);
  }
}

// Each DM owns the vtk.js objects for nodes of its class(es). update() is a deterministic re-apply from
// node state (idempotent); remove() tears down. handles() decides ownership.
class ModelDM {
  constructor() { this.items = new Map(); }
  handles(node) { return node.class === 'vtkMRMLModelNode'; }
  async update(id, node) {
    const gkey = node.blobs.points && node.blobs.points.hash;
    const disp = displayNodeOf(node);
    let it = this.items.get(id);
    if (!gkey) { if (it) this.remove(id); return; }
    if (!it) {
      const mapper = vtkMapper.newInstance(); const actor = vtkActor.newInstance();
      actor.setMapper(mapper); renderer.addActor(actor);
      it = { actor, mapper, hash: null }; this.items.set(id, it);
    }
    if (it.hash !== gkey) { it.mapper.setInputData(await buildPolyData(node.blobs)); it.hash = gkey; }
    const p = it.actor.getProperty();
    it.actor.setVisibility(visibleOf(disp));
    it.actor.setUserMatrix(worldMatrixCol(node) || IDENTITY4);   // apply the node's transform chain
    if (disp) {
      const a = disp.attrs;
      p.setColor(...(a.color || [1, 1, 1]));
      p.setOpacity(a.opacity === undefined ? 1 : a.opacity);
      p.setRepresentation(a.representation === undefined ? 2 : a.representation);
      p.setEdgeVisibility(!!a.edgeVisibility);
      this.applyScalars(it, a, visibleOf(disp));
    }
  }
  applyScalars(it, a, vis) {
    if (a.scalarVisibility && a.colorTF && a.colorTF.length) {
      const ctf = vtkColorTransferFunction.newInstance();
      for (const [x, r, g, bl] of a.colorTF) ctf.addRGBPoint(x, r, g, bl);
      it.mapper.setLookupTable(ctf);
      it.mapper.setScalarVisibility(true);
      it.mapper.setColorModeToMapScalars();
      it.mapper.setScalarModeToUsePointData();
      it.mapper.setUseLookupTableScalarRange(true);
      if (!it.scalarBar) {                                  // one scalar bar per scalar-colored model
        it.scalarBar = vtkScalarBarActor.newInstance({ axisLabel: a.activeScalarName || 'scalars' });
        renderer.addActor(it.scalarBar);
      }
      it.scalarBar.setScalarsToColors(ctf);
      it.scalarBar.setVisibility(!!vis);
    } else {
      it.mapper.setScalarVisibility(false);
      if (it.scalarBar) it.scalarBar.setVisibility(false);
    }
  }
  remove(id) {
    const it = this.items.get(id);
    if (it) { renderer.removeActor(it.actor); if (it.scalarBar) renderer.removeActor(it.scalarBar); this.items.delete(id); }
  }
}

class VolumeRenderingDM {
  constructor() { this.items = new Map(); }
  handles(node) { return node.class.includes('ScalarVolumeNode') && !!displayNodeOf(node, isVR); }
  async update(id, node) {
    const vr = displayNodeOf(node, isVR);
    const hash = volScalarKey(node);   // zarr dir or blob hash
    let it = this.items.get(id);
    if (!hash || !vr) { if (it) this.remove(id); return; }
    if (!it || it.hash !== hash) {
      const scalars = await getVolumeScalars(node);   // FETCH DATA FIRST (zarr chunks in parallel, or blob)
      if (!scalars) return;
      const img = vtkImageData.newInstance();
      img.setDimensions(node.attrs.dims);
      img.getPointData().setScalars(vtkDataArray.newInstance({ numberOfComponents: node.attrs.comps || 1, values: scalars }));
      if (!it) {
        const mapper = vtkVolumeMapper.newInstance(); mapper.setAutoAdjustSampleDistances(false); mapper.setMaximumSamplesPerRay(4000);
        const volume = vtkVolume.newInstance(); volume.setMapper(mapper);
        it = { volume, mapper, added: false, hash: null }; this.items.set(id, it);
      }
      it.mapper.setInputData(img);
      if (node.attrs.ijkToRAS) it.volume.setUserMatrix(volumeGeometry(img, node.attrs.ijkToRAS));
      if (!it.added) { renderer.addVolume(it.volume); it.added = true; }   // add the volume AFTER its input data is set
      it.hash = hash;
    }
    const vp = mirror.get((vr.refs.volumeProperty || [])[0]);
    if (vp) applyVolumeProperty(it.volume.getProperty(), vp.attrs);
    if (vr.attrs.blendMode === 'mip') it.mapper.setBlendModeToMaximumIntensity();   // PET: maximum-intensity projection
    else it.mapper.setBlendModeToComposite();
    it.volume.setVisibility(visibleOf(vr));
    // ROI cropping: rebuild clip planes from the ROI node each apply (deterministic; cheap)
    it.mapper.removeAllClippingPlanes();
    const roi = mirror.get((vr.refs.roi || [])[0]);
    if (vr.attrs.croppingEnabled && roi) for (const p of roiClipPlanes(roi.attrs)) it.mapper.addClippingPlane(p);
  }
  remove(id) { const it = this.items.get(id); if (it) { renderer.removeVolume(it.volume); this.items.delete(id); } }
}

class SegmentationDM {
  constructor() { this.items = new Map(); }
  handles(node) { return node.class === 'vtkMRMLSegmentationNode'; }
  async update(id, node) {
    const disp = displayNodeOf(node);
    const vis = visibleOf(disp);
    let it = this.items.get(id);
    if (!it) { it = { segs: new Map() }; this.items.set(id, it); }
    const present = new Set();
    for (const sg of node.attrs.segments || []) {
      const gkey = sg.mesh && sg.mesh.points && sg.mesh.points.hash;
      if (!gkey) continue;
      present.add(sg.id);
      let s = it.segs.get(sg.id);
      if (!s) {
        const mapper = vtkMapper.newInstance(); const actor = vtkActor.newInstance();
        actor.setMapper(mapper); renderer.addActor(actor);
        s = { actor, mapper, hash: null }; it.segs.set(sg.id, s);
      }
      if (s.hash !== gkey) { s.mapper.setInputData(await buildPolyData(sg.mesh)); s.hash = gkey; }
      s.actor.getProperty().setColor(...(sg.color || [1, 1, 1]));
      s.actor.setVisibility(vis);
      s.actor.setUserMatrix(node.__surfMat || worldMatrixCol(node) || IDENTITY4);   // __surfMat = client-side IDC IJK->RAS
    }
    for (const [sid, s] of it.segs) if (!present.has(sid)) { renderer.removeActor(s.actor); it.segs.delete(sid); }
  }
  remove(id) {
    const it = this.items.get(id);
    if (it) { for (const s of it.segs.values()) renderer.removeActor(s.actor); this.items.delete(id); }
  }
}

// ViewDM: apply the view node's background to the renderer (the local render fills the keyed region, so it
// should carry Slicer's 3D background, not black). vtk.js does gradient via the OpenGL renderer's
// background1/2; fall back to a solid blend if unavailable.
class ViewDM {
  constructor() { this.items = new Map(); }
  handles(node) { return node.class === 'vtkMRMLViewNode'; }
  async update(id, node) {
    const a = node.attrs;
    const c1 = a.backgroundColor || [0, 0, 0], c2 = a.backgroundColor2 || c1;
    renderer.setBackground(c1[0], c1[1], c1[2]);
    if (renderer.setBackground2 && renderer.setGradientBackground) {
      renderer.setBackground2(c2[0], c2[1], c2[2]); renderer.setGradientBackground(true);
    } else {
      renderer.setBackground((c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2, (c1[2] + c2[2]) / 2);
    }
  }
  remove() {}
}

// OrientationMarkerDM: an anatomical cube in a corner that follows the camera (view-node attribute, not a
// data node). Renders client-side so the view is complete for ANY source (recorded/synthetic), not just
// Slicer-over-video. RAS labels: +X=R/-X=L, +Y=A/-Y=P, +Z=S/-Z=I.
class OrientationMarkerDM {
  constructor() { this.widget = null; }
  handles(node) { return node.class === 'vtkMRMLViewNode'; }
  async update(id, node) {
    const on = (node.attrs.orientationMarkerType || 0) !== 0;
    if (on && !this.widget) {
      const cube = vtkAnnotatedCubeActor.newInstance();
      cube.setDefaultStyle({ fontColor: 'white', faceRotation: 0, fontSizeScale: (r) => r / 2 });
      cube.setXPlusFaceProperty({ text: 'R' }); cube.setXMinusFaceProperty({ text: 'L' });
      cube.setYPlusFaceProperty({ text: 'A' }); cube.setYMinusFaceProperty({ text: 'P' });
      cube.setZPlusFaceProperty({ text: 'S' }); cube.setZMinusFaceProperty({ text: 'I' });
      this.widget = vtkOrientationMarkerWidget.newInstance({ actor: cube, interactor });
      this.widget.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_LEFT);
      this.widget.setViewportSize(0.15); this.widget.setMinPixelSize(60); this.widget.setMaxPixelSize(160);
    }
    if (this.widget) this.widget.setEnabled(on);
  }
  remove() { if (this.widget) this.widget.setEnabled(false); }
}

// ROIDM: the client's own ROI widget -- a wireframe box + 6 draggable FACE handles (resize). The handle
// interaction (pick/drag/lease/write-back) is wired globally below; this DM just renders the geometry and
// publishes the handle world-positions for picking. Generalizes to other markups (control-point handles).
let pickableHandles = [];   // every draggable handle across all DMs (ROI face/corner/center + markup points)
function refreshHandles() {
  pickableHandles = [];
  for (const dm of DMS) {
    if (!dm.items) continue;
    for (const it of dm.items.values()) if (it.handles) for (const h of it.handles) pickableHandles.push(h);
  }
}

class ROIDM {
  constructor() { this.items = new Map(); }
  handles(node) { return node.class.includes('ROINode'); }
  async update(id, node) {
    const a = node.attrs;
    if (!a.center || !a.axes || !a.halfSizes) { if (this.items.get(id)) this.remove(id); return; }
    let it = this.items.get(id);
    if (!it) {
      const boxMapper = vtkMapper.newInstance(); const boxActor = vtkActor.newInstance();
      boxActor.setMapper(boxMapper);
      const bp = boxActor.getProperty(); bp.setColor(1, 1, 0.3); bp.setLineWidth(2); bp.setLighting(false);
      renderer.addActor(boxActor);
      const hs = [];
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) hs.push(mkHandle({ type: 'face', axis, sign }, id));
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) hs.push(mkHandle({ type: 'corner', s: [sx, sy, sz] }, id));
      hs.push(mkHandle({ type: 'center' }, id));   // 6 face + 8 corner + 1 center
      it = { boxActor, boxMapper, handles: hs }; this.items.set(id, it);
    }
    it.boxMapper.setInputData(boxPolyData(a.center, a.axes, a.halfSizes));
    const r = 0.075 * (a.halfSizes[0] + a.halfSizes[1] + a.halfSizes[2]) / 3;   // handle radius ~ box scale
    for (const h of it.handles) {
      h.world = handleWorld(h, a);
      h.src.setRadius(r); h.actor.setPosition(h.world[0], h.world[1], h.world[2]);
    }
    refreshHandles();
  }
  remove(id) {
    const it = this.items.get(id);
    if (it) { renderer.removeActor(it.boxActor); for (const h of it.handles) renderer.removeActor(h.actor); this.items.delete(id); }
    refreshHandles();
  }
}

// a polyline vtkPolyData through `pts` (optionally closed) -- for line/angle/curve markups
function polyline(pts, closed) {
  const flat = []; for (const p of pts) flat.push(p[0], p[1], p[2]);
  const n = pts.length, line = [closed ? n + 1 : n];
  for (let i = 0; i < n; i++) line.push(i);
  if (closed) line.push(0);
  const pd = vtkPolyData.newInstance();
  pd.getPoints().setData(Float32Array.from(flat), 3);
  pd.getLines().setData(Uint32Array.from(line));
  return pd;
}

// Glyph radius (world units) following Slicer's markups display logic, NOT an image-level fudge:
//   - useGlyphScale == false -> GlyphSize is an absolute diameter in mm (MRML GlyphSize).
//   - useGlyphScale == true  -> GlyphScale is a PERCENT of the viewport height (Slicer's glyphs are
//     screen-relative), so convert that screen-percentage to world units at the focal depth via the camera.
// (Recomputed on each sync; for screen-CONSTANT size during a local zoom we'd also refresh on camera change.)
function glyphRadius(disp) {
  const a = (disp && disp.attrs) || {};
  if (a.useGlyphScale === false && a.glyphSize) return a.glyphSize / 2;
  const s = (a.glyphScale != null ? a.glyphScale : 3.0);
  const cam = renderer.getActiveCamera();
  let worldH;
  if (cam.getParallelProjection()) {
    worldH = 2 * cam.getParallelScale();
  } else {
    const p = cam.getPosition(), f = cam.getFocalPoint();
    const dist = Math.hypot(p[0] - f[0], p[1] - f[1], p[2] - f[2]);
    worldH = 2 * dist * Math.tan((cam.getViewAngle() * Math.PI / 180) / 2);
  }
  return Math.max(0.2, (s / 100) * worldH / 2);   // GlyphScale% of the viewport height -> world radius
}

// MarkupsDM: the GENERAL markup widget -- N control-point handles (draggable, write {mcp}) + optional
// connecting line (curves use the server's interpolated linePoints; line/angle use the control points).
class MarkupsDM {
  constructor() { this.items = new Map(); }
  handles(node) { return node.class.includes('Markups') && !node.class.includes('Display') && !node.class.includes('ROINode'); }
  async update(id, node) {
    const a = node.attrs, cps = a.controlPoints || [];
    const disp = displayNodeOf(node), vis = visibleOf(disp);
    const color = (disp && (disp.attrs.selectedColor || disp.attrs.color)) || [1, 0.5, 0.1];   // MRML SelectedColor (control points default to selected)
    let it = this.items.get(id);
    if (!it) { it = { lineActor: null, lineMapper: null, handles: [] }; this.items.set(id, it); }
    if (a.connect && cps.length >= 2) {                    // connecting line/curve
      if (!it.lineActor) {
        it.lineMapper = vtkMapper.newInstance(); it.lineActor = vtkActor.newInstance(); it.lineActor.setMapper(it.lineMapper);
        const lp = it.lineActor.getProperty(); lp.setLineWidth(2); lp.setLighting(false);
        renderer.addActor(it.lineActor);
      }
      it.lineActor.getProperty().setColor(...color); it.lineActor.setVisibility(vis);
      // settled curve = the server's interpolated spline; WHILE dragging this markup, follow the local
      // control points (straight) immediately so the curve tracks the handle, then snap to the spline.
      const linePts = (id !== leasedId && a.linePoints) ? a.linePoints : cps;
      it.lineMapper.setInputData(polyline(linePts, a.closed));
    } else if (it.lineActor) { renderer.removeActor(it.lineActor); it.lineActor = null; }
    while (it.handles.length < cps.length) it.handles.push(mkHandle({ type: 'point', index: it.handles.length }, id));
    while (it.handles.length > cps.length) renderer.removeActor(it.handles.pop().actor);
    const gr = glyphRadius(disp), sel = a.selectedFlags, unsel = (disp && disp.attrs.color) || color;
    for (let i = 0; i < cps.length; i++) {
      const h = it.handles[i]; h.index = i; h.world = cps[i].slice();
      const pc = (sel && sel[i] === false) ? unsel : color;   // per-point: SelectedColor when selected, Color when not
      h.baseColor = pc; h.actor.getProperty().setColor(...pc);
      h.src.setRadius(gr); h.actor.setPosition(cps[i][0], cps[i][1], cps[i][2]); h.actor.setVisibility(vis);
    }
    refreshHandles();
  }
  remove(id) {
    const it = this.items.get(id);
    if (it) { if (it.lineActor) renderer.removeActor(it.lineActor); for (const h of it.handles) renderer.removeActor(h.actor); this.items.delete(id); }
    refreshHandles();
  }
}

// TransformWidgetDM: the LINEAR transform interaction widget -- 3 axis-translate handles (X/Y/Z) + a center
// free-translate handle at the transform's origin, oriented by its axes; drag edits the matrix translation and
// writes {t:transform}. (Non-linear transform editing is deferred to WebGPU/vtk-wasm -- see TODO.)
class TransformWidgetDM {
  constructor() { this.items = new Map(); }
  handles(node) {
    if (!node.class.includes('TransformNode') || !node.attrs.linear) return false;
    const disp = displayNodeOf(node);
    return !!(node.attrs.matrixToParent && node.attrs.widgetCenter && node.attrs.axes && disp && disp.attrs.editorVisibility);
  }
  async update(id, node) {
    if (!this.handles(node)) { if (this.items.get(id)) this.remove(id); return; }
    const a = node.attrs, disp = displayNodeOf(node), C = a.widgetCenter, ax = a.axes;
    let it = this.items.get(id);
    if (!it) {
      const lineMapper = vtkMapper.newInstance(), lineActor = vtkActor.newInstance(); lineActor.setMapper(lineMapper);
      const lp = lineActor.getProperty(); lp.setColor(0.85, 0.85, 0.85); lp.setLineWidth(2); lp.setLighting(false);
      renderer.addActor(lineActor);
      const hs = [];
      for (let axis = 0; axis < 3; axis++) hs.push(mkHandle({ type: 'taxis', axis }, id));
      hs.push(mkHandle({ type: 'tcenter' }, id));
      it = { lineActor, lineMapper, handles: hs }; this.items.set(id, it);
    }
    const len = Math.max(8, glyphRadius(disp) * 6), r = Math.max(1.5, len * 0.12);   // screen-relative arrow length
    const flat = [], lines = [];
    for (let axis = 0; axis < 3; axis++) {
      const u = ax[axis], end = [C[0] + u[0] * len, C[1] + u[1] * len, C[2] + u[2] * len];
      const h = it.handles[axis]; h.world = end; h.src.setRadius(r); h.actor.setPosition(...end);
      flat.push(C[0], C[1], C[2], end[0], end[1], end[2]); lines.push(2, axis * 2, axis * 2 + 1);
    }
    const ch = it.handles[3]; ch.world = C.slice(); ch.src.setRadius(r * 1.2); ch.actor.setPosition(...C);
    const pd = vtkPolyData.newInstance(); pd.getPoints().setData(Float32Array.from(flat), 3); pd.getLines().setData(Uint32Array.from(lines));
    it.lineMapper.setInputData(pd);
    refreshHandles();
  }
  remove(id) {
    const it = this.items.get(id);
    if (it) { renderer.removeActor(it.lineActor); for (const h of it.handles) renderer.removeActor(h.actor); this.items.delete(id); }
    refreshHandles();
  }
}

const DMS = [new ViewDM(), new ModelDM(), new VolumeRenderingDM(), new SegmentationDM(), new ROIDM(), new MarkupsDM(), new TransformWidgetDM(), new OrientationMarkerDM()];

// 3D introspection hook for the DM-debug harness: actor/volume counts, per-DM item counts, camera, bounds.
window.__dmDbg = () => {
  let acts = 0, vols = 0;
  try { acts = renderer.getActors().length; vols = renderer.getVolumes().length; } catch (e) {}
  const cam = renderer.getActiveCamera();
  return JSON.stringify({
    build: OFFLOAD_BUILD, standalone: STANDALONE, connected: connected(),
    mirror: mirror.size, actors: acts, volumes: vols,
    dms: DMS.map((d) => ({ name: d.constructor.name, items: d.items ? d.items.size : (d.widget ? 1 : 0) })),
    handles: pickableHandles.length,
    camera: { pos: cam.getPosition().map((x) => Math.round(x)), focal: cam.getFocalPoint().map((x) => Math.round(x)) },
    bounds: (renderer.computeVisiblePropBounds() || []).map((x) => Math.round(x)),
  });
};

// Deterministic full re-apply: run each DM over the current mirror, then drop any vtk objects whose node
// left the closure. No fragile incremental diffing -- the scene is rebuilt from MRML state every change.
// ===== SlicerLive 4-up: 3D + 3 orthogonal slice views (vtk.js multi-viewport; standalone, no compositor) =====
let _fourUp = null;            // { Red:{ren,mapper,slice,volHash}, Yellow:.., Green:.. } once laid out
window.__fourUpDbg = () => { const c = renderer.getActiveCamera(); return _fourUp ? Object.assign(Object.fromEntries(['Red', 'Green', 'Yellow'].map((n) => [n, _fourUp[n] ? { index: _fourUp[n].index, pscale: Math.round(_fourUp[n].pscale || 0) } : null])), { threeD: { dist: Math.round(c.getDistance()), pscale: Math.round(c.getParallelScale()), fp: c.getFocalPoint().map((v) => Math.round(v)) } }) : null; };
const _VP = { Red: [0.0, 0.5, 0.5, 1.0], Yellow: [0.5, 0.0, 1.0, 0.5], Green: [0.0, 0.0, 0.5, 0.5] };  // Slicer FourUp: axial UL, sagittal LR, coronal LL ([x0,y0,x1,y1] bottom-left)
const _col = (m, c) => [m[c], m[4 + c], m[8 + c]];                 // row-major 4x4 column c (xyz part)
const _nrm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const _dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function ensureFourUp() {
  if (_fourUp) return;
  renderer.setViewport(0.5, 0.5, 1.0, 1.0);                        // 3D -> top-right (Slicer FourUp). The 3 slice
  _fourUp = {};                                                    // quadrants are blitted into `out` (OHIF-style).
  // No sliders: scrolling is left-drag / wheel in the slice view (Slicer-style); shift+move jumps the other views.
  for (const name of ['Red', 'Yellow', 'Green']) _fourUp[name] = { index: null, maxIndex: 1, pscale: 0, pan: [0, 0, 0] };
}
// place an image in WORLD coordinates (origin/spacing/direction from ijkToRAS) so vtkImageResliceMapper reslices
// it in world space -- the CT and the labelmap then auto-align at the same world plane (no manual index matching).
function setImageWorldGeometry(img, ijkToRAS) {
  const M = ijkToRAS, g = (r, c) => M[r * 4 + c];
  const sp = [0, 1, 2].map((c) => Math.hypot(g(0, c), g(1, c), g(2, c)) || 1);
  img.setSpacing(sp[0], sp[1], sp[2]);
  img.setOrigin(g(0, 3), g(1, 3), g(2, 3));
  img.setDirection([g(0, 0) / sp[0], g(0, 1) / sp[1], g(0, 2) / sp[2],
                    g(1, 0) / sp[0], g(1, 1) / sp[1], g(1, 2) / sp[2],
                    g(2, 0) / sp[0], g(2, 1) / sp[1], g(2, 2) / sp[2]]);
}

// mat3 (row-major) * vec3
function mv3(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
// Place an image AXIS-ALIGNED (origin 0, spacing, identity direction) and return the world->local frame {Rt, t}:
// local = Rt * (world - t), where R is the volume's normalized IJK->RAS rotation (so Rt = R^-1). vtk.js
// ImageResliceMapper treats the image as axis-aligned (it honors neither the image direction matrix nor the actor
// user matrix), so a rotated/permuted volume is resliced in its OWN physical frame: transform the slice plane +
// camera by this frame -- the same idea as Slicer's reslice axes (XYToIJK) / the dcmjs display2 MPR example.
function imageLocalFrame(img, ijkToRAS) {
  const M = ijkToRAS, g = (r, c) => M[r * 4 + c];
  const sp = [0, 1, 2].map((c) => Math.hypot(g(0, c), g(1, c), g(2, c)) || 1);
  img.setSpacing(sp[0], sp[1], sp[2]); img.setOrigin(0, 0, 0); img.setDirection(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const Rt = [g(0, 0) / sp[0], g(1, 0) / sp[0], g(2, 0) / sp[0],    // R^T (row-major): world vector -> local vector
              g(0, 1) / sp[1], g(1, 1) / sp[1], g(2, 1) / sp[1],
              g(0, 2) / sp[2], g(1, 2) / sp[2], g(2, 2) / sp[2]];
  return { Rt, t: [g(0, 3), g(1, 3), g(2, 3)] };
}

// OHIF-style MPR: ONE offscreen reslice context (multiple ImageResliceMappers across SEPARATE on-screen renderers
// don't render in vtk.js -- only the first does). We reconfigure its plane+camera per orientation, render, and blit
// the result into the visible 2D `out` canvas at that quadrant. CT + labelmap are two reslice mappers in the SAME
// renderer (both render together -- proven), so each blit already carries the colored segment overlay.
let slicesDirty = false;   // slice cameras changed -> reposition + re-render next composite frame
// SLICERLIVE 4-up: render the 3D + 3 thin-slab MPR slices as 4 VIEWPORTS of the ONE (WebGL2) render window. The
// volume mapper applies each volume's IJK->RAS (rotations/permutations just work); a parallel camera + a thin
// clip-range slab per viewport reads as a slice. (vtk.js volume rendering needs the main WebGL2 context.)
let _sliceRens = null;
const _VPRECT = { threeD: [0.5, 0.5, 1, 1], Red: [0, 0.5, 0.5, 1], Green: [0, 0, 0.5, 0.5], Yellow: [0.5, 0, 1, 0.5] };   // origin BOTTOM-left
function ensureSliceRenderers() {
  if (_sliceRens) return _sliceRens;
  renderer.setViewport(..._VPRECT.threeD);   // the existing 3D renderer -> top-right quadrant
  _sliceRens = {};
  for (const name of ['Red', 'Green', 'Yellow']) {
    const ren = vtkRenderer.newInstance({ background: [0, 0, 0] });   // slice views are black (Slicer convention)
    ren.setViewport(..._VPRECT[name]); ren.getActiveCamera().setParallelProjection(true);
    ren.createLight();   // a volume render with 0 lights compiles a broken/dark shader -> the slice would be black
    renderWindow.addRenderer(ren);
    _sliceRens[name] = { ren, ctVol: null, ctMapper: null, ovVol: null, ovMapper: null, key: null, win: 255, lev: 128 };
  }
  return _sliceRens;
}

function setSliceIndex(slot, idx) {
  if (!slot) return;
  slot.index = Math.max(0, Math.min(slot.maxIndex, Math.round(idx)));
  if (slot.slider && +slot.slider.value !== slot.index) slot.slider.value = String(slot.index);
  slicesDirty = true; scene3DDirty = true;
}

// Build (once, cached) the labelmap image (world geometry) + per-label color LUT for the 2D slice FILL overlay.
// The colored OUTLINE is a separate screen-space edge-detect pass (drawSegOutlines), not baked into the data.
const _lmCache = new Map();   // segId:token -> { img, ctf, ofun }
async function ensureLabelmapImage(seg) {
  const meta = seg.blobs && seg.blobs.labelmap;
  if (!seg.attrs.labelmapDims || (!seg.__labelmap && !meta)) return null;
  const key = seg.id + ':' + (seg.__labelmap ? 'direct' : meta.hash);
  if (_lmCache.has(key)) return _lmCache.get(key);
  const arr = seg.__labelmap || await fetchArray(meta); if (!arr) return null;
  const img = vtkImageData.newInstance();
  img.setDimensions(seg.attrs.labelmapDims);
  img.getPointData().setScalars(vtkDataArray.newInstance({ numberOfComponents: 1, values: arr }));
  imageLocalFrame(img, seg.attrs.labelmapIjkToRAS);   // axis-aligned (reslice in the volume's physical frame, like the CT)
  const ctf = vtkColorTransferFunction.newInstance();
  ctf.addRGBPoint(0, 0, 0, 0);
  for (const c of (seg.attrs.segmentColors || [])) ctf.addRGBPoint(c[0], c[1], c[2], c[3]);   // [label, r, g, b]
  const ofun = vtkPiecewiseFunction.newInstance(); ofun.addPoint(0, 0);   // applySeg2DOpacity sets the real LUT
  const rec = { img, ctf, ofun };
  _lmCache.set(key, rec); return rec;
}

// Set up the offscreen reslice context's inputs + each orientation's plane/camera params (rendered at blit time).
async function syncFourUp() {
  const sliceNodes = [...mirror.values()].filter((n) => n.class === 'vtkMRMLSliceNode');
  if (!sliceNodes.length) return;
  ensureFourUp();
  const srs = ensureSliceRenderers();
  const segNode = [...mirror.values()].find((n) => n.class === 'vtkMRMLSegmentationNode' && ((n.blobs && n.blobs.labelmap) || n.__labelmap));
  const lm = segNode ? await ensureLabelmapImage(segNode) : null;
  for (const sn of sliceNodes) {
    const name = sn.attrs.layoutName, slot = _fourUp[name], sr = srs[name];
    if (!slot || !sr || !sn.attrs.sliceToRAS) continue;
    const comp = [...mirror.values()].find((n) => n.class === 'vtkMRMLSliceCompositeNode' && n.attrs.layoutName === name);
    const vol = comp && comp.attrs.backgroundVolumeID ? mirror.get(comp.attrs.backgroundVolumeID) : null;
    if (!vol || !volScalarKey(vol) || !vol.attrs.ijkToRAS) continue;
    const scalars = await getVolumeScalars(vol); if (!scalars) continue;
    const ctxKey = volScalarKey(vol) + '|' + (lm ? segNode.id + ':' + (segNode.__labelmap ? 'direct' : segNode.blobs.labelmap.hash) : '-');
    if (sr.key !== ctxKey) {                                       // (re)build this viewport's slice volumes
      if (sr.ctVol) sr.ren.removeVolume(sr.ctVol);
      if (sr.ovVol) { sr.ren.removeVolume(sr.ovVol); sr.ovVol = null; sr.ovMapper = null; }
      sr.win = 255; sr.lev = 128;
      for (const did of (vol.refs.display || [])) { const d = mirror.get(did); if (d && d.attrs.window != null) { sr.win = d.attrs.window; sr.lev = d.attrs.level; break; } }
      const img = vtkImageData.newInstance();
      img.setDimensions(vol.attrs.dims);
      img.getPointData().setScalars(vtkDataArray.newInstance({ numberOfComponents: vol.attrs.comps || 1, values: scalars }));
      // Thin-slab VOLUME-RENDERED MPR (dcmjs vtkDisplay / OHIF technique): the volume mapper applies the full IJK->RAS
      // via the actor user matrix, so rotations/permutations just work. A parallel camera + thin clip-range slab +
      // opaque scalar opacity (early ray termination) reads as a slice -- rendered as a viewport of the main WebGL2 window.
      const ctm = vtkVolumeMapper.newInstance(); ctm.setInputData(img); ctm.setBlendModeToComposite();
      ctm.setSampleDistance(0.5); ctm.setAutoAdjustSampleDistances(false); ctm.setMaximumSamplesPerRay(4000);   // else a per-frame "steps>max" warning floods the console
      const ctv = vtkVolume.newInstance(); ctv.setMapper(ctm); ctv.setUserMatrix(volumeGeometry(img, vol.attrs.ijkToRAS));
      const lo = sr.lev - sr.win / 2, hi = sr.lev + sr.win / 2;
      const cctf = vtkColorTransferFunction.newInstance(); cctf.addRGBPoint(lo, 0, 0, 0); cctf.addRGBPoint(hi, 1, 1, 1);   // windowed grayscale
      const cofn = vtkPiecewiseFunction.newInstance(); cofn.addPoint(lo - 1, 1); cofn.addPoint(hi + 1, 1);                 // opaque -> early termination
      const cp = ctv.getProperty();
      cp.setRGBTransferFunction(0, cctf); cp.setScalarOpacity(0, cofn); cp.setInterpolationTypeToLinear(); cp.setShade(false); cp.setUseGradientOpacity(0, false);
      sr.ren.addVolume(ctv); sr.ctVol = ctv; sr.ctMapper = ctm;
      if (lm) {   // colored segmentation overlay: a 2nd volume, labels semi-transparent over the opaque CT
        // MAXIMUM-INTENSITY (not composite): a thin slab accumulates multiple labels through-plane where a label
        // boundary grazes the slice -> composite muddies green+red and the jitter speckles it. MIP picks ONE label
        // per pixel (the max along the ray), jitter-insensitive, so the fill (and the outline derived from it) is crisp.
        const ovm = vtkVolumeMapper.newInstance(); ovm.setInputData(lm.img); ovm.setBlendModeToMaximumIntensity();
        ovm.setSampleDistance(0.5); ovm.setAutoAdjustSampleDistances(false); ovm.setMaximumSamplesPerRay(4000);
        const ovv = vtkVolume.newInstance(); ovv.setMapper(ovm); ovv.setUserMatrix(volumeGeometry(lm.img, segNode.attrs.labelmapIjkToRAS));
        const op = ovv.getProperty();
        op.setRGBTransferFunction(0, lm.ctf); op.setScalarOpacity(0, lm.ofun); op.setInterpolationTypeToNearest(); op.setShade(false); op.setUseGradientOpacity(0, false);
        sr.ren.addVolume(ovv); sr.ovVol = ovv; sr.ovMapper = ovm;
      }
      sr.key = ctxKey;
    }
    const i2r = vol.attrs.ijkToRAS, s2r = sn.attrs.sliceToRAS, normal = _nrm3(_col(s2r, 2));
    let axis = 2, best = -1;                                       // image axis most aligned with the slice normal
    for (let a = 0; a < 3; a++) { const d = Math.abs(_dot3(normal, _nrm3(_col(i2r, a)))); if (d > best) { best = d; axis = a; } }
    const ijk = mulMatVec(inv4(i2r), [s2r[3], s2r[7], s2r[11], 1]);   // slice-center -> IJK
    const center = [s2r[3], s2r[7], s2r[11]], step = Math.hypot(..._col(i2r, axis));   // world spacing along axis = scroll step
    slot.normal = normal; slot.up = _nrm3(_col(s2r, 1)); slot.right = _nrm3(_col(s2r, 0));
    slot.axis = axis; slot.maxIndex = vol.attrs.dims[axis] - 1; slot.step = step;
    slot.origin0 = [center[0] - ijk[axis] * step * normal[0], center[1] - ijk[axis] * step * normal[1], center[2] - ijk[axis] * step * normal[2]];
    slot.fov = (sn.attrs.fieldOfView && sn.attrs.fieldOfView[1]) ? sn.attrs.fieldOfView[1] : 250;
    if (slot.index == null || slot._initKey !== ctxKey) {          // initial slice + view (once per scene)
      slot.index = Math.round(ijk[axis]); slot._initKey = ctxKey; slot.pscale = slot.fov / 2; slot.pan = [0, 0, 0];
    }
  }
  slicesDirty = true;
}

// Position each slice viewport's parallel camera + thin clip-range slab at its slice (the main render window draws
// all four viewports). Thin-slab volume render + opaque opacity (early ray termination) == a slice; the volume
// mapper applies the IJK->RAS (user matrix), so rotations/permutations just work -- everything stays in WORLD.
function renderSlices() {
  if (!_sliceRens) return;
  for (const name of ['Red', 'Green', 'Yellow']) {
    const slot = _fourUp[name], sr = _sliceRens[name];
    if (!slot || !sr || !slot.normal || !slot.origin0) continue;
    const n = slot.normal, i = slot.index, s = slot.step, o = slot.origin0, p = slot.pan || [0, 0, 0];
    const orig = [o[0] + i * s * n[0] + p[0], o[1] + i * s * n[1] + p[1], o[2] + i * s * n[2] + p[2]];   // world slice center (with pan)
    const co = cross3(slot.right, slot.up);   // world out-of-screen = right x up -> RADIOLOGICAL camera side
    const D = 500, t = Math.max(slot.step || 1, 1);
    const cam = sr.ren.getActiveCamera();
    cam.setParallelProjection(true); cam.setFocalPoint(orig[0], orig[1], orig[2]);
    cam.setPosition(orig[0] + co[0] * D, orig[1] + co[1] * D, orig[2] + co[2] * D);
    cam.setViewUp(slot.up[0], slot.up[1], slot.up[2]); cam.setParallelScale(slot.pscale || slot.fov / 2);
    cam.setClippingRange(D - t * 0.4, D + t * 0.4);   // thin slab CENTERED on the slice voxel (was D-0.5..D+t, which
    // reached a full voxel BEHIND the plane -> the ray composited this slice's label AND the next slice's, so a
    // segment behind showed THROUGH (the "cyst through kidney" overlap). +/-0.4*spacing stays inside one voxel.
    const sd = Math.max(0.05, t / 8);   // sample the slab ~8x: non-axial slabs cut the FINE axis (thin), so 0.5mm left
    if (sr.ctMapper) sr.ctMapper.setSampleDistance(sd);   // gaps -> dotted/speckled seg-only render -> spurious outlines
    if (sr.ovMapper) sr.ovMapper.setSampleDistance(sd);
  }
}

// --- Segmentation OUTLINE (GPU): screen-space edge detection on a seg-only slab, composited on the GPU.
// Its own transparent WebGL2 layer over the CT+fill render (a SEPARATE context, so vtk.js's GL state is untouched).
// Per slice/scene change: render the seg-only slabs, upload that frame to a texture (texImage2D from the canvas --
// a GPU upload, no readPixels/getImageData), and a fragment shader marks any segment pixel within ~2px of a
// different segment/background as an outline pixel in its own color. Fill reaches the edge (it's the layer below),
// the outline sits on top, two abutting where segments meet, and it stays synced while scrubbing (no CPU pixel loop).
const _outGL = document.createElement('canvas');
_outGL.id = 'offload3d-outline';
_outGL.style.cssText = 'position:fixed; z-index:6; display:none; pointer-events:none;';
document.body.appendChild(_outGL);
let _ogl = null, _oglProg = null, _oglTex = null, _oglU = {}, _segOutlineDirty = true, _outlineReady = false;
function setupOutlineGL() {
  if (_ogl) return _ogl;
  _ogl = _outGL.getContext('webgl2', { premultipliedAlpha: false, alpha: true, antialias: false }); if (!_ogl) return null;
  const gl = _ogl;
  const VS = '#version 300 es\nin vec2 aPos; out vec2 vUV; void main(){ vUV=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }';
  const FS = '#version 300 es\nprecision highp float;\nuniform sampler2D uSeg; uniform vec2 uTexel; uniform vec4 u3D; uniform float uHas;\nin vec2 vUV; out vec4 frag;\nbool sg(vec4 c){ return max(c.r,max(c.g,c.b))>0.07; }\nvoid main(){ frag=vec4(0.0); if(uHas<0.5) return; if(vUV.x>=u3D.x&&vUV.x<=u3D.z&&vUV.y>=u3D.y&&vUV.y<=u3D.w) return; vec4 c=texture(uSeg,vUV); if(!sg(c)) return; bool b=false; for(int dy=-2;dy<=2;dy++){ for(int dx=-2;dx<=2;dx++){ if(dx==0&&dy==0) continue; if(abs(dx)+abs(dy)>2) continue; vec4 n=texture(uSeg, vUV+vec2(float(dx),float(dy))*uTexel); if(!sg(n)||distance(n.rgb,c.rgb)>0.23) b=true; } } if(b) frag=vec4(c.rgb,1.0); }';
  const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS)); gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  _oglProg = p; _oglU = { uSeg: gl.getUniformLocation(p, 'uSeg'), uTexel: gl.getUniformLocation(p, 'uTexel'), u3D: gl.getUniformLocation(p, 'u3D'), uHas: gl.getUniformLocation(p, 'uHas') };
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  _oglTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _oglTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  return _ogl;
}
function computeSegOutlines() {
  const glc = glWindow.getCanvas && glWindow.getCanvas(); if (!glc) return;
  if (!mirror.get('idcSeg') || !setupOutlineGL()) return;
  const draw3D = renderer.getDraw ? renderer.getDraw() : true;
  const ctVis = [];                                          // seg-only: hide 3D + every slice's CT, fill -> opaque
  renderer.setDraw(false);
  for (const nm in _sliceRens) { const sr = _sliceRens[nm]; if (sr && sr.ctVol) { ctVis.push([sr.ctVol, sr.ctVol.getVisibility()]); sr.ctVol.setVisibility(false); } }
  _segOutOpaque = true; applySeg2DOpacity();
  try { renderWindow.render(); } catch (e) {}                // vtk canvas = the seg-only slabs
  try { const vgl = glWindow.get3DContext && glWindow.get3DContext(); if (vgl) vgl.finish(); } catch (e) {}   // FLUSH vtk's GL before the cross-context texImage2D below, else fast scrubbing reads a STALE canvas (a previous slice) -> outline desynced from the fill until the next render
  drawOutlineGL(glc);                                        // GPU: upload that frame + edge-detect -> the _outGL layer
  renderer.setDraw(draw3D);                                  // restore (the caller renders the normal CT+fill view right after)
  for (const [v, vis] of ctVis) v.setVisibility(vis);
  _segOutOpaque = false; applySeg2DOpacity();
}
function drawOutlineGL(glc) {
  const gl = _ogl, W = glc.width, H = glc.height; if (!gl || !W || !H) return;
  if (_outGL.width !== W || _outGL.height !== H) { _outGL.width = W; _outGL.height = H; }
  gl.bindTexture(gl.TEXTURE_2D, _oglTex);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glc); } catch (e) { return; }
  gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(_oglProg);
  gl.uniform1i(_oglU.uSeg, 0); gl.uniform2f(_oglU.uTexel, 1 / W, 1 / H);
  gl.uniform1f(_oglU.uHas, _maxView === 'threeD' ? 0 : 1);   // 3D maximized -> no slices -> no outline
  if (_maxView && _maxView !== 'threeD') gl.uniform4f(_oglU.u3D, 2, 2, 2, 2);   // a slice fills the window -> skip nothing
  else gl.uniform4f(_oglU.u3D, 0.5, 0.5, 1.0, 1.0);                              // 4-up -> skip the 3D quadrant (top-right, UV)
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  _outlineReady = true;
}
// --- maximize: double-click a viewport -> fullscreen; double-click again -> restore 4-up. The 3D + 3 slice
// renderers are viewports of the ONE render window, so maximize = give that renderer the whole window and stop
// drawing the others (setDraw(false)). _sliceVP() reports the effective hit-test rect for the active layout.
let _maxView = null;   // null = 4-up; else 'threeD' | 'Red' | 'Green' | 'Yellow'
function setMaxView(name) {
  _maxView = name || null;
  const full = [0, 0, 1, 1];
  const set = (ren, rect, draw) => { ren.setViewport(rect[0], rect[1], rect[2], rect[3]); if (ren.setDraw) ren.setDraw(draw); };
  set(renderer, name === 'threeD' ? full : _VPRECT.threeD, !name || name === 'threeD');
  for (const n of ['Red', 'Green', 'Yellow']) set(_sliceRens[n].ren, name === n ? full : _VPRECT[n], !name || name === n);
  if (_ctrlBtn) _ctrlBtn.style.display = (name && name !== 'threeD') ? 'none' : 'flex';   // display menu belongs to the 3D view
  if (name && name !== 'threeD') closeCtrlMenu();
  _segOutlineDirty = true; slicesDirty = true; scene3DDirty = true; try { renderWindow.render(); } catch (e) {} markDirty();
}
function toggleMaxAt(cx, cy) {
  if (_maxView) { setMaxView(null); return; }                         // already maximized -> restore
  const r = host.getBoundingClientRect();
  const x = (cx - r.left) / r.width, y = 1 - (cy - r.top) / r.height;
  let target = 'threeD';                                              // not in a slice quadrant -> the 3D view
  for (const n of ['Red', 'Yellow', 'Green']) { const v = _VP[n]; if (x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3]) { target = n; break; } }
  setMaxView(target);
}
function _sliceVP(name) {                                             // effective hit-test rect, honoring maximize
  if (_maxView === 'threeD') return null;
  if (_maxView && _maxView !== name) return null;
  return _maxView === name ? [0, 0, 1, 1] : _VP[name];
}
// --- slice-view interaction (standalone 4-up): route by quadrant; pan/zoom/scroll match Slicer ---
function fourUpSlotAt(clientX, clientY) {
  if (!_fourUp || _maxView === 'threeD') return null;
  const r = host.getBoundingClientRect();
  const x = (clientX - r.left) / r.width, y = 1 - (clientY - r.top) / r.height;   // 0..1, bottom-left origin
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  for (const name of ['Red', 'Yellow', 'Green']) { const v = _sliceVP(name); if (v && x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3]) return _fourUp[name]; }
  return null;   // the 3D quadrant -> let the vtk.js interactor (trackball) handle it
}
// World (RAS) point under the cursor, on the hovered slice plane. Inverts the slice's parallel camera (slot.right =
// screen-right, slot.up = screen-up, slot.pscale = half world-height; horizontal half-extent = pscale*aspect).
function sliceWorldAt(cx, cy) {
  if (!_fourUp || _maxView === 'threeD') return null;
  const r = host.getBoundingClientRect();
  const x = (cx - r.left) / r.width, y = 1 - (cy - r.top) / r.height;
  for (const name of ['Red', 'Yellow', 'Green']) {
    const v = _sliceVP(name); if (!v) continue;
    if (x < v[0] || x > v[2] || y < v[1] || y > v[3]) continue;
    const slot = _fourUp[name]; if (!slot || !slot.normal || !slot.origin0) return null;
    const u = (x - v[0]) / (v[2] - v[0]), vv = (y - v[1]) / (v[3] - v[1]);
    const qwPx = (v[2] - v[0]) * r.width, qhPx = (v[3] - v[1]) * r.height, aspect = qhPx ? qwPx / qhPx : 1;
    const ps = slot.pscale || slot.fov / 2;
    const sx = (u - 0.5) * 2 * ps * aspect, sy = (vv - 0.5) * 2 * ps;
    const i = slot.index, s = slot.step, n = slot.normal, o = slot.origin0, p = slot.pan || [0, 0, 0], R = slot.right, U = slot.up;
    const orig = [o[0] + i * s * n[0] + p[0], o[1] + i * s * n[1] + p[1], o[2] + i * s * n[2] + p[2]];
    return { name, slot, ras: [orig[0] + R[0] * sx + U[0] * sy, orig[1] + R[1] * sx + U[1] * sy, orig[2] + R[2] * sx + U[2] * sy] };
  }
  return null;
}
// Is the cursor over the 3D quadrant (top-right in 4-up, or the whole host when 3D is maximized)?
function inThreeDQuadrant(cx, cy) {
  if (!_fourUp) return false;
  if (_maxView === 'threeD') return true;                                // 3D fills the host
  if (_maxView) return false;                                            // a slice fills the host -> no 3D shown
  const r = host.getBoundingClientRect();
  const x = (cx - r.left) / r.width, y = 1 - (cy - r.top) / r.height;    // bottom-left origin
  const v = _VPRECT.threeD;
  return x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3];
}
// World (RAS) under the cursor in the 3D view, projected onto the plane through the camera focal point (the rotation
// center) perpendicular to the view -- Slicer's shift-move "pick" without needing a surface/volume depth pick.
function world3DAt(cx, cy) {
  if (!geom) return null;
  const r = host.getBoundingClientRect();
  const px = (cx - r.left) * (geom.cw / r.width), py = (cy - r.top) * (geom.ch / r.height);
  const aspect = geom.cw / geom.ch, F = renderer.getActiveCamera().getFocalPoint();
  const Fn = renderer.worldToNormalizedDisplay(F[0], F[1], F[2], aspect);   // focal-point depth in the frustum
  const W = renderer.normalizedDisplayToWorld(px / geom.cw, 1 - py / geom.ch, Fn[2], aspect);
  return (W && isFinite(W[0])) ? [W[0], W[1], W[2]] : null;
}
// Unified shift-target: the RAS point under the cursor, whether over a slice (its plane) or the 3D view (focal plane).
function shiftWorldAt(cx, cy) {
  const w = sliceWorldAt(cx, cy); if (w) return w;
  if (inThreeDQuadrant(cx, cy)) { const ras = world3DAt(cx, cy); if (ras) return { name: null, ras }; }
  return null;
}
// Slicer-style crosshair jump: set every OTHER slice's offset so its plane passes through the RAS point.
function jumpOthersTo(ras, exceptName) {
  for (const name of ['Red', 'Yellow', 'Green']) {
    if (name === exceptName) continue;
    const slot = _fourUp[name]; if (!slot || !slot.normal || !slot.origin0 || !slot.step) continue;
    const n = slot.normal, o = slot.origin0;
    setSliceIndex(slot, ((ras[0] - o[0]) * n[0] + (ras[1] - o[1]) * n[1] + (ras[2] - o[2]) * n[2]) / slot.step);
    // ALSO pan in-plane so `ras` sits at the viewport CENTER, not just on the slice plane. Without this a small,
    // off-center segmentation (e.g. a kidney low in the volume) lands in a corner while the view stays centered on
    // the whole volume -- the 2D looked "off" even though the seg is correctly registered on the CT. base = this
    // slice's center at this index (no pan); shift by the in-plane component of (ras - base) along right/up.
    const i = slot.index, s = slot.step, R = slot.right, U = slot.up;
    const base = [o[0] + i * s * n[0], o[1] + i * s * n[1], o[2] + i * s * n[2]];
    const d = [ras[0] - base[0], ras[1] - base[1], ras[2] - base[2]];
    const dr = d[0] * R[0] + d[1] * R[1] + d[2] * R[2], du = d[0] * U[0] + d[1] * U[1] + d[2] * U[2];
    slot.pan = [R[0] * dr + U[0] * du, R[1] * dr + U[1] * du, R[2] * dr + U[2] * du];
  }
  slicesDirty = true;
}
let _sliceDrag = null, _lastDown = null;
host.addEventListener('wheel', (e) => {
  const slot = fourUpSlotAt(e.clientX, e.clientY); if (!slot) return;   // 3D quadrant -> vtk.js zoom
  e.stopPropagation(); e.preventDefault();
  setSliceIndex(slot, slot.index + (e.deltaY > 0 ? -1 : 1));            // wheel = slice offset
}, true);
// shift + move over a slice OR the 3D view -> jump the other slices to that physical location (hovering OR dragging)
host.addEventListener('pointermove', (e) => {
  if (!_fourUp || !e.shiftKey) return;
  if (_sliceDrag) return;                                               // a shift+right-drag (synced zoom) owns the gesture -> don't jump
  const w = shiftWorldAt(e.clientX, e.clientY); if (!w) return;         // not over any viewport -> let it pass
  e.stopPropagation(); jumpOthersTo(w.ras, w.name);
}, true);
host.addEventListener('pointerdown', (e) => {
  if (!_fourUp) return;
  // double-click ANY viewport (incl. the 3D quadrant) -> toggle fullscreen / restore. Detected here (not via the
  // dblclick event) because slice pointerdowns preventDefault, which would suppress the synthesized dblclick.
  const dbl = _lastDown && (e.timeStamp - _lastDown.t) < 350 && Math.hypot(e.clientX - _lastDown.x, e.clientY - _lastDown.y) < 6;
  _lastDown = dbl ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY };
  if (dbl) { toggleMaxAt(e.clientX, e.clientY); e.stopPropagation(); e.preventDefault(); return; }
  // SHIFT gestures work over ANY quadrant (slice OR 3D): right-drag = synced zoom (all 3 slices + the 3D), left/move = jump
  if (e.shiftKey && (e.button === 0 || e.button === 2)) {
    const over = !!fourUpSlotAt(e.clientX, e.clientY) || inThreeDQuadrant(e.clientX, e.clientY);
    if (over) {
      e.stopPropagation(); e.preventDefault();
      if (e.button === 2) {   // shift + right-drag = zoom every view together (no jump) -> home in, then study in detail
        _sliceDrag = { mode: 'zoomAll', x: e.clientX, y: e.clientY, acc: 0 };
        window.addEventListener('pointermove', onSliceDrag, true);
        window.addEventListener('pointerup', onSliceUp, true);
      } else {                // shift + left/move = jump the slices to here (the move handler continues it)
        const w = shiftWorldAt(e.clientX, e.clientY); if (w) jumpOthersTo(w.ras, w.name);
      }
      return;
    }
  }
  const slot = fourUpSlotAt(e.clientX, e.clientY); if (!slot) return;   // 3D quadrant (no shift) -> vtk.js trackball
  e.stopPropagation(); e.preventDefault();                             // a slice view owns this -> never trackball
  const mode = e.button === 2 ? 'zoom' : e.button === 1 ? 'pan' : e.button === 0 ? 'scroll' : null;   // left = scroll slices
  if (!mode) return;
  _sliceDrag = { slot, mode, x: e.clientX, y: e.clientY, acc: 0 };
  window.addEventListener('pointermove', onSliceDrag, true);
  window.addEventListener('pointerup', onSliceUp, true);
}, true);
function onSliceDrag(e) {
  if (!_sliceDrag) return; e.stopPropagation();
  const { slot, mode } = _sliceDrag, dx = e.clientX - _sliceDrag.x, dy = e.clientY - _sliceDrag.y;
  _sliceDrag.x = e.clientX; _sliceDrag.y = e.clientY;
  if (mode === 'scroll') {                                              // drag up/right -> forward, down/left -> back
    _sliceDrag.acc += (dx - dy); const STEP = 7;
    while (Math.abs(_sliceDrag.acc) >= STEP) { const d = _sliceDrag.acc > 0 ? 1 : -1; setSliceIndex(slot, slot.index + d); _sliceDrag.acc -= d * STEP; }
    return;
  }
  if (mode === 'zoomAll') {                                            // shift+right: same factor on all 3 slices AND the 3D
    const f = Math.exp(-dy * 0.006);                                  // (slices stay centered on their jumped location;
    for (const nm of ['Red', 'Green', 'Yellow']) { const so = _fourUp[nm]; if (so) so.pscale = Math.max(0.5, (so.pscale || so.fov / 2) * f); }
    slicerDolly(renderer, 1 / f);                                     // 3D dollies toward its focal point. pscale*=f (f<1=in); dolly>1=in
    slicesDirty = true; scene3DDirty = true; return;
  }
  const ps = slot.pscale || slot.fov / 2;
  if (mode === 'zoom') {
    slot.pscale = Math.max(0.5, ps * Math.exp(-dy * 0.006));          // right-drag down = zoom in (matches Slicer)
  } else {                                                             // middle-drag pan: image follows the cursor
    const qh = (geom ? geom.ch : 1000) / 2, worldPerPx = (ps * 2) / qh;
    const mvx = -dx * worldPerPx, mvy = dy * worldPerPx, p = slot.pan || [0, 0, 0];
    slot.pan = [p[0] + slot.right[0] * mvx + slot.up[0] * mvy, p[1] + slot.right[1] * mvx + slot.up[1] * mvy, p[2] + slot.right[2] * mvx + slot.up[2] * mvy];
  }
  slicesDirty = true; scene3DDirty = true;
}
function onSliceUp(e) { e.stopPropagation(); window.removeEventListener('pointermove', onSliceDrag, true); window.removeEventListener('pointerup', onSliceUp, true); _sliceDrag = null; }

async function syncDMs() {
  for (const [id, node] of mirror) {
    for (const dm of DMS) {
      if (dm.handles(node)) { try { await dm.update(id, node); } catch (e) { console.warn('[offload] DM', node.class, e); } }
    }
  }
  for (const dm of DMS) if (dm.items) for (const id of [...dm.items.keys()]) if (!mirror.has(id)) dm.remove(id);
  updateViewBox();
  try { await syncSlices(); } catch (e) { console.warn('[offload] syncSlices', e); }
  if (SLICERLIVE) { try { await syncFourUp(); } catch (e) { console.warn('[SlicerLive] syncFourUp', e); window.__syncFourUpErr = String(e && e.stack || e); } }
  drawVectorOverlay();      // markups-in-slice redraw on scene/slice change (also fires on mousemove for the brush)
  markDirty();              // let composite() do the actual render next frame (was: render every syncDMs)
}

// Slicer 3D view box: a faint wireframe at the DATA bounds (the view node's boxVisible). Updated after the
// content DMs so the renderer's bounds are populated; the box excludes itself from those bounds.
let viewBoxActor = null, viewBoxMapper = null;
function updateViewBox() {
  const viewNode = [...mirror.values()].find((n) => n.class === 'vtkMRMLViewNode');
  if (!viewNode || !viewNode.attrs.boxVisible) { if (viewBoxActor) viewBoxActor.setVisibility(false); viewBounds = null; return; }
  if (!viewBoxActor) {
    viewBoxMapper = vtkMapper.newInstance(); viewBoxActor = vtkActor.newInstance(); viewBoxActor.setMapper(viewBoxMapper);
    const p = viewBoxActor.getProperty(); p.setColor(1, 1, 1); p.setOpacity(0.35); p.setLighting(false);
    viewBoxActor.setUseBounds(false);
    renderer.addActor(viewBoxActor);
  }
  const b = renderer.computeVisiblePropBounds();
  if (!b || b[0] > b[1]) { viewBoxActor.setVisibility(false); viewBounds = null; return; }
  viewBoxMapper.setInputData(axisAlignedBox(b));
  viewBoxActor.setVisibility(true);
  viewBounds = b; axisLabelsOn = !!viewNode.attrs.axisLabelsVisible;   // drive the 2D axis labels (R/A/S/L/P/I)
}

let cameraInit = false;
function applyCameraOnce() {     // align to Slicer's camera ONCE, then the browser owns the camera locally
  if (cameraInit) return;
  const camNode = [...mirror.values()].find((n) => n.class === 'vtkMRMLCameraNode');
  if (!camNode || !camNode.attrs.position) return;
  const c = renderer.getActiveCamera(), a = camNode.attrs;
  c.setPosition(...a.position); c.setFocalPoint(...a.focalPoint); c.setViewUp(...a.viewUp);
  c.setViewAngle(a.viewAngle);
  if (a.parallelProjection) { c.setParallelProjection(true); c.setParallelScale(a.parallelScale); }
  renderer.resetCameraClippingRange();
  cameraInit = true;
}

async function pullMRML() {
  let state;
  try { state = await fetch(`${SCENE}/mrml?view=${VIEW}`).then((r) => r.json()); } catch (e) { return false; }
  if (!state || state.error) { if (state && state.error) console.error('[offload]', state.error); return false; }
  mirror.clear();
  for (const [id, node] of Object.entries(state)) mirror.set(id, node);
  // LEASE: while dragging a handle, the browser owns this ROI -- keep the local drag value so the server's
  // (slightly stale) echo of our own write doesn't snap the box back mid-drag.
  if (leasedId && leasedLocal) {
    const n = mirror.get(leasedId);
    if (n) Object.assign(n.attrs, leasedLocal);            // ROI {center,halfSizes} or markup {controlPoints}
  }
  applyCameraOnce();
  await syncDMs();
  return true;
}

// Converge to the latest announced version (retry on failure; re-read pendingVersion each pass).
async function syncToLatest() {
  if (syncing) return;
  syncing = true;
  try {
    let guard = 0;
    while (pendingVersion !== appliedVersion && guard++ < 1000) {
      const target = pendingVersion;
      const ok = await pullMRML();
      if (ok) appliedVersion = target;
      else await new Promise((r) => setTimeout(r, 120));
    }
  } finally { syncing = false; }
}

// =====================================================================================================
//  ROI handle interaction (Phase 2): local re-crop at full rate + leased, rate-gated write-back.
//  This is the generalizable markup-widget pattern (pick handle -> drag -> local effect -> sync out).
// =====================================================================================================
let leasedId = null, leasedLocal = null, dragging = null, hoveredHandle = null;
const HANDLE_BASE = [0.35, 0.8, 1], HANDLE_HOVER = [1, 0.9, 0.3];   // light blue / yellow highlight

function worldToScreen(w) {                     // world (RAS) -> CSS px relative to out/host (top-left origin)
  const aspect = geom ? geom.cw / geom.ch : 1;
  const n = renderer.worldToNormalizedDisplay(w[0], w[1], w[2], aspect);
  return { x: n[0] * geom.cw, y: (1 - n[1]) * geom.ch };
}
function cursorPx(e) {
  const r = out.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (geom.cw / r.width), y: (e.clientY - r.top) * (geom.ch / r.height) };
}
function pickHandle(e) {
  if (!geom || !pickableHandles.length) return null;
  const c = cursorPx(e); let best = null, bestD = 16;       // 16px pick radius
  for (const h of pickableHandles) { const s = worldToScreen(h.world); const d = Math.hypot(s.x - c.x, s.y - c.y); if (d < bestD) { bestD = d; best = h; } }
  return best;
}
const screenDir = (C, v) => { const p0 = worldToScreen(C), p1 = worldToScreen([C[0] + v[0], C[1] + v[1], C[2] + v[2]]); return { x: p1.x - p0.x, y: p1.y - p0.y }; };

// capture-phase so it runs BEFORE the vtk.js interactor; if we grab a handle, stopPropagation -> no camera move
host.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !connected()) return;
  const h = pickHandle(e);
  if (!h) return;
  const node = mirror.get(h.nodeId); if (!node) return;
  e.stopPropagation(); e.preventDefault();
  const a = node.attrs;
  const drag = { h, startCursor: cursorPx(e) };
  const cameraPlane = (anchor) => {                         // set up a 2x2 screen->world solve in the camera plane
    const cam = renderer.getActiveCamera();
    drag.up = cam.getViewUp(); drag.right = norm3(cross3(cam.getDirectionOfProjection(), drag.up));
    drag.screenRight = screenDir(anchor, drag.right); drag.screenUp = screenDir(anchor, drag.up);
  };
  if (h.type === 'point') {                                 // markup control point: translate in the camera plane
    drag.startPoint = a.controlPoints[h.index].slice();
    cameraPlane(drag.startPoint);
    leasedLocal = { controlPoints: a.controlPoints.map((p) => p.slice()) };
  } else if (h.type === 'taxis' || h.type === 'tcenter') {  // transform interaction widget handle
    const C = a.widgetCenter, ax = a.axes;
    drag.startCenter = C.slice();
    if (h.type === 'taxis') { const u = ax[h.axis]; drag.axisVec = u; drag.screenOut = screenDir(C, u); }
    else cameraPlane(C);                                    // center: free translate in the camera plane
    leasedLocal = { widgetCenter: C.slice(), matrixToParent: a.matrixToParent.slice() };
  } else {                                                  // ROI handle
    const C = a.center, ax = a.axes;
    drag.startCenter = C.slice(); drag.startHalf = a.halfSizes.slice();
    if (h.type === 'face') { const u = ax[h.axis], s = h.sign; drag.screenOut = screenDir(C, [s * u[0], s * u[1], s * u[2]]); }
    else if (h.type === 'corner') { drag.screenOut = [0, 1, 2].map((i) => { const u = ax[i], si = h.s[i]; return screenDir(C, [si * u[0], si * u[1], si * u[2]]); }); }
    else cameraPlane(C);                                    // center: translate
    leasedLocal = { center: a.center.slice(), halfSizes: a.halfSizes.slice() };
  }
  dragging = drag; leasedId = h.nodeId;
  window.addEventListener('pointermove', onHandleMove, true);
  window.addEventListener('pointerup', onHandleUp, true);
}, true);

// hover highlight: recolor the handle under the cursor (the composite loop re-renders it next frame)
function setHoveredHandle(h) {
  if (h === hoveredHandle) return;
  if (hoveredHandle) hoveredHandle.actor.getProperty().setColor(...hoveredHandle.baseColor);
  if (h) {                                          // hover = the node's MRML ActiveColor (markups: green), else default
    const node = mirror.get(h.nodeId), disp = node && displayNodeOf(node);
    h.actor.getProperty().setColor(...((disp && disp.attrs.activeColor) || HANDLE_HOVER));
  }
  hoveredHandle = h;
}
host.addEventListener('pointermove', (e) => {
  if (dragging) return;                                    // keep the grabbed handle highlighted while dragging
  setHoveredHandle(pickHandle(e));
}, true);

const projOnto = (dx, dy, so) => (dx * so.x + dy * so.y) / (so.x * so.x + so.y * so.y || 1);   // world units along so
const cameraSolve = (dx, dy, dr) => {                                     // screen delta -> (a along right, b along up)
  const sr = dr.screenRight, su = dr.screenUp, det = sr.x * su.y - su.x * sr.y || 1e-6;
  return [(dx * su.y - su.x * dy) / det, (sr.x * dy - dx * sr.y) / det];
};
function onHandleMove(e) {
  if (!dragging) return;
  e.stopPropagation();
  const cur = cursorPx(e), dx = cur.x - dragging.startCursor.x, dy = cur.y - dragging.startCursor.y;
  const node = mirror.get(leasedId); if (!node) return;
  const a = node.attrs, h = dragging.h;
  if (h.type === 'point') {                                               // markup control point -> translate, write {mcp}
    const [ca, cb] = cameraSolve(dx, dy, dragging), R = dragging.right, U = dragging.up, P0 = dragging.startPoint;
    const np = [P0[0] + R[0] * ca + U[0] * cb, P0[1] + R[1] * ca + U[1] * cb, P0[2] + R[2] * ca + U[2] * cb];
    a.controlPoints = a.controlPoints.map((p, i) => (i === h.index ? np : p));
    leasedLocal = { controlPoints: a.controlPoints.map((p) => p.slice()) };
    drawVectorOverlay();              // SYNC slice-glyph update with the NEW position -- the async syncDMs's own
    syncDMs();                        // redraw lands a frame or two later (that delay WAS the slice-view drag lag)
    sendGated({ t: 'mcp', id: leasedId, index: h.index, pos: np });
    return;
  }
  if (h.type === 'taxis' || h.type === 'tcenter') {                       // transform widget -> edit the matrix translation
    const C0 = dragging.startCenter;
    let np;
    if (h.type === 'tcenter') {
      const [ca, cb] = cameraSolve(dx, dy, dragging), R = dragging.right, U = dragging.up;
      np = [C0[0] + R[0] * ca + U[0] * cb, C0[1] + R[1] * ca + U[1] * cb, C0[2] + R[2] * ca + U[2] * cb];
    } else {
      const u = dragging.axisVec, d = projOnto(dx, dy, dragging.screenOut);   // world units along the screen-projected axis
      np = [C0[0] + u[0] * d, C0[1] + u[1] * d, C0[2] + u[2] * d];
    }
    a.widgetCenter = np;
    const M = a.matrixToParent.slice(); M[3] = np[0]; M[7] = np[1]; M[11] = np[2];   // row-major translation column
    a.matrixToParent = M;
    leasedLocal = { widgetCenter: np.slice(), matrixToParent: M.slice() };
    syncDMs();                                                            // re-render the widget + the transformed content
    sendGated({ t: 'transform', id: leasedId, matrix: M });
    return;
  }
  const ax = a.axes;
  if (h.type === 'center') {                                              // ROI translate in the camera plane
    const [ca, cb] = cameraSolve(dx, dy, dragging), R = dragging.right, U = dragging.up, C0 = dragging.startCenter;
    a.center = [C0[0] + R[0] * ca + U[0] * cb, C0[1] + R[1] * ca + U[1] * cb, C0[2] + R[2] * ca + U[2] * cb];
    a.halfSizes = dragging.startHalf.slice();
  } else {                                                                // resize: face = 1 axis, corner = 3 (opposite fixed)
    const axesI = h.type === 'face' ? [h.axis] : [0, 1, 2];
    const newHalf = dragging.startHalf.slice(); let center = dragging.startCenter.slice();
    for (const i of axesI) {
      const so = h.type === 'face' ? dragging.screenOut : dragging.screenOut[i];
      const s = h.type === 'face' ? h.sign : h.s[i];
      const d = projOnto(dx, dy, so);
      newHalf[i] = Math.max(1, dragging.startHalf[i] + d / 2);
      const shift = s * (newHalf[i] - dragging.startHalf[i]), u = ax[i];
      center = [center[0] + u[0] * shift, center[1] + u[1] * shift, center[2] + u[2] * shift];
    }
    a.halfSizes = newHalf; a.center = center;
  }
  leasedLocal = { center: a.center.slice(), halfSizes: a.halfSizes.slice() };
  syncDMs();                                                              // LOCAL re-crop + re-box + re-handles, full rate
  sendGated({ t: 'roi', id: leasedId, center: a.center, size: a.halfSizes.map((x) => x * 2) });
}
function onHandleUp(e) {
  e.stopPropagation();
  window.removeEventListener('pointermove', onHandleMove, true);
  window.removeEventListener('pointerup', onHandleUp, true);
  dragging = null;
  if (!wsOpen) { finalizing = false; leasedId = null; leasedLocal = null; return; }
  if (writeInFlight || writePending) finalizing = true;                  // lease releases on the final ack
  else { leasedId = null; leasedLocal = null; }                          // nothing pending -> already settled
}

// Rate-adaptive, drop-to-latest write-back: at most ONE write in flight; the next sends when the server
// ACKs the previous. The outbound rate then tracks the real round-trip -- impedance matching (§6c). The
// local re-crop stays full-rate regardless; only the sync-out adapts. Safety timeout: treat a lost ack as
// acked so a drag never stalls.
let writeInFlight = false, writePending = null, ackTimer = null, finalizing = false;
function sendGated(msg) { writePending = msg; if (!writeInFlight) flushWrite(); }   // drop-to-latest
function flushWrite() {
  if (!writePending || !wsOpen) return;
  const w = writePending; writePending = null; writeInFlight = true;
  try { ws.send(JSON.stringify(w)); } catch (e) { writeInFlight = false; return; }
  clearTimeout(ackTimer); ackTimer = setTimeout(onAck, 500);                       // safety if an ack is lost
}
function onAck() {
  clearTimeout(ackTimer); writeInFlight = false;
  if (writePending) flushWrite();
  else if (finalizing) { finalizing = false; leasedId = null; leasedLocal = null; }   // settled -> drop the lease
}

// =====================================================================================================
//  compositing + interaction routing + camera + WS (unchanged transport; just drives pullMRML)
// =====================================================================================================
function videoMap() {
  const v = document.getElementById('v');
  if (!v) return null;
  const r = v.getBoundingClientRect();
  const sw = v.width || 1600, sh = v.height || 1000;
  const scale = Math.min(r.width / sw, r.height / sh);
  return { left: r.left + (r.width - sw * scale) / 2, top: r.top + (r.height - sh * scale) / 2, scale, sw, sh };
}

function positionOverlay() {
  if (STANDALONE) {                                            // harness: host IS the visible output, full window, no video
    const cw = window.innerWidth, ch = window.innerHeight;
    for (const el of [host, out, _outGL]) { el.style.left = '0px'; el.style.top = '0px'; el.style.width = cw + 'px'; el.style.height = ch + 'px'; }   // _outGL display is toggled in composite
    for (const el of [host, out]) el.style.display = 'block';
    host.style.opacity = '1';
    _segOutlineDirty = true;                                  // window/layout resized -> recompute the outline at the new size
    if (out.width !== cw || out.height !== ch) { out.width = cw; out.height = ch; }
    if (maskCv.width !== cw || maskCv.height !== ch) { maskCv.width = cw; maskCv.height = ch; }
    geom = { sx: 0, sy: 0, sw: cw, sh: ch, cw, ch };
    const dpr = window.devicePixelRatio || 1;                 // render the WebGL backing store at DEVICE resolution
    glWindow.setSize(Math.round(cw * dpr), Math.round(ch * dpr));   // (vtk.js 36 setSize = backing px, no DPR) -> crisp on retina
    const cv = glWindow.getCanvas && glWindow.getCanvas();
    if (cv) { cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; }   // but display at logical CSS size
    slicesDirty = true; renderWindow.render(); markDirty();
    return;
  }
  if (!lastRect) return;
  const m = videoMap();
  if (!m) return;
  const rx = m.sw / (lastRect.screenW || m.sw), ry = m.sh / (lastRect.screenH || m.sh);
  const sx = lastRect.x * rx, sy = lastRect.y * ry, sw = lastRect.w * rx, sh = lastRect.h * ry;
  const cw = Math.max(1, Math.round(sw * m.scale)), ch = Math.max(1, Math.round(sh * m.scale));
  const left = (m.left + sx * m.scale) + 'px', top = (m.top + sy * m.scale) + 'px';
  for (const el of [host, out]) {
    el.style.left = left; el.style.top = top; el.style.width = cw + 'px'; el.style.height = ch + 'px'; el.style.display = 'block';
  }
  if (out.width !== cw || out.height !== ch) { out.width = cw; out.height = ch; }
  if (maskCv.width !== cw || maskCv.height !== ch) { maskCv.width = cw; maskCv.height = ch; }
  geom = { sx, sy, sw, sh, cw, ch };
  glWindow.setSize(cw, ch);
  slicesDirty = true; renderWindow.render(); markDirty();   // re-render slices at the new quadrant size
}

function composite(now) {
  requestAnimationFrame(composite);
  if (!connected() && !SLICERLIVE) {   // SlicerLive has no WS/server -> stay rendering the loaded scene
    if (out.style.display !== 'none') { outCtx.clearRect(0, 0, out.width, out.height); out.style.display = 'none'; host.style.display = 'none'; }
    return;
  }
  if (!geom || out.style.display === 'none') return;
  const gl = glWindow.getCanvas && glWindow.getCanvas();
  if (!gl) return;
  if (STANDALONE) {                                            // no video: host (opacity 1) shows the render; just draw decorations
    if (slicesDirty) { renderSlices(); slicesDirty = false; scene3DDirty = true; _segOutlineDirty = true; }   // slice cameras moved -> redraw all viewports
    if (scene3DDirty || interacting || pendingRenders > 0) {
      if (scene3DDirty || pendingRenders > 0) renderer.resetCameraClippingRange();   // async-loaded volume/models changed bounds -> keep in clip range
      renderer.updateLightsGeometryToFollowCamera();   // the render path doesn't follow the camera; without this the headlight lags -> dark VR until interaction
      if (_segOutlineDirty && _seg2DOn && _segOutline && mirror.get('idcSeg')) computeSegOutlines();   // seg-only readback -> screen-space outline (before the normal render restores the view)
      _segOutlineDirty = false;
      renderWindow.render(); pushCameraIfChanged(); scene3DDirty = false;   // renders ALL viewports: 3D (top-right) + 3 MPR slices
      if (pendingRenders > 0) pendingRenders--;
    }
    _outGL.style.display = (_seg2DOn && _segOutline && _outlineReady && mirror.get('idcSeg')) ? 'block' : 'none';   // GPU outline layer
    outCtx.clearRect(0, 0, geom.cw, geom.ch);
    drawDecorations2D();   // 2D decorations over the viewports (no slice blit)
    return;
  }
  const v = document.getElementById('v');
  if (!v) return;
  const { sx, sy, sw, sh, cw, ch } = geom;

  // Render the local 3D only when it changed, then hand it to the GPU desktop compositor (index.html), which
  // composites video + 3D in a chroma-key shader. No JS pixel loop / canvas blit here anymore.
  if (scene3DDirty || interacting || pendingRenders > 0) {
    if (scene3DDirty || pendingRenders > 0) renderer.resetCameraClippingRange();   // bounds may have changed (async-loaded volume/models) ->
    renderer.updateLightsGeometryToFollowCamera();   // render path doesn't follow the camera; without this the headlight lags -> dark VR
    renderWindow.render(); pushCameraIfChanged(); scene3DDirty = false;   // keep content in the camera's clip range so it
    if (pendingRenders > 0) pendingRenders--;
    if (window.desktopCompositor) window.desktopCompositor.invalidate();  // shows WITHOUT needing a first interaction (race fix)
  }

  // routing mask (bare-3D vs popup over the 3D rect) -- NOW only used for event routing, at ~10 Hz, so the
  // 60 Hz per-pixel cost is gone. (The visual keyhole is done on the GPU in the compositor shader.)
  if ((now - lastMaskAt) >= MASK_MS) {
    lastMaskAt = now;
    if (!maskHit || maskHit.length !== cw * ch) maskHit = new Uint8Array(cw * ch);
    try {
      maskCtx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch);
      const im = maskCtx.getImageData(0, 0, cw, ch), d = im.data; let keyCount = 0;
      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        const isKey = Math.abs(d[i] - KEY[0]) < KEY_TOL && Math.abs(d[i + 1] - KEY[1]) < KEY_TOL && Math.abs(d[i + 2] - KEY[2]) < KEY_TOL;
        maskHit[px] = isKey ? 1 : 0; if (isKey) keyCount++;
      }
      maskActive = keyCount > 0.02 * cw * ch;
    } catch (e) {}
  }

  // decorations (axis labels + ruler) -- out is now a transparent text-only overlay above the composited 3D
  outCtx.clearRect(0, 0, cw, ch);
  drawDecorations2D();
}

// --- 2D overlays drawn on the compositor canvas (no vtk.js 3D-text actor exists) -----------------------
let viewBounds = null, axisLabelsOn = false;
function drawDecorations2D() {
  if (_fourUp) return;   // SlicerLive 4-up: the 3D is a quadrant -> full-window worldToScreen labels would misplace
  outCtx.save();
  outCtx.shadowColor = 'black'; outCtx.shadowBlur = 3; outCtx.fillStyle = 'white'; outCtx.strokeStyle = 'white';
  if (axisLabelsOn && viewBounds) {
    const b = viewBounds, mx = (b[0] + b[1]) / 2, my = (b[2] + b[3]) / 2, mz = (b[4] + b[5]) / 2;
    const labels = [['R', [b[1], my, mz]], ['L', [b[0], my, mz]], ['A', [mx, b[3], mz]],   // RAS: +X=R,+Y=A,+Z=S
      ['P', [mx, b[2], mz]], ['S', [mx, my, b[5]]], ['I', [mx, my, b[4]]]];
    outCtx.font = 'bold 14px sans-serif'; outCtx.textAlign = 'center'; outCtx.textBaseline = 'middle';
    for (const [t, w] of labels) { const s = worldToScreen(w); outCtx.fillText(t, s.x, s.y); }
  }
  drawRuler();
  outCtx.restore();
  drawMarkupLabels3D();
}

// Markup text in the 3D view (vtk.js has no 3D text actor -> draw on the 2D decoration canvas via worldToScreen,
// like the axis labels). pointLabelsVisibility -> per-control-point name; propertiesLabelVisibility -> one
// name+measurements label. Color = MRML SelectedColor, size from textScale -- both read from the display node.
function drawMarkupLabels3D() {
  for (const node of mirror.values()) {
    if (!node.class.includes('Markups') || node.class.includes('Display') || node.class.includes('ROINode')) continue;
    const disp = displayNodeOf(node); if (!disp || !visibleOf(disp)) continue;
    const a = node.attrs, da = disp.attrs, cps = a.controlPoints || [];
    if (!cps.length || (!da.pointLabelsVisibility && !da.propertiesLabelVisibility)) continue;
    const color = da.selectedColor || da.color || [1, 0.5, 0.5];
    const px = Math.max(9, Math.round((da.textScale || 3) * 4));
    outCtx.save();
    outCtx.font = `${px}px sans-serif`; outCtx.fillStyle = rgbaStr(color, 1);
    outCtx.strokeStyle = 'black'; outCtx.lineWidth = 3; outCtx.lineJoin = 'round';
    outCtx.textBaseline = 'middle'; outCtx.textAlign = 'left';
    const label = (t, sx, sy) => { if (t) { outCtx.strokeText(t, sx, sy); outCtx.fillText(t, sx, sy); } };
    if (da.pointLabelsVisibility && a.pointLabels) {
      for (let i = 0; i < cps.length; i++) { const s = worldToScreen(cps[i]); label(a.pointLabels[i] || '', s.x + 7, s.y); }
    }
    if (da.propertiesLabelVisibility) {
      const s = worldToScreen(cps[0]);
      let txt = node.name;
      for (const mm of (a.measurements || [])) if (mm.value) txt += '  ' + mm.value;
      label(txt, s.x + 7, s.y - 12);
    }
    outCtx.restore();
  }
}
function drawRuler() {
  const cam = renderer.getActiveCamera(), F = cam.getFocalPoint();
  const right = norm3(cross3(cam.getDirectionOfProjection(), cam.getViewUp()));
  const s0 = worldToScreen(F), s1 = worldToScreen([F[0] + right[0], F[1] + right[1], F[2] + right[2]]);
  const pxPerMM = Math.hypot(s1.x - s0.x, s1.y - s0.y);
  if (!pxPerMM || !isFinite(pxPerMM)) return;
  const exp = Math.floor(Math.log10(80 / pxPerMM)), f = (80 / pxPerMM) / 10 ** exp;
  const mm = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * 10 ** exp, len = mm * pxPerMM;
  const cw = geom.cw, ch = geom.ch, x0 = cw / 2 - len / 2, y = ch - 16;
  outCtx.lineWidth = 2;
  outCtx.beginPath();
  outCtx.moveTo(x0, y); outCtx.lineTo(x0 + len, y);
  outCtx.moveTo(x0, y - 4); outCtx.lineTo(x0, y + 4); outCtx.moveTo(x0 + len, y - 4); outCtx.lineTo(x0 + len, y + 4);
  outCtx.stroke();
  outCtx.font = '12px sans-serif'; outCtx.textAlign = 'center'; outCtx.textBaseline = 'bottom';
  outCtx.fillText(`${mm >= 1 ? mm : mm.toFixed(1)} mm`, cw / 2, y - 6);
}

function routePointer(e) {
  if (e.buttons) return;
  if (STANDALONE) { host.style.pointerEvents = 'auto'; return; }   // no video region; host owns all input
  if (!geom || out.style.display === 'none' || !connected()) { host.style.pointerEvents = 'auto'; return; }
  const r = out.getBoundingClientRect();
  let local = true;
  if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom && maskActive && maskHit) {
    const x = Math.floor((e.clientX - r.left) * (geom.cw / r.width));
    const y = Math.floor((e.clientY - r.top) * (geom.ch / r.height));
    if (x >= 0 && y >= 0 && x < geom.cw && y < geom.ch) local = maskHit[y * geom.cw + x] === 1;
  }
  host.style.pointerEvents = local ? 'auto' : 'none';
}
window.addEventListener('pointermove', routePointer, true);

function postCamera() {
  if (SLICERLIVE) return;   // no server in SlicerLive/IDC/SEGRoulette mode -- don't spray failed /offload/camera POSTs (waste connections)
  const c = renderer.getActiveCamera();
  const cam = {
    position: c.getPosition(), focalPoint: c.getFocalPoint(), viewUp: c.getViewUp(),
    viewAngle: c.getViewAngle(), parallelScale: c.getParallelScale(), parallelProjection: c.getParallelProjection(),
  };
  if (wsOpen) { try { ws.send(JSON.stringify({ t: 'camera', view: VIEW, cam })); return; } catch (e) {} }
  fetch(`${SCENE}/camera?view=${VIEW}`, { method: 'POST', body: JSON.stringify(cam) }).catch(() => {});
}
let lastCamSig = '';
function pushCameraIfChanged() {
  const c = renderer.getActiveCamera();
  const sig = `${c.getPosition()}|${c.getFocalPoint()}|${c.getViewUp()}|${c.getParallelScale()}|${c.getViewAngle()}`;
  if (sig !== lastCamSig) { lastCamSig = sig; postCamera(); }
}

// On WS disconnect (e.g. the server restarting) drop ALL stale rendering so no leftover slice lines /
// markups / 3D actors linger frozen on screen until the fresh reconnect repulls the scene.
function clearClientRendering() {
  sliceViewports = {};
  if (window.desktopCompositor) { window.desktopCompositor.setSliceLayers([]); window.desktopCompositor.redraw(); }
  if (typeof vctx !== 'undefined' && vec2d) { vec2d.width = vec2d.width; }   // clear the 2D vector overlay (markup lines/brush)
  for (const dm of DMS) if (dm.items) for (const id of [...dm.items.keys()]) dm.remove(id);
  if (viewBoxActor) viewBoxActor.setVisibility(false);
  mirror.clear();
  cameraInit = false;               // re-apply the server camera once the fresh scene arrives
  scene3DDirty = true;
}

function connectWS() {
  const wsproto = location.protocol === 'https:' ? 'wss:' : 'ws:';   // same-origin (proxy /offload-ws -> :2028)
  const wsurl = window.__OFFLOAD_WS || `${wsproto}//${location.host}/offload-ws`;   // harness overrides (direct :2028/:2031)
  try { ws = new WebSocket(wsurl); } catch (e) { return; }
  ws.onopen = () => {
    wsOpen = true; lastPong = Date.now(); appliedVersion = null;   // force a fresh pull (server may have restarted)
    console.log('[offload] ws connected (MRML sync)');
    try { ws.send(JSON.stringify({ t: 'keyhole', view: VIEW, on: true })); } catch (e) {}
    clearInterval(hbTimer);
    hbTimer = setInterval(() => { try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {} }, 1000);
  };
  ws.onclose = () => { wsOpen = false; clearInterval(hbTimer); clearClientRendering(); setTimeout(connectWS, 1000); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    lastPong = Date.now();
    if (m.t === 'ack') { onAck(); return; }             // gate the next write -> rate adapts to RTT
    if (m.t === 'state' || m.t === 'pong') {            // both carry version+viewport (pong = 1s reconcile)
      if (m.viewport) { threeDActive = true; lastRect = m.viewport; positionOverlay(); }
      else if (m.viewport === null) {   // 3D view left the layout (slice maximized) -> hide the 3D overlay + decorations
        threeDActive = false; host.style.display = 'none'; out.style.display = 'none';
        if (window.desktopCompositor) window.desktopCompositor.redraw();
      }
      // ATOMIC slice geometry: patch the mirror slice NODES (dims/xyToRAS) AND their screen rects TOGETHER,
      // then rebuild -- so the reslice never pairs a new rect with stale node dims (wrong-aspect-on-resize).
      if (m.sliceNodes) { for (const id in m.sliceNodes) mirror.set(id, m.sliceNodes[id]); }
      if (m.sliceViewports) sliceViewports = m.sliceViewports;
      if (m.sliceNodes || m.sliceViewports) { syncSlices(); drawVectorOverlay(); }
      if (m.segEdit !== undefined) { segEdit = m.segEdit; drawVectorOverlay(); }
      if (m.version !== undefined) { pendingVersion = m.version; syncToLatest(); }
    }
  };
}

// ===================== SlicerLive: load a MRML scene from a URL (no server) =====================
let __slHash = 0;
function _regBlob(arr) { const h = 'sl' + (__slHash++); localBlobs.set(h, arr); return h; }
function _floats(s) { return (s || '').trim().split(/\s+/).filter((x) => x !== '').map(Number); }
async function readPolyData(url) {   // dispatch by extension: legacy .vtk (ASCII text) vs .vtp (XML); default XML
  const ext = (url.split('?')[0].toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if (ext === 'vtk') { const txt = await fetch(url).then((r) => r.text()); const r = vtkPolyDataReader.newInstance(); r.parseAsText(txt); return r.getOutputData(0); }
  const buf = await fetch(url).then((r) => r.arrayBuffer()); const r = vtkXMLPolyDataReader.newInstance(); r.parseAsArrayBuffer(buf); return r.getOutputData(0);
}

// Full-scene load: a node-state JSON (mrml_sync.mrml_state output) + content-addressed gzip blob FILES.
// --- load progress: a centered liquid-glass panel with a byte-accurate bar (created lazily) ---
let _progEl = null, _progBar = null, _progTxt = null;
function setLoadProgress(frac, label) {   // frac<0 hides; frac 0..1 sets the bar; label = caption
  if (frac < 0) { if (_progEl) _progEl.style.display = 'none'; mosaicHide(); if (_progSegs) _progSegs.innerHTML = ''; return; }
  if (!_progEl) {
    _progEl = document.createElement('div');
    _progEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;min-width:300px;'
      + 'padding:18px 22px;border-radius:16px;background:rgba(18,20,32,0.55);border:1px solid rgba(255,255,255,0.12);'
      + 'backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);'
      + 'box-shadow:0 10px 50px rgba(0,0,0,0.45);font:13px/1.5 -apple-system,system-ui,sans-serif;color:#eef0f8;text-align:center;';
    _progTxt = document.createElement('div');
    const track = document.createElement('div');
    track.style.cssText = 'height:6px;border-radius:3px;background:rgba(255,255,255,0.13);margin:11px 0 2px;overflow:hidden;';
    _progBar = document.createElement('div');
    _progBar.style.cssText = 'height:100%;width:0%;border-radius:3px;background:linear-gradient(90deg,#5b8cff,#7be0ff);transition:width .15s ease;';
    track.appendChild(_progBar); _progEl.appendChild(_progTxt); _progEl.appendChild(track);
    document.body.appendChild(_progEl);
  }
  _progEl.style.display = 'block';
  _progBar.style.width = Math.round(Math.min(1, Math.max(0, frac)) * 100) + '%';
  if (label) _progTxt.textContent = label;
}
let _progSegs = null;
function addSegName(name) {   // show segment names as the SEG is processed (a rolling window of recent ones)
  if (!_progEl) return;
  if (!_progSegs) {
    _progSegs = document.createElement('div');
    _progSegs.style.cssText = 'margin-top:11px; max-width:380px; max-height:84px; overflow:hidden; display:flex; flex-wrap:wrap; gap:4px; justify-content:center;';
    _progEl.appendChild(_progSegs);
  }
  const chip = document.createElement('span');
  chip.textContent = name;
  chip.style.cssText = 'font-size:11px; background:rgba(123,224,255,0.13); border:1px solid rgba(123,224,255,0.22); border-radius:9px; padding:1px 8px; color:#cfe8ff; white-space:nowrap;';
  _progSegs.appendChild(chip);
  while (_progSegs.childElementCount > 18) _progSegs.removeChild(_progSegs.firstChild);
}

// Prefetch + gunzip EVERY blob in the scene in parallel (the DMs would otherwise fetch them serially, one segment
// at a time). Populates blobCache so syncDMs builds geometry with zero network waits. Progress is byte-accurate
// when the serializer ships meta.size, else falls back to a file count.
async function prefetchBlobs() {
  const metas = [], seen = new Set(), zarrNodes = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.hash === 'string') { if (!seen.has(o.hash)) { seen.add(o.hash); metas.push(o); } return; }
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    for (const k in o) walk(o[k]);
  };
  for (const n of mirror.values()) { walk(n.attrs); walk(n.blobs); if (n.attrs && n.attrs.zarr) zarrNodes.push(n); }
  const total = metas.length;
  if (!total && !zarrNodes.length) return;
  const bytesTotal = metas.reduce((s, m) => s + (m.size || 0), 0)
                   + zarrNodes.reduce((s, n) => s + (n.attrs.zarr.bytes || 0), 0);
  const mb = (x) => (x / 1e6).toFixed(0);
  let done = 0, bytesDone = 0;
  const upd = () => setLoadProgress(bytesTotal ? bytesDone / bytesTotal : done / total,
    bytesTotal ? `Loading anatomy…  ${mb(bytesDone)} / ${mb(bytesTotal)} MB` : `Loading…  ${done} / ${total} files`);
  window.__slicerliveProgress = { total, bytesTotal };
  upd();
  let idx = 0;
  const CONC = 12;   // browser caps concurrent connections per host; the rest queue. Still far better than serial.
  const worker = async () => {
    while (idx < metas.length) {
      const m = metas[idx++];
      try { await fetchArray(m); } catch (e) {}
      done++; bytesDone += (m.size || 0); upd();
    }
  };
  const onBytes = (n) => { bytesDone += n; upd(); };          // zarr chunks feed the same byte-progress bar
  await Promise.all([
    ...Array.from({ length: Math.min(CONC, Math.max(1, total)) }, worker),
    ...zarrNodes.map((n) => fetchZarrVolume(n, onBytes).catch(() => {})),
  ]);
  window.__slicerlivePrefetched = total;
}

// This is the "publish" format -- it reuses ALL the DMs + blob/geometry handling (volumes, VR, segs, markups),
// unlike the plain-MRML path which only does models. base/blobs/<hash> are the gz typed-array files.
async function loadSceneJson(sceneUrl, base) {
  let raw;
  try { raw = await fetch(sceneUrl).then((r) => r.json()); }
  catch (e) { console.error('[SlicerLive] cannot fetch scene json', e); window.__slicerliveError = String(e); return; }
  const state = (raw && raw.nodes) ? raw.nodes : raw;   // wrapper {blobBase,nodes} (bucket-hosted) or flat node-states
  let bb = new URLSearchParams(location.search).get('blobs') || (raw && raw.blobBase) || (base + 'blobs/');
  window.__SLICERLIVE_BLOB_BASE = bb.endsWith('/') ? bb : bb + '/';
  mirror.clear(); localBlobs.clear();
  for (const [id, node] of Object.entries(state)) mirror.set(id, node);
  console.log('[SlicerLive] loaded', mirror.size, 'nodes (json) from', sceneUrl);
  window.__slicerliveLoaded = mirror.size;
  threeDActive = true;
  applyCameraOnce();
  await prefetchBlobs();                 // fetch+gunzip ALL blobs in parallel (was: serial per-segment) + progress bar
  setLoadProgress(1, 'Building scene…');  // download done; DMs now build geometry from the cached blobs (no network)
  await syncDMs();
  setLoadProgress(-1);                    // hide the progress panel
  renderer.resetCameraClippingRange();   // content now loaded -> keep it in the (exported) camera's clip range
  renderer.updateLightsGeometryToFollowCamera();   // headlight -> exported camera (render path doesn't do it) so the VR is lit on the FIRST frame
  renderWindow.render(); markDirty();
  // A few deferred renders to cover the GPU texture-upload window (the volume's texture lands a bit after load).
  // dark-until-nudge is fixed by createLight at setup + following the camera here and in composite().
  for (const d of [120, 400, 1000, 2200]) setTimeout(() => { try { renderer.resetCameraClippingRange(); renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); } catch (e) {} }, d);
}

// ===================== SlicerLive: client-side IDC loader (DICOM straight from AWS, no server) =====================
// idc-open-data S3 has open CORS; list a series' instances + parse with dcmjs in a worker, generate a scene, render.
// IDC spreads series across several open buckets (idc-open-data, idc-open-data-cr, idc-open-data-two, ...) -- a
// series listed under the wrong bucket returns 0 keys, so each case carries its real bucket (segroulette.json cb/sb).
const idcS3 = (bucket) => 'https://' + (bucket || 'idc-open-data') + '.s3.us-east-1.amazonaws.com/';
// fetch with retries + jittered backoff (the IDC S3 endpoint occasionally returns transient network errors)
async function fetchRetry(url, opts, tries = 6) {
  let err;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000);   // abort a stalled connection so it frees the per-host pool (QtWebEngine caps ~6/host) instead of hanging forever
    try { const r = await fetch(url, { ...(opts || {}), signal: ac.signal }); if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status); return r; }
    catch (e) { err = e; if (i < tries - 1) await new Promise((res) => setTimeout(res, Math.min(4000, 250 * 2 ** i) * (0.6 + 0.8 * Math.random()))); }
    finally { clearTimeout(to); }
  }
  throw err;
}
async function s3ListKeys(prefix, bucket) {
  if (!prefix.endsWith('/')) prefix += '/';
  const base = idcS3(bucket);
  let keys = [], token = null, more = true;
  while (more) {
    let url = `${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    if (token) url += `&continuation-token=${encodeURIComponent(token)}`;
    const x = new DOMParser().parseFromString(await fetchRetry(url).then((r) => r.text()), 'application/xml');
    keys.push(...[...x.getElementsByTagName('Key')].map((e) => e.textContent).filter((k) => k && /\.dcm$/i.test(k)));   // skip S3 folder-marker keys ("<prefix>/") -> they aren't DICOM and crash the parse
    more = x.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
    token = more ? x.getElementsByTagName('NextContinuationToken')[0]?.textContent : null;
  }
  return keys;
}
// progress-bar background: a screen-filling mosaic of CT slice thumbnails as they stream in (by InstanceNumber)
let _mosaic = null;
function mosaicInit(count) {
  if (!_mosaic) {
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed; inset:0; z-index:55; width:100vw; height:100vh;';
    document.body.appendChild(c);
    _mosaic = { canvas: c, ctx: c.getContext('2d'), tmp: document.createElement('canvas') };
  }
  _mosaic.canvas.style.display = 'block';
  const W = window.innerWidth, H = window.innerHeight;
  _mosaic.canvas.width = W; _mosaic.canvas.height = H;
  _mosaic.cols = Math.max(1, Math.round(Math.sqrt(count * W / H)));   // grid sized from the slice count -> fills the screen
  _mosaic.rows = Math.ceil(count / _mosaic.cols);
  _mosaic.cw = W / _mosaic.cols; _mosaic.ch = H / _mosaic.rows; _mosaic.count = count;
  _mosaic.ctx.fillStyle = '#06060c'; _mosaic.ctx.fillRect(0, 0, W, H);
}
function mosaicDraw(n, w, h, buf) {
  if (!_mosaic) return;
  const cell = Math.max(0, Math.min(_mosaic.count - 1, (n | 0) - 1)), col = cell % _mosaic.cols, row = (cell / _mosaic.cols) | 0;
  const t = _mosaic.tmp; if (t.width !== w || t.height !== h) { t.width = w; t.height = h; }
  t.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  _mosaic.ctx.drawImage(t, col * _mosaic.cw, row * _mosaic.ch, _mosaic.cw, _mosaic.ch);
}
function mosaicHide() { if (_mosaic) _mosaic.canvas.style.display = 'none'; }

// Drive progressive rendering: onCT fires as soon as the CT volume is ready; onLabelmap when the SEG is parsed.
let _idcWorker = null;   // current worker; killed before a new spin so a still-downloading worker can't leak idc-open-data connections
function runIDCWorker(ctKeys, segKeys, handlers, ctBucket, segBucket, modality) {
  if (_idcWorker) { try { _idcWorker.terminate(); } catch (e) {} _idcWorker = null; }   // kill any prior (re-spin) worker first
  return new Promise((resolve, reject) => {
    const w = new Worker('idc-worker.js?t=' + Date.now());
    _idcWorker = w;
    let chain = Promise.resolve();   // serialize handler work so renders don't interleave
    w.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'ctinfo') { mosaicInit(m.count); return; }
      if (m.t === 'thumb') { mosaicDraw(m.n, m.w, m.h, m.rgba); return; }
      if (m.t === 'seg') { addSegName(m.name); return; }
      if (m.t === 'progress') { setLoadProgress(m.frac, m.msg); return; }
      if (m.t === 'ct') { const Ctor = m.dtype === 'float32' ? Float32Array : Int16Array;   // PET volume is Float32 (Int16 overflows)
        const ct = { vol: new Ctor(m.vol), dims: m.dims, ijkToRAS: m.ijkToRAS, win: m.win, lev: m.lev };
        chain = chain.then(() => handlers.onCT(ct)).catch((err) => console.error('[IDC] onCT', err)); return; }
      if (m.t === 'labelmap') { const seg = { lab: new Uint8Array(m.lab), colors: m.colors, names: m.names };
        chain = chain.then(() => handlers.onLabelmap(seg)).catch((err) => console.error('[IDC] onLabelmap', err)); return; }
      if (m.t === 'error') { w.terminate(); reject(new Error(m.error)); return; }
      if (m.t === 'alldone') { w.terminate(); chain.then(resolve); return; }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error('worker: ' + (e.message || e))); };
    w.postMessage({ ctKeys, segKeys, ctBucket, segBucket, modality });
  });
}
// CT-only SlicerLive scene (mirror nodes): orthogonal slice views, no volume rendering (segments render as
// surfaces instead). An empty segmentation node is created up front; surfaces are added progressively.
// Volume-rendering preset by source modality. CT = Slicer's CT-Chest-Contrast-Enhanced (HU); MR = grayscale ramp on
// the DICOM window/level; PT/PET = hot-metal on the window/level. (SEGRoulette spins CT/MR/PET sources.)
function vrPresetFor(modality, win, lev) {
  if (modality === 'CT' || !win) return {
    ambient: 0.1, diffuse: 0.9, specular: 0.2, specularPower: 10,
    color: [[-3024, 0, 0, 0], [67.0106, 0.54902, 0.25098, 0.14902], [251.105, 0.882353, 0.603922, 0.290196], [439.291, 1, 0.937033, 0.954531], [3071, 0.827451, 0.658824, 1]],
    scalarOpacity: [[-3024, 0], [67.0106, 0], [251.105, 0.446429], [439.291, 0.625], [3071, 0.616071]], gradientOpacity: [[0, 1], [255, 1]] };
  const lo = lev - win / 2, hi = lev + win / 2, q = (f) => lo + (hi - lo) * f;
  if (modality === 'PT') return {   // PET = MIP (set on the VR node): hot-metal over the intensity range, opaque so the projected max shows
    ambient: 0.2, diffuse: 0.8, specular: 0.1, specularPower: 10,
    color: [[lo, 0, 0, 0], [q(0.4), 0.7, 0, 0], [q(0.75), 1, 0.6, 0], [hi, 1, 1, 1]],
    scalarOpacity: [[lo, 0], [q(0.2), 0.5], [hi, 1]], gradientOpacity: [[0, 1], [255, 1]] };
  return {   // MR (default): grayscale ramp on window/level
    ambient: 0.2, diffuse: 0.8, specular: 0.2, specularPower: 10,
    color: [[lo, 0, 0, 0], [hi, 1, 1, 1]],
    scalarOpacity: [[lo, 0], [q(0.35), 0.05], [hi, 0.55]], gradientOpacity: [[0, 1], [255, 1]] };
}
function buildIDCNodes(ct, hasSeg, modality) {
  const M = ct.ijkToRAS, [nx, ny, nz] = ct.dims;
  const apply = (p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const i of [0, nx]) for (const j of [0, ny]) for (const k of [0, nz]) { const w = apply([i, j, k]); for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); } }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], center = apply([nx / 2, ny / 2, nz / 2]);
  const axExt = (v) => Math.abs(v[0]) * ext[0] + Math.abs(v[1]) * ext[1] + Math.abs(v[2]) * ext[2];
  const nodes = {};
  const add = (id, cls, attrs, refs, extra) => { nodes[id] = Object.assign({ id, class: cls, name: id, attrs, refs: refs || {}, blobs: {} }, extra || {}); return id; };
  add('vtkMRMLViewNode1', 'vtkMRMLViewNode', { backgroundColor: [0.756, 0.764, 0.909], backgroundColor2: [0.454, 0.470, 0.745], boxVisible: 1, axisLabelsVisible: 1, orientationMarkerType: 0 });
  const volDisp = add('idcVolDisp', 'vtkMRMLScalarVolumeDisplayNode', { visibility: 1, window: ct.win, level: ct.lev, color: [1, 1, 1], opacity: 1 });
  const prop = add('idcVolProp', 'vtkMRMLVolumePropertyNode', Object.assign({ shade: 1, interpolationType: 1 }, vrPresetFor(modality, ct.win, ct.lev)));
  const vrDisp = add('idcVRDisp', 'vtkMRMLGPURayCastVolumeRenderingDisplayNode', { visibility: 1, visibility3D: _vrOn ? 1 : 0, kind: 'volumeRendering', croppingEnabled: 0, blendMode: modality === 'PT' ? 'mip' : 'composite' }, { volumeProperty: [prop] });
  const vol = add('idcVol', 'vtkMRMLScalarVolumeNode', { dims: [nx, ny, nz], comps: 1, ijkToRAS: M }, { display: [volDisp, vrDisp] });
  nodes[vol].__scalars = ct.vol; nodes[vol].__volKey = 'idc-ct';
  const ORI = { Red: { right: [-1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], ori: 'Axial' },
                Yellow: { right: [0, -1, 0], up: [0, 0, 1], normal: [-1, 0, 0], ori: 'Sagittal' },   // match Slicer's sagittal
                Green: { right: [-1, 0, 0], up: [0, 0, 1], normal: [0, 1, 0], ori: 'Coronal' } };
  for (const name in ORI) {
    const o = ORI[name], r = o.right, u = o.up, n = o.normal, c = center;
    add('idcSlice' + name, 'vtkMRMLSliceNode', { layoutName: name, orientation: o.ori, dimensions: [300, 300, 1],
      sliceToRAS: [r[0], u[0], n[0], c[0], r[1], u[1], n[1], c[1], r[2], u[2], n[2], c[2], 0, 0, 0, 1], fieldOfView: [axExt(r), axExt(u), 2.5] });
    add('idcComp' + name, 'vtkMRMLSliceCompositeNode', { layoutName: name, backgroundVolumeID: vol, foregroundOpacity: 0, labelOpacity: 1 }, { backgroundVolume: [vol] });
  }
  if (hasSeg) {
    const segDisp = add('idcSegDisp', 'vtkMRMLSegmentationDisplayNode', { visibility: (_seg3DOn || _seg2DOn) ? 1 : 0, visibility3D: _seg3DOn ? 1 : 0 });
    add('idcSeg', 'vtkMRMLSegmentationNode', { labelmapDims: [nx, ny, nz], labelmapIjkToRAS: M, segmentColors: [], seg2DOpacity: 0.5, segments: [] }, { display: [segDisp] });
  }
  return nodes;
}

// Default 3D view: look from the anterior (+Y) with superior (+Z) up, centered + fit on the CT, and make the
// trackball center of rotation the centroid of the CT bounding box (the camera focal point).
function setIDCCamera(ct) {
  const M = ct.ijkToRAS, [nx, ny, nz] = ct.dims;
  const apply = (p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const i of [0, nx]) for (const j of [0, ny]) for (const k of [0, nz]) { const w = apply([i, j, k]); for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); } }
  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const maxExt = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // Frame the CT bbox directly: at this point the 3D renderer has no actors yet (slices reslice offscreen, no VR,
  // surfaces not built), so resetCamera has nothing to fit. Place the camera manually so the centroid projects to
  // the viewport center (centered + rotation center = CT centroid) and the bbox fits.
  const D = maxExt * 2.5;
  const cam = renderer.getActiveCamera();
  cam.setViewUp(0, 0, 1);                                            // superior up
  cam.setFocalPoint(center[0], center[1], center[2]);               // rotation center = CT bbox centroid
  cam.setPosition(center[0], center[1] + D, center[2]);             // anterior (+Y), looking posterior
  cam.setClippingRange(Math.max(1, D - maxExt), D + maxExt * 1.5);
  renderer.updateLightsGeometryToFollowCamera();
}

// Move the trackball pivot to `c` (RAS) WITHOUT disturbing the user's current view: shift focal point + camera
// position by the same delta, so view direction / distance / any rotation are preserved -- only the rotation
// center moves. Used to recenter on the segmentation centroid once it's known (it loads after the CT).
function recenterRotation(c) {
  const cam = renderer.getActiveCamera(), f = cam.getFocalPoint(), p = cam.getPosition();
  const d = [c[0] - f[0], c[1] - f[1], c[2] - f[2]];
  cam.setFocalPoint(c[0], c[1], c[2]);
  cam.setPosition(p[0] + d[0], p[1] + d[1], p[2] + d[2]);
  renderer.resetCameraClippingRange(); scene3DDirty = true; markDirty();
}

// Geometric centroid of the CT bounding box (RAS) -- the rotation-center fallback when the segmentation is empty.
function ctBBoxCenter(ct) {
  const M = ct.ijkToRAS, [nx, ny, nz] = ct.dims;
  const apply = (p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const i of [0, nx]) for (const j of [0, ny]) for (const k of [0, nz]) { const w = apply([i, j, k]); for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); } }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

// Set the trackball pivot ONCE, after the full study (source image + seg) has loaded: the segmentation centroid if
// it has any labeled voxels (_idcRotCenter, computed in buildSegSurfaces), else the volume centroid. After this it
// stays put -- only a middle-mouse pan in the 3D view moves it (vtk.js pan shifts the focal point). Idempotent per
// case via _rotCenterSet so the deferred render passes can't keep yanking the view (the old "rotates oddly" bug).
function finalizeRotationCenter() {
  if (_rotCenterSet) return;
  let c = _idcRotCenter;                                  // segmentation centroid (set iff the SEG had labeled voxels)
  const ct = window.__idcData && window.__idcData.ct;
  if (!c && ct) c = ctBBoxCenter(ct);                     // empty / no segmentation -> volume centroid
  if (!c) return;
  _idcRotCenter = c; _rotCenterSet = true;
  recenterRotation(c); jumpOthersTo(c, '');               // pivot on it + park the 3 slices there (2D overlay visible)
  renderer.resetCameraClippingRange(); renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); markDirty();
}

// --- Volume-rendering on/off toggle (a glass button over the 3D quadrant; NO emoji -> see the QtWebEngine crash) ---
let _vrOn = true, _seg3DOn = true, _seg2DOn = true, _segFill = true, _segOutline = true, _ctrlBtn = null, _ctrlMenu = null;
let _segVis = {};           // per-segment visibility: label -> bool (default visible); gated by the per-view masters
let _rotCenterSet = false;  // the trackball pivot has been finalized for the current case (set once after full load)
let _idcRotCenter = null;   // RAS trackball pivot for the current case (segmentation centroid once known, else null)
function segVisible(L) { return _segVis[L] !== false; }   // default true
function applyVR() {
  const disp = mirror.get('idcVRDisp'); if (disp) disp.attrs.visibility3D = _vrOn ? 1 : 0;
  let it = null; for (const dm of DMS) if (dm.items && dm.items.has('idcVol')) { it = dm.items.get('idcVol'); break; }
  if (it && it.volume) it.volume.setVisibility(_vrOn);
  updateCtrlSwitches();
  scene3DDirty = true; try { renderWindow.render(); } catch (e) {} markDirty();
}
// Segmentation visibility: independent 3D (surfaces) + 2D-in-slices toggles, AND per-segment (_segVis[label]).
// 3D = SegmentationDM surface actors (keyed 'seg'<label>); 2D = per-label opacity in the slice overlay (ovVol).
function applySegVis() {
  const disp = mirror.get('idcSegDisp'); if (disp) { disp.attrs.visibility = (_seg3DOn || _seg2DOn) ? 1 : 0; disp.attrs.visibility3D = _seg3DOn ? 1 : 0; }
  for (const dm of DMS) if (dm.items && dm.items.has('idcSeg')) {
    const it = dm.items.get('idcSeg');
    for (const [sid, s] of it.segs) { const L = parseInt(String(sid).replace(/^seg/, ''), 10); s.actor.setVisibility(_seg3DOn && segVisible(L)); }
  }
  applySeg2DOpacity();
  updateCtrlSwitches();
  _segOutlineDirty = true; slicesDirty = true; scene3DDirty = true; try { renderWindow.render(); } catch (e) {} markDirty();
}
// Rebuild the 2D slice FILL LUT: per-label opacity, gated by the in-slices master + Fill toggle + per-segment
// visibility. The OUTLINE is drawn separately in screen space (drawSegOutlines). _segOutOpaque temporarily forces
// full opacity for the seg-only readback that the outline pass uses.
let _segOutOpaque = false;
function applySeg2DOpacity() {
  const seg = mirror.get('idcSeg'); if (!seg) return;
  const fillOp = _segOutOpaque ? 1.0 : (seg.attrs.seg2DOpacity != null ? seg.attrs.seg2DOpacity : 0.45);
  const ofun = vtkPiecewiseFunction.newInstance();
  ofun.addPoint(0, 0); ofun.addPoint(0.5, 0);
  for (const c of (seg.attrs.segmentColors || [])) ofun.addPoint(c[0], ((_segOutOpaque || (_seg2DOn && _segFill)) && segVisible(c[0])) ? fillOp : 0);
  for (const nm in _sliceRens) { const sr = _sliceRens[nm]; if (sr && sr.ovVol) sr.ovVol.getProperty().setScalarOpacity(0, ofun); }
}

// Display-options menu: a glass popup of toggle switches, opened on hover of the SlicerLive button (top-right of 3D).
function makeSwitch() {
  const track = document.createElement('span');
  track.style.cssText = 'position:relative;flex:none;width:38px;height:22px;border-radius:11px;transition:background .15s;';
  const knob = document.createElement('span');
  knob.style.cssText = 'position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:transform .15s;';
  track.appendChild(knob);
  track._paint = (on) => { track.style.background = on ? 'linear-gradient(180deg,#9fe9ff,#54c6f0)' : 'rgba(255,255,255,0.20)'; knob.style.transform = 'translateX(' + (on ? '16px' : '0px') + ')'; };
  return track;
}
// opts: { swatch:[r,g,b] color chip, indent, small, dim:()=>bool (disabled+faded, e.g. per-segment while master is off) }
function makeToggleRow(label, getOn, setOn, opts) {
  opts = opts || {};
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer;border-radius:9px;' +
    'padding:' + (opts.small ? '6px 8px' : '9px 8px') + ';' + (opts.indent ? 'margin-left:10px;' : '');
  row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.07)'; };
  row.onmouseleave = () => { row.style.background = 'transparent'; };
  const left = document.createElement('span'); left.style.cssText = 'display:flex;align-items:center;gap:9px;min-width:0;';
  if (opts.swatch) { const sw = document.createElement('span'); const c = opts.swatch;
    sw.style.cssText = 'flex:none;width:11px;height:11px;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.25);background:rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
    left.appendChild(sw); }
  const lab = document.createElement('span'); lab.textContent = label;
  lab.style.cssText = 'font:' + (opts.small ? '500 12.5px' : '600 13px') + ' -apple-system,system-ui,sans-serif;color:#eaf0ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  left.appendChild(lab);
  const track = makeSwitch();
  const paint = () => { const dim = opts.dim && opts.dim(); row.style.opacity = dim ? '0.4' : '1'; track._paint(!!getOn()); };
  row.onclick = () => { if (opts.dim && opts.dim()) return; setOn(!getOn()); paint(); };
  row.appendChild(left); row.appendChild(track); paint(); row._paint = paint;
  return row;
}
function updateCtrlSwitches() { if (_ctrlMenu && _ctrlMenu._rows) for (const r of _ctrlMenu._rows) if (r._paint) r._paint(); }
function _ctrlOutside(ev) { if (_ctrlMenu && !_ctrlMenu.contains(ev.target) && _ctrlBtn && !_ctrlBtn.contains(ev.target)) closeCtrlMenu(); }
function closeCtrlMenu() { if (_ctrlMenu) { _ctrlMenu.remove(); _ctrlMenu = null; document.removeEventListener('mousedown', _ctrlOutside, true); } }
function openCtrlMenu() {
  _ctrlMenu = document.createElement('div');
  // same liquid-glass skin as the case-detail popup
  _ctrlMenu.style.cssText = 'position:fixed; top:108px; right:14px; z-index:76; min-width:248px; max-width:340px; border-radius:14px; padding:8px;' +
    ' font:13px/1.4 -apple-system,system-ui,sans-serif; color:#e8eeff;' +
    ' background:linear-gradient(135deg, rgba(58,64,88,0.55), rgba(20,24,38,0.62));' +
    ' backdrop-filter:blur(26px) saturate(1.7); -webkit-backdrop-filter:blur(26px) saturate(1.7);' +
    ' border:1px solid rgba(255,255,255,0.22); box-shadow:0 18px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.22);';
  const rows = []; _ctrlMenu._rows = rows;
  const add = (r) => { rows.push(r); return r; };
  const title = document.createElement('div'); title.textContent = 'Display';
  title.style.cssText = 'font:700 11px -apple-system,system-ui,sans-serif;letter-spacing:1px;text-transform:uppercase;opacity:0.5;padding:6px 8px 8px;';
  _ctrlMenu.appendChild(title);
  _ctrlMenu.appendChild(add(makeToggleRow('Volume rendering', () => _vrOn, (v) => { _vrOn = v; applyVR(); })));
  const segs = window.__caseSegments || [];
  if (mirror.get('idcSeg')) {
    _ctrlMenu.appendChild(add(makeToggleRow('Segmentation (3D)', () => _seg3DOn, (v) => { _seg3DOn = v; applySegVis(); })));
    _ctrlMenu.appendChild(add(makeToggleRow('Segmentation in slices', () => _seg2DOn, (v) => { _seg2DOn = v; applySegVis(); })));
    _ctrlMenu.appendChild(add(makeToggleRow('Fill', () => _segFill, (v) => { _segFill = v; applySegVis(); },
      { indent: true, small: true, dim: () => !_seg2DOn })));
    _ctrlMenu.appendChild(add(makeToggleRow('Outline', () => _segOutline, (v) => { _segOutline = v; applySegVis(); },
      { indent: true, small: true, dim: () => !_seg2DOn })));
    if (segs.length) {                              // per-segment visibility, nested + scrollable past 5 segments
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:2px;border-top:1px solid rgba(255,255,255,0.12);padding-top:4px;' +
        (segs.length > 5 ? 'max-height:184px;overflow-y:auto;' : '');
      for (const s of segs) { const L = s.n;
        wrap.appendChild(add(makeToggleRow(s.name, () => segVisible(L), (v) => { _segVis[L] = v; applySegVis(); },
          { swatch: s.rgb, indent: true, small: true, dim: () => !_seg3DOn && !_seg2DOn }))); }
      _ctrlMenu.appendChild(wrap);
    }
  }
  const about = document.createElement('div');   // About -> the SlicerLive GitHub readme (opens in a new tab)
  about.style.cssText = 'cursor:pointer;border-radius:9px;padding:9px 8px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.12);' +
    'font:600 13px -apple-system,system-ui,sans-serif;color:#9fe9ff;';
  about.textContent = 'About SlicerLive';
  about.onmouseenter = () => { about.style.background = 'rgba(255,255,255,0.07)'; };
  about.onmouseleave = () => { about.style.background = 'transparent'; };
  about.onclick = () => { window.open('https://github.com/pieper/SlicerLive', '_blank', 'noopener'); };
  _ctrlMenu.appendChild(about);
  document.body.appendChild(_ctrlMenu);
  if (_ctrlBtn) { const r = _ctrlBtn.getBoundingClientRect();   // anchor just under the button, right edges aligned
    _ctrlMenu.style.top = Math.round(r.bottom + 8) + 'px'; _ctrlMenu.style.right = Math.round(Math.max(8, window.innerWidth - r.right)) + 'px'; }
  document.addEventListener('mousedown', _ctrlOutside, true);
}
function ensureControlsButton() {
  if (_ctrlBtn) return;
  _ctrlBtn = document.createElement('button');
  _ctrlBtn.title = 'Display options';
  // The full vertical lockup: mark with the lightning, "SlicerLive" wordmark directly UNDER the bolts (the
  // Frankenstein-reanimation reference -> semantically the text must sit below the lightning). Solid near-black
  // panel like the brand markup (NOT glass -- the gold reads washed-out on a translucent skin).
  _ctrlBtn.style.cssText = 'position:fixed; top:12px; right:14px; z-index:77; cursor:pointer; padding:10px 14px 9px;' +
    ' display:inline-flex; flex-direction:column; align-items:center; overflow:visible;' +
    ' border:1px solid rgba(255,255,255,0.12); border-radius:15px; background:#121826;' +
    ' box-shadow:0 10px 30px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);';
  _ctrlBtn.innerHTML = slicerLiveLogo(60);
  const openIfClosed = () => { if (!_ctrlMenu) openCtrlMenu(); };
  _ctrlBtn.onmouseenter = openIfClosed;                 // open on hover...
  _ctrlBtn.onclick = (ev) => { ev.stopPropagation(); openIfClosed(); };   // ...and on click/tap; stays up until a click outside
  document.body.appendChild(_ctrlBtn);
}

// Apply the SEG once the labelmap is decoded: colored 2D overlay on the slice views AND closed-surface models in 3D
// (the SegmentationDM surface path), generated client-side from the labelmap with vtk.js marching cubes.
async function addIDCSegments(ct, seg) {
  const segNode = mirror.get('idcSeg'); if (!segNode) return;
  segNode.attrs.segmentColors = seg.colors;
  window.__caseSegments = (seg.colors || []).map((c) => ({ n: c[0], rgb: [c[1], c[2], c[3]], name: (seg.names || {})[c[0]] || ('Segment ' + c[0]) }));
  segNode.__labelmap = seg.lab; segNode.attrs.labelmapDims = ct.dims; segNode.attrs.labelmapIjkToRAS = ct.ijkToRAS;
  await syncDMs();                                          // 2D colored overlay on the slices (labelmap path) first
  renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); markDirty();
  try { await buildSegSurfaces(ct, seg, segNode); } catch (e) { console.warn('[IDC] surfaces', e); }   // then 3D surfaces
  applySegVis();                                            // honor the Segmentation toggle on both 3D + 2D after (re)load
  finalizeRotationCenter();                                 // study fully loaded -> set the trackball pivot (seg centroid) once
}

// Closed-surface models per segment, generated client-side from the labelmap with vtk.js marching cubes. Each
// segment is meshed in its own cropped sub-volume for speed; surfaces stay in the volume's SCALED-INDEX frame and a
// single shared actor matrix (idcSeg.__surfMat, from volumeGeometry) maps them to RAS -- so rotated/permuted volumes
// just work and normals stay correct (vtk.js applies the matrix to normals). Feeds segNode.attrs.segments[].mesh,
// which the SegmentationDM renders. Yields between segments so a many-segment case doesn't freeze the page.
async function buildSegSurfaces(ct, seg, segNode) {
  const [nx, ny, nz] = ct.dims, lab = seg.lab, M = ct.ijkToRAS;
  const colors = seg.colors || []; if (!colors.length) return;
  const probe = vtkImageData.newInstance(); probe.setDimensions(nx, ny, nz);
  segNode.__surfMat = volumeGeometry(probe, M);            // shared IJK(scaled)->RAS matrix; also gives us spacing
  const sp = probe.getSpacing();
  const bb = new Map();                                    // label -> [i0,j0,k0,i1,j1,k1]
  for (const c of colors) bb.set(c[0], [nx, ny, nz, -1, -1, -1]);
  let ci = 0, cj = 0, ck = 0, cn = 0;                      // centroid of ALL labeled voxels (rotation center)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {                 // one pass: per-label bounding box + centroid
    let base = (k * ny + j) * nx;
    for (let i = 0; i < nx; i++) { const v = lab[base + i]; if (!v) continue; const b = bb.get(v); if (!b) continue;
      if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
      ci += i; cj += j; ck += k; cn++; }
  }
  if (cn) {                                                // trackball pivot = segmentation centroid (RAS); applied once
    const a = ci / cn, b = cj / cn, c = ck / cn;           // by finalizeRotationCenter() after the full study loads
    _idcRotCenter = [M[0] * a + M[1] * b + M[2] * c + M[3], M[4] * a + M[5] * b + M[6] * c + M[7], M[8] * a + M[9] * b + M[10] * c + M[11]];
  }
  const segs = [];
  for (const c of colors) {
    const L = c[0], color = [c[1], c[2], c[3]], b = bb.get(L);
    if (!b || b[3] < b[0]) continue;                       // empty label
    const x0 = Math.max(0, b[0] - 1), y0 = Math.max(0, b[1] - 1), z0 = Math.max(0, b[2] - 1);
    const x1 = Math.min(nx - 1, b[3] + 1), y1 = Math.min(ny - 1, b[4] + 1), z1 = Math.min(nz - 1, b[5] + 1);
    const sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1;
    const mask = new Uint8Array(sx * sy * sz);
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) { const src = ((k + z0) * ny + (j + y0)) * nx + x0, dst = (k * sy + j) * sx;
      for (let i = 0; i < sx; i++) mask[dst + i] = lab[src + i] === L ? 1 : 0; }
    const img = vtkImageData.newInstance();
    img.setDimensions(sx, sy, sz); img.setSpacing(sp[0], sp[1], sp[2]); img.setDirection(1, 0, 0, 0, 1, 0, 0, 0, 1);
    img.setOrigin(x0 * sp[0], y0 * sp[1], z0 * sp[2]);     // sub-volume offset -> points land in full scaled-index frame
    img.getPointData().setScalars(vtkDataArray.newInstance({ numberOfComponents: 1, values: mask }));
    const mc = vtkImageMarchingCubes.newInstance({ contourValue: 0.5, computeNormals: true, mergePoints: true });
    mc.setInputData(img);
    const pd = mc.getOutputData();
    if (pd && pd.getPoints().getNumberOfPoints() > 0)
      segs.push({ id: 'seg' + L, color, mesh: { points: { hash: 'surf' + L + ':' + pd.getPoints().getNumberOfPoints() }, __pd: pd } });
    await new Promise((r) => setTimeout(r, 0));            // yield -> surfaces appear progressively, no freeze
  }
  segNode.attrs.segments = segs;
  await syncDMs();
  renderer.resetCameraClippingRange(); renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); markDirty();
}

// Drop the previous dataset COMPLETELY so nothing from the prior spin lingers: DM actors/volumes (VR + seg
// surfaces), the slice-view volumes (syncFourUp only removes these when a NEW volume replaces them, so an empty
// mirror would leave them), the view box, and the cached per-slice state. Called at the start of every load.
function clearIDCScene() {
  mirror.clear(); localBlobs.clear(); _lmCache.clear();   // drop the previous case's cached labelmap overlay image
  for (const dm of DMS) if (dm.items) for (const id of [...dm.items.keys()]) { try { dm.remove(id); } catch (e) {} }
  if (_sliceRens) for (const name in _sliceRens) {
    const sr = _sliceRens[name];
    if (sr.ctVol) { sr.ren.removeVolume(sr.ctVol); sr.ctVol = null; sr.ctMapper = null; }
    if (sr.ovVol) { sr.ren.removeVolume(sr.ovVol); sr.ovVol = null; sr.ovMapper = null; }
    sr.key = null;
  }
  if (_fourUp) for (const name in _fourUp) { const slot = _fourUp[name]; if (slot) { slot.index = null; slot._initKey = null; } }
  if (viewBoxActor) viewBoxActor.setVisibility(false);
  window.__caseSegments = null; window.__idcData = null;
  _idcRotCenter = null; _rotCenterSet = false; _segVis = {};   // reset trackball pivot + per-segment visibility for the next case
  closeCtrlMenu();
  scene3DDirty = true; slicesDirty = true; try { renderWindow.render(); } catch (e) {}
}

async function loadIDCScene(ctPrefix, segPrefix, modality, ctBucket, segBucket) {
  window.__slicerliveError = null; window.__caseSegments = null;
  clearIDCScene();   // drop the previous dataset immediately -> no lingering actors/slices during the new load
  try {
    setLoadProgress(0.02, 'Listing IDC instances…');
    const ctKeys = await s3ListKeys(ctPrefix, ctBucket);
    const segKeys = segPrefix ? await s3ListKeys(segPrefix, segBucket) : [];
    console.log('[IDC] CT', ctKeys.length, 'SEG', segKeys.length);
    if (!ctKeys.length) {   // no instances under this bucket/prefix -> surface it instead of crashing the worker into a blank screen
      window.__slicerliveError = 'No CT instances at ' + (ctBucket || 'idc-open-data') + '/' + ctPrefix;
      setLoadProgress(-1); return;
    }
    let ctData = null;
    await runIDCWorker(ctKeys, segKeys, {
      onCT: async (ct) => {                          // CT fully available -> render the 3 slice views + the VR
        ctData = ct; window.__idcData = { ct };
        const vox = ct.dims[0] * ct.dims[1] * ct.dims[2];   // guard: a too-large volume blows the GPU 3D textures (white crash)
        if (vox > 64e6) { window.__slicerliveError = 'Source too large for in-browser 3D: ' + ct.dims.join('×') + ' (' + Math.round(vox / 1e6) + 'M voxels)'; mosaicHide(); setLoadProgress(-1); return; }
        const nodes = buildIDCNodes(ct, segKeys.length > 0, modality);
        for (const id in nodes) mirror.set(id, nodes[id]);
        window.__slicerliveLoaded = mirror.size; threeDActive = true;
        await syncDMs();
        ensureControlsButton();                      // SlicerLive-mark button -> display-options menu over the 3D quadrant
        mosaicHide();                                // real slices render now -> drop the thumbnail mosaic
        setIDCCamera(ct);
        renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); markDirty();
        // deferred renders cover the GPU volume-texture upload window (the VR is dark-until-nudge without this)
        for (const d of [120, 400, 1000]) setTimeout(() => { try { renderer.resetCameraClippingRange(); renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); } catch (e) {} }, d);
      },
      onLabelmap: async (seg) => { await addIDCSegments(ctData, seg); },   // 2D colored overlay on the slices
    }, ctBucket, segBucket, modality);
    setLoadProgress(-1);
    if (segKeys.length === 0) finalizeRotationCenter();   // no segmentation -> pivot on the volume centroid (seg cases finalize in addIDCSegments)
    renderer.resetCameraClippingRange(); renderer.updateLightsGeometryToFollowCamera();
    renderWindow.render(); markDirty();
    // deferred renders cover the GPU volume-texture upload window; they no longer touch the pivot (it's fixed once finalized)
    for (const d of [120, 400, 1000, 2200]) setTimeout(() => { try { renderer.resetCameraClippingRange(); renderer.updateLightsGeometryToFollowCamera(); renderWindow.render(); } catch (e) {} }, d);
  } catch (e) { console.error('[IDC]', e); window.__slicerliveError = String(e); setLoadProgress(-1); }
}

// ===================== SEGRoulette: spin a random IDC SEG (CT/MR/PET source) into the viewer =====================
// Auto-spin a random case + a top bar (Details / Spin) + a case-detail popup. Hard QtWebEngine rule learned the hard
// way: NO color emoji anywhere -- a color-emoji glyph composited over the WebGL canvas crashes the render process
// (white screen) on macOS. Translucency / backdrop-filter / box-shadow are all fine (the glass UI relies on them).
let _segByCol = null, _segStats = null, _srSpinning = false, _srBar = null, _srCap = null, _srBtn = null;
let _srInfoBtn = null, _srCurrent = null, _srLic = null, _srViewer = null;   // current picked case + bar license/viewer chips
function ohifViewerURL(st) { return st ? 'https://viewer.imaging.datacommons.cancer.gov/v3/viewer/?StudyInstanceUIDs=' + encodeURIComponent(st) : null; }
function ccDeedURL(lic) { const m = /CC BY(-NC)?\s*([\d.]+)/i.exec(lic || ''); return m ? 'https://creativecommons.org/licenses/by' + (m[1] ? '-nc' : '') + '/' + m[2] + '/' : null; }
// A shared "Copy link" (?ct=&seg=&col=&st=&pid=...) opens a single case directly -> show the same bar + Details box
// as SEGRoulette (minus Spin). Pull _segStats (collMeta) in the background so the Details popup is fully populated.
function setupSharedCase(caseObj) {
  _srCurrent = caseObj;
  ensureSRBar();
  if (_srBtn) _srBtn.style.display = 'none';
  if (_srCap) _srCap.textContent = ({ CT: 'CT', MR: 'MR', PT: 'PET' }[caseObj.m] || caseObj.m) + '  ·  ' + caseObj.col + '  ·  ' + (caseObj.sd || 'segmentation');
  if (_srLic) _srLic.textContent = caseObj.lic || '';
  if (_srViewer) _srViewer.style.display = caseObj.st ? 'inline-block' : 'none';
  if (!_segStats) fetchRetry('segroulette.json?t=' + Date.now()).then((r) => r.json()).then((d) => { _segStats = d.stats || _segStats; }).catch(() => {});
}
async function loadSEGRoulette() {
  try {
    const data = await fetchRetry('segroulette.json?t=' + Date.now()).then((r) => r.json());   // cache-bust: stay in sync with bundle updates
    const rows = data.rows || data; _segStats = data.stats || null;
    _segByCol = {};
    for (const e of rows) (_segByCol[e.col] = _segByCol[e.col] || []).push(e);   // group by collection -> balanced spin
    showLanding();                                                              // intro: IDC seg stats + a Spin button
  } catch (e) { console.error('[SEGRoulette]', e); window.__slicerliveError = String(e); }
}
function srPick() {
  const cols = Object.keys(_segByCol);
  const list = _segByCol[cols[Math.floor(Math.random() * cols.length)]];        // collection-uniform so nlst doesn't dominate
  return list[Math.floor(Math.random() * list.length)];
}
async function srSpin() {
  if (_srSpinning || !_segByCol) return;
  _srSpinning = true; if (_srBtn) _srBtn.disabled = true;
  const e = srPick(), mod = { CT: 'CT', MR: 'MR', PT: 'PET' }[e.m] || e.m;
  _vrOn = true; _seg3DOn = true; _seg2DOn = true;   // every spin starts with VR + segmentation visible (fill/outline style persists)
  _srCurrent = e; closeCaseInfo();
  if (_srCap) _srCap.textContent = mod + '  \u00b7  ' + e.col + '  \u00b7  ' + (e.sd || 'segmentation');
  if (_srLic) _srLic.textContent = e.lic || '';
  if (_srViewer) _srViewer.style.display = e.st ? 'inline-block' : 'none';
  try { await loadIDCScene(e.c, e.s, e.m, e.cb, e.sb); } catch (err) { window.__slicerliveError = String(err); }
  if (window.__slicerliveError && _srCap) _srCap.textContent += '  \u2014 failed (spin again)';
  _srSpinning = false; if (_srBtn) _srBtn.disabled = false;
}
function ensureSRBar() {
  if (_srBar) return;
  _srBar = document.createElement('div');
  // ONE hard rule: NO color emoji in the caption/button text -- a color-emoji glyph composited over the WebGL canvas
  // CRASHES QtWebEngine's render process on macOS -> instant white screen (Chrome is fine). This was the
  // qSlicerWebWidget "blank on spin" bug. Translucency / backdrop-filter are fine, so the bar is glass too.
  _srBar.style.cssText = 'position:fixed; left:10px; top:10px; z-index:75; display:flex;' +
    ' align-items:center; gap:12px; padding:7px 10px 7px 16px; max-width:94vw; border-radius:13px;' +
    ' background:rgba(20,23,36,0.55); backdrop-filter:blur(20px) saturate(1.5); -webkit-backdrop-filter:blur(20px) saturate(1.5);' +
    ' border:1px solid rgba(255,255,255,0.16); box-shadow:0 8px 30px rgba(0,0,0,0.4);' +
    ' color:#eaf0ff; font:13px/1.4 -apple-system,system-ui,sans-serif;';
  _srCap = document.createElement('div'); _srCap.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;';
  _srCap.textContent = 'SEGRoulette';
  _srInfoBtn = document.createElement('button'); _srInfoBtn.textContent = 'Details';
  _srInfoBtn.style.cssText = 'flex:none; cursor:pointer; border:1px solid #34384a; border-radius:9px; padding:8px 13px;' +
    ' font:600 13px -apple-system,system-ui,sans-serif; color:#cfe6ff; background:#1b2030;';
  _srInfoBtn.onclick = openCaseInfo;
  _srLic = document.createElement('span');   // subtle license chip (disclosure without a popup)
  _srLic.style.cssText = 'flex:none; font:600 11px system-ui; color:#9fb0c8; opacity:0.9; padding:2px 7px; border:1px solid rgba(255,255,255,0.14); border-radius:7px; white-space:nowrap;';
  _srViewer = document.createElement('button'); _srViewer.textContent = 'IDC viewer';   // OHIF link, visible without the popup (Andrey)
  _srViewer.style.cssText = 'flex:none; cursor:pointer; border:1px solid #34384a; border-radius:9px; padding:8px 13px; font:600 13px -apple-system,system-ui,sans-serif; color:#cfe6ff; background:#1b2030;';
  _srViewer.onclick = () => { const u = _srCurrent && ohifViewerURL(_srCurrent.st); if (u) window.open(u, '_blank', 'noopener'); };
  _srBtn = document.createElement('button'); _srBtn.textContent = 'Spin';
  _srBtn.style.cssText = 'flex:none; cursor:pointer; border:0; border-radius:9px; padding:8px 16px; font:600 13px system-ui;' +
    ' color:#04121c; background:linear-gradient(180deg,#9fe9ff,#54c6f0);';
  _srBtn.onclick = srSpin;
  _srBar.appendChild(_srCap); _srBar.appendChild(_srLic); _srBar.appendChild(_srViewer); _srBar.appendChild(_srInfoBtn); _srBar.appendChild(_srBtn);
  document.body.appendChild(_srBar);
}

// Intro landing: IDC segmentation stats + a big Spin button. Clicking Spin dismisses it, shows the bar, and loads
// the first case (then the progress UI takes over, like the IDC TS demo). Liquid glass; NO color emoji (crash rule).
let _srLanding = null;
function closeLanding() { if (_srLanding) { _srLanding.remove(); _srLanding = null; } }
function showLanding() {
  closeLanding();
  _vrOn = true; _seg3DOn = true; _seg2DOn = true; _segFill = true; _segOutline = true;   // back to the spin page -> all display modes to defaults
  const s = _segStats || {}, bm = s.byMod || {}, n = (x) => (x == null ? '–' : x.toLocaleString());
  _srLanding = document.createElement('div');
  _srLanding.style.cssText = 'position:fixed; inset:0; z-index:95; display:flex; align-items:center; justify-content:center;' +
    ' background:rgba(6,8,14,0.45); font:14px/1.5 -apple-system,system-ui,sans-serif; color:#e8eeff;';
  const panel = document.createElement('div');
  panel.style.cssText = 'max-width:min(560px,92vw); text-align:center; border-radius:22px; padding:34px 38px;' +
    ' background:linear-gradient(135deg, rgba(58,64,88,0.55), rgba(20,24,38,0.62));' +
    ' backdrop-filter:blur(26px) saturate(1.7); -webkit-backdrop-filter:blur(26px) saturate(1.7);' +
    ' border:1px solid rgba(255,255,255,0.22); box-shadow:0 18px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.22);';
  panel.innerHTML =
    slicerLiveLogo(180) +
    '<div style="font-size:22px;font-weight:700;letter-spacing:1px;opacity:0.92;margin-top:14px">SEGRoulette</div>' +
    '<div style="opacity:0.85;margin:8px 0 24px">Spin a random AI / expert segmentation from the NCI Imaging Data Commons — with its source CT, MR, or PET — straight into a live 3D viewer in your browser. No install, data streamed from the IDC public buckets.</div>' +
    '<div style="font-size:42px;font-weight:800;color:#9fe9ff;line-height:1">' + n(s.totalSeg) + '</div>' +
    '<div style="opacity:0.7;margin:4px 0 20px">segmentation series in IDC ' + (s.idcVersion ? '(' + s.idcVersion + ')' : '') + ', across ' + n(s.collections) + ' collections</div>' +
    '<div style="opacity:0.75;margin-bottom:6px;font-size:12px;text-transform:uppercase;letter-spacing:1px">Spin pool — ' + n(s.sampled) + ' viewable cases</div>' +
    '<div style="display:flex;gap:22px;justify-content:center;margin-bottom:26px">' +
      '<div><span style="font-size:22px;font-weight:700">' + n(bm.CT) + '</span> CT</div>' +
      '<div><span style="font-size:22px;font-weight:700">' + n(bm.MR) + '</span> MR</div>' +
      '<div><span style="font-size:22px;font-weight:700">' + n(bm.PT) + '</span> PET</div></div>';
  const spin = document.createElement('button'); spin.textContent = 'Spin';
  spin.style.cssText = 'cursor:pointer; border:0; border-radius:13px; padding:13px 44px; font:800 17px system-ui;' +
    ' color:#04121c; background:linear-gradient(180deg,#9fe9ff,#54c6f0); box-shadow:0 6px 22px rgba(84,198,240,0.45);';
  spin.onclick = () => { closeLanding(); ensureSRBar(); srSpin(); };
  panel.appendChild(spin);
  _srLanding.appendChild(panel); document.body.appendChild(_srLanding);
}

// Case-detail popup: collection summary + TCIA/IDC links + colored segment list. Liquid-glass look = backdrop-filter
// blur over the live 3D + a translucent gradient skin + inner highlight rim. (Only hard rule: NO color emoji -- that
// crashes the QtWebEngine render process; compositing/blur is fine.)
let _srModal = null;
function closeCaseInfo() { if (_srModal) { _srModal.remove(); _srModal = null; } }
function collDisplayName(id) { return (id || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()); }
function openCaseInfo() {
  closeCaseInfo();
  const e = _srCurrent; if (!e) return;
  const meta = (_segStats && _segStats.collMeta && _segStats.collMeta[e.col]) || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const viewerURL = e.st ? 'https://viewer.imaging.datacommons.cancer.gov/v3/viewer/?StudyInstanceUIDs=' + encodeURIComponent(e.st) : null;
  const portalURL = 'https://portal.imaging.datacommons.cancer.gov/explore/filters/?collection_id=' + encodeURIComponent(e.col);
  const licURL = ccDeedURL(e.lic);
  const modName = { CT: 'CT', MR: 'MR', PT: 'PET' }[e.m] || e.m;

  // Citations: the DISTINCT source DOIs of exactly what is on screen -- the image series AND the segmentation,
  // which in the general case is an analysis result with its OWN DOI (e.g. a Zenodo AIMI dataset, NOT the TCIA
  // collection) -- plus the IDC platform. Built by idc-index's citations_from_selection at data-prep time and
  // baked into stats.doiCite (source_DOI -> APA citation). This auto-handles the link text: the citation itself
  // names "The Cancer Imaging Archive" or "Zenodo", so nothing hard-codes "TCIA".
  const dc = (_segStats && _segStats.doiCite) || {}, idcCite = (_segStats && _segStats.idcCite) || '';
  const linkifyDoi = (s) => String(s).replace(/https?:\/\/doi\.org\/(\S+)/gi, (mm, p) => '<a href="https://doi.org/' + esc(p) + '" target="_blank" rel="noopener" style="color:#9fe9ff">' + esc('https://doi.org/' + p) + '</a>');
  const citeList = [], seenDoi = {};
  [['Image', e.idoi], ['Segmentation', e.sdoi]].forEach((pair) => {
    const role = pair[0], d = pair[1];
    if (!d || seenDoi[d] || !dc[d]) return; seenDoi[d] = 1;
    citeList.push('<div style="margin:8px 0"><span style="opacity:0.55">' + role + ':</span> ' + linkifyDoi(dc[d]) + '</div>');
  });
  if (idcCite) citeList.push('<div style="margin:8px 0"><span style="opacity:0.55">Platform:</span> ' + linkifyDoi(idcCite) + '</div>');
  if (!citeList.length) citeList.push('<div style="opacity:0.85">' + esc('Data via the NCI Imaging Data Commons' + (meta.doi ? ' (DOI ' + meta.doi + ')' : '') + '.') + '</div>');
  const dlUIDs = [e.u, e.su].filter(Boolean).join(' ');
  const dlCode = 'pip install --upgrade idc-index\nidc download ' + dlUIDs;

  const rows = [];
  if (meta.cancer) rows.push(['Primary cancer', meta.cancer]);
  if (meta.loc) rows.push(['Body part', meta.loc]);
  if (meta.cases != null) rows.push(['Cases in collection', String(meta.cases)]);
  if (meta.sites) rows.push(['Contributing scanners/sites', meta.sites]);
  if (e.sd) rows.push(['This segmentation', e.sd]);
  const link = (href, text) => href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener" style="color:#9fe9ff;text-decoration:none;border-bottom:1px solid rgba(159,233,255,0.4)">' + esc(text) + '</a>' : '';
  const linksHTML = [viewerURL && link(viewerURL, 'Open case in IDC viewer'), link(portalURL, 'Collection in IDC portal')].filter(Boolean).join('<span style="opacity:0.4;margin:0 10px">|</span>');

  _srModal = document.createElement('div');
  _srModal.style.cssText = 'position:fixed; inset:0; z-index:90; display:flex; align-items:center; justify-content:center;' +
    ' background:rgba(6,8,14,0.38); font:13px/1.5 -apple-system,system-ui,sans-serif; color:#e8eeff;';
  _srModal.onclick = (ev) => { if (ev.target === _srModal) closeCaseInfo(); };
  const panel = document.createElement('div');
  // liquid glass: frosted blur over the live 3D behind it + a translucent gradient skin + an inner highlight rim
  panel.style.cssText = 'max-width:min(680px,92vw); max-height:86vh; overflow:auto; border-radius:18px; padding:22px 24px;' +
    ' background:linear-gradient(135deg, rgba(58,64,88,0.55), rgba(20,24,38,0.62));' +
    ' backdrop-filter:blur(26px) saturate(1.7); -webkit-backdrop-filter:blur(26px) saturate(1.7);' +
    ' border:1px solid rgba(255,255,255,0.22); box-shadow:0 18px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.22);';
  panel.innerHTML =
    '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px">' +
    '<div style="font-size:19px;font-weight:700">' + esc(collDisplayName(e.col)) + (e.pid ? '<span style="opacity:0.7;font-weight:500;font-size:15px;margin-left:8px">' + esc(e.pid) + '</span>' : '') + '</div>' +
    '<div style="opacity:0.7;font-size:12px">' + esc(modName) + ' · IDC ' + esc((_segStats && _segStats.idcVersion) || '') +
    (e.lic ? ' · ' + (licURL ? link(licURL, e.lic) : esc(e.lic)) : '') + '</div></div>' +
    (meta.desc ? '<div style="opacity:0.85;margin-bottom:12px">' + esc(meta.desc) + '</div>' : '') +
    '<div style="margin:6px 0 14px">' + linksHTML + '</div>' +
    rows.map(([k, v]) => '<div style="display:flex;gap:12px;margin:7px 0"><div style="flex:0 0 168px;opacity:0.6">' + esc(k) + '</div><div style="flex:1">' + esc(v) + '</div></div>').join('') +
    '<details style="margin-top:16px"><summary style="cursor:pointer;opacity:0.6;outline:none;user-select:none">Cite &amp; download</summary>' +
    '<div style="opacity:0.8;margin:10px 0 2px">Cite the data shown and the IDC platform:</div>' +
    citeList.join('') +
    '<div style="opacity:0.8;margin:14px 0 4px">Download the exact image + segmentation series shown:</div>' +
    '<pre style="margin:0;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:10px 12px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;color:#cfe6ff;white-space:pre">' + esc(dlCode) + '</pre></details>';

  // Shareable deep-link to exactly this case on the live site (copy + send to a colleague)
  const shareURL = 'https://pieper.github.io/live/viewer.html?' + new URLSearchParams(   // carry case context so the opened link can show Details
    { ct: e.c, seg: e.s, mod: e.m, ctb: e.cb || 'idc-open-data', segb: e.sb || 'idc-open-data',
      col: e.col || '', st: e.st || '', sd: e.sd || '', lic: e.lic || '', su: e.su || '', pid: e.pid || '',
      u: e.u || '', idoi: e.idoi || '', sdoi: e.sdoi || '' }).toString();
  const shareLabel = document.createElement('div'); shareLabel.style.cssText = 'margin:16px 0 6px;opacity:0.6'; shareLabel.textContent = 'Link to this case';
  const shareRow = document.createElement('div'); shareRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  const inp = document.createElement('input'); inp.readOnly = true; inp.value = shareURL;
  inp.style.cssText = 'flex:1;min-width:0;background:rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.18);border-radius:8px;padding:8px 10px;color:#cfe6ff;font:12px ui-monospace,Menlo,monospace';
  inp.onclick = () => inp.select();
  const copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy link';
  copyBtn.style.cssText = 'flex:none;cursor:pointer;border:0;border-radius:8px;padding:8px 16px;font:600 13px system-ui;color:#04121c;background:linear-gradient(180deg,#9fe9ff,#54c6f0)';
  copyBtn.onclick = () => {
    inp.select();
    const done = () => { copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(shareURL).then(done, () => { try { document.execCommand('copy'); done(); } catch (e2) {} });
    else { try { document.execCommand('copy'); done(); } catch (e2) {} }
  };
  shareRow.appendChild(inp); shareRow.appendChild(copyBtn);

  const close = document.createElement('button'); close.textContent = 'Close';
  close.style.cssText = 'margin-top:18px;cursor:pointer;border:1px solid rgba(255,255,255,0.22);border-radius:9px;' +
    'padding:8px 18px;font:600 13px system-ui;color:#e8eeff;background:rgba(255,255,255,0.08)';
  close.onclick = closeCaseInfo;
  panel.appendChild(shareLabel); panel.appendChild(shareRow); panel.appendChild(close);
  _srModal.appendChild(panel); document.body.appendChild(_srModal);
}

async function loadSlicerLiveScene(sceneUrl) {
  const base = sceneUrl.slice(0, sceneUrl.lastIndexOf('/') + 1);
  if (/\.json(\?|$)/.test(sceneUrl)) return loadSceneJson(sceneUrl, base);   // full-scene publish format
  let text;
  try { text = await fetch(sceneUrl).then((r) => r.text()); }
  catch (e) { console.error('[SlicerLive] cannot fetch scene', sceneUrl, e); window.__slicerliveError = String(e); return; }
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const root = xml.documentElement;
  const byId = {};
  for (const el of root.children) { const id = el.getAttribute('id'); if (id) byId[id] = el; }
  mirror.clear(); localBlobs.clear();
  // display nodes first (models reference them)
  for (const el of root.children) {
    const id = el.getAttribute('id'); if (!id || el.tagName !== 'ModelDisplay') continue;
    mirror.set(id, { id, class: 'vtkMRMLModelDisplayNode', name: el.getAttribute('name') || id, refs: {}, blobs: {},
      attrs: { color: _floats(el.getAttribute('color') || '1 1 1'),
               opacity: el.getAttribute('opacity') != null ? +el.getAttribute('opacity') : 1,
               visibility: el.getAttribute('visibility') === 'false' ? 0 : 1,
               representation: el.getAttribute('representation') != null ? +el.getAttribute('representation') : 2,
               edgeVisibility: el.getAttribute('edgeVisibility') === 'true' } });
  }
  // models + their VTP geometry (relative fileName resolved against the scene URL)
  for (const el of root.children) {
    const id = el.getAttribute('id'); if (!id || el.tagName !== 'Model') continue;
    const dispRef = (el.getAttribute('displayNodeRef') || '').split(/\s+/).filter(Boolean);
    const storeRef = (el.getAttribute('storageNodeRef') || '').split(/\s+/).filter(Boolean)[0];
    const fileName = storeRef && byId[storeRef] && byId[storeRef].getAttribute('fileName');
    const blobs = {};
    if (fileName) {
      try {
        const pd = await readPolyData(base + fileName);
        blobs.points = { hash: 'sl' + (__slHash++) };   // a key for ModelDM change-detection
        blobs.__pd = pd;                                 // the reader's vtkPolyData, used directly by buildPolyData
      } catch (e) { console.warn('[SlicerLive] model read failed', fileName, e); }
    }
    mirror.set(id, { id, class: 'vtkMRMLModelNode', name: el.getAttribute('name') || id, refs: { display: dispRef }, attrs: {}, blobs });
  }
  console.log('[SlicerLive] loaded', mirror.size, 'nodes from', sceneUrl);
  window.__slicerliveLoaded = mirror.size;
  threeDActive = true;
  await syncDMs();
  renderer.resetCamera(); renderWindow.render(); markDirty();
}

(async () => {
  if (SLICERLIVE) {                                  // SlicerLive: render a MRML scene from a URL, no server/WS
    if (!bound) { interactor.bindEvents(host); bound = true; }
    positionOverlay();
    window.addEventListener('resize', positionOverlay);
    requestAnimationFrame(composite);   // start the render loop NOW so CT slices + VR show progressively as they load
    if (window.__SEGROULETTE) await loadSEGRoulette();                              // spin a random IDC SEG + its CT/MR/PET source
    else if (window.__IDC_CT) {   // client-side IDC (optional ctb/segb buckets); a shared link also carries case context
      if (window.__IDC_CASE) setupSharedCase(window.__IDC_CASE);
      await loadIDCScene(window.__IDC_CT, window.__IDC_SEG, window.__IDC_MOD || 'CT', window.__IDC_CTB, window.__IDC_SEGB);
    }
    else await loadSlicerLiveScene(window.__SLICERLIVE_SCENE_URL);
    return;
  }
  if (!(await pullMRML())) { console.warn('[offload] MRML server not reachable; overlay disabled'); return; }
  if (!bound) { interactor.bindEvents(host); bound = true; }
  appliedVersion = pendingVersion = 0;
  connectWS();
  if (STANDALONE) positionOverlay();     // size + show the full-window vtk.js view now (no server viewport rect needed)
  window.addEventListener('resize', positionOverlay);
  if (window.desktopCompositor) window.desktopCompositor.setLayer({   // GPU desktop compositor composites our 3D
    active: () => connected() && !!geom && threeDActive,
    source: () => (glWindow.getCanvas && glWindow.getCanvas()),       // vtk's WebGL canvas, sampled as a texture
    rect: () => geom,                                                 // {sx,sy,sw,sh} in stream px
    key: KEY, tol: KEY_TOL,
  });
  requestAnimationFrame(composite);
  console.log('[offload] overlay active (MRML mirror + JS displayable managers)');
})();
