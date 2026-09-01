// cards-browser.ts — SlicerLive "label cards" demo (first use of in-scene SDF text).
//
// Loads a KiTS kidney-tumour case from IDC (idc_tools), renders the segmentation surface in a single 3D
// view, and floats a museum-exhibit "label card" over each segment: a ground-glass panel with the segment
// name + coded terminology, tethered by a leader line to a pin at the segment's centroid. A force-directed
// layout keeps ≤12 cards legible and non-overlapping and glides them as the camera orbits.
//
// Bundle for the gallery (idc-worker.js must sit next to the output):
//   deno run -A npm:esbuild@0.21.5 render/demos/cards-browser.ts --bundle --format=esm \
//     --outfile=live/webgpu/cards.js
//   cp render/vendor/idc_tools/idc-worker.js live/webgpu/idc-worker.js
//   cp render/demos/cards.html live/webgpu/cards.html
import { initDevice } from "../device.ts";
import { buildSegrouletteScene, type SegrouletteScene } from "./segroulette-scene.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import { buildFontAtlas } from "../sdf-text.ts";
import { type CardSpec, CardOverlay } from "../label-cards.ts";
import { loadSeries } from "../vendor/idc_tools/index.js";
import type { Vec3 } from "../mat4.ts";

const P = new URLSearchParams(location.search);
// Default KiTS-00051 (IDC c4kc_kits) noncontrast CT + kidney/tumour SEG; overridable via ?series=&seg=.
const SOURCE = {
  c: P.get("series") ?? "e3e86cde-da96-44b0-9e3b-b0b7bdd5a675",
  cb: P.get("bucket") ?? "idc-open-data",
  s: P.get("seg") ?? "04a800eb-2f06-4e29-a10d-934a6f5c7d47",
  sb: P.get("segBucket") ?? "idc-open-data",
  m: "CT",
};
const MAX_CARDS = 12;

const statusEl = document.getElementById("status") as HTMLElement | null;
const setStatus = (t: string) => { if (statusEl) statusEl.textContent = t; };

interface SegStat { centroidRAS: Vec3; voxels: number; volumeCc: number; hu?: { mean: number; std: number }; bboxLo: Vec3; bboxHi: Vec3 }
/** Per-segment centroid (RAS), voxel count, volume (cc), and HU mean/std — one pass over the labelmap +
 *  CT scalars on the CT grid. `scalars` (HU) is optional (only CT). */
function segStats(lab: Uint8Array, dims: [number, number, number], M: number[], scalars?: Int16Array | Float32Array): Map<number, SegStat> {
  const [nx, ny, nz] = dims;
  const acc = new Map<number, { n: number; x: number; y: number; z: number; s: number; s2: number; lo: Vec3; hi: Vec3 }>();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const idx = (k * ny + j) * nx + i, v = lab[idx]; if (!v) continue;
    let e = acc.get(v); if (!e) { e = { n: 0, x: 0, y: 0, z: 0, s: 0, s2: 0, lo: [i, j, k] as Vec3, hi: [i, j, k] as Vec3 }; acc.set(v, e); }
    e.n++; e.x += i; e.y += j; e.z += k;
    if (i < e.lo[0]) e.lo[0] = i; if (j < e.lo[1]) e.lo[1] = j; if (k < e.lo[2]) e.lo[2] = k;
    if (i > e.hi[0]) e.hi[0] = i; if (j > e.hi[1]) e.hi[1] = j; if (k > e.hi[2]) e.hi[2] = k;
    if (scalars) { const hu = scalars[idx]; e.s += hu; e.s2 += hu * hu; }
  }
  // |det| of the 3x3 direction/scale block = voxel volume (mm^3)
  const voxMm3 = Math.abs(M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]));
  const out = new Map<number, SegStat>();
  for (const [v, e] of acc) {
    const cx = e.x / e.n, cy = e.y / e.n, cz = e.z / e.n;
    const centroidRAS: Vec3 = [M[0] * cx + M[1] * cy + M[2] * cz + M[3], M[4] * cx + M[5] * cy + M[6] * cz + M[7], M[8] * cx + M[9] * cy + M[10] * cz + M[11]];
    const st: SegStat = { centroidRAS, voxels: e.n, volumeCc: (e.n * voxMm3) / 1000, bboxLo: e.lo, bboxHi: e.hi };
    if (scalars) { const mean = e.s / e.n; st.hu = { mean, std: Math.sqrt(Math.max(0, e.s2 / e.n - mean * mean)) }; }
    out.set(v, st);
  }
  return out;
}

interface Coded { scheme: string; value: string; meaning: string }
interface Term { type?: Coded | null; region?: Coded | null }
/** Coded terminology → a body line under the segment name. Prefers a human meaning that ADDS to the name
 *  (region, or a type meaning that differs), else surfaces the code (e.g. "SCT 64033007") so the card
 *  always shows genuine terminology rather than echoing the label. Undefined when no terminology. */
function bodyText(term: Term | undefined, name: string): string | undefined {
  if (!term || (!term.type && !term.region)) return undefined;
  const norm = (t?: string) => (t ?? "").trim().toLowerCase();
  const parts: string[] = [];
  if (term.type?.meaning && norm(term.type.meaning) !== norm(name)) parts.push(term.type.meaning);
  if (term.region?.meaning && norm(term.region.meaning) !== norm(name) && norm(term.region.meaning) !== norm(term.type?.meaning)) parts.push(term.region.meaning);
  if (!parts.length && term.type) parts.push(`${term.type.scheme} ${term.type.value}`.trim());   // fall back to the code
  return parts.length ? parts.join(" · ") : undefined;
}

async function main() {
  const gpu = await initDevice();
  const canvas = document.getElementById("c-threeD") as HTMLCanvasElement;
  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const preferred = navigator.gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;   // a view format COMPATIBLE with the canvas
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });

  setStatus("loading KiTS case from IDC…");
  const res = await loadSeries(SOURCE, { onProgress: (p: { msg: string; frac?: number }) => setStatus(`${p.msg}${p.frac ? ` — ${Math.round(p.frac * 100)}%` : ""}`) });
  if (!res.seg) { setStatus("no segmentation in this series"); return; }
  setStatus("building scene…");

  const sc: SegrouletteScene = buildSegrouletteScene(gpu, srgb, res.ct, res.seg);
  sc.setVolumeOpacity?.(0.0);   // show the segmentation surfaces cleanly (no volume haze) for the PoC

  // per-segment anchor + stats; the <=12 largest segments become cards
  const isCT = (res.ct.modality ?? "CT") === "CT";
  const stats = segStats(res.seg.lab, res.ct.dims, res.ct.ijkToRAS, isCT ? (res.ct.vol as Int16Array) : undefined);
  const term = res.seg.terminology ?? {};
  const chosen = [...sc.segments].sort((a, b) => b.voxels - a.voxels).slice(0, MAX_CARDS);
  const M = res.ct.ijkToRAS;
  const cornerRAS = (i: number, j: number, k: number): Vec3 => [M[0] * i + M[1] * j + M[2] * k + M[3], M[4] * i + M[5] * j + M[6] * k + M[7], M[8] * i + M[9] * j + M[10] * k + M[11]];
  const specs: CardSpec[] = [];
  const geom: { corners: Vec3[] }[] = [];   // per-card RAS bbox corners (for the keep-out circle)
  for (const s of chosen) {
    const st = stats.get(s.num); if (!st) continue;
    specs.push({ anchorRAS: st.centroidRAS, id: s.num, title: s.name, subtitle: bodyText(term[s.num] as Term | undefined, s.name),
      swatch: s.color, stat: { voxels: st.voxels, volumeCc: st.volumeCc, hu: st.hu } });
    const [lx, ly, lz] = st.bboxLo, [hx, hy, hz] = st.bboxHi;
    geom.push({ corners: [[lx,ly,lz],[hx,ly,lz],[lx,hy,lz],[hx,hy,lz],[lx,ly,hz],[hx,ly,hz],[lx,hy,hz],[hx,hy,hz]].map(([i,j,k]) => cornerRAS(i, j, k)) });
  }

  const dpr = globalThis.devicePixelRatio || 1;
  const font = buildFontAtlas({ sizePx: 44, spread: 6, fontFamily: "Helvetica, \"Helvetica Neue\", Arial, sans-serif" });
  const overlay = new CardOverlay(gpu, srgb, font);
  overlay.setCards(specs, dpr);

  // per-segment 3D opacity actions driven by the card buttons
  const applyAction = (id: number, action: "isolate" | "hide" | "reset") => {
    if (action === "reset") { for (const s of sc.segments) sc.setSegmentOpacity(s.num, 1); }
    else if (action === "hide") { sc.setSegmentOpacity(id, 0); }
    else if (action === "isolate") { for (const s of sc.segments) sc.setSegmentOpacity(s.num, s.num === id ? 1 : 0.4); }
  };

  // test/introspection hook (device-px coords). click() exercises the real hitTest path.
  (globalThis as unknown as { __cards?: unknown }).__cards = {
    count: specs.length, titles: specs.map((s) => s.title), bodies: specs.map((s) => s.subtitle ?? null),
    stats: specs.map((s) => s.stat),
    toggle: (i: number) => overlay.toggle(i),
    act: (i: number, a: "isolate" | "hide" | "reset") => applyAction(specs[i].id!, a),
    cardCenter: (i: number) => overlay.cardCenter(i),
    buttonCenter: (i: number, part: "isolate" | "hide" | "reset") => overlay.buttonCenter(i, part),
    click(x: number, y: number) { const h = overlay.hitTest(x, y); if (!h) return null; if (h.action === "toggle") overlay.toggle(h.index); else applyAction(specs[h.index].id!, h.action); return h; },
  };
  setStatus(`${specs.length} segment${specs.length === 1 ? "" : "s"} — click a card for details; drag to orbit`);

  const camera = framedCamera(sc.center, sc.radius);
  attachCameraControls(canvas, camera, { onChange: () => a3d.draw() });

  // Card interaction: a click on a card flips it / triggers a back-face button; a drag orbits (camera).
  // Capture phase + stopPropagation so a click that lands on a card never starts a camera orbit.
  const dprPx = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }; };
  let down: { x: number; y: number; hit: boolean } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    const p = dprPx(e);
    if (overlay.hitTest(p.x, p.y)) { down = { x: e.clientX, y: e.clientY, hit: true }; e.stopPropagation(); canvas.setPointerCapture(e.pointerId); }
    else down = { x: e.clientX, y: e.clientY, hit: false };
  }, true);
  canvas.addEventListener("pointerup", (e) => {
    if (down?.hit && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      const p = dprPx(e); const h = overlay.hitTest(p.x, p.y);
      if (h) { if (h.action === "toggle") overlay.toggle(h.index); else applyAction(specs[h.index].id!, h.action); a3d.draw(); }
    }
    down = null;
  }, true);

  const resize = () => { canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr)); canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr)); };
  resize(); addEventListener("resize", () => { resize(); a3d.draw(); });

  // rAF-independent profiler: render N frames back-to-back, timing scene vs overlay vs GPU.
  (globalThis as unknown as { __bench?: unknown }).__bench = async (N = 120, scale = 1) => {
    let sceneAcc = 0, ovAcc = 0, layoutAcc = 0, buildAcc = 0, submitAcc = 0, gpuAcc = 0;
    const w = canvas.width, h = canvas.height;
    for (let f = 0; f < N; f++) {
      camera.azimuth(0.6);   // keep it "moving" so nothing is cached
      const view = ctx.getCurrentTexture().createView({ format: srgb });
      let t = performance.now();
      if (scale >= 0.999) { sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h); sc.scene.renderToView(view, w, h); }
      else { const rw = Math.max(16, Math.round(w * scale)), rh = Math.max(16, Math.round(h * scale)); sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, rw, rh); sc.scene.renderUpscaled(view, rw, rh, w, h); }
      sceneAcc += performance.now() - t;
      const kos = geom.map((g, i) => { const cc = camera.worldToDisplay(specs[i].anchorRAS as Vec3, w, h); let r = 0; for (const c of g.corners) { const p = camera.worldToDisplay(c, w, h); if (p.depth > 0) r = Math.max(r, Math.hypot(p.x - cc.x, p.y - cc.y)); } return { x: cc.x, y: cc.y, radius: r }; });
      t = performance.now();
      overlay.render(view, camera, { w, h, dpr }, 1 / 60, kos);
      ovAcc += performance.now() - t;
      layoutAcc += overlay.perf.layoutMs; buildAcc += overlay.perf.buildMs; submitAcc += overlay.perf.submitMs;
      t = performance.now();
      await gpu.device.queue.onSubmittedWorkDone();
      gpuAcc += performance.now() - t;
    }
    return { frames: N, canvas: [w, h], sceneMs: sceneAcc / N, overlayMs: ovAcc / N, layoutMs: layoutAcc / N, buildMs: buildAcc / N, submitMs: submitAcc / N, gpuWaitMs: gpuAcc / N };
  };
  // Adaptive 3D: budget-scaled MOVING frames (renderUpscaled) while interacting, a crisp full-res SETTLE
  // when still, and DORMANT when nothing changes — the fix for the full-res-every-frame lag (GPU ~410ms
  // at retina). The card overlay is drawn on top of every scene frame; a light ticker keeps the loop
  // alive only while the cards are still reflowing (then it too goes idle).
  let lastFrame = performance.now();
  const keepOutsNow = (w: number, h: number) => geom.map((g, i) => {
    const cc = camera.worldToDisplay(specs[i].anchorRAS as Vec3, w, h);
    let r = 0; for (const c of g.corners) { const p = camera.worldToDisplay(c, w, h); if (p.depth > 0) r = Math.max(r, Math.hypot(p.x - cc.x, p.y - cc.y)); }
    return { x: cc.x, y: cc.y, radius: r };
  });
  const a3d = mountAdaptive3d({
    scene: () => sc.scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu, movingScaleCap: 0.5, target: 8,
    onFrame: () => {
      const now = performance.now(), dt = (now - lastFrame) / 1000; lastFrame = now;
      const w = canvas.width, h = canvas.height;
      overlay.render(ctx.getCurrentTexture().createView({ format: srgb }), camera, { w, h, dpr }, dt, keepOutsNow(w, h));
      if (!overlay.settled()) a3d.draw();   // keep rendering while the cards are still gliding, then go idle
    },
  });
  a3d.draw();
}

main().catch((e) => { console.error(e); setStatus("error: " + (e as Error).message); });
