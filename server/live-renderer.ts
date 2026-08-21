// LiveRenderer (M3) — the SAME TS/WebGPU renderer, run headless under Deno, streaming traced
// SAMPLES to a browser client that reconstructs them (docs/UNIFIED-RENDERING-PLAN.md M3). This is
// the remote half of the DRY unification: local and remote run identical render code; only the
// transport between Producer (this server's SceneRenderer.traceSamples) and Reconstructor (the
// browser's Reconstructor) differs — an in-process GPU buffer locally, a WebSocket here.
//
//   deno run --unstable-webgpu --allow-net --allow-read --allow-env server/live-renderer.ts
//   (localhost only for now; per-session isolation + bandwidth/latency budget come in M4)
import { initDevice } from "../render/device.ts";
import { SceneRenderer } from "../render/scene-renderer.ts";
import { loadSceneVolumeField } from "../render/scene-volume.ts";
import { BudgetController } from "../render/budget-controller.ts";
import { buildMultiVolume } from "../render/demos/selftest-scenes.ts";
import { TransformGizmoField } from "../render/transform-gizmo-field.ts";
import { ImageField } from "../render/fields.ts";
import { loadNrrd } from "../render/nrrd.ts";
import { fetchVP, lutFromVP } from "../render/vp-preset.ts";
import type { Field } from "../render/fields.ts";
import { identity, type Mat4, type Vec3 } from "../render/mat4.ts";
import { Av1Sidecar, codedSize } from "./av1-sidecar.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8787);
// DEMO=single  one big volume (CTACardio) — the original M3 scene.
// DEMO=multi   the selftest MULTI-VOLUME scene (CTACardio + Panoramix +200mm R) with the
//              interactive transform GIZMO on Panoramix: identical fields to
//              demos/selftest-browser.ts?demo=multi, only the compositing runs up here.
const DEMO = Deno.env.get("DEMO") ?? "single";
// The REAL volume rendered remotely — the point of remote rendering is data too big for the browser.
const SCENE_URL = Deno.env.get("SCENE") ?? "https://pieper.github.io/live/scenes/CTACardio.json";
// Self-contained client (page + bundle) served by this server — kept out of the public gallery since
// it needs the local server running. Build with:
//   deno run -A npm:esbuild render/demos/remote-browser.ts --bundle --format=esm --outfile=server/client/remote.js
const CLIENT_DIR = Deno.env.get("CLIENT_DIR") ?? new URL("./client/", import.meta.url).pathname;
const DBG = (Deno.env.get("DBG") ?? "0") !== "0";
const dbg = (...a: unknown[]) => { if (DBG) console.log(`[${performance.now().toFixed(0)}]`, ...a); };
const IDLE_MS = 80;                          // after this long with no camera update, send one native frame
const COMPRESS = (Deno.env.get("COMPRESS") ?? "1") !== "0";   // gzip the rgba8 samples (fallback codec)
// Hardware AV1 via the Rust sidecar (native/encode). CODEC=av1 + SIDECAR_BIN set → the server
// spawns it and encodes patches to AV1 intra; on any failure it falls back to gzip per-frame, so
// the demo never depends on the encoder being up. QP is the quality/size dial.
const CODEC = Deno.env.get("CODEC") ?? "gzip";
const GPU_RATE_PER_HR = Number(Deno.env.get("GPU_RATE_PER_HR") ?? 0.80);   // shown in the client cost meter
const SCALEDOWN_S = Number(Deno.env.get("SCALEDOWN_S") ?? 20);             // Modal's post-disconnect tail
const SIDECAR_BIN = Deno.env.get("SIDECAR_BIN") ?? "";
const AV1_QP = Number(Deno.env.get("AV1_QP") ?? 31);
const BG: [number, number, number] = [Math.round(0.05 * 255), Math.round(0.06 * 255), Math.round(0.09 * 255)];
// codec ids on the wire (header field [5]): 0 raw · 1 gzip · 2 av1
const CODEC_GZIP = 1, CODEC_AV1 = 2;

let sidecar: Av1Sidecar | null = null;
if (CODEC === "av1" && SIDECAR_BIN) {
  try {
    sidecar = await Av1Sidecar.start(SIDECAR_BIN, "/tmp/lr-enc.sock");
    console.log("[live-renderer] AV1 sidecar ready");
  } catch (e) {
    console.error("[live-renderer] AV1 sidecar failed to start, using gzip:", (e as Error).message);
  }
}

/** Encode a whole patch/frame. Returns the wire bytes + codec id; falls back to gzip if AV1 is off
 *  or the sidecar errors on this frame. `w`,`h` are the SAMPLE dims of `raw`. */
async function encodeWhole(raw: Uint8Array, w: number, h: number, allowAv1: boolean): Promise<{ payload: Uint8Array; codec: number }> {
  if (sidecar && allowAv1) {
    const t0 = performance.now();
    dbg(`encode av1 ${w}x${h} (${raw.length / 1e3 | 0}kB) ...`);
    const av1 = await sidecar.encode(raw, w, h, AV1_QP, BG);
    dbg(`encode av1 ${w}x${h} -> ${av1 ? (av1.length + " bytes " + ((performance.now() - t0) | 0) + "ms") : "NULL (fallback)"}`);
    if (av1) return { payload: av1, codec: CODEC_AV1 };
  }
  return { payload: COMPRESS ? await gzip(raw) : raw, codec: COMPRESS ? CODEC_GZIP : 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// gzip a byte buffer (CompressionStream). The premultiplied rgba8 trace is very compressible (large
// transparent background). M5 note: a delta-across-lattice/time codec or a small autoencoder tuned to
// this sparse-sample pattern would beat generic gzip — left as the next compression rung.
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---- one shared headless renderer + SWITCHABLE scene ----------------------------------------
// A menu of MorphoDepot specimens (SlicerMorph) rendered on the L4, each with one of Murat Maga's
// published transfer functions (SlicerMorph/VPs). The big single-file NRRDs are GitHub release
// assets — the server (no CORS) fetches them; a scan switch reloads the scene and re-hellos.
const gpu = await initDevice();
const scene = new SceneRenderer(gpu, "rgba8unorm");
// The device's granted 3D-texture size gates whether a volume can be a single texture. Log it so
// the "will it fit" answer is authoritative (NVIDIA caps 3D textures well below 2D).
const MAX3D = (gpu.device.limits as unknown as { maxTextureDimension3D: number }).maxTextureDimension3D;
console.log(`[live-renderer] device maxTextureDimension3D=${MAX3D} maxBufferSize=${(gpu.device.limits as unknown as {maxBufferSize:number}).maxBufferSize}`);

// An r32float 3D texture needs bytes = 4·nx·ny·nz of VRAM. ImageField uploads it in Z-slabs, so the
// staging buffer stays small (no maxBufferSize ceiling); the volume is bounded only by total VRAM.
// The L4 has 24 GB — reserve ~6 GB for framebuffers, AV1 input, the reconstructor and LUTs, so a
// volume "fits" when its float32 payload ≤ 18 GiB (and every axis ≤ maxTextureDimension3D).
const VRAM_GIB = 24;
const VRAM_FIT_LIMIT = (VRAM_GIB - 6) * 2 ** 30;   // 18 GiB of float32 payload
function volFit(dims: [number, number, number]): { fits: boolean; gib: number; reason?: string } {
  const bytes = 4 * dims[0] * dims[1] * dims[2];
  const gib = bytes / 2 ** 30;
  if (Math.max(...dims) > MAX3D) return { fits: false, gib, reason: `${Math.max(...dims)} > ${MAX3D} per-axis 3D-texture limit` };
  if (bytes > VRAM_FIT_LIMIT) return { fits: false, gib, reason: `${gib.toFixed(1)} GiB as float32 exceeds the L4's usable VRAM` };
  return { fits: true, gib };
}
interface Specimen { label: string; url: string; preset: string; dims: [number, number, number]; note?: string }
// dims from MorphoDepot's dashboard-data.json; only volumes whose largest dim ≤ MAX3D are offered.
const MORPHO: Record<string, Specimen> = {
  bumblebee:      { label: "Bumblebee — diceCT", url: "https://github.com/muratmaga/Bumblebee_Stained/releases/download/v1/Bumblebee.nrrd", preset: "diceCT_16", dims: [1159, 1663, 1482] },
  plethodon:      { label: "Salamander hindlimb — diceCT", url: "https://github.com/dinonoto/Plethodon_Hindlimb2/releases/download/v1/A159522_hind_8bit.nrrd", preset: "diceCT_16", dims: [988, 1660, 1721] },
  herpetotherium: { label: "Fossil marsupial (Herpetotherium)", url: "https://github.com/muratmaga/Peratherium_sp/releases/download/v1/AMNH_FM_22304.nrrd", preset: "Bat-8bit", dims: [1166, 1990, 865] },
  coweye:         { label: "Cow eye — diceCT", url: "https://github.com/PaulGignac/GignacLab_DiceCT_CowEye_2025/releases/download/v1/PaulGignac-Gignac_Cow_Eye_DiceCT-01-volume.nrrd", preset: "diceCT_16", dims: [1215, 954, 1550] },
  xenopus:        { label: "Xenopus frog — diceCT", url: "https://github.com/dinonoto/Xenopus-diceCT/releases/download/v1/CAS-H-2234-DICECT_cropped.nrrd", preset: "diceCT_16", dims: [1711, 1376, 705] },
  glaucomys:      { label: "Flying-squirrel skull", url: "https://js2.jetstream-cloud.org:8001/swift/v1/MorphoDepot-volumes/muratmaga/glaucomys-sabrinus-skull/UWMB-30808.nrrd", preset: "Bat-8bit", dims: [975, 1589, 750] },
  daphnia:        { label: "Water flea (Daphnia) — diceCT", url: "https://github.com/JeanCopper/Daphnia_magna/releases/download/v1/Daphnia_Gut_AAA391.nrrd", preset: "diceCT_16", dims: [378, 750, 175] },
};
const SCENES = ["multi", ...Object.keys(MORPHO)];

// scene state (rebuilt by loadScene)
let mb = 0;
let fields: Field[] = [], center: Vec3 = [0, 0, 0], radius = 200, sceneName = "", detail = "";
let xformTarget: ImageField | null = null;
let gizmo: TransformGizmoField | null = null;
let xformC0: Vec3 = [0, 0, 0];
let xformM: Mat4 = identity();
let currentScene = "";
const fieldCache = new Map<string, ImageField>();

/** Load a scene by name ("multi" or a MORPHO key). Rebuilds the shared renderer. */
async function loadScene(name: string): Promise<void> {
  if (!SCENES.includes(name)) throw new Error(`unknown scene "${name}"`);
  if (name === "multi") {
    const sc = await buildMultiVolume(gpu.device, (n) => { mb += n; });
    xformTarget = sc.pano.field;
    xformC0 = sc.pano.field.worldCenter();
    gizmo = new TransformGizmoField(xformC0, 88);
    fields = [...sc.fields, gizmo];
    center = [(sc.cta.center[0] + sc.pano.center[0]) / 2, (sc.cta.center[1] + sc.pano.center[1]) / 2, (sc.cta.center[2] + sc.pano.center[2]) / 2];
    radius = Math.max(sc.cta.radius, sc.pano.radius) * 1.35;
    sceneName = `${sc.cta.name} + ${sc.pano.name}`;
    detail = `${sc.cta.dims.join("×")} + ${sc.pano.dims.join("×")}`;
  } else {
    const spec = MORPHO[name];
    const fit = volFit(spec.dims);
    if (!fit.fits) throw new Error(`${spec.label} (${spec.dims.join("×")}, ${fit.gib.toFixed(1)} GB) does not fit — ${fit.reason}`);
    let field = fieldCache.get(name);
    if (!field) {
      console.log(`[live-renderer] fetching ${spec.label} …`);
      const t0 = performance.now();
      const nrrd = await loadNrrd(spec.url, (n) => { mb += n; });
      const vp = await fetchVP(spec.preset).catch(() => null);
      const { lut, clim, shade } = vp ? lutFromVP(vp, nrrd.range) : { lut: buildGrayLut(), clim: nrrd.range, shade: [0.25, 0.75, 0.5, 24] as [number, number, number, number] };
      field = new ImageField(gpu.device, nrrd.data, nrrd.dims, [1, 1, 1], lut, { clim, ijkToRAS: nrrd.ijkToRAS, shade });
      fieldCache.set(name, field);
      console.log(`[live-renderer] ${spec.label} ${nrrd.dims.join("×")} range [${nrrd.range}] in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    }
    // a transform gizmo on the specimen, so it is interactive like the multi scene
    xformTarget = field;
    xformC0 = field.worldCenter();
    gizmo = new TransformGizmoField(xformC0, 88);
    fields = [field, gizmo];
    const [lo, hi] = field.aabb();
    center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 * 1.15;
    sceneName = spec.label;
    detail = spec.dims.join("×");
  }
  xformM = identity();
  scene.build(fields);
  scene.setBackground(0.05, 0.06, 0.09);
  currentScene = name;
  console.log(`[live-renderer] scene "${sceneName}" ready — ${detail} · ${(mb / 1e6).toFixed(0)} MB`);
}

function buildGrayLut(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { const g = i, a = Math.round(Math.max(0, (i - 40) / 215) * 200); lut[i*4]=lut[i*4+1]=lut[i*4+2]=g; lut[i*4+3]=a; }
  return lut;
}

const SCENE_MENU = [
  { name: "multi", label: "Cardiac CTA + Abdomen (2 vols + gizmo)", dims: "512³ + 441³", gib: 0.1, fits: true },
  ...Object.entries(MORPHO).map(([name, sp]) => {
    const f = volFit(sp.dims);
    return { name, label: sp.label, dims: sp.dims.join("×"), gib: Math.round(f.gib * 10) / 10, fits: f.fits, reason: f.reason };
  }),
];
// Default to the largest specimen that comfortably fits (unless SCENE_NAME overrides), so the demo
// opens on a real MorphoDepot scan rather than the selftest.
const LARGEST_FIT = [...SCENE_MENU].filter((x) => x.name !== "multi" && x.fits).sort((a, b) => b.gib - a.gib)[0]?.name;
console.log(`[live-renderer] specimen menu: ${SCENE_MENU.map((x) => `${x.name}${x.fits ? "" : "✗"}`).join(" ")} · largest-fit=${LARGEST_FIT}`);
let sceneLoading = false;
const DEFAULT_SCENE = Deno.env.get("SCENE_NAME") ?? "multi";   // safe universal default; pick a specimen from the menu
await loadScene(DEFAULT_SCENE);

interface CamMsg { type: "cam"; w: number; h: number; p: Vec3; f: Vec3; u: Vec3; a: number; dn?: number }
// The gizmo drag, as the client computed it: the target's world matrix, the gizmo's new pivot
// (it rides the target) and which component is highlighted. Tier-A — syncUniforms, no rebuild.
// NOTE: a Mat4 is a Float32Array, which JSON.stringify turns into an OBJECT ({"0":1,...}), not an
// array — so matrices cross the wire as plain number[] and are rebuilt on arrival at both ends.
interface XformMsg { type: "xform"; m: number[]; pivot: Vec3; active: number | null }

// A 4K settled frame is ~32 MB of samples, ~4.6 MB gzipped — and a cloud WebSocket proxy (Modal's,
// measured 2026-08-20) DROPS THE CONNECTION on a message that big. So a frame goes out as one or
// more chunks of at most CHUNK bytes, each repeating the header with its (index, count); the client
// concatenates and only acks the last one. Chunking is unconditional — same path everywhere.
const CHUNK = Number(Deno.env.get("CHUNK_BYTES") ?? 1_000_000);
// Bumped on EVERY wire-format change. The client refuses to talk across a mismatch — today's
// debugging fog came from a stale cached bundle speaking an older protocol at a newer server,
// which decodes as coherent-looking garbage rather than failing loudly.
const PROTO = 4;

// kind 0 = FULL  : sw×sh samples reconstructed across the whole view
// kind 1 = PATCH : sw×sh samples covering only the VIEW RECT (px,py,pw,ph) — everything else on the
//                  client is left exactly as it was. A patch may be native (pw==sw) or reduced.
// The client assembles all chunks before presenting, so a frame is applied ATOMICALLY or not at all.

// ---------------------------------------------------------------------------
// FRAME DELTA. Two facts make this sound and cheap (measured 2026-08-20):
//   * an unchanged scene re-traces to BIT-IDENTICAL samples (no per-frame jitter), so a plain
//     comparison is an exact change detector — no thresholds, no false positives;
//   * a local edit really is local — moving one of the two volumes changed 7.5% of pixels, bbox
//     9.6% of the view — so the bound is worth finding.
// Nothing here knows what a gizmo is: it compares this probe's samples with the last probe the
// client SAW (committed only after a complete send) and reports where they differ.
// ---------------------------------------------------------------------------
const NX = 48, NY = 27;   // ~1300 tiles — the spatial resolution of the delta
const NTILES = NX * NY;

const tileLo = (i: number, n: number, size: number) => Math.floor((i * size) / n);

/** Mark tiles whose samples differ between two frames of the SAME geometry. Returns how many. */
function diffTiles(a: Uint8Array, b: Uint8Array, w: number, h: number, out: Uint8Array): number {
  const A = new Uint32Array(a.buffer, a.byteOffset, w * h);
  const B = new Uint32Array(b.buffer, b.byteOffset, w * h);
  let n = 0;
  for (let ty = 0; ty < NY; ty++) {
    const y0 = tileLo(ty, NY, h), y1 = tileLo(ty + 1, NY, h);
    for (let tx = 0; tx < NX; tx++) {
      const x0 = tileLo(tx, NX, w), x1 = tileLo(tx + 1, NX, w);
      let hit = 0;
      for (let y = y0; y < y1 && !hit; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) if (A[row + x] !== B[row + x]) { hit = 1; break; }
      }
      out[ty * NX + tx] = hit;
      n += hit;
    }
  }
  return n;
}

/** Tile-aligned bounding box of the marked tiles, in samples of a w×h frame. */
function tileBBox(dirty: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let tx0 = NX, ty0 = NY, tx1 = -1, ty1 = -1;
  for (let ty = 0; ty < NY; ty++) {
    for (let tx = 0; tx < NX; tx++) {
      if (!dirty[ty * NX + tx]) continue;
      if (tx < tx0) tx0 = tx; if (tx > tx1) tx1 = tx;
      if (ty < ty0) ty0 = ty; if (ty > ty1) ty1 = ty;
    }
  }
  if (tx1 < 0) return null;
  const x = tileLo(tx0, NX, w), y = tileLo(ty0, NY, h);
  return { x, y, w: tileLo(tx1 + 1, NX, w) - x, h: tileLo(ty1 + 1, NY, h) - y };
}

/** Copy a sample sub-rect out of a full sample buffer (tight rows, ready to compress). */
function cropSamples(src: Uint8Array, w: number, r: { x: number; y: number; w: number; h: number }): Uint8Array {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * w + r.x) * 4;
    out.set(src.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return out;
}

interface Rect { x: number; y: number; w: number; h: number }

function handleWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  // Budget targets an END-TO-END frame period (render + transport), so on a constrained link the
  // bytes cost of a bigger frame shows up as a slower ack and the resolution shrinks. Start
  // CONSERVATIVE and grow into the link: an optimistic start puts its oversized frames exactly
  // where they hurt most — the opening seconds of finger-to-photon.
  // A budget for the GPU alone: the probe trace must stay cheap however fast the link is.
  const renderBudget = new BudgetController({ targetMs: 10, startPx: 0.5e6 });

  // ---- LINK MODEL: measured, not chased. --------------------------------------------------------
  // The old controller steered a pixel budget toward a 33 ms end-to-end target that a WAN cannot
  // meet (RTT alone exceeds it), so it pinned at its floor; and it learned only from frames that
  // completed un-preempted, so mid-interaction it was frozen at whatever stale value it last had —
  // which is exactly "sometimes sharp, sometimes stuttering, sometimes degraded for no reason".
  // Instead, the cack stream (receipt time of every chunk) directly yields bandwidth and RTT, sent
  // frames yield compressed bytes/pixel, and the patch AREA is computed feed-forward so a frame's
  // predicted render+transfer time fits the frame period. Estimates update on EVERY chunk, aborted
  // frames included.
  let bwBpms = 3000;      // link bandwidth, bytes per ms (init ~24 Mbit/s)
  let rttMs = 60;         // round-trip, ms
  let bppC = 0.4;         // compressed bytes per sample pixel
  let probeMsE = 12;      // whole-view probe trace, ms (fixed cost per frame)
  let renderPerPx = 4e-5; // patch trace, ms per sample pixel
  let encodePerPx = 2e-5; // gzip, ms per sample pixel
  let renderMsE = 15;     // probe+retrace of the last frame, ms (for the status stamp)
  const ew = (old_: number, v: number, a: number) => old_ * (1 - a) + v * a;
  /** Target frame period while interacting: ~10 updates/s, stretched only when the round trip
   *  itself makes that impossible. */
  const periodMs = () => Math.min(160, Math.max(80, rttMs + probeMsE + 40));
  /** The area whose PREDICTED cost — render + encode + transfer, all per pixel, after the fixed
   *  round-trip and probe — fits in one period. Every term is measured, so this is right on a LAN
   *  (render-bound), on a WAN (transfer-bound) and on a slow GPU alike. */
  // Closed-loop TRIM on top of the feed-forward model: the ratio of predicted to ACTUAL frame
  // period, so systematic model error (a WAN that never quite delivers its measured bandwidth,
  // an encoder that shares the CPU) converges the real period onto the target instead of
  // overshooting it by a constant factor.
  let trim = 1;
  let lastCommitT = 0, lastPredictedMs = 0;
  const linkArea = (w: number, h: number) => {
    const budgetMs = Math.max(10, periodMs() - rttMs - probeMsE);
    const perPx = renderPerPx + encodePerPx + bppC / bwBpms;
    return Math.max(0.03e6, Math.min(w * h, (budgetMs / perPx) * trim));
  };
  let latest: CamMsg | null = null;
  let gen = 0, sentGen = -1, lastMsg = 0, open = false;

  // ---- The ENTIRE model of the client, kept exact by ordered delivery. ----
  // WebSocket frames arrive in order and the client applies a frame atomically or drops it and says
  // so (resync). So three facts suffice — no per-tile bookkeeping to fall out of sync:
  //   needFull   the next frame must repaint the whole view (new session / resize / resync)
  //   stale      union view-rect currently shown below native resolution (null = fully native)
  //   prevMotion the last probe the client's content is consistent with — committed ONLY after a
  //              frame derived from it was completely sent, so an aborted send never poisons it
  // Codec is per CLIENT: the browser advertises what it can decode ({caps}); until then we use
  // gzip, so a decoder-less browser (old Safari, some phones) always gets frames it can show.
  let clientAv1 = false;
  let needFull = true;
  let stale: Rect | null = null;
  // A settle painted native content over this VIEW region that the motion diff baseline knows
  // nothing about. The first motion frame after a settle must re-cover it, or slow motion overwrites
  // it sliver by sliver and the old position ghosts (a trail). Union it into that frame's rect —
  // just this region, at motion density, not a whole-view wash.
  let settleRect: Rect | null = null;
  let motionStreak = 0;   // committed motion frames in this burst — 0 = the engage frame
  let lastMotionCommit = 0;
  let prevMotion: Uint8Array | null = null, motionW = 0, motionH = 0;
  const dirty = new Uint8Array(NTILES);

  const unionRect = (a: Rect | null, b: Rect): Rect => {
    if (!a) return { ...b };
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
  };
  const addStale = (r: Rect) => {
    if (!stale) { stale = { ...r }; return; }
    const x0 = Math.min(stale.x, r.x), y0 = Math.min(stale.y, r.y);
    const x1 = Math.max(stale.x + stale.w, r.x + r.w), y1 = Math.max(stale.y + stale.h, r.y + r.h);
    stale = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const resetClientModel = (why: string) => {
    needFull = true; stale = null; prevMotion = null; probeF = 0; settleRect = null;
    dbg(`client model reset (${why})`);
  };

  // Ack-based credit: one frame in flight; the ack is PACING, never a gate on responding to input.
  let ackResolve: ((real: boolean) => void) | null = null;
  let ackTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const settleAck = (real: boolean) => { if (ackResolve) { clearTimeout(ackTimer); const r = ackResolve; ackResolve = null; r(real); } };
  const gotAck = () => settleAck(true);
  const abortWait = () => settleAck(false);
  const waitAck = (ms: number) => new Promise<boolean>((res) => { ackResolve = res; ackTimer = setTimeout(() => { ackResolve = null; dbg(`ack TIMEOUT ${ms}ms`); res(false); }, ms); });

  /** Wait until the socket send buffer is below `cap` (or input/close intervenes). Bytes already in
   *  the buffer cannot be unsent, so bounding them is what makes preemption real on a slow link. */
  async function drained(atGen: number, cap = 0, preempt = true): Promise<boolean> {
    while (open && (!preempt || gen === atGen) && socket.bufferedAmount > cap) await sleep(2);
    return open && (!preempt || gen === atGen);
  }

  // APP-LEVEL chunk flow control. bufferedAmount only sees the userland queue — the kernel and the
  // network hold megabytes more that preemption can never recall. The client cacks every binary
  // message on RECEIPT, so `sentChunks - cacked` is a true count of chunks in flight end-to-end;
  // holding it at ≤ CHUNK_WINDOW makes the preemption tail a constant ~2 chunks on ANY link.
  const CHUNK_WINDOW = 2;
  const inflight: { bytes: number; t: number; pre: number }[] = [];   // chunks on the wire, in order
  let cackWaiter: (() => void) | null = null;
  const gotCack = () => {
    const c = inflight.shift();
    if (c) {
      const dt = performance.now() - c.t;
      if (c.pre === 0) {
        // Sent onto an empty wire: dt ≈ RTT + bytes/BW — the cleanest RTT sample we get.
        rttMs = ew(rttMs, Math.max(1, dt - c.bytes / bwBpms), 0.2);
      }
      // Bandwidth sample from the part of dt that was not RTT. On a LAN that is sub-millisecond,
      // so the floor keeps the sample finite (and large) instead of skipping it — skipping fast
      // links left the estimate at its 24 Mbit/s seed and starved local density.
      const xfer = Math.max(0.5, dt - rttMs);
      bwBpms = Math.min(2e6, Math.max(50, ew(bwBpms, (c.pre + c.bytes) / xfer, 0.2)));
    }
    if (cackWaiter) { const r = cackWaiter; cackWaiter = null; r(); }
  };
  async function cackRoom(atGen: number, preempt = true): Promise<boolean> {
    while (open && (!preempt || gen === atGen) && inflight.length >= CHUNK_WINDOW) {
      const tw = performance.now();
      await new Promise<void>((res) => {
        cackWaiter = res;
        setTimeout(() => { if (cackWaiter === res) { cackWaiter = null; res(); } }, 250);
      });
      if (performance.now() - tw > 240) dbg(`cack TIMEOUT (inflight ${inflight.length}, buffered ${socket.bufferedAmount})`);
    }
    return open && (!preempt || gen === atGen);
  }

  /** PREEMPTABLE chunked send. At most ~one chunk beyond what has drained is ever committed to the
   *  wire, and new input aborts between chunks — so even a native 4K frame never blocks a fresh
   *  motion frame by more than ~one chunk. Returns false if aborted (the client, which assembles
   *  chunks and presents atomically, then simply never shows the partial frame). */
  let sentBytes = 0;      // compressed bytes of the frame currently being sent (feeds bppC)
  let encodeMs = 0;       // gzip time of the frame currently being sent (feeds encodePerPx)
  let genAt = 0;          // performance.now() of the last gen bump — the server side of finger-to-photon
  /** `preempt`: abort between chunks when input arrives. TRUE only for the long settle sends.
   *  A motion frame is never preempted: it is small by construction (the link model sized it to
   *  one frame period) and it is newer than anything the client holds — discarding it on every
   *  new event is how continuous input LIVELOCKED the pipeline into ~1 update/s. */
  async function sendFrameP(atGen: number, sw: number, sh: number, vw: number, vh: number, settled: number, raw: Uint8Array, kind = 0, px = 0, py = 0, pw = 0, ph = 0, renderMs = 0, preempt = true): Promise<boolean> {
    sentBytes = 0;
    const sinceInput = Math.min(65535, Math.round(performance.now() - genAt));
    // Encode the WHOLE frame first — AV1 (~0.05 ms hardware + a ~1 ms socket round-trip) or gzip.
    // AV1 frames are independent intra images so they cannot be split before decode; the encoded
    // bytes are then chunked for the WS proxy limit and the client reassembles before decoding.
    const te = performance.now();
    const { payload, codec } = await encodeWhole(raw, sw, sh, clientAv1);
    encodeMs = performance.now() - te;
    if (!open || (preempt && gen !== atGen)) return false;
    sentBytes = payload.length;
    const n = Math.max(1, Math.ceil(payload.length / CHUNK));
    for (let i = 0; i < n; i++) {
      if (!open || (preempt && gen !== atGen)) return false;
      const part = payload.subarray(i * CHUNK, Math.min(payload.length, (i + 1) * CHUNK));
      // header [5] = codec id; spare fields [13]/[14] carry the server's input→send / render split.
      const head = new Uint16Array([sw, sh, vw, vh, settled, codec, i, n, kind, px, py, pw, ph, sinceInput, Math.min(65535, Math.round(renderMs)), 0]);   // 32-byte header
      const frame = new Uint8Array(32 + part.length);
      frame.set(new Uint8Array(head.buffer), 0);
      frame.set(part, 32);
      if (!await cackRoom(atGen, preempt)) return false;   // ≤ CHUNK_WINDOW chunks in flight, end to end
      inflight.push({ bytes: frame.length, t: performance.now(), pre: inflight.reduce((n, c) => n + c.bytes, 0) });
      socket.send(frame);
      if (!await drained(atGen, CHUNK, preempt)) return false;
    }
    return true;
  }

  const sendHello = () => {
    // Each viewer starts from a CLEAN transform (module-level, one shared scene — reset so a prior
    // viewer's gizmo edits don't leak; the hello would otherwise replay them).
    if (xformTarget && gizmo) {
      xformM = identity();
      xformTarget.setWorldTransform(xformM);
      gizmo.setPivot(xformC0);
      gizmo.setActive(null);
      scene.syncUniforms();
    }
    socket.send(JSON.stringify({
      type: "hello", proto: PROTO, center, radius, name: sceneName, sceneUrl: SCENE_URL, demo: DEMO,
      rate: GPU_RATE_PER_HR, scaledownS: SCALEDOWN_S,
      scenes: SCENE_MENU, scene: currentScene,
      widget: xformTarget ? { center: xformC0, m: [...xformM] } : null,
    }));
  };
  socket.onopen = () => { open = true; sendHello(); loop(); };
  socket.onclose = () => { open = false; settleAck(false); };
  socket.onerror = () => { open = false; settleAck(false); };
  socket.onmessage = async (e) => {
    try {
      // A UNION, not an intersection: the message shapes have incompatible `type` fields.
      const m = JSON.parse(e.data as string) as CamMsg | XformMsg | { type: "ack" | "resync" | "cack" | "caps" | "scene"; av1?: boolean; scene?: string };
      if (m.type === "scene") {
        const name = (m as { scene?: string }).scene;
        if (typeof name !== "string" || name === currentScene || sceneLoading) return;
        if (!SCENE_MENU.some((x) => x.name === name && x.fits)) {
          socket.send(JSON.stringify({ type: "sceneError", message: `"${name}" is not available on this GPU` }));
          return;
        }
        sceneLoading = true;
        socket.send(JSON.stringify({ type: "loading", scene: name }));
        try { await loadScene(name); }
        catch (err) { socket.send(JSON.stringify({ type: "sceneError", message: (err as Error).message })); sceneLoading = false; return; }
        sceneLoading = false;
        resetClientModel("scene switch");
        gen++; abortWait();
        sendHello();   // new center/radius/scene name for the switched scene
        return;
      }
      if (m.type === "cam") {
        const c = m as CamMsg;
        // An IDENTICAL camera is not a change: re-sending it must not invalidate anything.
        const same = latest !== null && latest.w === c.w && latest.h === c.h && latest.a === c.a &&
          latest.p.every((v, i) => v === c.p[i]) && latest.f.every((v, i) => v === c.f[i]) &&
          latest.u.every((v, i) => v === c.u[i]);
        // A RESIZE means the client rebuilt its surface: everything we believe it holds is gone.
        if (latest === null || latest.w !== c.w || latest.h !== c.h) resetClientModel(`size ${c.w}x${c.h}`);
        latest = c;
        lastMsg = performance.now();
        if (!same) { gen++; genAt = performance.now(); abortWait(); }
      }
      else if (m.type === "caps") {
        clientAv1 = !!(m as { av1?: boolean }).av1 && sidecar !== null;
        dbg(`client caps: av1=${(m as { av1?: boolean }).av1} -> using ${clientAv1 ? "av1" : "gzip"}`);
      }
      else if (m.type === "ack") gotAck();
      else if (m.type === "cack") gotCack();
      else if (m.type === "resync") {
        // The client dropped a frame it could not apply. Start over from a full frame.
        resetClientModel("resync");
        gen++; gotAck();
      }
      else if (m.type === "xform" && xformTarget && gizmo) {
        const x = m as XformMsg;
        const a = Array.isArray(x.m) ? x.m : Object.values(x.m as unknown as Record<string, number>);
        if (a.length !== 16) return;             // ignore a malformed matrix rather than NaN the scene
        xformM = new Float32Array(a) as Mat4;
        xformTarget.setWorldTransform(xformM);
        gizmo.setPivot(x.pivot);
        gizmo.setActive(x.active);
        scene.syncUniforms();      // Tier-A: re-pack uniforms + ray-entry AABB, no rebuild
        lastMsg = performance.now();
        gen++; genAt = performance.now(); abortWait();   // a scene edit invalidates; the DIFF decides what to send
      }
    } catch { /* ignore */ }
  };

  /** Geometry of the PROBE trace — the cheap whole-view render whose only jobs are to answer
   *  "what changed?" and to cover the case where everything did. Its divisor answers to TWO limits
   *  and takes the stricter: the GPU (the probe must stay cheap to trace) and the link (when
   *  everything changed, the probe IS the frame). It snaps to 1/f and only moves after the answer
   *  disagrees twice running — the delta can only compare frames of the same geometry. */
  let probeF = 0, probeDisagree = 0;
  const divisor = (px: number, w: number, h: number) =>
    Math.max(1, Math.min(4, Math.round(1 / Math.max(0.25, Math.min(1, Math.sqrt(px / (w * h)))))));
  function probeSize(w: number, h: number): [number, number] {
    const want = Math.max(divisor(renderBudget.budgetPx, w, h), divisor(linkArea(w, h), w, h));
    if (probeF === 0) probeF = want;
    else if (want !== probeF) { if (++probeDisagree >= 2) { probeF = want; probeDisagree = 0; } }
    else probeDisagree = 0;
    return [Math.max(16, Math.round(w / probeF)), Math.max(16, Math.round(h / probeF))];
  }

  async function loop() {
    while (open) {
      if (sceneLoading) { await sleep(50); continue; }
      if (!latest) { await sleep(10); continue; }
      const { w, h, p, f, u, a } = latest;

      // ---- SETTLED: ONE native pass over the stale region, applied atomically. ------------------
      // The client presents it only when every chunk has arrived, so the view goes from "coarse but
      // coherent" to "native and coherent" in a single step — no block-by-block pop-in. Preemption
      // lives at every boundary: after the trace, after compression, and BETWEEN CHUNKS of the send.
      if (gen === sentGen) {
        // While the finger is DOWN a pause is usually mid-gesture: starting a native settle then
        // is work we will almost surely preempt and re-drain. Wait longer before committing.
        const idleMs = latest.dn ? 250 : IDLE_MS;
        if ((stale || needFull) && performance.now() - lastMsg > idleMs) {
          const atGen = gen;
          let r: Rect = needFull || !stale ? { x: 0, y: 0, w, h } : { ...stale };
          // clamp to the view
          const x0 = Math.max(0, Math.min(w, Math.floor(r.x))), y0 = Math.max(0, Math.min(h, Math.floor(r.y)));
          r = { x: x0, y: y0, w: Math.min(w - x0, Math.ceil(r.w)), h: Math.min(h - y0, Math.ceil(r.h)) };
          if (r.w <= 0 || r.h <= 0) { stale = null; continue; }
          if (r.w * r.h > 0.8 * w * h) r = { x: 0, y: 0, w, h };
          const full = r.w === w && r.h === h && r.x === 0 && r.y === 0;
          // TWO-STEP: when native would take a while to cross the link, first ship the same region
          // at HALF density (~1/4 the bytes) — a big, ATOMIC sharpening a few hundred ms after the
          // gesture ends — then the native pass. Kills "lingers degraded for a second, then snaps".
          const nativeEtaMs = (r.w * r.h * bppC) / bwBpms;
          const steps: number[] = nativeEtaMs > 400 ? [0.5, 1] : [1];
          let done = true;
          for (const den of steps) {
            const tw = Math.max(16, Math.round(r.w * den)), th = Math.max(16, Math.round(r.h * den));
            const tr0 = performance.now();
            if (full) scene.setCamera(p, f, u, a, w, h);
            else scene.setCameraTile(p, f, u, a, w, h, r);
            const raw = await scene.traceSamples(tw, th);
            const renderMs = performance.now() - tr0;
            if (!open || gen !== atGen) { dbg("settle abandoned after trace"); done = false; break; }
            const ok = await sendFrameP(atGen, tw, th, w, h, den === 1 ? 1 : 0, raw, full ? 0 : 1, r.x, r.y, r.w, r.h, renderMs);
            if (!ok) { dbg("settle send preempted"); done = false; break; }
            settleRect = unionRect(settleRect, r);   // motion must re-cover this on resume
            if (raw.length) bppC = Math.max(0.05, ew(bppC, sentBytes / (tw * th), 0.3));
            dbg(`settled ${den === 1 ? "native" : "half"} ${full ? "full" : "patch"} ${tw}x${th} ${(sentBytes / 1e3) | 0}kB`);
            await waitAck(2000);
          }
          if (done) { stale = null; needFull = false; }
          motionStreak = 0;
          continue;
        }
        await sleep(8); continue;
      }

      // ---- MOVING: probe the whole view cheaply, then ship only what differs. -------------------
      const [sw, sh] = probeSize(w, h);
      const renderedGen = gen;
      scene.setCamera(p, f, u, a, sw, sh);
      const t0 = performance.now();
      const bytes = await scene.traceSamples(sw, sh, h);   // view height: keeps the gizmo view-sized
      const probeMs = performance.now() - t0;
      probeMsE = ew(probeMsE, probeMs, 0.3);
      renderBudget.update(probeMs);
      if (!open) break;
      // NOT preempted here: input that landed during this ~10-50 ms trace does not make the frame
      // worthless — it is still newer than what the client shows, and the next iteration picks up
      // the newest input immediately after. (Discarding it was the continuous-input livelock.)

      const baseOk = !needFull && prevMotion !== null && motionW === sw && motionH === sh;
      let nDirty: number;
      if (baseOk) nDirty = diffTiles(prevMotion!, bytes, sw, sh, dirty);
      else { dirty.fill(1); nDirty = NTILES; }

      if (baseOk && nDirty === 0) { sentGen = renderedGen; continue; }   // nothing changed: send NOTHING

      const box = baseOk && nDirty / NTILES < 0.5 ? tileBBox(dirty, sw, sh) : null;
      const kx = w / sw, ky = h / sh;   // probe samples → view pixels
      let view = box && {
        x: Math.round(box.x * kx), y: Math.round(box.y * ky),
        w: Math.round(box.w * kx), h: Math.round(box.h * ky),
      };
      // First motion frame after a settle: also re-cover the region the settle painted, so the old
      // position cannot ghost through. If that pushes past half the view, drop to a full frame.
      if (settleRect && view) {
        view = unionRect(view, settleRect);
        const cx = Math.max(0, view.x), cy = Math.max(0, view.y);
        view = { x: cx, y: cy, w: Math.min(w - cx, view.w), h: Math.min(h - cy, view.h) };
        if (view.w * view.h > 0.5 * w * h) view = null;
      }
      settleRect = null;

      // Re-trace the changed rect at the density the LINK affords — up to NATIVE. Feed-forward
      // from measured bandwidth/RTT/bytes-per-pixel, so it adapts the moment the rect changes
      // size, instead of a lagging pixel budget frozen mid-interaction. The FIRST frame of a
      // motion burst is capped small: that frame IS the finger-to-photon response, and nothing
      // may make it expensive.
      let native = false, psw = sw, psh = sh;
      let payloadRaw: Uint8Array;
      if (performance.now() - lastMotionCommit > 400) motionStreak = 0;   // a new burst is starting
      if (view) {
        let area = linkArea(w, h);
        // The engage frame is the finger-to-photon response: HALF the sustainable area (and never
        // more than 0.25 MP), so it lands in well under a period; the stream escalates right after.
        if (motionStreak === 0) area = Math.min(area * 0.5, 0.25e6);
        const s2 = Math.min(1, Math.sqrt(area / (view.w * view.h)));
        psw = Math.max(16, Math.round(view.w * s2));
        psh = Math.max(16, Math.round(view.h * s2));
        scene.setCameraTile(p, f, u, a, w, h, view);
        const tr = performance.now();
        payloadRaw = await scene.traceSamples(psw, psh);   // tile projection: view focal is default
        renderPerPx = ew(renderPerPx, (performance.now() - tr) / (psw * psh), 0.3);
        native = psw >= view.w;
      } else {
        payloadRaw = bytes;
      }
      const renderMs = performance.now() - t0;
      const ok = view
        ? await sendFrameP(renderedGen, psw, psh, w, h, 0, payloadRaw, 1, view.x, view.y, view.w, view.h, renderMs, false)
        : await sendFrameP(renderedGen, sw, sh, w, h, 0, payloadRaw, 0, 0, 0, 0, 0, renderMs, false);
      if (!ok) break;      // only a closed socket stops a motion frame
      renderMsE = ew(renderMsE, renderMs, 0.3);
      {
        // Observed period vs what the model promised for this frame → trim toward target.
        const now = performance.now();
        if (lastCommitT && motionStreak > 0 && lastPredictedMs > 0) {
          const actual = now - lastCommitT;
          if (actual < 2000) trim = Math.min(1.5, Math.max(0.25, ew(trim, trim * (lastPredictedMs / actual), 0.25)));
        }
        lastCommitT = now;
        lastPredictedMs = periodMs();
      }
      const px = payloadRaw.length / 4;
      if (px) {
        bppC = Math.max(0.05, ew(bppC, sentBytes / px, 0.3));
        encodePerPx = ew(encodePerPx, encodeMs / px, 0.3);
      }
      motionStreak++; lastMotionCommit = performance.now();

      // Committed: the client now holds a view consistent with THIS probe.
      prevMotion = bytes; motionW = sw; motionH = sh;
      if (view) { if (!native) addStale(view); }
      else { needFull = false; addStale({ x: 0, y: 0, w, h }); }
      sentGen = renderedGen;
      dbg(`sent ${view ? `patch ${psw}x${psh}` : `full ${sw}x${sh}`} ${sentBytes / 1e3 | 0}kB${native ? " native" : ""} bw=${bwBpms | 0} rtt=${rttMs | 0} bpp=${bppC.toFixed(2)} r=${(renderPerPx * 1e6).toFixed(0)}ns e=${(encodePerPx * 1e6).toFixed(0)}ns P=${periodMs() | 0} trim=${trim.toFixed(2)} area=${(linkArea(w, h) / 1e6).toFixed(2)}MP`);
      await waitAck(500);
    }
  }
  return response;
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname === "/" ? "/remote.html" : url.pathname;
  path = path.replace(/\.\.+/g, "");   // no traversal
  try {
    const body = await Deno.readFile(CLIENT_DIR + path.replace(/^\//, ""));
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(body, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        // The page and its bundle MUST move in lockstep with the server: with no validators at all,
        // cache behaviour is undefined and a stale bundle speaks a stale protocol.
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

Deno.serve({ port: PORT }, (req) => {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") return handleWs(req);
  return serveStatic(req);
});
console.log(`[live-renderer] http://localhost:${PORT}/  (serving ${CLIENT_DIR})`);
