// Browser entry for the SlicerLive livecodec demo: a side-by-side DOWNLOAD-SPEED RACE
// between "LiveCodec neural" (FSQ latents + a ~0.8 MB WGSL-decoded model) and HTJ2K
// (OpenJPH wasm) on one CT scan. Two codec rows × (axial / sagittal / coronal / 3D)
// with real per-row progress bars; both pipelines start fetching simultaneously on load.
//   Neural: coarse.gz (~100 KB) → decode with zf=0 → FIRST IMAGE in seconds, then
//           fine.gz + dc.gz stream in the background and refine chunk by chunk.
//           Decoding runs on hand-written WebGPU compute kernels (wgpu-net.js, the
//           nnLive executor adapted for Decoder25D) on the SAME device as the
//           renderer — no ONNX Runtime. f16 kernels, f32 fallback without shader-f16.
//   HTJ2K:  slices.bin streams. Res-progressive layout (round 0 = every slice's
//           lowest-res tile-part): a whole-volume 16px preview appears from the
//           first ~1% of the stream and sharpens round by round to lossless
//           (decodeSubResolution on truncated codestreams). Legacy flat layout:
//           every completed slice decodes at full res, updating every ~32 slices.
//   ?scan=<id>   (defaults to a random scan; the button picks another at random)
//   ?ver=<tag>   pick a training-effort checkpoint (versioned bucket layout:
//                versions/<tag>/… for neural data + decoder, ood/<id>/ for the
//                shared HTJ2K arm). Omitted/unknown → legacy baseline layout.
//   ?model=<url-base>  override the decoder graph/weights location (local testing)
//   ?data=<url-base>   override the per-scan data location (local testing)
//   ?bucket=<url-base> override the whole data bucket (local mocks / portability)
// Bundled to live/webgpu/livecodec.js; the CDN <script> tag in livecodec.html supplies
// the openjph `Module` factory.
import { initDevice } from "../../render/device.ts";
import { makeRunner, Net } from "./wgpu-net.js";
import { slicerDefaultOffset01, type Orientation } from "../../render/slice-renderer.ts";
import { SliceInteractor } from "../../render/slice-interactor.ts";
import { attachSliceControls } from "../../render/demos/slice-control.ts";
import { attachCameraControls, framedCamera } from "../../render/demos/camera-control.ts";
import { makeSnapshotViewer } from "./livecodec-compare.ts";
import { decodeFineStage, dequantFineFloat, type StageIndex } from "./livecodec-range.ts";
import { attachDoubleClick } from "../../render/demos/view-grid.ts";
import { installChrome } from "../../render/demos/sl-chrome.ts";
import {
  applyDcCorrection, BandwidthMeter, BUCKET, byteChunks, cacheSize, dequantCoarseNative,
  dequantCoarseUp, dequantFine, gunzip, latentShapes,
  LinkPacer, loadDecoderMeta, loadOodScans, loadScanMeta, loadScans, loadVersions,
  makeLiveCodecScene, mapOutputToHU, type ResProgressiveIndex, type RowKey, type ScanEntry,
  prefetch, setSimulatedBandwidth, type SliceIndexEntry, streamFetch, type VersionEntry,
} from "./livecodec-scene.ts";

// ── CDN globals (declared, not bundled) ──────────────────────────────────────
interface OpenJphDecoder {
  getEncodedBuffer(len: number): Uint8Array;
  getDecodedBuffer(): Uint8Array;
  decode(): void;
  /** Decode skipping `level` resolution levels: a truncated codestream holding
   *  rounds 0..k of R decodes at level R-1-k → a (W>>level)×(H>>level) image.
   *  NOTE: getFrameInfo() still reports the FULL dims — size the output from
   *  getDecodedBuffer().length instead. */
  decodeSubResolution(level: number): void;
}
type OpenJphModule = { HTJ2KDecoder: new () => OpenJphDecoder };

const ORIENTS = ["axial", "sagittal", "coronal"] as const;
const PARAMS = new URLSearchParams(location.search);

const el = (id: string) => document.getElementById(id) as HTMLElement;
const status = (msg: string, err = false) => {
  const s = el("status");
  if (s) { s.textContent = msg; s.style.color = err ? "#ff6b74" : "#9fb3d0"; }
};
const fmtBytes = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const fmtMB = (b: number) => (b / 1e6).toFixed(b >= 1e6 ? 1 : 2);

// ── per-row race state (drives the bars + timers) ────────────────────────────
interface RaceState {
  t0: number;
  stage: string;                // "coarse" | "fine+dc" | "slices" | …
  note: string;                 // e.g. "decode 3/5"
  got: number;                  // bytes received in the CURRENT stage
  expected: number;             // bytes expected for the CURRENT stage
  tFirst: number | null;        // s, time to first image
  tFinal: number | null;        // s, time to final state (freezes the clock)
  error: string | null;
}
const race: Record<RowKey, RaceState> = {
  neural: { t0: 0, stage: "waiting", note: "", got: 0, expected: 0, tFirst: null, tFinal: null, error: null },
  htj2k: { t0: 0, stage: "waiting", note: "", got: 0, expected: 0, tFirst: null, tFinal: null, error: null },
};
const elapsed = (k: RowKey) => (performance.now() - race[k].t0) / 1000;
/** Decoder start-up charged to each arm: neural = weights download + WGSL
 *  pipeline build; htj2k = wasm fetch + instantiate + decoder construct. Both
 *  are costs a real user pays before seeing anything. */
const spinup: Record<RowKey, number> = { neural: 0, htj2k: 0 };

function updateBars() {
  for (const k of ["neural", "htj2k"] as RowKey[]) {
    const r = race[k];
    const fill = el(`fill-${k}`), ptext = el(`ptext-${k}`), times = el(`times-${k}`);
    if (!fill || !ptext || !times) continue;
    if (r.error) {
      fill.style.width = "100%";
      fill.className = "fill err";
      ptext.textContent = r.error;
      continue;
    }
    const frac = r.tFinal != null ? 1 : r.expected > 0 ? Math.min(1, r.got / r.expected) : 0;
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    fill.className = "fill" + (r.tFinal != null ? " done" : "");
    const t = r.tFinal ?? (r.t0 ? elapsed(k) : 0);
    ptext.textContent = r.t0 === 0
      ? "waiting…"
      : `${r.stage} · ${fmtMB(r.got)} / ${fmtMB(r.expected)} MB · ${t.toFixed(1)} s${r.note ? ` · ${r.note}` : ""}`;
    times.textContent =
      (r.tFirst != null ? `first ${r.tFirst.toFixed(1)} s` : "") +
      (r.tFinal != null ? ` · final ${r.tFinal.toFixed(1)} s` : "");
  }
}

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) {
    status("WebGPU not available — try Chrome/Edge 113+ or Safari 18+.", true);
    return;
  }
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;

  status("loading scan list…");
  // ── encoding version: versions.json lists training-effort checkpoints. Absent
  // or empty → legacy baseline layout only (the selector stays hidden). An
  // unknown ?ver tag also falls back to the baseline.
  const versions: VersionEntry[] = await loadVersions();
  const version = versions.find((v) => v.tag === (PARAMS.get("ver") ?? "")) ?? null;
  // active dataset: legacy scans.json for the baseline, the fixed OOD set otherwise
  const scans = version ? await loadOodScans() : await loadScans();
  const wanted = PARAMS.get("scan") ?? "";
  const scan: ScanEntry = scans.find((s) => s.id === wanted) ?? scans[Math.floor(Math.random() * scans.length)];

  // ── resolved data locations (computed once; ?data= / ?model= still override):
  //   neuralBase — coarse/fine/dc/residual* + meta.json (per-checkpoint when versioned)
  //   htj2kBase  — slices.bin + index.json (shared ood/<id>/ arm when versioned)
  //   modelBase  — decoder graph/weights/dequant constants (per-checkpoint when versioned)
  const norm = (u: string) => u.endsWith("/") ? u : u + "/";
  const dataOverride = PARAMS.get("data");   // ?data=<url-base> for local stream testing
  const neuralBase = dataOverride ? norm(dataOverride)
    : version ? `${BUCKET}versions/${version.tag}/${scan.id}/`
    : `${BUCKET}scans/${scan.id}/`;
  const htj2kBase = dataOverride ? norm(dataOverride)
    : version ? `${BUCKET}ood/${scan.id}/`
    : `${BUCKET}scans/${scan.id}/`;
  const modelOverride = PARAMS.get("model");
  const modelBase = modelOverride ? norm(modelOverride)
    : version ? `${BUCKET}versions/${version.tag}/model/`
    : BUCKET + "model/";
  const [Z, Y, X] = scan.shape;

  el("info").textContent =
    `scan ${scan.id}${scan.heldout ? " (held-out)" : ""}${scan.source ? ` · ${scan.source}` : ""}` +
    `${version ? ` · ${version.tag}` : ""} · ${Z}×${Y}×${X} @ ${scan.spacing.map((s) => s.toFixed(2)).join("/")} mm · raw ${fmtBytes(scan.bytes.raw)}`;
  (el("rand") as HTMLButtonElement).addEventListener("click", () => {
    const others = scans.filter((s) => s.id !== scan.id);
    const pick = others[Math.floor(Math.random() * others.length)] ?? scan;
    const p = new URLSearchParams(location.search);
    p.set("scan", pick.id);                 // a scan switch rebuilds everything — clean reload
    location.search = p.toString();         // (?ver / ?net ride along untouched)
  });

  // ── header selectors: encoding version + scan. Both follow the net-select
  // pattern — a change updates the URL params and reloads; ?ver, ?scan and ?net
  // all survive any selector change (view persistence is keyed by scan id and
  // rides along independently via sessionStorage).
  const verSel = el("ver") as HTMLSelectElement | null;
  if (verSel && versions.length > 0) {
    const wrap = el("verwrap");
    if (wrap) wrap.style.display = "";
    const fmtSteps = (s: number) => s >= 1000 ? `${Math.round(s / 1000)}k` : String(s);
    const fmtParams = (p: number | string) =>
      typeof p === "number" ? (p >= 1e6 ? `${(p / 1e6).toFixed(1)}M` : `${Math.round(p / 1e3)}k`) : p;
    verSel.add(new Option("v3 · 31 vols (baseline)", ""));
    for (const v of versions) {
      // Mark which checkpoints ship the progressive fine tier: it is the whole
      // difference in how the race behaves, and is otherwise invisible until
      // you watch the bars.
      const prog = v.staged ? " · progressive" : "";
      verSel.add(new Option(
        `${v.tag} · ${fmtSteps(v.steps)} steps · ${fmtParams(v.params)}${prog}`, v.tag));
    }
    verSel.value = version?.tag ?? "";
    verSel.addEventListener("change", () => {
      const p = new URLSearchParams(location.search);
      if (verSel.value) p.set("ver", verSel.value);
      else p.delete("ver");
      p.set("scan", scan.id);               // same scan across checkpoints when possible;
      location.search = p.toString();       // baseline↔versioned falls back to random (different sets)
    });
  }
  const scanSel = el("scan") as HTMLSelectElement | null;
  if (scanSel) {
    for (const s of scans) {
      const hint = s.heldout ? " (held-out)" : s.source ? ` (${s.source})` : "";
      scanSel.add(new Option(`${s.id.slice(0, 8)} · ${s.shape.join("×")}${hint}`, s.id));
    }
    scanSel.value = scan.id;
    scanSel.addEventListener("change", () => {
      const p = new URLSearchParams(location.search);
      p.set("scan", scanSel.value);
      location.search = p.toString();
    });
  }

  // ── simulated network: each row gets its own link at the selected speed, so
  // the race compares codec+decode strategy under identical delivery conditions
  // (as each method would perform if used alone on that network).
  const netSel = el("net") as HTMLSelectElement;
  const netParam = PARAMS.get("net") ?? netSel?.value ?? "25";
  if (netSel) {
    netSel.value = netParam;
    netSel.addEventListener("change", () => {
      const p = new URLSearchParams(location.search);
      p.set("net", netSel.value);
      p.set("scan", scan.id);               // re-race the SAME scan at the new speed
      location.search = p.toString();
    });
  }
  const raceMode = PARAMS.get("mode") ?? "fair";
  const modeSel = el("mode") as HTMLSelectElement | null;
  if (modeSel) {
    modeSel.value = raceMode;
    modeSel.addEventListener("change", () => {
      const p = new URLSearchParams(location.search);
      p.set("mode", modeSel.value);
      p.set("scan", scan.id);
      location.search = p.toString();
    });
  }
  setSimulatedBandwidth(netParam === "off" ? null : Number(netParam) * 1e6);
  const pacers = { neural: new LinkPacer(), htj2k: new LinkPacer() };
  const meters = { neural: new BandwidthMeter(), htj2k: new BandwidthMeter() };

  // ── evolution recorder ────────────────────────────────────────────────────
  // A handful of log-spaced budgets was too coarse to see anything develop, and
  // it snapped at whatever byte count a decode step happened to land on, so the
  // two arms were never really matched. Instead sample on a fixed 60 Hz clock
  // and keep the planes UNCOMPRESSED, so scrubbing is a memory read rather than
  // a PNG decode.
  //
  // 60 Hz is affordable only because frames are deduplicated: the decoders
  // change the volume a few hundred times across a race, so most ticks are
  // identical to the one before and store a shared reference instead of a copy.
  // Memory therefore tracks the number of real visual updates, not the frame
  // rate, and the timeline stays uniform in time for smooth scrubbing.
  const FPS = 60;
  const MAX_DISTINCT = 320;         // per arm; beyond this older frames are thinned
  interface Planes { ax: Int16Array; co: Int16Array; sa: Int16Array }
  interface Frame { ms: number; bytes: number; gen: number; p: Planes }
  const frames: Record<RowKey, Frame[]> = { neural: [], htj2k: [] };
  const gen: Record<RowKey, number> = { neural: 0, htj2k: 0 };
  let distinctBytes = 0;

  /** Mark the row's volume as changed. Called wherever pixels actually move —
   *  per decoded slice, not per flush, so the residual's slow reveal is
   *  recorded rather than quantised to 32-slice steps. */
  const touch = (key: RowKey) => { gen[key]++; };

  function planeBytes(): number {
    const [Z, Y, X] = sc.shape;
    return (Y * X + Z * X + Z * Y) * 2;
  }

  /** Halve the resolution of the stored timeline when it grows too large,
   *  keeping the full span rather than truncating one end of the race. */
  function thin(key: RowKey): void {
    const f = frames[key];
    const seen = new Set<number>();
    const keep: Frame[] = [];
    for (let i = 0; i < f.length; i++) {
      if (f[i].gen !== f[i - 1]?.gen && (seen.size % 2 === 0 || i === f.length - 1)) keep.push(f[i]);
      else if (f[i].gen === f[i - 1]?.gen) keep.push({ ...f[i], p: keep[keep.length - 1]?.p ?? f[i].p });
      seen.add(f[i].gen);
    }
    frames[key] = keep;
  }

  function recorder(key: RowKey): { stop: () => void } {
    let lastGen = -1;
    let last: Planes | null = null;
    let distinct = 0;
    const tick = () => {
      const bytes = meters[key].summary().bytes;
      const ms = performance.now() - race[key].t0;
      if (gen[key] !== lastGen || last == null) {
        const [Z, Y, X] = sc.shape;
        last = capturePlanes(sc.rows[key].vol, Z, Y, X);
        lastGen = gen[key];
        distinct++;
        distinctBytes += planeBytes();
        if (distinct > MAX_DISTINCT) { thin(key); distinct = Math.ceil(distinct / 2); }
      }
      frames[key].push({ ms, bytes, gen: lastGen, p: last });
    };
    tick();
    const id = setInterval(tick, 1000 / FPS);
    return { stop: () => { clearInterval(id); tick(); } };
  }

  function capturePlanes(vol: Float32Array, Z: number, Y: number, X: number) {
    const zc = Z >> 1, yc = Y >> 1, xc = X >> 1;
    const ax = new Int16Array(Y * X), co = new Int16Array(Z * X), sa = new Int16Array(Z * Y);
    const base = zc * Y * X;
    for (let i = 0; i < Y * X; i++) ax[i] = vol[base + i];
    for (let z = 0; z < Z; z++) {
      const rowOff = z * Y * X + yc * X;
      for (let x = 0; x < X; x++) co[z * X + x] = vol[rowOff + x];
      const colOff = z * Y * X + xc;
      for (let y = 0; y < Y; y++) sa[z * Y + y] = vol[colOff + y * X];
    }
    return { ax, co, sa };
  }



  // end-of-race report: measured per-row throughput + fairness verdict
  const reportIfDone = () => {
    if (race.neural.tFinal == null || race.htj2k.tFinal == null) return;
    const ns = meters.neural.summary(), hs = meters.htj2k.summary();
    for (const [k, m] of [["neural", ns], ["htj2k", hs]] as const) {
      const t = el(`times-${k}`);
      if (t) t.textContent += ` · avg ${m.mbps.toFixed(1)} Mbps`;
    }
    const delta = Math.abs(ns.mbps - hs.mbps) / Math.max(ns.mbps, hs.mbps);
    const target = netParam === "off" ? "" : ` · target ${netParam} Mbps`;
    const verdict = delta <= 0.15 ? "delivery fair \u2713" : `\u26a0 unequal delivery`;
    status(`measured: neural ${ns.mbps.toFixed(1)} Mbps \u00b7 HTJ2K ${hs.mbps.toFixed(1)} Mbps \u00b7 \u0394${(delta * 100).toFixed(0)}%${target} \u2014 ${verdict}`);
    console.table([...ns.streams, ...hs.streams].map((x) => ({
      stream: x.name, MB: (x.bytes / 1e6).toFixed(2),
      s: ((x.t1 - x.t0) / 1000).toFixed(2), Mbps: (x.bytes * 8 / Math.max(1, x.t1 - x.t0) / 1e3).toFixed(1),
    })));
  };

  status(`loading ${scan.id} meta…`);
  const [meta, dec] = await Promise.all([loadScanMeta(neuralBase), loadDecoderMeta(modelBase)]);
  // per-scan byte budgets: raw + htj2k always come from the case-list entry; the
  // neural budgets come from the list entry in legacy mode but from THIS
  // checkpoint's meta.json in versioned mode (each checkpoint encodes its own).
  const nb = version ? meta.bytes : scan.bytes;
  const bytes = {
    raw: scan.bytes.raw, htj2k: scan.bytes.htj2k,
    coarse: nb.coarse ?? 0, fine: nb.fine ?? 0, dc: nb.dc ?? 0, residual: nb.residual,
  };
  el("name-neural").textContent =
    `LiveCodec neural — coarse ${fmtBytes(bytes.coarse)} → fine ${fmtBytes(bytes.fine + bytes.dc)}`
    + (bytes.residual ? ` → near-lossless ${fmtBytes(bytes.residual)}` : "");
  el("name-htj2k").textContent = `HTJ2K${bytes.residual ? " lossless" : ""} — ${fmtBytes(bytes.htj2k)}`;
  const sc = makeLiveCodecScene(gpu, srgb, scan.shape, scan.spacing);

  // ── canvases: rows × cells ─────────────────────────────────────────────────
  const keys: RowKey[] = ["neural", "htj2k"];
  const cellNames = [...ORIENTS, "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {};
  const cx: Record<string, GPUCanvasContext> = {};
  for (const k of keys) {
    for (const c of cellNames) {
      const id = `c-${k}-${c}`;
      cv[id] = document.getElementById(id) as HTMLCanvasElement;
      cx[id] = cv[id].getContext("webgpu") as GPUCanvasContext;
      cx[id].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    }
  }

  // ── linked navigation state (shared offsets + ONE camera, spine-compare style) ─
  const off: Record<Orientation, number> = {
    axial: slicerDefaultOffset01("axial", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    coronal: slicerDefaultOffset01("coronal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
    sagittal: slicerDefaultOffset01("sagittal", sc.dims, sc.ijkToRAS, sc.rasLo, sc.rasHi),
  };
  const sliceIx = new SliceInteractor({ ijkToRAS: sc.ijkToRAS, rasLo: sc.rasLo, rasHi: sc.rasHi });
  const camera = framedCamera(sc.center, sc.radius);

  // ── view persistence: keep pan/zoom/offsets/camera across reloads of the SAME
  // scan (bandwidth switches reload the page), so a zoomed-in detail stays framed
  // while tiers stream in. A different scan starts from the default framing.
  const viewKey = `lcview:${scan.id}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(viewKey) ?? "null");
    if (saved) {
      Object.assign(off, saved.off ?? {});
      sc.slice.setViewState(saved.slice ?? {});
      if (saved.camera) {
        camera.position = saved.camera.position ?? camera.position;
        camera.focalPoint = saved.camera.focalPoint ?? camera.focalPoint;
        camera.viewUp = saved.camera.viewUp ?? camera.viewUp;
        camera.viewAngle = saved.camera.viewAngle ?? camera.viewAngle;
      }
    }
  } catch { /* corrupt entry -> default view */ }
  addEventListener("beforeunload", () => {
    sessionStorage.setItem(viewKey, JSON.stringify({
      off,
      slice: sc.slice.getViewState(),
      camera: {
        position: camera.position, focalPoint: camera.focalPoint,
        viewUp: camera.viewUp, viewAngle: camera.viewAngle,
      },
    }));
  });

  const drawSlice = (k: RowKey, o: Orientation) => {
    const c = cv[`c-${k}-${o}`];
    if (!c || !c.width) return;
    sc.bindRowSlice(k);                       // shared renderer, this row's volume texture
    sc.slice.setPlane(o, off[o]);
    sc.slice.renderToView(cx[`c-${k}-${o}`].getCurrentTexture().createView({ format: srgb }), c.width, c.height);
  };
  // interactive 3D at half res (upscaled), debounced native-res settle — the spine pattern
  let fast3d = false;
  let settle3dTimer = 0;
  const draw3dCell = (k: RowKey) => {
    const c = cv[`c-${k}-threeD`];
    if (!c || !c.width) return;
    const scene = sc.rows[k].scene;
    const view = cx[`c-${k}-threeD`].getCurrentTexture().createView({ format: srgb });
    if (fast3d) {
      const rw = Math.max(16, Math.round(c.width * 0.5)), rh = Math.max(16, Math.round(c.height * 0.5));
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, rw, rh);
      scene.renderUpscaled(view, rw, rh, c.width, c.height);
    } else {
      scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, c.width, c.height);
      scene.renderToView(view, c.width, c.height);
    }
  };
  const touch3d = () => {
    fast3d = true;
    clearTimeout(settle3dTimer);
    settle3dTimer = setTimeout(() => { fast3d = false; drawAll3d(); }, 350) as unknown as number;
  };
  const drawAll3d = () => { for (const k of keys) draw3dCell(k); };
  const drawSlices = () => { for (const k of keys) for (const o of ORIENTS) drawSlice(k, o); };
  const drawAll = () => { drawSlices(); drawAll3d(); };
  let drawRaf = 0;
  const requestDraw = () => {          // coalesce pipeline-update redraws into one rAF
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => { drawRaf = 0; drawAll(); });
  };

  // ── interaction: slices (scroll/pan/zoom shared across rows) + linked 3D camera ─
  for (const k of keys) {
    for (const o of ORIENTS) {
      attachSliceControls(cv[`c-${k}-${o}`], {
        orient: o,
        getSlice: () => sc.slice,
        step: (fwd) => { off[o] = sliceIx.wheel(o, off[o], fwd); },
        redraw: () => { for (const kk of keys) drawSlice(kk, o); },
        hooks: { onDoubleClick: () => { toggleMax(`c-${k}-${o}`); return true; } },
      });
    }
    attachCameraControls(cv[`c-${k}-threeD`], camera, { onChange: () => { touch3d(); drawAll3d(); } });
    attachDoubleClick(cv[`c-${k}-threeD`], () => toggleMax(`c-${k}-threeD`));
  }

  // ── double-click any cell to maximize (again to restore) ───────────────────
  let maxed: string | null = null;
  const toggleMax = (id: string) => {
    maxed = maxed === id ? null : id;
    const rowsEl = el("rows");
    rowsEl.classList.toggle("maxmode", !!maxed);
    for (const k of keys) {
      for (const c of cellNames) {
        const cell = cv[`c-${k}-${c}`].parentElement!;
        cell.classList.toggle("max", maxed === `c-${k}-${c}`);
      }
    }
    for (const r of rowsEl.querySelectorAll(".mrow")) {
      r.classList.toggle("hasmax", !!maxed && !!r.querySelector(".cell.max"));
    }
    resize();
  };

  installChrome({ controls: [], anchor: cv["c-htj2k-threeD"].parentElement ?? undefined });

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    for (const c of Object.values(cv)) {
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
    }
    drawAll();
  };
  globalThis.addEventListener("resize", resize);
  resize();

  // ── the race ───────────────────────────────────────────────────────────────

  // NEURAL row: coarse → instant volume; fine + dc refine in the background.
  // Decoding = the vendored WGSL executor on the renderer's device (f16 kernels when
  // the adapter has shader-f16, f32 otherwise — same math, checked at init).
  const runNeural = async () => {
    const r = race.neural;
    try {
      // graph + weights fetch/upload in parallel with the coarse fetch.
      // Trained exports live in the bucket at modelBase — per-checkpoint in
      // versioned mode, so every version runs its OWN decoder weights + dequant
      // constants (regenerate with LiveCodec's scripts/dump_graph25.py from the
      // decoder ONNX); ?model= overrides for testing.
      const dtype = gpu.features.has("shader-f16") ? "f16" : "f32";
      const tNet = performance.now();
      const sh = latentShapes(meta);
      const coarseNative = dec.coarse_upsampled === false;
      const zfZero = new Float32Array(sh.C * sh.Df * sh.Hf * sh.Wf);
      // ── conv-tiling autotune. Measuring means running the real forward a few
      // dozen times, so it is memoized in localStorage per (adapter, dtype, graph
      // shape) and NEVER measured on the critical path: a load reads the memo, and
      // anything still unmeasured is tuned after the row finishes, on an idle GPU,
      // to be there for the next visit. Otherwise the tuner would cost the demo
      // several seconds of time-to-first-image to buy back a few percent.
      const info = (gpu.adapter as unknown as { info?: Record<string, string> }).info ?? {};
      const gpuKey = [info.vendor, info.architecture, info.device].filter(Boolean).join("/") || "gpu";
      const untuned: [string, Net][] = [];
      const loadNet = async (name: string) => {
        const n = await new Net(gpu.device, makeRunner(gpu.device, dtype), dtype)
          .load(`${modelBase}${name}.graph.json`, `${modelBase}${name}.weights.bin`);
        n.setInputData("zf", zfZero);                      // tuning needs inputs bound;
        // the second input is the coarse latent: at the fine grid for most
        // decoders, at its own grid when decoder.json says coarse_upsampled=false
        n.setInputData("zc_up", coarseNative
          ? new Float32Array(sh.C * sh.Dc * sh.Hc * sh.Wc) : zfZero);
        const t = await n.autotune(gpuKey, { cachedOnly: true });
        if (t.skipped) untuned.push([name, n]);
        console.log(`livecodec: ${name} (${dtype}) ready in ${((performance.now() - tNet) / 1000).toFixed(1)} s`
          + ` · conv tiling ${t.TM}x${t.TN}${t.cached ? " (cached)" : " (default, tuning deferred)"}`);
        return n;
      };
      // ── two-tier decode: v3 versions publish a 1/4-scale PREVIEW head next to
      // the full one. Where it exists, the coarse tier decodes through it (2.5x
      // less compute for a picture that is a ~3000:1 blur either way) and the
      // fine tier still decodes at full resolution. Older versions ship only
      // decoder25.* — the HEAD probe 404/403s and we run exactly as before.
      // versions.json declares which heads a version publishes, so no
      // speculative request is needed. (RGW answers a missing key with 403,
      // not 404 — anonymous callers lack ListBucket, so the server refuses to
      // confirm existence — which logged a red console error on every legacy
      // load.) Only probe when the manifest predates the `heads` field.
      const declared = version?.heads;
      const previewP = (declared
        ? Promise.resolve(declared.includes("preview") ? true : false)
        : fetch(modelBase + "decoder25-preview.graph.json", { method: "HEAD" })
            .then((resp) => resp.ok).catch(() => false)
      )
        .then((has) => has ? loadNet("decoder25-preview") : null)
        .catch(() => null);
      const netP = loadNet("decoder25");
      netP.then(() => { spinup.neural = performance.now() - race.neural.t0; });
      netP.catch(() => { /* surfaced below when awaited */ });
      previewP.catch(() => { /* falls back to the full net */ });
      r.stage = "coarse"; r.expected = bytes.coarse; r.got = 0;
      const mCoarse = meters.neural.begin("coarse.gz");
      const coarseGz = await streamFetch(neuralBase + "coarse.gz", (n) => { r.got = n; mCoarse.at(n); }, pacers.neural);
      const coarseCodes = await gunzip(coarseGz);
      r.note = "loading decoder";
      const [net, previewNet] = await Promise.all([netP, previewP]);
      const vol = sc.rows.neural.vol;
      // preview scale comes from the graph itself (output [1,1,chunkZ,H/s,W/s]), not
      // a sidecar — a mismatched/odd shape just disables the tier rather than
      // scribbling garbage into the volume.
      const pOut = previewNet?.graph.outputs[0].shape ?? null;
      const pscale = pOut && pOut[2] === sh.chunkZ && pOut[3] > 0 && pOut[4] > 0 &&
          sh.H % pOut[3] === 0 && sh.W % pOut[4] === 0 && sh.H / pOut[3] === sh.W / pOut[4]
        ? sh.W / pOut[4]
        : 1;
      const coarseNet = pscale > 1 && previewNet ? previewNet : net;
      const pxNote = pscale > 1 ? ` · ${sh.W / pscale}px` : "";
      if (previewNet && pscale === 1) console.warn("livecodec: preview graph shape unusable — full net for both tiers");
      const decodeChunk = async (useNet: Net, scale: number, zf: Float32Array, ch: number) => {
        useNet.setInputData("zf", zf);
        useNet.setInputData("zc_up", coarseNative
          ? dequantCoarseNative(coarseCodes, ch, sh, dec)
          : dequantCoarseUp(coarseCodes, ch, sh, dec));
        useNet.run();
        const out = await useNet.read("volume");          // [-1,1] units, (chunkZ,H/scale,W/scale)
        const z0 = ch * sh.chunkZ;
        mapOutputToHU(out, vol, z0, Z, sh, dec, scale);
        sc.writeSlab("neural", z0, Math.min(Z, z0 + sh.chunkZ));
        touch("neural");
      };
      const tDec = performance.now();
      for (let ch = 0; ch < sh.chunks; ch++) {
        r.note = `decode ${ch + 1}/${sh.chunks}${pxNote}`;
        await decodeChunk(coarseNet, pscale, zfZero, ch);  // show each slab as it lands
        if (ch === 0) r.tFirst = elapsed("neural");        // first anatomy on screen
        requestDraw();
      }
      console.log(`livecodec: coarse decode ${sh.chunks} chunks in ${((performance.now() - tDec) / 1000).toFixed(1)} s`
        + ` (${pscale > 1 ? `preview head, ${sh.W / pscale}px` : "full head"})`);
      r.note = "";
      requestDraw();

      // background: fine + dc → per-chunk refinement, then the DC-corrected final state
      const staged = meta.staged;
      r.stage = "fine+dc";
      r.expected = (staged ? staged.bytes.reduce((a, b) => a + b, 0) : bytes.fine) + bytes.dc;
      r.got = 0;
      let fGot = 0, dGot = 0;
      const dcP = streamFetch(neuralBase + "dc.gz",
        ((m) => (n: number) => { dGot = n; r.got = fGot + dGot; m.at(n); })(
          meters.neural.begin("dc.gz")), pacers.neural);

      if (staged) {
        // Progressive fine tier: each stage narrows every site's FSQ code to a
        // finer bucket, so the volume can be re-decoded and shown after ANY of
        // them. The monolithic tier is useless until its last byte; the first
        // stage here is about a quarter of it.
        let prev = dec.levels.map(() => new Int32Array(
          sh.chunks * sh.Df * sh.Hf * sh.Wf)) as Int32Array<ArrayBufferLike>[];
        let prevN = dec.levels.map(() => 1);
        const per = sh.Df * sh.Hf * sh.Wf;
        for (let s = 1; s <= staged.stages; s++) {
          const idxP = fetch(neuralBase + `fine-s${s}.json`).then((x) => x.json() as Promise<StageIndex>);
          const mS = meters.neural.begin(`fine-s${s}.bin`);
          const buf = await streamFetch(neuralBase + `fine-s${s}.bin`,
            ((base) => (n: number) => { fGot = base + n; r.got = fGot + dGot; mS.at(n); })(fGot),
            pacers.neural);
          const idx = await idxP;
          r.note = `stage ${s}/${staged.stages}`;
          const tS = performance.now();
          const out = decodeFineStage(buf, idx, dec.levels, prev, prevN,
                                      sh.chunks, sh.Df, sh.Hf, sh.Wf);
          const entropyMs = performance.now() - tS;
          prev = out.buckets;
          prevN = idx.buckets;
          for (let ch = 0; ch < sh.chunks; ch++) {
            r.note = `stage ${s}/${staged.stages} · chunk ${ch + 1}/${sh.chunks}`;
            await decodeChunk(net, 1, dequantFineFloat(out.codes, ch, sh.C, per,
                                                       dec.offset, dec.half), ch);
            touch("neural");
            requestDraw();
          }
          console.log(`livecodec: fine stage ${s} — ${(buf.byteLength / 1024).toFixed(0)} KB, `
            + `entropy decode ${entropyMs.toFixed(0)} ms, `
            + `neural decode ${(performance.now() - tS - entropyMs).toFixed(0)} ms`);
        }
      } else {
        const fineGz = await streamFetch(neuralBase + "fine.gz",
          ((m) => (n: number) => { fGot = n; r.got = fGot + dGot; m.at(n); })(
            meters.neural.begin("fine.gz")), pacers.neural);
        const fineCodes = await gunzip(fineGz);
        for (let ch = 0; ch < sh.chunks; ch++) {
          r.note = `refine ${ch + 1}/${sh.chunks}`;
          // the FINE tier always runs the full head — detail is the whole point here
          await decodeChunk(net, 1, dequantFine(fineCodes, ch, sh, dec), ch);
          requestDraw();
        }
      }
      const dcBytes = await gunzip(await dcP);
      const dcGrid = new Int8Array(dcBytes.buffer, dcBytes.byteOffset, dcBytes.byteLength);
      r.note = "dc correction";
      if (!applyDcCorrection(vol, scan.shape, dcGrid)) {
        console.warn(`dc grid size ${dcGrid.length} does not match the volume shape — skipping DC correction`);
      }
      sc.writeSlab("neural", 0, Z);
      touch("neural");
      requestDraw();

      // ── residual stage → near-lossless (reversible HT slices of
      // original − fixed recon, uint16 = residual + 4096, decoded with the same
      // openjph wasm as the HTJ2K row). Every update REPLACES a plane with
      // base + residual — with progressive refinement an ADD would double-apply
      // when a slice is re-decoded at a higher round. ──
      if (bytes.residual) {
        r.stage = "residual"; r.expected = bytes.residual; r.got = 0; r.note = "";
        const factory = (globalThis as unknown as { Module?: () => Promise<OpenJphModule> }).Module;
        if (!factory) throw new Error("openjph script did not load");
        const rDecoder = new (await factory()).HTJ2KDecoder();
        const idxResp = await fetch(neuralBase + "residual-index.json", { cache: "no-store" });
        if (!idxResp.ok) throw new Error(`residual-index.json HTTP ${idxResp.status}`);
        const ridx = await idxResp.json() as SliceIndexEntry[] | ResProgressiveIndex;
        // BASE snapshot of the refined (fine + DC-corrected) volume — one extra
        // full-volume Float32Array (~raw size), acceptable for the demo. The
        // server computed the residual against
        //   fixed = np.clip(recon_f32 - dc_corr, -1024, 3071).astype(np.int16)
        // where astype TRUNCATES toward zero, so replicate clip+trunc exactly —
        // a float base drifts up to ~82 HU from the int16 the residual targets.
        // What remains after this is only browser-vs-server f16/f32 recon drift
        // (~±2 HU; bit-exact would need an integer-deterministic decoder).
        const base = new Int16Array(vol.length);   // integers by construction
        for (let i = 0; i < vol.length; i++) {
          base[i] = Math.trunc(Math.min(3071, Math.max(-1024, vol[i])));
        }
        const writeResidualPlane = makePlaneWriter(vol, 4096, base);
        if (!Array.isArray(ridx)) {
          // new packs: the same res-progressive layout as the HTJ2K arm — the
          // whole residual previews coarse-first and sharpens round by round
          await runResProgressive({
            idx: ridx, decoder: rDecoder, r, row: "neural", stage: "residual",
            url: neuralBase + "residual.bin", pacer: pacers.neural,
            meter: meters.neural, streamName: "residual.bin",
            writePlane: writeResidualPlane,
          });
        } else {
          // legacy flat layout: [{z, offset, bytes}] full-res codestreams
          const total = ridx.length ? ridx[ridx.length - 1].offset + ridx[ridx.length - 1].bytes : 0;
          r.expected = total || r.expected;
          const rbuf = new Uint8Array(total);
          let received = 0, next = 0, flushed = 0;
          const applySlice = (e: SliceIndexEntry) => {
            const enc = rDecoder.getEncodedBuffer(e.bytes);
            enc.set(rbuf.subarray(e.offset, e.offset + e.bytes));
            rDecoder.decode();
            const out = rDecoder.getDecodedBuffer();
            const u16 = new Uint16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
            writeResidualPlane(e.z, 0, u16);
          };
          const mRes = meters.neural.begin("residual.bin");
          for await (const value of byteChunks(neuralBase + "residual.bin", pacers.neural)) {
            mRes.add(value.byteLength);
            rbuf.set(value, received);
            received += value.byteLength;
            r.got = received;
            while (next < ridx.length && ridx[next].offset + ridx[next].bytes <= received) {
              applySlice(ridx[next]);
              touch("neural");            // per slice: the residual reveals slowly
              next++;
              r.note = `${next}/${ridx.length} slices`;
              if (next - flushed >= 32) {
                sc.writeSlab("neural", flushed, next);
                touch("neural");
                flushed = next;
                requestDraw();
              }
            }
          }
          while (next < ridx.length && ridx[next].offset + ridx[next].bytes <= received) { applySlice(ridx[next]); next++; }
          sc.writeSlab("neural", flushed, Z);
          touch("neural");
          requestDraw();
        }
        r.note = "near-lossless";
        const pt = el("ptext-neural");
        if (pt) {
          pt.title = "residual is applied against the browser's float recon (clipped/truncated to match "
            + "the server's int16); browser-vs-server f16/f32 decoder drift leaves ≤ ~±2 HU — "
            + "bit-exact would require an integer-deterministic decoder";
        }
      }
      r.tFinal = elapsed("neural");
      reportIfDone();
      // race over, GPU idle: measure the conv tiling for any net that had no memo
      // and store it, so the NEXT load of this graph on this adapter starts tuned
      for (const [nm, n] of untuned) {
        const t = await n.autotune(gpuKey, { force: true });
        console.log(`livecodec: ${nm} conv tiling ${t.TM}x${t.TN} @ ${t.ms} ms/chunk`
          + ` (${t.verified}/${t.tried} candidates verified) — cached for the next load`);
      }
    } catch (e) {
      r.error = "neural: " + ((e as Error)?.message ?? String(e));
      console.error(e);
    }
  };

  // Plane writer for res-progressive decodes: writes one decoded uint16 plane
  // (full-res, or level-reduced → nearest-upsampled to the full X×Y plane) into
  // vol at slice z as vol = (base ?? 0) + u16 − bias. With a base the plane
  // REPLACES (base + residual, safe to re-decode at higher rounds); without one
  // it overwrites directly (absolute HU planes, bias 1024).
  const makePlaneWriter = (vol: Float32Array, bias: number, base?: Float32Array) =>
  (z: number, level: number, u16: Uint16Array) => {
    const sliceSize = X * Y;
    const b = z * sliceSize;
    if (level === 0) {
      const n = Math.min(sliceSize, u16.length);
      if (base) { for (let i = 0; i < n; i++) vol[b + i] = base[b + i] + u16[i] - bias; }
      else { for (let i = 0; i < n; i++) vol[b + i] = u16[i] - bias; }
    } else {
      const w = Math.max(1, Math.ceil(X / (1 << level)));
      const h = Math.max(1, Math.ceil(Y / (1 << level)));
      for (let y = 0; y < Y; y++) {
        const srow = Math.min(h - 1, (y * h / Y) | 0) * w;
        const drow = b + y * X;
        for (let x = 0; x < X; x++) {
          const v = u16[srow + Math.min(w - 1, (x * w / X) | 0)] - bias;
          vol[drow + x] = base ? base[drow + x] + v : v;
        }
      }
    }
  };

  // Shared res-progressive streamer: the stream is resolution-MAJOR (round 0 =
  // every slice's main header + lowest-res tile-part, round 1 = every slice's
  // next tile-part, …). Each slice's received prefix decodes via
  // decodeSubResolution and writePlane maps it into the row volume, so the
  // WHOLE volume previews at 16px from ~1% of the stream and sharpens round by
  // round. Used by the HTJ2K row (slices.bin, absolute HU planes) and the
  // neural residual stage (residual.bin, base + residual planes). The caller
  // sets the final note / tFinal.
  const runResProgressive = async (opts: {
    idx: ResProgressiveIndex;
    decoder: OpenJphDecoder;
    r: RaceState;
    row: RowKey;
    stage: string;
    url: string;
    pacer: LinkPacer;
    meter: BandwidthMeter;
    streamName: string;
    writePlane: (z: number, level: number, u16: Uint16Array) => void;
  }) => {
    const { idx, decoder, r, row } = opts;
    const slices = idx.slices, nS = slices.length, R = idx.rounds;
    // flattened [round][slice] schedule in exact stream order; a cursor over it
    // makes per-slice round completion monotonic and O(1) per received chunk
    const schedSlice: number[] = [];
    const schedEnd: number[] = [];               // end offset of each scheduled part
    const roundEnd: number[] = [];               // schedule index after each round
    for (let rnd = 0; rnd < R; rnd++) {
      for (let si = 0; si < nS; si++) {
        const p = slices[si].parts[rnd];
        if (p) { schedSlice.push(si); schedEnd.push(p[0] + p[1]); }
      }
      roundEnd.push(schedSlice.length);
    }
    const total = schedEnd.length ? schedEnd[schedEnd.length - 1] : 0;
    r.stage = opts.stage; r.expected = total; r.got = 0;
    const buf = new Uint8Array(total);
    const arrived = new Uint8Array(nS);          // rounds fully received per slice
    const applied = new Uint8Array(nS);          // rounds already decoded to vol

    const decodePrefix = (si: number) => {
      const s = slices[si], k = arrived[si];
      let len = 0;
      for (let i = 0; i < k; i++) len += s.parts[i][1];
      const enc = decoder.getEncodedBuffer(len);
      let o = 0;
      for (let i = 0; i < k; i++) {
        const [off, n] = s.parts[i];
        enc.set(buf.subarray(off, off + n), o);
        o += n;
      }
      const level = s.parts.length - k;          // resolution levels skipped
      decoder.decodeSubResolution(level);
      const out = decoder.getDecodedBuffer();
      // out is a VIEW into the wasm heap — copy before the decoder reuses it.
      // getFrameInfo() reports FULL dims even for sub-resolution decodes, so the
      // reduced size comes from `level` (verified: len = (X>>level)*(Y>>level)).
      const u16 = new Uint16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
      opts.writePlane(s.z, level, u16);
      applied[si] = k;
    };

    // decode ONLY the slices that gained a round since their last decode, then
    // upload the touched z-range in one slab; yields keep the UI live mid-pass
    const applyPass = async () => {
      let minZ = Z, maxZ = -1, n = 0;
      for (let si = 0; si < nS; si++) {
        if (arrived[si] <= applied[si]) continue;
        decodePrefix(si);
        const z = slices[si].z;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (++n % 32 === 0) await new Promise((res) => setTimeout(res));
      }
      if (maxZ < 0) return;
      sc.writeSlab(row, minZ, maxZ + 1);
      touch(row);
      let full = R;                              // rounds applied volume-wide
      for (let si = 0; si < nS; si++) if (applied[si] < full) full = applied[si];
      if (full >= 1 && r.tFirst == null) r.tFirst = elapsed(row);  // whole-volume preview on screen
      const shown = Math.max(1, full);
      const px = Math.max(1, Math.ceil(X / (1 << (R - shown))));
      r.note = `round ${shown}/${R} · ${px}px${full < 1 ? " …" : ""}`;
      requestDraw();
    };

    const resp = await fetch(opts.url, { cache: "no-store" });
    if (!resp.ok || !resp.body) throw new Error(`${opts.streamName} HTTP ${resp.status}`);
    const mSl = opts.meter.begin(opts.streamName);
    const rd = resp.body.getReader();
    let received = 0, cursor = 0, nextRound = 0, lastPassAt = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      await opts.pacer.admit(value.byteLength);
      mSl.add(value.byteLength);
      buf.set(value, received);
      received += value.byteLength;
      r.got = received;
      while (cursor < schedEnd.length && schedEnd[cursor] <= received) arrived[schedSlice[cursor++]]++;
      let roundDone = false;
      while (nextRound < R && cursor >= roundEnd[nextRound]) { nextRound++; roundDone = true; }
      // decode when a round completes, plus ~2 MB ticks while a round streams in
      if (roundDone || received - lastPassAt >= 2e6) {
        lastPassAt = received;
        await applyPass();
      }
    }
    while (cursor < schedEnd.length && schedEnd[cursor] <= received) arrived[schedSlice[cursor++]]++;
    await applyPass();
  };

  // HTJ2K row: stream slices.bin. New res-progressive layout → round-based
  // whole-volume refinement (16px preview first); legacy flat layout → per-slice
  // full-res decode, bottom-up. Same pacer/meter/no-store delivery either way.
  const runHTJ2K = async () => {
    const r = race.htj2k;
    try {
      const factory = (globalThis as unknown as { Module?: () => Promise<OpenJphModule> }).Module;
      if (!factory) throw new Error("openjph script did not load");
      // The openjph wasm is fetched by a <script> tag at page load, i.e. before
      // the clock starts, while the neural arm pays its 12.7 MB of weights
      // INSIDE the clock. Charging the HTJ2K arm for that download keeps the
      // two spin-ups comparable; the timing is recoverable after the fact from
      // the resource entry.
      const ojEntry = performance.getEntriesByType("resource")
        .find((e) => e.name.includes("openjph")) as PerformanceResourceTiming | undefined;
      const ojFetchMs = ojEntry ? ojEntry.duration : 0;
      const openjphP = factory();
      const idxResp = await fetch(htj2kBase + "index.json", { cache: "no-store" });
      if (!idxResp.ok) throw new Error(`index.json HTTP ${idxResp.status}`);
      const rawIdx = await idxResp.json() as SliceIndexEntry[] | ResProgressiveIndex;
      const openjph = await openjphP;
      const decoder = new openjph.HTJ2KDecoder();
      spinup.htj2k = (performance.now() - race.htj2k.t0) + ojFetchMs;
      const vol = sc.rows.htj2k.vol;
      const sliceSize = X * Y;
      if (!Array.isArray(rawIdx) && rawIdx.layout === "res-progressive") {
        await runResProgressive({
          idx: rawIdx, decoder, r, row: "htj2k", stage: "slices",
          url: htj2kBase + "slices.bin", pacer: pacers.htj2k,
          meter: meters.htj2k, streamName: "slices.bin",
          writePlane: makePlaneWriter(vol, 1024),   // uint16 = HU + 1024
        });
        r.note = "lossless";
        r.tFinal = elapsed("htj2k");
        reportIfDone();
        return;
      }

      // ── legacy flat layout: [{z, offset, bytes}] full-res codestreams ──────
      const idx = rawIdx as SliceIndexEntry[];
      const total = idx.length ? idx[idx.length - 1].offset + idx[idx.length - 1].bytes : 0;
      r.stage = "slices"; r.expected = total; r.got = 0;
      const buf = new Uint8Array(total);
      let received = 0, next = 0, flushed = 0;

      const decodeSlice = (e: SliceIndexEntry) => {
        const sub = buf.subarray(e.offset, e.offset + e.bytes);
        const enc = decoder.getEncodedBuffer(e.bytes);
        enc.set(sub);
        decoder.decode();
        const out = decoder.getDecodedBuffer();
        // out is a VIEW into the wasm heap — copy before the decoder reuses it
        const u16 = new Uint16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        const n = Math.min(sliceSize, u16.length), b = e.z * sliceSize;
        for (let i = 0; i < n; i++) vol[b + i] = u16[i] - 1024;   // uint16 = HU + 1024
      };
      const flush = () => {
        if (next <= flushed) return;
        sc.writeSlab("htj2k", flushed, next);
        touch("htj2k");
        flushed = next;
        if (r.tFirst == null) r.tFirst = elapsed("htj2k");
        requestDraw();
      };

      const mSl = meters.htj2k.begin("slices.bin");
      for await (const value of byteChunks(htj2kBase + "slices.bin", pacers.htj2k)) {
        mSl.add(value.byteLength);
        buf.set(value, received);
        received += value.byteLength;
        r.got = received;
        while (next < idx.length && idx[next].offset + idx[next].bytes <= received) {
          decodeSlice(idx[next]);
          touch("htj2k");
          next++;
          r.note = `${next}/${idx.length} slices`;
          if (next - flushed >= 32) flush();
        }
      }
      while (next < idx.length && idx[next].offset + idx[next].bytes <= received) { decodeSlice(idx[next]); next++; }
      flush();
      r.note = "";
      r.tFinal = elapsed("htj2k");
      reportIfDone();
    } catch (e) {
      r.error = "htj2k: " + ((e as Error)?.message ?? String(e));
      console.error(e);
    }
  };

  // introspection for automated tests (numeric ground truth over screenshots) —
  // installed BEFORE the race so a driver can watch it live
  (globalThis as unknown as { __lcDbg: unknown }).__lcDbg = {
    ready: () => true,
    scan: () => scan.id,
    ver: () => version?.tag ?? null,
    bases: () => ({ neuralBase, htj2kBase, modelBase }),
    dims: () => sc.dims,
    offsets: () => ({ ...off }),
    race: () => JSON.parse(JSON.stringify(race)),
    camera: () => ({ position: [...camera.position], focalPoint: [...camera.focalPoint] }),
    volSample: (k: RowKey, z: number, y: number, x: number) => sc.rows[k].vol[(z * Y + y) * X + x],
  };

  const barTimer = setInterval(() => {
    updateBars();
    if ((race.neural.tFinal != null || race.neural.error) && (race.htj2k.tFinal != null || race.htj2k.error)) {
      clearInterval(barTimer);
      updateBars();
    }
  }, 100);

  // ── cached mode: pull every byte first, then race from memory ─────────────
  // Racing off the live network measures the link as much as the codec: real
  // bandwidth wanders, the two arms run minutes apart under different
  // conditions, and re-running at a new rate costs another full download.
  // Prefetching makes the simulated pacer the ONLY thing setting the pace, so
  // the comparison is reproducible and a rate or encoding change re-races at
  // once. It does not remove main-thread contention — that is why even a cached
  // race still runs the arms one at a time.
  async function prefetchAll(): Promise<void> {
    // The residual tier is optional: a version without one 404/403s here, which
    // the per-URL catch below absorbs, so there is nothing to probe for first.
    const urls = [
      neuralBase + "coarse.gz", neuralBase + "fine.gz", neuralBase + "dc.gz",
      ...(meta.staged
        ? Array.from({ length: meta.staged.stages }, (_, i) =>
            [neuralBase + `fine-s${i + 1}.bin`, neuralBase + `fine-s${i + 1}.json`]).flat()
        : []),
      neuralBase + "residual-index.json", neuralBase + "residual.bin",
      htj2kBase + "index.json", htj2kBase + "slices.bin",
    ];
    let done = 0;
    for (const u of urls) {
      const short = u.slice(u.lastIndexOf("/") + 1);
      status(`caching ${short} (${++done}/${urls.length})…`);
      try {
        await prefetch(u);
      } catch (e) {
        // A version without a residual tier 404s here; that is not fatal, the
        // race just falls through to the network for whatever is missing.
        console.warn("prefetch skipped", u, e);
      }
    }
    status(`cached ${(cacheSize() / 1e6).toFixed(1)} MB — replaying at the simulated rate`);
  }

  // ── byte-matched snapshot viewer ──────────────────────────────────────────
  // Both panes draw the SAME budget, so any difference on screen is a
  // difference between the codecs and not between how far each happened to get.
  // Zoom and pan are shared, because a fine-detail comparison is worthless if
  // the two views are not on the same pixel.
  function buildCompare(): void {
    makeSnapshotViewer({
      shape: sc.shape, spacing: scan.spacing, win: sc.win, lev: sc.lev,
      frames, keys, el,
    });
  }

  (el("cmpopen") as HTMLButtonElement).addEventListener("click", () => {
    if (!frames.neural.length && !frames.htj2k.length) { status("nothing recorded yet — let a race finish"); return; }
    el("cmp").classList.add("on");
    buildCompare();
  });
  (el("cmpclose") as HTMLButtonElement).addEventListener("click", () => el("cmp").classList.remove("on"));

  // ── how the two arms share the machine ────────────────────────────────────
  // "fair" (default): one at a time, each with its own clock. Simultaneous
  // running makes the numbers meaningless — HTJ2K does thousands of SYNCHRONOUS
  // wasm slice-decodes on the main thread while the neural arm needs that same
  // thread between chunks to read back each decode and submit the next, so
  // whichever arm wins a given interleaving looks faster and repeat runs of the
  // same scan disagree wildly. Sequential costs the visual drama and buys
  // reproducible, contention-free times.
  // "live": the old simultaneous behaviour, for the side-by-side spectacle.
  const record = async (key: RowKey, run: () => Promise<void>) => {
    const rec = recorder(key);
    try { await run(); } finally { rec.stop(); }
  };
  if (raceMode === "cached") await prefetchAll();
  if (raceMode === "live") {
    const start = performance.now();
    race.neural.t0 = start;
    race.htj2k.t0 = start;
    status(`racing on ${scan.id} (live, simultaneous — times include contention)`);
    await Promise.all([record("neural", runNeural), record("htj2k", runHTJ2K)]);
  } else {
    status(`measuring neural on ${scan.id} (fair mode — one arm at a time)…`);
    race.neural.t0 = performance.now();
    await record("neural", runNeural);
    updateBars();
    status(`measuring HTJ2K on ${scan.id}…`);
    race.htj2k.t0 = performance.now();
    await record("htj2k", runHTJ2K);
    status(raceMode === "cached"
      ? `${scan.id} — cached replay at the simulated rate (${(cacheSize() / 1e6).toFixed(1)} MB held). `
        + `Change net or encoding to re-race instantly. Scroll a slice, drag a 3D to orbit.`
      : `${scan.id} — fair mode: each arm timed alone. Scroll a slice, drag a 3D to orbit.`);
  }
  updateBars();
  drawAll();
}

main().catch((e) => { status("error: " + ((e as Error)?.message ?? e), true); console.error(e); });
