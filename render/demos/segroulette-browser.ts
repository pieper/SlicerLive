// Browser entry for SlicerLive SEGRoulette: spin a random IDC series (CT/MR/PET +
// DICOM SEG), load it client-side with idc_tools (dcmjs in a worker, straight from the
// IDC public buckets), and render a 4-up — 3 MPR planes (grayscale + colored seg
// overlay) + a 3D view where the segmentation is the SegmentField `iso` band-shell
// (step-derived isosurface). The WebGPU-native replacement for the vtk.js roulette.
// Bundled to live/webgpu/segroulette.js (idc-worker.js sits next to it).
import { initDevice } from "../device.ts";
import { slicerDefaultOffset01 } from "../slice-renderer.ts";
import { buildSegrouletteScene, type SegrouletteScene } from "./segroulette-scene.ts";
import { type Crosshair4up, mountCrosshair } from "./crosshair.ts";
import { spinRandom } from "../vendor/idc_tools/index.js";
import type { LoadResult, SeriesEntry } from "../vendor/idc_tools/types.js";
import type { Vec3 } from "../mat4.ts";

const MANIFEST = "../legacy/segroulette.json";   // reuse the existing roulette manifest (2MB, cache-busted)

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) { el.textContent = msg; el.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const el = (id: string) => document.getElementById(id) as HTMLElement;
const cvEl = (id: string) => document.getElementById(id) as HTMLCanvasElement;

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true); return; }
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "coronal", "sagittal", "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = cvEl("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  const planes = [
    { cell: "axial", orient: "axial" },
    { cell: "coronal", orient: "coronal" },
    { cell: "sagittal", orient: "sagittal" },
  ] as const;

  let rs: SegrouletteScene | null = null;
  const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };
  let az = 0.6, elev = 0.32, dist = 500;

  const eye = (): Vec3 => [
    rs!.center[0] + dist * Math.cos(elev) * Math.sin(az),
    rs!.center[1] - dist * Math.cos(elev) * Math.cos(az),
    rs!.center[2] + dist * Math.sin(elev),
  ];
  const drawSlice = (p: { cell: "axial" | "coronal" | "sagittal"; orient: "axial" | "coronal" | "sagittal" }) => {
    if (!rs || !cv[p.cell].width) return;
    rs.slice.setPlane(p.orient, off[p.cell]);
    rs.slice.renderToView(cx[p.cell].getCurrentTexture().createView({ format: srgb }), cv[p.cell].width, cv[p.cell].height);
  };
  const draw3d = () => {
    if (!rs || !cv.threeD.width) return;
    rs.scene.setCamera(eye(), rs.center, [0, 0, 1], 28, cv.threeD.width, cv.threeD.height);
    rs.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  let xhair: Crosshair4up | null = null;
  const drawAll = () => { for (const p of planes) drawSlice(p); draw3d(); xhair?.redraw(); };

  // SHARED shift-move crosshair pick — same one-call mount every MPR demo uses. Getters keep it
  // valid across a spin (the scene/slice are rebuilt underneath while the canvases persist).
  const nAxisOf: Record<string, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
  const jumpAll = (ras: Vec3) => {
    if (!rs) return;
    for (const p of planes) {
      const a = nAxisOf[p.orient];
      off[p.cell] = Math.max(0, Math.min(1, (ras[a] - rs.rasLo[a]) / (rs.rasHi[a] - rs.rasLo[a])));
    }
    drawAll();
  };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) { cv[n].width = Math.floor(cv[n].clientWidth * dpr); cv[n].height = Math.floor(cv[n].clientHeight * dpr); }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);

  // metadata panel
  const showMeta = (entry: SeriesEntry | undefined, sc: SegrouletteScene) => {
    const info = el("info");
    if (!info) return;
    const segs = sc.segments.map((s) =>
      `<span class="chip" style="border-color:rgb(${s.color.map((c) => Math.round(c * 255)).join(",")})">${s.name}</span>`).join(" ");
    info.innerHTML =
      `<div class="col">${entry?.col ?? ""} <span class="mod">${entry?.m ?? ""}</span></div>` +
      `<div class="sd">${entry?.sd ?? "segmentation"}</div>` +
      `<div class="segs">${segs || "<i>no segments</i>"}</div>` +
      (entry?.lic ? `<div class="lic">${entry.lic}</div>` : "");
  };

  const spinBtn = el("spin") as HTMLButtonElement;
  async function spin() {
    spinBtn.disabled = true;
    status("spinning… picking a random IDC series");
    try {
      const res: LoadResult = await spinRandom(
        { onProgress: (p) => status(`${p.msg}${p.frac ? ` — ${Math.round(p.frac * 100)}%` : ""}`) },
        { manifestUrl: MANIFEST },
      );
      status("baking segmentation iso shells…");
      rs = buildSegrouletteScene(gpu, srgb, res.ct, res.seg);
      // frame: slices at the Slicer default voxel-centre plane; camera fit to the volume
      for (const p of planes) off[p.cell] = slicerDefaultOffset01(p.orient, rs.dims, rs.ijkToRAS, rs.rasLo, rs.rasHi);
      dist = rs.radius * 2.7;
      showMeta(res.entry, rs);
      resize();
      status(`${res.entry?.col ?? "IDC"} · ${res.entry?.m ?? ""} · ${rs.segments.length} segment${rs.segments.length === 1 ? "" : "s"} · scroll a slice, drag 3D to orbit · Spin for another`);
    } catch (e) {
      status("load failed: " + ((e as Error)?.message ?? e) + " — try Spin again", true);
    } finally {
      spinBtn.disabled = false;
    }
  }
  spinBtn.addEventListener("click", spin);

  // slice scrub + 3D orbit/zoom
  for (const p of planes) {
    cv[p.cell].addEventListener("wheel", (e) => {
      e.preventDefault();
      off[p.cell] = Math.max(0, Math.min(1, off[p.cell] + (e.deltaY > 0 ? 0.015 : -0.015)));
      drawSlice(p); xhair?.redraw();
    }, { passive: false });
  }
  let dragging = false, lx = 0, ly = 0;
  cv.threeD.addEventListener("pointerdown", (e) => { if (e.shiftKey) return; dragging = true; lx = e.clientX; ly = e.clientY; cv.threeD.setPointerCapture(e.pointerId); });
  cv.threeD.addEventListener("pointerup", (e) => { dragging = false; try { cv.threeD.releasePointerCapture(e.pointerId); } catch { /* */ } });
  cv.threeD.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    az += (e.clientX - lx) * 0.008; elev = Math.max(-1.4, Math.min(1.4, elev - (e.clientY - ly) * 0.008));
    lx = e.clientX; ly = e.clientY; draw3d(); xhair?.redraw();
  });
  cv.threeD.addEventListener("wheel", (e) => { e.preventDefault(); dist = Math.max(rs ? rs.radius : 50, Math.min(4000, dist * (e.deltaY > 0 ? 1.08 : 0.93))); draw3d(); xhair?.redraw(); }, { passive: false });

  xhair = mountCrosshair({
    cells: { axial: cv.axial, coronal: cv.coronal, sagittal: cv.sagittal, threeD: cv.threeD },
    getScene: () => rs!.scene,
    getSlice: () => rs!.slice,
    getCamera: () => ({ position: eye(), focalPoint: rs!.center, viewUp: [0, 0, 1], viewAngle: 28 }),
    getOffset: (o) => off[o],
    onJump: jumpAll,
  });

  // introspection for automated tests
  (globalThis as unknown as { __segDbg: unknown }).__segDbg = {
    ready: () => !!rs,
    segments: () => rs?.segments ?? [],
    center: () => rs?.center ?? null,
    crosshair: () => xhair?.state.ras ?? null,
    pick3D: (u: number, v: number) => rs?.scene.pick(u, v) ?? null,
  };

  status("SlicerLive SEGRoulette — click Spin to load a random IDC segmentation");
  await spin();
}
main().catch((e) => status("error: " + (e?.message ?? e), true));
