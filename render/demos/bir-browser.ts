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
import { attachWidgetControls } from "./widget-control.ts";
import type { Box, HandleMeta } from "./roi-widget.ts";
import { createMosaic } from "./mosaic.ts";
import { installChrome, type VizControl } from "./sl-chrome.ts";
import { loadSeries } from "../vendor/idc_tools/index.js";
import { type BirApi, mountBir, type Plane } from "./bir.ts";
import { downloadStudyWithDialog, type SeriesRef, shareStudy } from "./idc-share.ts";
import { CT_VR_PRESETS, presetLUT } from "../ct-vr-presets.ts";
import { openVrPresetMenu, type VrPresetItem } from "./vr-preset-menu.ts";
import type { Vec3 } from "../mat4.ts";

// The demo case: an arbitrary KiTS kidney-tumour study (IDC c4kc_kits · KiTS-00051) — the
// noncontrast CT (95 slices) WITH its DICOM SEG (kidney + tumour). Which case loads is
// resolved from the URL (see resolveSource) — a drop-in for OHIF on the IDC portal:
//   OHIF / IDC-portal form:  ?StudyInstanceUIDs=<uid>[&SeriesInstanceUIDs=<uid[,uid]>]
//   IHE IID form:            ?requestType=STUDY&studyUID=<uid>[&seriesUID=<uid>]
//   Fast direct-S3 form:     ?series=<crdc_uuid>&bucket=<b>[&seg=<uuid>&segBucket=<b>]
//   (no params → the default KiTS-00051 CT+SEG demo)
const P = new URLSearchParams(location.search);

interface Source {
  c: string; // CT/MR/PET series S3 prefix (crdc uuid)
  cb: string; // its bucket
  s?: string; // optional SEG series prefix
  sb?: string; // SEG bucket
  m: string; // modality
  col: string; // collection
  st: string; // StudyInstanceUID
  sd: string; // patient · series label
  lic: string; // license/attribution
}

const KITS_DEFAULT: Source = {
  c: "e3e86cde-da96-44b0-9e3b-b0b7bdd5a675",
  cb: "idc-open-data",
  s: "04a800eb-2f06-4e29-a10d-934a6f5c7d47",
  sb: "idc-open-data",
  m: "CT",
  col: "c4kc_kits",
  st: "1.3.6.1.4.1.14519.5.2.1.6919.4624.368281589441706814147998236429",
  sd: "KiTS-00051 · noncontrast abdomen + kidney/tumour SEG",
  lic: "CC BY 3.0 · IDC c4kc_kits · doi:10.7937/tcia.2019.ix49e8nx",
};

// OHIF/IID UID resolution uses a SLIM, radiology-only IDC index (built offline by
// build-idc-slim.ts) hosted in a CORS-enabled bucket. Two artifacts sit under IDC_INDEX_BASE:
//   idc-rad-groups.json  — tiny (~43 KB) directory: full min/max StudyInstanceUID per 2000-row
//                          group of the parquet, sorted by StudyInstanceUID.
//   idc-rad-slim.parquet — 617k radiology series (drops pathology/SR/etc.), sorted by study,
//                          columns trimmed to what resolution needs.
// A lookup fetches the sidecar ONCE (Cache Storage, then in-memory), binary-searches it for the
// 1–2 groups whose [min,max] span the study, and RANGE-reads only those groups (~0.6 MB) — the
// 51 MB parquet is never fully downloaded. Resolved studies are memoized in localStorage, so a
// repeat launch of the same study skips the index entirely ("hit the penalty once").
//
// The public full-index hosts (GCS mirror, GitHub release) send no CORS, so a cross-origin
// browser can't read them — hence the slim copy in a CORS bucket. Default base is same-origin
// ./idc-rad/ (drop the two files next to bir.html); point ?indexBase= / __IDC_INDEX_BASE at the
// js2 bucket for the deployed gallery.
const IDC_INDEX_BASE = ((globalThis as Record<string, unknown>).__IDC_INDEX_BASE as string) ||
  P.get("indexBase") || "https://js2.jetstream-cloud.org:8001/swift/v1/idc-index/";
const GROUPS_URL = new URL("idc-rad-groups.json", IDC_INDEX_BASE).href;
const PARQUET_URL = new URL("idc-rad-slim.parquet", IDC_INDEX_BASE).href;
const HYPARQUET_ESM = "https://cdn.jsdelivr.net/npm/hyparquet@1.28.2/+esm";
const splitList = (v: string | null): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

interface GroupDir { version: string; rowGroupSize: number; total: number; groups: { min: string; max: string }[] }
let _dirCache: GroupDir | null = null;

/** Fetch the slim-index group directory once (Cache Storage → in-memory memo). */
async function loadGroupDir(onStatus: (m: string) => void): Promise<GroupDir> {
  if (_dirCache) return _dirCache;
  onStatus("fetching the IDC index directory…");
  let resp: Response | undefined;
  try {
    // deno-lint-ignore no-explicit-any
    const cache = (globalThis as any).caches ? await (globalThis as any).caches.open("idc-rad") : null;
    if (cache) resp = await cache.match(GROUPS_URL);
    if (!resp) {
      resp = await fetch(GROUPS_URL);
      if (resp.ok && cache) await cache.put(GROUPS_URL, resp.clone());
    }
  } catch {
    resp = await fetch(GROUPS_URL);
  }
  if (!resp || !resp.ok) throw new Error(`index directory not reachable at ${GROUPS_URL} (HTTP ${resp?.status ?? "?"})`);
  _dirCache = await resp.json() as GroupDir;
  return _dirCache;
}

const SLIM_COLS = [
  "StudyInstanceUID", "SeriesInstanceUID", "crdc_series_uuid", "aws_bucket", "Modality",
  "instanceCount", "SeriesDescription", "PatientID", "collection_id", "license_short_name", "source_DOI",
];

/** Range-read every series row of a study from the slim index: find the 1–2 sorted row groups
 *  whose [min,max] span the study and read only those (~0.6 MB), never the whole parquet. */
// deno-lint-ignore no-explicit-any
async function readStudyRows(studyUID: string, onStatus: (m: string) => void): Promise<any[]> {
  const dir = await loadGroupDir(onStatus);
  const RGS = dir.rowGroupSize;
  const spans: [number, number][] = [];
  for (let i = 0; i < dir.groups.length; i++) {
    const g = dir.groups[i];
    if (studyUID >= g.min && studyUID <= g.max) spans.push([i * RGS, Math.min((i + 1) * RGS, dir.total)]);
  }
  if (!spans.length) {
    throw new Error(
      `StudyInstanceUID not found in the slim IDC index (${dir.version}): ${studyUID}. ` +
        `It may be a non-radiology study, or from a newer index. The direct form always works: ` +
        `?series=<crdc_series_uuid>&bucket=idc-open-data.`,
    );
  }
  onStatus(`range-reading the IDC index (${spans.length} group${spans.length > 1 ? "s" : ""})…`);
  try {
    // deno-lint-ignore no-explicit-any
    const hp: any = await import(HYPARQUET_ESM);
    const file = await hp.asyncBufferFromUrl({ url: PARQUET_URL });
    const metadata = await hp.parquetMetadataAsync(file); // footer once, reused per group
    const parts = await Promise.all(
      spans.map(([rowStart, rowEnd]) => hp.parquetReadObjects({ file, metadata, columns: SLIM_COLS, rowStart, rowEnd })),
    );
    const rows = parts.flat().filter((r: { StudyInstanceUID: string }) => r.StudyInstanceUID === studyUID);
    if (!rows.length) throw new Error(`StudyInstanceUID not found in the IDC index: ${studyUID}`);
    return rows;
  } catch (e) {
    if ((e as Error).message.includes("not found")) throw e;
    throw new Error(
      `couldn't range-read the slim IDC index at ${PARQUET_URL} — check the CORS bucket (?indexBase=). ` +
        `Meanwhile the direct form works: ?series=<crdc_series_uuid>&bucket=idc-open-data. (${(e as Error).message})`,
    );
  }
}

/** Decide which series to load from the URL: fast direct-S3, OHIF/IID UID (index lookup), or default. */
async function resolveSource(onStatus: (m: string) => void): Promise<Source> {
  const series = P.get("series");
  if (series) { // direct S3 prefix — no index needed
    return {
      c: series, cb: P.get("bucket") || "idc-open-data",
      s: P.get("seg") || undefined, sb: P.get("segBucket") || "idc-open-data",
      m: (P.get("modality") || "CT").toUpperCase(), col: P.get("collection") || "IDC", st: "",
      sd: `${P.get("patient") || "IDC"} · ${series.slice(0, 8)}…`, lic: "NCI Imaging Data Commons",
    };
  }
  const studyUIDs = [...splitList(P.get("StudyInstanceUIDs")), ...splitList(P.get("studyUID"))];
  if (studyUIDs.length) {
    const want = [
      ...splitList(P.get("SeriesInstanceUIDs")),
      ...splitList(P.get("initialSeriesInstanceUID")),
      ...splitList(P.get("seriesUID")),
    ];
    return await resolveFromIndex(studyUIDs[0], want, onStatus);
  }
  return KITS_DEFAULT;
}

/** Resolve a StudyInstanceUID (+ optional SeriesInstanceUIDs) to an S3 image series (+ SEG)
 *  via the SLIM idc-index — the OHIF/IDC-portal drop-in path. Reads only the 1–2 sorted row
 *  groups whose [min,max] span the study (~0.6 MB), never the whole parquet. */
async function resolveFromIndex(
  studyUID: string,
  wantSeries: string[],
  onStatus: (m: string) => void,
): Promise<Source> {
  const memoKey = `idc-rad:${studyUID}:${wantSeries.join(",")}`;
  try {
    const hit = localStorage.getItem(memoKey);
    if (hit) return JSON.parse(hit) as Source;
  } catch { /* private mode / no storage */ }

  const inStudy = await readStudyRows(studyUID, onStatus);
  const want = new Set(wantSeries);
  const IMG = new Set(["CT", "MR", "PT", "PET", "NM"]);
  const imgs = inStudy.filter((r) => IMG.has(String(r.Modality).toUpperCase()));
  const segs = inStudy.filter((r) => String(r.Modality).toUpperCase() === "SEG");
  // Prefer an explicitly-requested image series; else the largest (primary) one.
  const chosen = imgs.find((r) => want.has(r.SeriesInstanceUID)) ??
    imgs.slice().sort((a, b) => Number(b.instanceCount) - Number(a.instanceCount))[0];
  if (!chosen) throw new Error("no CT/MR/PET/NM image series found in this study");
  // If a SEG was explicitly requested, honour it; else pick one whose SEG references the chosen
  // image (best-effort: just take the first SEG in the study).
  const seg = segs.find((r) => want.has(r.SeriesInstanceUID)) ?? segs[0];
  const mod = String(chosen.Modality).toUpperCase();
  const src: Source = {
    c: String(chosen.crdc_series_uuid), cb: String(chosen.aws_bucket),
    s: seg ? String(seg.crdc_series_uuid) : undefined, sb: seg ? String(seg.aws_bucket) : undefined,
    m: mod === "PET" ? "PT" : mod, col: String(chosen.collection_id), st: studyUID,
    sd: `${chosen.PatientID} · ${chosen.SeriesDescription || mod}`,
    lic: `${chosen.license_short_name || "IDC"} · ${chosen.collection_id}${chosen.source_DOI ? " · doi:" + chosen.source_DOI : ""}`,
  };
  try { localStorage.setItem(memoKey, JSON.stringify(src)); } catch { /* ignore */ }
  return src;
}

const status = (msg: string, err = false) => {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = msg;
    el.style.color = err ? "#ff6b74" : "#9fb3d0";
  }
};
const cvEl = (id: string) => document.getElementById(id) as HTMLCanvasElement;

const PLANES: Plane[] = ["axial", "coronal", "sagittal"];
const SEG_FILL = 0.5; // 2D MPR segmentation-overlay alpha at 100% (buildSegrouletteScene default)
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

  // Download-progress mosaic (the SEGRoulette loading visual): the series' slice thumbnails
  // tile in as the DICOM streams from S3 — informative + a little fun instead of a blank wait.
  const mosaic = createMosaic(document.getElementById("viewer")!);
  mosaic.status("contacting the NCI Imaging Data Commons…");

  // Which case? Resolve the URL — OHIF/IID StudyInstanceUID (via the IDC index), direct S3
  // prefix, or the default demo. This is what makes it a drop-in for OHIF on the IDC portal.
  const setLoad = (m: string) => {
    status(m);
    mosaic.status(m);
  };
  const source = await resolveSource(setLoad);

  // Load the series straight from S3, reconstruct + build the scene (grayscale MPR + 3D VR).
  const res = await loadSeries(source, {
    onProgress: (p: { msg: string; frac?: number }) => {
      setLoad(`${p.msg}${p.frac ? ` — ${Math.round(p.frac * 100)}%` : ""}`);
    },
    onSliceCount: (n: number) => mosaic.setCount(n),
    onThumb: (n: number, w: number, h: number, rgba: ArrayBuffer) => mosaic.thumb(n, w, h, rgba),
  });
  const sc: SegrouletteScene = buildSegrouletteScene(gpu, srgb, res.ct, res.seg);
  sc.setVolumeOpacity(0.5); // 3D volume rendering starts semi-transparent (composites with SEG)

  // SlicerLive display state (toggled from the badge popup, below).
  let sliceOutline = false; // segmentation overlay: fill (default) vs outline
  let roiEnabled = false, roiVisible = false, roiFirstEnable = true; // 3D volume-render crop box
  let annOn = true; // DICOM corner annotations (IHE BIR §4.16.4.2.2.5.8 "official radiology look")

  // ---- corner annotations (IHE BIR §4.16.4.2.2.5.8) ---------------------------------------
  // The profile mandates overlaid corner text: patient identity (TL), institution/study (TR),
  // series/technique (BR); the slice position/number sits bottom-left with the readout. IDC
  // public data is de-identified, so we show what's present (ID, collection, modality, series,
  // geometry, live W/L). Sourced from the loaded metadata — real deployments read full tags.
  const annEls: Record<string, { br: HTMLElement }> = {};
  const buildAnnotations = () => {
    for (const p of PLANES) {
      const cell = document.querySelector(`[data-cell="${p}"]`) as HTMLElement;
      if (!cell) continue;
      const mk = (cls: string, html: string) => {
        const e = document.createElement("div");
        e.className = "ann " + cls;
        e.innerHTML = html;
        e.style.cssText = "position:absolute;z-index:2;font:600 10px ui-monospace,Menlo,monospace;" +
          "color:#cfe0f5;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;line-height:1.35;max-width:46%;" +
          (cls === "tl" ? "top:22px;left:7px;" : cls === "tr" ? "top:22px;right:7px;text-align:right;" : "bottom:22px;right:7px;text-align:right;");
        cell.appendChild(e);
        return e;
      };
      const pid = (source.sd.split("·")[0] || "").trim() || source.col;
      mk("tl", `${pid}<br>${source.col} · ${res.ct.modality}`);
      mk("tr", `${res.ct.modality} · ${sc.dims[2]} slices${sc.hasSeg ? " · SEG" : ""}<br>${sc.dims[0]}×${sc.dims[1]}`);
      annEls[p] = { br: mk("br", "") };
    }
    updateAnnWL();
  };
  const updateAnnWL = () => {
    for (const p of PLANES) {
      if (annEls[p]) annEls[p].br.innerHTML = `W ${Math.round(wl.win)} / L ${Math.round(wl.lev)}`;
    }
  };
  const applyAnn = () => {
    for (const e of document.querySelectorAll(".ann")) (e as HTMLElement).style.display = annOn ? "" : "none";
  };

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
    updateAnnWL(); // live W/L in the corner annotation
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
  // Whole-study download: re-read the study's every (radiology) series from the slim index. Only
  // available when we came in by StudyInstanceUID; the direct-S3 path downloads the loaded pair.
  const listAllStudySeries = source.st
    ? async (): Promise<SeriesRef[]> => {
      const rows = await readStudyRows(source.st, () => {});
      return rows.map((r) => ({
        prefix: String(r.crdc_series_uuid),
        bucket: String(r.aws_bucket),
        modality: String(r.Modality).toUpperCase(),
        seriesUID: String(r.SeriesInstanceUID),
        seriesDescription: r.SeriesDescription ? String(r.SeriesDescription) : undefined,
      }));
    }
    : undefined;

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
    extraTools: [
      {
        id: "idc-share",
        icon: "share",
        title: "Share — copy a link that reopens this study here (or in the IDC OHIF portal)",
        run: () => shareStudy(source),
      },
      {
        id: "idc-download",
        icon: "download",
        title: "Download this study's DICOM to a local folder (streamed, parallel)",
        run: () => downloadStudyWithDialog(source, listAllStudySeries),
      },
    ],
  });
  (globalThis as Record<string, unknown>).__birDbg = {
    ready: () => !!bir,
    dims: () => sc.dims,
    tool: () => bir?.tool(),
    cellOrder: () => [...document.querySelectorAll("#grid .cell")].map((c) => (c as HTMLElement).dataset.cell),
    // test hooks
    setRoi: (en: boolean, vis: boolean) => {
      roiEnabled = en;
      roiVisible = vis;
      if (en) roiFirstEnable = false;
      sc.setRoiEnabled(en);
      sc.setRoiVisible(vis);
      draw3d();
    },
    roiState: () => ({ visible: sc.roiVisible(), handles: sc.roi.handleList().length }),
    setSegOpacity: (o: number) => {
      sc.setSegOpacity(o);
      sc.slice.setOverlayOpacity(o * SEG_FILL);
      drawAll();
    },
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

  // 3D ROI-crop widget: grab a face/corner/centre handle to resize/move the crop box; the
  // cursor changes over a handle while the box is visible. Capture-phase, so grabbing a
  // handle doesn't reach the camera; empty space bubbles through to orbit.
  let roiBox0: Box | null = null;
  attachWidgetControls(cv.threeD, camera, {
    getHandles: () =>
      sc.roiVisible()
        ? sc.roi.handleList().map((h) => ({ id: h.id, world: h.world, data: h.data, cursor: h.cursor }))
        : [],
    getSize: () => ({ w: cv.threeD.width, h: cv.threeD.height }),
    onDragStart: () => {
      roiBox0 = sc.roi.snapshot();
    },
    onDrag: (h, world) => {
      if (!roiBox0) return;
      const d: Vec3 = [world[0] - h.world[0], world[1] - h.world[1], world[2] - h.world[2]];
      sc.roi.applyDrag(h.data as HandleMeta, roiBox0, d);
      sc.reclip(); // re-crop + upload box/handle/clip in one syncUniforms
      draw3d();
      xhair?.redraw();
    },
    onHover: (h) => {
      sc.roi.setHover(h ? h.id : null);
      sc.scene.syncUniforms();
      draw3d();
    },
    onChange: () => draw3d(),
  });

  xhair = mountCrosshair({
    cells: { axial: cv.axial, coronal: cv.coronal, sagittal: cv.sagittal, threeD: cv.threeD },
    getScene: () => sc.scene,
    getSlice: () => sc.slice,
    getCamera: () => camera,
    getOffset: (o) => off[o as Plane],
    onJump: jumpAll,
  });

  // ---- 3D volume-rendering preset + shift (Slicer/OHIF CT presets) ------------------------
  // vrPreset = active preset id (null = grayscale W/L VR). vrShift = Slicer's VR "Shift" (offset
  // the whole transfer function along the scalar axis). Shift range derives from the actual data
  // range (sampled), like Slicer's shift slider spanning the scalar range.
  let vrPreset: string | null = null;
  let vrShift = 0;
  const vd = res.ct.vol;
  let vmin = Infinity, vmax = -Infinity;
  const vstride = Math.max(1, Math.floor(vd.length / 2_000_000));
  for (let i = 0; i < vd.length; i += vstride) { const v = vd[i]; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
  const shiftRange = Math.max(200, (vmax - vmin) / 2);
  const bakeOf = (name: string | null) => name ? presetLUT(CT_VR_PRESETS.find((p) => p.name === name)!) : null;
  const presetLabel = () => vrPreset ? (CT_VR_PRESETS.find((p) => p.name === vrPreset)?.label ?? vrPreset) : "Default (W/L)";
  const applyVrPreset = (name: string | null) => {
    vrPreset = name;
    sc.setVolumePreset(bakeOf(name));
    if (sc.volumeOpacity() <= 0) sc.setVolumeOpacity(1); // reveal the VR so the preset is visible
    draw3d();
    xhair?.redraw();
  };
  const applyVrShift = (hu: number) => { vrShift = hu; sc.setVolumeShift(hu); draw3d(); xhair?.redraw(); };

  // On-the-fly thumbnails: render THIS volume at the CURRENT camera with each preset into a small
  // WebGPU canvas. Full opacity, no shift, segmentation hidden for a clean preview; live state is
  // restored afterward.
  const renderPresetThumbnails = (): VrPresetItem[] => {
    const THUMB = 116;
    const savedOp = sc.volumeOpacity(), savedShift = sc.volumeShift(), savedSeg = sc.segOpacity();
    sc.setVolumeShift(0);
    if (savedSeg > 0) sc.setSegOpacity(0);
    if (savedOp < 1) sc.setVolumeOpacity(1);
    const entries: { name: string | null; label: string }[] = [
      { name: null, label: "Default (W/L)" },
      ...CT_VR_PRESETS.map((p) => ({ name: p.name, label: p.label })),
    ];
    const items: VrPresetItem[] = [];
    for (const e of entries) {
      const c = document.createElement("canvas");
      c.width = THUMB; c.height = THUMB;
      const cxt = c.getContext("webgpu") as GPUCanvasContext;
      cxt.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
      sc.setVolumePreset(bakeOf(e.name));
      sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, THUMB, THUMB);
      sc.scene.renderToView(cxt.getCurrentTexture().createView({ format: srgb }), THUMB, THUMB);
      items.push({ name: e.name, label: e.label, canvas: c });
    }
    // restore live VR state
    sc.setVolumePreset(bakeOf(vrPreset));
    sc.setVolumeShift(savedShift);
    if (savedSeg > 0) sc.setSegOpacity(savedSeg);
    if (savedOp < 1) sc.setVolumeOpacity(savedOp);
    draw3d();
    return items;
  };
  Object.assign((globalThis as Record<string, unknown>).__birDbg as object, {
    presets: () => CT_VR_PRESETS.map((p) => p.name),
    setPreset: (name: string | null) => applyVrPreset(name),
    setShift: (hu: number) => applyVrShift(hu),
    vrState: () => ({ preset: vrPreset, shift: vrShift, shiftRange, dataRange: [vmin, vmax] }),
    thumbCount: () => renderPresetThumbnails().length,
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
    // Slicer's VR "Shift" — a plain slider directly below the opacity control.
    {
      label: "Shift",
      slider: {
        min: -shiftRange,
        max: shiftRange,
        step: Math.max(1, Math.round(shiftRange / 200)),
        get: () => vrShift,
        set: (v) => applyVrShift(v),
        format: (v) => (v > 0 ? "+" : "") + Math.round(v),
      },
      disabled: () => sc.volumeOpacity() <= 0,
    },
    // Volume-rendering preset — opens the on-the-fly thumbnail menu (Slicer/OHIF CT presets).
    {
      label: "Preset",
      button: { text: () => presetLabel(), run: () => openVrPresetMenu({ items: renderPresetThumbnails(), current: vrPreset, onPick: applyVrPreset }) },
    },
    {
      label: "Segmentation",
      getOpacity: () => sc.segOpacity(),
      setOpacity: (o) => {
        sc.setSegOpacity(o); // 3D surface global opacity
        sc.slice.setOverlayOpacity(o * SEG_FILL); // AND the 2D MPR overlay (fill/outline)
        drawAll();
      },
      disabled: () => !sc.hasSeg,
      color: [0.62, 0.9, 1.0],
    },
    // Segmentation overlay: fill (default) vs outline on the MPR planes.
    {
      label: "Segmentation outline",
      get: () => sliceOutline,
      set: (on) => {
        sliceOutline = on;
        sc.slice.setOverlayOutline(on);
        for (const p of PLANES) drawSlice(p);
        xhair?.redraw();
      },
      disabled: () => !sc.hasSeg,
    },
    // 3D volume-render crop: enabling it reveals the ROI box the first time (Slicer behaviour).
    {
      label: "Crop volume (3D)",
      get: () => roiEnabled,
      set: (on) => {
        roiEnabled = on;
        if (on && roiFirstEnable) {
          roiVisible = true;
          roiFirstEnable = false;
        }
        sc.setRoiEnabled(roiEnabled);
        sc.setRoiVisible(roiVisible);
        draw3d();
        xhair?.redraw();
      },
      disabled: () => sc.volumeOpacity() <= 0,
    },
    {
      label: "Show ROI box",
      get: () => roiVisible,
      set: (on) => {
        roiVisible = on;
        sc.setRoiVisible(on);
        draw3d();
        xhair?.redraw();
      },
    },
    // DICOM corner annotations (IHE BIR) — the "official radiology look".
    {
      label: "Corner annotations",
      get: () => annOn,
      set: (on) => {
        annOn = on;
        applyAnn();
      },
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

  buildAnnotations();
  applyAnn();
  const info = document.getElementById("info");
  if (info) info.textContent = `${source.sd} · ${res.ct.modality} ${sc.dims.join("×")} · ${source.lic}`;
  resize();
  mosaic.done(); // scene is up → fade the download mosaic out
  status("KiTS abdomen CT — scroll to page slices, pick a tool from the toolbar, drag 3D to orbit");
}

main().catch((e) => status("error: " + ((e as Error)?.message ?? e), true));
