// seged app — browser entry. Standalone (no Slicer): load an IDC case (CT + gold-standard DICOM SEG)
// via idc_tools, build the AGENT-EDITABLE seged scene, render a 4-up, and expose `window.seged.*` — the
// dev-hook API a cooperative AI agent drives over CDP (state / view / applyOp / say / degrade / score).
// The right-hand chat/log panel shows the agent's messages + every op, so a human watches live.
//   ?pid=MED_LYMPH_073   which LNQ case to load (default). Bundled to seged-app.js next to idc-worker.js.
import { initDevice } from "../device.ts";
import { buildSegedScene, type SegedScene } from "./seged-app-scene.ts";
import { framedCamera, attachCameraControls } from "./camera-control.ts";
import { mountAdaptive3d } from "./accum-loop.ts";
import { loadManifest, loadSeries } from "../vendor/idc_tools/index.js";
import type { SeriesEntry } from "../vendor/idc_tools/types.js";
import { BlindedCase } from "../../algorithms/eval/degrade.ts";
import type { Vec3 } from "../mat4.ts";

const MANIFEST = "./segroulette.json";
const PARAMS = new URLSearchParams(location.search);
const PID = PARAMS.get("pid") || "MED_LYMPH_073";
const BLIND = PARAMS.get("blind") === "1";

const status = (m: string, err = false) => { const e = document.getElementById("status"); if (e) { e.textContent = m; e.style.color = err ? "#ff6b74" : "#9fb3d0"; } };
const cvEl = (id: string) => document.getElementById(id) as HTMLCanvasElement;

// --- session log (the mrson-shaped record: ops + prompts + scores, machine-parsable) + chat panel ---
const session: Array<Record<string, unknown>> = [];
function logEvent(ev: Record<string, unknown>) { session.push({ ...ev, t: Date.now() }); }
function chat(role: string, text: string) {
  const log = document.getElementById("chat-log");
  if (log) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.innerHTML = `<span class="who">${role}</span>${text.replace(/</g, "&lt;")}`;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
  }
  logEvent({ event: "SegChat", role, text });
}

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available — use Chrome 113+.", true); return; }
  const gpu = await initDevice();
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const names = ["axial", "coronal", "sagittal", "threeD"] as const;
  const cv: Record<string, HTMLCanvasElement> = {}, cx: Record<string, GPUCanvasContext> = {};
  for (const n of names) { cv[n] = cvEl("c-" + n); cx[n] = cv[n].getContext("webgpu") as GPUCanvasContext; cx[n].configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" }); }

  let rs: SegedScene | null = null;
  const off: Record<string, number> = { axial: 0.5, coronal: 0.5, sagittal: 0.5 };
  const orientOf: Record<string, "axial" | "coronal" | "sagittal"> = { axial: "axial", coronal: "coronal", sagittal: "sagittal" };
  const camera = framedCamera([0, 0, 0], 100);
  const drawSlice = (cell: "axial" | "coronal" | "sagittal") => { if (!rs || !cv[cell].width) return; rs.slice.setPlane(orientOf[cell], off[cell]); rs.slice.renderToView(cx[cell].getCurrentTexture().createView({ format: srgb }), cv[cell].width, cv[cell].height); };
  const a3d = mountAdaptive3d({ scene: () => rs?.scene ?? null, view: () => cx.threeD.getCurrentTexture().createView({ format: srgb }), size: () => ({ w: cv.threeD.width, h: cv.threeD.height }), setCamera: (sc, w, h) => sc.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h), gpu });
  const draw3d = () => a3d.draw();
  const drawAll = () => { for (const c of ["axial", "coronal", "sagittal"] as const) drawSlice(c); draw3d(); };
  const resize = () => { const dpr = Math.min(2, globalThis.devicePixelRatio || 1); for (const n of names) { cv[n].width = Math.floor(cv[n].clientWidth * dpr); cv[n].height = Math.floor(cv[n].clientHeight * dpr); } drawAll(); };
  globalThis.addEventListener("resize", resize);
  attachCameraControls(cv.threeD, camera, { onChange: draw3d });

  // ---- load the LNQ case (CT + gold-standard DICOM SEG) from IDC ----
  status(`loading ${PID} from IDC…`);
  const manifest = await loadManifest(MANIFEST);
  const entry = manifest.rows.find((r: SeriesEntry & { pid?: string }) => r.pid === PID);
  if (!entry) { status(`case ${PID} not in manifest`, true); return; }
  const res = await loadSeries(entry, { onProgress: (p) => status(`${PID}: ${p.msg} ${Math.round(p.frac * 100)}%`) });
  if (!res.ct || !res.seg) { status(`${PID}: CT or SEG failed to load`, true); return; }
  rs = buildSegedScene(gpu, srgb, res.ct, res.seg, { blind: BLIND });
  rs.onRedraw(drawAll);
  const framed = framedCamera(rs.center, rs.radius);   // Slicer-default framing for this case
  camera.position = framed.position; camera.focalPoint = framed.focalPoint; camera.viewUp = framed.viewUp; camera.viewAngle = framed.viewAngle;
  resize();
  status(`${PID} — ${rs.segments.length} segment(s): ${rs.segments.map((s) => `${s.name}(${s.num})`).join(", ")}`);
  if (BLIND) chat("system", `CANDIDATE ${PID} (BLIND). Ground truth is hidden. Task: segment these classes from the CT — ${rs.segments.map((s) => `${s.name} [label ${s.num}]`).join("; ")}. Build into the editable, then call seged.scoreCandidate().`);
  else chat("system", `Loaded ${PID}. Segments: ${rs.segments.map((s) => `${s.name} [label ${s.num}, ${s.voxels} vox]`).join("; ")}.`);

  // ---- blinded-degradation eval state (GT + transform kept PRIVATE in this closure) ----
  let blinded: BlindedCase | null = null;

  // ---- window.seged.* — the agent's hands + eyes + voice (driven over CDP) ----
  Object.assign(globalThis, {
    seged: {
      /** Case + segments + current view. Never leaks GT or the degradation. */
      async state() {
        const counts = await rs!.voxelCounts();
        return { pid: PID, dims: rs!.dims, ijkToRAS: rs!.ijkToRAS, win: rs!.win, lev: rs!.lev,
          segments: rs!.segments.map((s) => ({ num: s.num, name: s.name, color: s.color, voxels: counts[s.num] ?? 0 })),
          view: { ...off }, degraded: !!blinded, camera: { position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp] } };
      },
      /** Drive the 4-up: set a slice offset (0..1) per orientation, overlay opacity, or camera. */
      view(v: { axial?: number; coronal?: number; sagittal?: number; overlay?: number; camera?: { position: Vec3; focalPoint: Vec3; viewUp: Vec3 } } = {}) {
        if (typeof v.axial === "number") off.axial = v.axial;
        if (typeof v.coronal === "number") off.coronal = v.coronal;
        if (typeof v.sagittal === "number") off.sagittal = v.sagittal;
        if (typeof v.overlay === "number") rs!.slice.setOverlayOpacity(v.overlay);
        if (v.camera) { camera.position = v.camera.position; camera.focalPoint = v.camera.focalPoint; camera.viewUp = v.camera.viewUp; }
        drawAll(); return { ...off };
      },
      /** Apply a SegEdit op (stroke/scissors/seeds) — the agent's edit. Recorded. */
      async applyOp(op: unknown) { await rs!.applyOp(op); logEvent({ event: "SegEdit", edit: op }); return { ok: true }; },
      /** Jump the MPR to a segment (its centroid) + frame the 3D on it, and return its current stats
       *  (bbox, centroid RAS, HU distribution) so the agent can SEE it and diagnose. */
      async focus(label: number) {
        const st = await rs!.labelStats(label);
        const cl = (v: number) => Math.max(0, Math.min(1, v));
        off.axial = cl((st.centroidRAS[2] - rs!.rasLo[2]) / (rs!.rasHi[2] - rs!.rasLo[2]));
        off.coronal = cl((st.centroidRAS[1] - rs!.rasLo[1]) / (rs!.rasHi[1] - rs!.rasLo[1]));
        off.sagittal = cl((st.centroidRAS[0] - rs!.rasLo[0]) / (rs!.rasHi[0] - rs!.rasLo[0]));
        const f = framedCamera(st.centroidRAS as Vec3, 55);   // ~5.5cm frame: node + immediate surroundings
        camera.position = f.position; camera.focalPoint = f.focalPoint; camera.viewUp = f.viewUp; camera.viewAngle = f.viewAngle;
        drawAll();
        return st;
      },
      /** Inspect a segment (no navigation) — same stats as focus(). */
      stats(label: number) { return rs!.labelStats(label); },
      /** HU histogram of a segment (distribution shape). */
      histogram(label: number) { return rs!.segHistogram(label); },
      /** Orbit the 3D view to an absolute (azimuth,elevation) around the whole scene (whole=true) or
       *  around the current focal point (whole=false, after focus(label)). Then screenshot to see shape. */
      orbit(az = 0, el = 0, whole = true) {
        if (whole) { const f = framedCamera(rs!.center, rs!.radius); camera.position = f.position; camera.focalPoint = f.focalPoint; camera.viewUp = f.viewUp; camera.viewAngle = f.viewAngle; }
        if (az) camera.azimuth(az); if (el) camera.elevation(el); camera.orthogonalizeViewUp();
        draw3d(); return { az, el };
      },
      /** Lay down many brush decisions at once: each dab is a labeled (or erased) sphere at a view
       *  fraction on its orientation's CURRENT slice. This is the expert's paint brush — pixel-by-pixel
       *  labeling, batched. Follow with threshold(label,min,max) to gate to the tissue's HU if desired. */
      async paintDabs(seeds: Array<{ o: "axial"|"coronal"|"sagittal"; u: number; v: number; label: number; d?: number; erase?: boolean }>, diamMm = 14) {
        for (const s of seeds) {
          const ras = rs!.slice.viewToRas(s.o, off[s.o], s.u, s.v, cv[s.o].width / cv[s.o].height);
          await rs!.applyOp({ kind: "stroke", segmentId: String(s.label), points: [ras], brush: { diameterMm: s.d ?? diamMm }, mode: s.erase ? "remove" : "add" });
        }
        logEvent({ event: "SegEdit", edit: { kind: "paintDabs", n: seeds.length } });
        return { painted: seeds.length };
      },
      // ── NATIVE DATA ACCESS — reason directly on the arrays (injected code runs in-page; the big
      //    buffers never cross the wire). ctArray = HU volume; labArray = current labelmap; applyLabelmap
      //    writes a computed segmentation back. dims/ijk give the voxel↔RAS geometry. ──
      ctArray() { return rs!.ct; },
      dimsArr() { return rs!.dims; },
      ijkArr() { return rs!.ijkToRAS; },
      async labArray() { return await rs!.readLabelmap(); },
      applyLabelmap(a: Uint8Array | number[]) { rs!.setLabelmap(a instanceof Uint8Array ? a : Uint8Array.from(a)); logEvent({ event: "SegEdit", edit: { kind: "applyLabelmap", n: a.length } }); return { applied: (a as ArrayLike<number>).length }; },
      /** Score my current segmentation per class vs the hidden ground truth (blind candidate). */
      async scoreCandidate() {
        const r = await rs!.scoreCandidate();
        logEvent({ event: "ScoreCandidate", result: r });
        chat("agent", "Dice vs hidden GT: " + r.map((x) => `${x.name} ${x.dice.toFixed(3)} (mine ${x.mineVox} / gt ${x.gtVox})`).join("  |  "));
        return r;
      },
      /** Set every voxel of a scratch label to 0 (drop a growcut "background" label). */
      clearLabel(label: number) { return rs!.clearLabel(label); },
      /** After scoring: show the hidden GT (compare), then restore mine. */
      showGroundTruth() { return rs!.showGroundTruth(); },
      showMine() { rs!.showMine(); },
      /** Map a view-fraction (u,v in [0,1], y-down as seen on screen) on orientation `o` at its CURRENT
       *  slice to RAS — via the slice renderer's own inverse (handles pan/zoom/aspect/flips exactly). */
      seedRAS(o: "axial"|"coronal"|"sagittal", u: number, v: number) { return rs!.slice.viewToRas(o, off[o], u, v, cv[o].width / cv[o].height); },
      /** Paint one seed dab (a labeled sphere) at a view-fraction on the current slice — for calibration. */
      async placeSeed(o: "axial"|"coronal"|"sagittal", u: number, v: number, label: number, opts: { diameterMm?: number } = {}) {
        const ras = rs!.slice.viewToRas(o, off[o], u, v, cv[o].width / cv[o].height);
        await rs!.applyOp({ kind: "stroke", segmentId: String(label), points: [ras], brush: { diameterMm: opts.diameterMm ?? 8 }, mode: "add" });
        return ras;
      },
      /** Place a set of seeds (by view-fraction on their current slices) and run intensity-guided
       *  growcut. Each seed: {o, u, v, label, d?}; the slice offset used is the view's CURRENT off[o]. */
      async growFromViewSeeds(seeds: Array<{ o: "axial"|"coronal"|"sagittal"; u: number; v: number; label: number; d?: number }>, opts: { edgeLo?: number; edgeHi?: number; intensityRange?: number } = {}) {
        const scribbles = seeds.map((s) => ({ label: s.label, points: [rs!.slice.viewToRas(s.o, off[s.o], s.u, s.v, cv[s.o].width / cv[s.o].height)], brush: { diameterMm: s.d ?? 10 } }));
        await rs!.applyOp({ kind: "seeds", scribbles, edgeLo: opts.edgeLo ?? 0.1, edgeHi: opts.edgeHi ?? 0.4, intensityRange: opts.intensityRange });
        logEvent({ event: "SegEdit", edit: { kind: "seeds", n: scribbles.length } });
        return { seeded: scribbles.length };
      },
      /** Intensity-guided cleanup: trim `label` to HU window [min,max] (remove out-of-range voxels). */
      async threshold(label: number, min: number, max: number) {
        const removed = await rs!.thresholdTrim(label, min, max);
        logEvent({ event: "SegEdit", edit: { kind: "threshold", label, min, max } });
        chat("agent", `threshold(label ${label}, keep HU ${min}..${max}) → removed ${removed} voxels`);
        return { removed };
      },
      /** Say something (reasoning / diagnosis) — shown in the chat panel + recorded. */
      say(role: string, text: string) { chat(role, text); return { ok: true }; },
      /** BLIND: snapshot current labelmap as hidden GT, apply a randomized boundary leak to `label`,
       *  install the degraded map. Returns only that a flaw was applied (not what). */
      async degrade(label?: number, radiusVox = 3) {
        const gt = await rs!.readLabelmap();
        const lbl = label ?? rs!.segments.slice().sort((a, b) => b.voxels - a.voxels)[0]?.num ?? 1;
        blinded = new BlindedCase(gt, rs!.dims, lbl, Math.random, radiusVox);
        rs!.setLabelmap(blinded.degraded);
        logEvent({ event: "Degrade", label: lbl });   // deliberately no params (blinding)
        chat("system", `A blinded flaw was applied to label ${lbl}. Diagnose and refine it from the images; call seged.score() when done.`);
        return { label: lbl, degraded: true };
      },
      /** SCORE: Dice of the CURRENT labelmap vs the hidden GT (+ the baseline degraded Dice to beat). */
      async score() {
        if (!blinded) return { error: "no degradation applied" };
        const cur = await rs!.readLabelmap();
        const s = blinded.score(cur);
        const baseline = blinded.baselineDice();
        logEvent({ event: "Score", ...s, baseline });
        chat("system", `Dice vs ground truth: ${s.diceVsGT.toFixed(4)} (degraded baseline was ${baseline.toFixed(4)}).`);
        return { ...s, baseline };
      },
      /** Reveal what was degraded — call ONLY after committing a fix + scoring (breaks blinding). */
      reveal() { return blinded ? blinded.reveal() : { error: "no degradation" }; },
      /** The machine-parsable session record (ops + prompts + scores). */
      session: () => session,
      dims: () => rs!.dims,
    },
  });

  chat("system", "Ready. An agent can call seged.state(), seged.view(...), seged.applyOp(...), seged.degrade(), seged.score().");
}

main().catch((e) => status("error: " + (e as Error).message, true));
