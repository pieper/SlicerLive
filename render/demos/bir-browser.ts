// bir-browser.ts — SlicerLive "Basic Image Review" gallery demo.
//
// Loads an arbitrary KiTS case (Kidney Tumor Segmentation challenge, IDC collection
// c4kc_kits) straight from the IDC public bucket with idc_tools, reconstructs the volume,
// and presents it in the general-purpose IHE Basic Image Review reader (demos/bir.ts) — the
// same reader chrome SlicerRad uses. The 3D volume-rendering + segmentation controls live
// under the SlicerLive badge (sl-chrome installChrome), separate from the BIR toolbar since
// they are beyond the BIR profile.
//
// Bundle for the gallery (idc-worker.js must sit next to the output):
//   deno run -A npm:esbuild@0.21.5 render/demos/bir-browser.ts --bundle --format=esm \
//     --outfile=live/webgpu/bir.js
//   cp render/vendor/idc_tools/idc-worker.js live/webgpu/idc-worker.js
//   cp render/demos/bir.html live/webgpu/bir.html
// then add a gallery tile linking webgpu/bir.html.
import { initDevice } from "../device.ts";
import { slicerDefaultOffset01 } from "../slice-renderer.ts";
import { offset01ToMm, SliceInteractor } from "../slice-interactor.ts";
import { buildSegrouletteScene, type SegrouletteScene } from "./segroulette-scene.ts";
import { type Crosshair4up, mountCrosshair } from "./crosshair.ts";
import { attachCameraControls, framedCamera } from "./camera-control.ts";
import { attachSliceControls } from "./slice-control.ts";
import { attachDoubleClick, attachViewGrid } from "./view-grid.ts";
import { installChrome, type VizControl } from "./sl-chrome.ts";
import { loadSeries } from "../vendor/idc_tools/index.js";
import { type BirApi, mountBir, type Plane } from "./bir.ts";
import type { Vec3 } from "../mat4.ts";

// The demo case: an arbitrary KiTS abdomen CT (IDC c4kc_kits · KiTS-00108, 99 slices, CC BY
// 3.0). `?series=<uuid>&bucket=<b>` overrides it to review any IDC series.
const P = new URLSearchParams(location.search);
const DEMO = {
  c: P.get("series") || "9c8b6382-bdf6-4253-b2d1-7d011a59eb59",
  cb: P.get("bucket") || "idc-open-data",
  m: "CT",
  col: "c4kc_kits",
  st: "1.3.6.1.4.1.14519.5.2.1.6919.4624.986013693303407740653302415642",
  sd: "KiTS-00108 · three-phase abdomen",
  lic: "CC BY 3.0 · IDC c4kc_kits · doi:10.7937/tcia.2019.ix49e8nx",
};

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = msg;
    el.style.color = err ? "#ff6b74" : "#9fb3d0";
  }
};
const cvEl = (id: string) => document.getElementById(id) as HTMLCanvasElement;

const PLANES: Plane[] = ["axial", "coronal", "sagittal"];
const CT_WL_PRESETS = [
  { name: "Soft Tissue", win: 400, lev: 40 },
  { name: "Lung", win: 1500, lev: -600 },
  { name: "Bone", win: 1800, lev: 400 },
  { name: "Brain", win: 80, lev: 40 },
  { name: "Abdomen", win: 350, lev: 50 },
];

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) {
    status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true);
    return;
  }
  status("loading KiTS case from the NCI Imaging Data Commons…");
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  const names = ["axial", "threeD", "coronal", "sagittal"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) {
    cv[n] = cvEl("c-" + n);
    cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext;
    cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  }

  // Load the series straight from S3, reconstruct + build the scene (grayscale MPR + 3D VR).
  const res = await loadSeries(DEMO, {
    onProgress: (p: { msg: string; frac?: number }) =>
      status(`${p.msg}${p.frac ? ` — ${Math.round(p.frac * 100)}%` : ""}`),
  });
  const sc: SegrouletteScene = buildSegrouletteScene(gpu, srgb, res.ct, res.seg);

  const off: Record<Plane, number> = {
    axial: slicerDefaultOffset01("axial", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    coronal: slicerDefaultOffset01("coronal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    sagittal: slicerDefaultOffset01("sagittal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
  };
  const sliceIx = new SliceInteractor({ ijkToRAS: sc.ijkToRAS, rasLo: sc.rasLo, rasHi: sc.rasHi });
  const camera = framedCamera(sc.center, sc.radius);
  const wl = { win: sc.win, lev: sc.lev };
  let bir: BirApi | null = null;
  let xhair: Crosshair4up | null = null;

  const drawSlice = (p: Plane) => {
    bir?.drawOverlay(p);
    if (!cv[p].width) return;
    sc.slice.setPlane(p, off[p]);
    sc.slice.renderToView(cx[p].getCurrentTexture().createView({ format: srgb }), cv[p].width, cv[p].height);
    updateReadout(p);
  };
  const draw3d = () => {
    if (!cv.threeD.width) return;
    sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, cv.threeD.width, cv.threeD.height);
    sc.scene.renderToView(cx.threeD.getCurrentTexture().createView({ format: srgb }), cv.threeD.width, cv.threeD.height);
  };
  const drawAll = () => {
    for (const p of PLANES) drawSlice(p);
    draw3d();
    xhair?.redraw();
  };
  const updateReadout = (p: Plane) => {
    const el = document.getElementById("sr-" + p);
    if (!el) return;
    const [lo, hi] = sliceIx.bounds(p);
    const sp = sliceIx.spacing(p);
    const mm = offset01ToMm(p, off[p], sc.rasLo, sc.rasHi);
    el.textContent = `${Math.round((mm - lo) / sp + 0.5)}/${Math.round((hi - lo) / sp)} · ${mm.toFixed(1)} mm`;
  };

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const n of names) {
      cv[n].width = Math.max(1, Math.round(cv[n].clientWidth * dpr));
      cv[n].height = Math.max(1, Math.round(cv[n].clientHeight * dpr));
    }
    bir?.resize();
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  for (const n of names) new ResizeObserver(() => resize()).observe(cv[n]);

  const viewGrid = attachViewGrid(document.getElementById("grid")!, [...names], resize);
  attachDoubleClick(cv.threeD, () => viewGrid.toggleMax("threeD"));

  const setWL = (win: number, lev: number) => {
    wl.win = win;
    wl.lev = lev;
    sc.slice.setWindowLevel(win, lev);
    for (const p of PLANES) drawSlice(p);
    xhair?.redraw();
    syncWl();
  };
  // Hidden preset <select> the BIR "Presets" button drives (mountBir wants a presetsEl).
  const presets = document.getElementById("wl-readout") as HTMLSelectElement;
  const syncWl = () => {
    presets.innerHTML = "";
    presets.add(new Option(`W ${Math.round(wl.win)} / L ${Math.round(wl.lev)}`, "current", true, true));
    presets.add(new Option(`Auto (${Math.round(sc.win)}/${Math.round(sc.lev)})`, "auto"));
    for (const q of CT_WL_PRESETS) presets.add(new Option(`${q.name} (${q.win}/${q.lev})`, q.name));
  };
  presets.addEventListener("change", () => {
    if (presets.value === "auto") setWL(sc.win, sc.lev);
    else {
      const q = CT_WL_PRESETS.find((x) => x.name === presets.value);
      if (q) setWL(q.win, q.lev);
    }
  });
  syncWl();

  const nAxisOf: Record<Plane, 0 | 1 | 2> = { axial: 2, coronal: 1, sagittal: 0 };
  const jumpAll = (ras: Vec3) => {
    for (const p of PLANES) {
      const a = nAxisOf[p];
      off[p] = Math.max(0, Math.min(1, (ras[a] - sc.rasLo[a]) / (sc.rasHi[a] - sc.rasLo[a])));
    }
    drawAll();
  };

  // The IHE Basic Image Review reader chrome (shared demos/bir.ts).
  const sliceControls: { resetView(): void }[] = [];
  bir = mountBir({
    overlay: document.getElementById("viewer")!,
    bar: document.getElementById("bir-bar")!,
    grid: document.getElementById("grid")!,
    planes: PLANES,
    canvases: cv,
    cellOf: (name) => document.querySelector(`[data-cell="${name}"]`),
    slice: () => sc.slice,
    off01: (p) => off[p],
    setOff01: (p, v) => (off[p] = Math.max(0, Math.min(1, v))),
    offsetMm: (p) => offset01ToMm(p, off[p], sc.rasLo, sc.rasHi),
    spacing: (p) => sliceIx.spacing(p),
    step: (p, fwd) => (off[p] = sliceIx.wheel(p, off[p], fwd)),
    redraw: (p) => {
      drawSlice(p);
      xhair?.redraw();
    },
    redrawAll: drawAll,
    rasLo: sc.rasLo,
    rasHi: sc.rasHi,
    wl: { get: () => [wl.win, wl.lev], set: setWL, auto: [sc.win, sc.lev] },
    presetsEl: presets,
    resetViews: () => sliceControls.forEach((c) => c.resetView()),
    close: () => status("This is the SlicerLive Basic Image Review demo — reload to restart."),
    jumpAll,
    modality: res.ct.modality,
  });
  (globalThis as Record<string, unknown>).__birDbg = {
    ready: () => !!bir,
    dims: () => sc.dims,
    tool: () => bir?.tool(),
    cellOrder: () => [...document.querySelectorAll("#grid .cell")].map((c) => (c as HTMLElement).dataset.cell),
  };

  for (const p of PLANES) {
    const hooks = bir.hooks(p);
    sliceControls.push(attachSliceControls(cv[p], {
      orient: p,
      getSlice: () => sc.slice,
      step: (fwd) => (off[p] = sliceIx.wheel(p, off[p], fwd)),
      redraw: () => {
        drawSlice(p);
        xhair?.redraw();
      },
      wl: {
        enabled: () => bir!.tool() === "wl",
        get: () => [wl.win, wl.lev],
        set: setWL,
        range: () => res.ct.range,
        reset: () => setWL(sc.win, sc.lev),
      },
      leftMode: () => bir!.leftMode(),
      hooks: {
        onLeftGrab: hooks.onLeftGrab,
        onDoubleClick: () => {
          viewGrid.toggleMax(p);
          return true;
        },
      },
    }));
  }
  attachCameraControls(cv.threeD, camera, { onChange: () => { draw3d(); xhair?.redraw(); } });

  xhair = mountCrosshair({
    cells: { axial: cv.axial, coronal: cv.coronal, sagittal: cv.sagittal, threeD: cv.threeD },
    getScene: () => sc.scene,
    getSlice: () => sc.slice,
    getCamera: () => camera,
    getOffset: (o) => off[o as Plane],
    onJump: jumpAll,
  });

  // SlicerLive badge popup: 3D volume-rendering + segmentation controls (NON-BIR), anchored
  // to the 3D cell — the SlicerLive-native version of the reader's "Live" controls.
  const controls: VizControl[] = [
    {
      label: "Volume render",
      getOpacity: () => sc.volumeOpacity(),
      setOpacity: (o) => {
        sc.setVolumeOpacity(o);
        draw3d();
        xhair?.redraw();
      },
      color: [0.75, 0.78, 0.85],
    },
    {
      label: "Segmentation",
      getOpacity: () => sc.segOpacity(),
      setOpacity: (o) => {
        sc.setSegOpacity(o);
        drawAll();
      },
      disabled: () => !sc.hasSeg,
      color: [0.62, 0.9, 1.0],
    },
  ];
  installChrome({
    controls,
    anchor: cv.threeD.parentElement ?? undefined,
    segments: {
      list: () => sc.segments.map((s) => ({ num: s.num, name: s.name, color: s.color })),
      get: (num) => sc.segmentOpacity(num),
      set: (num, o) => {
        sc.setSegmentOpacity(num, o);
        drawAll();
      },
      enabled: () => sc.hasSeg,
    },
  });

  const info = document.getElementById("info");
  if (info) info.textContent = `${DEMO.sd} · CT ${sc.dims.join("×")} · ${DEMO.lic}`;
  resize();
  status("KiTS abdomen CT — scroll to page slices, pick a tool from the toolbar, drag 3D to orbit");
}

main().catch((e) => status("error: " + ((e as Error)?.message ?? e), true));
