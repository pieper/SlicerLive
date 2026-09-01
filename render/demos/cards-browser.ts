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

/** Per-segment centroid in RAS, from the labelmap on its own (CT) grid. */
function centroids(lab: Uint8Array, dims: [number, number, number], M: number[]): Map<number, Vec3> {
  const [nx, ny, nz] = dims;
  const acc = new Map<number, { n: number; x: number; y: number; z: number }>();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = lab[(k * ny + j) * nx + i]; if (!v) continue;
    let e = acc.get(v); if (!e) { e = { n: 0, x: 0, y: 0, z: 0 }; acc.set(v, e); }
    e.n++; e.x += i; e.y += j; e.z += k;
  }
  const out = new Map<number, Vec3>();
  for (const [v, e] of acc) {
    const cx = e.x / e.n, cy = e.y / e.n, cz = e.z / e.n;
    out.set(v, [M[0] * cx + M[1] * cy + M[2] * cz + M[3], M[4] * cx + M[5] * cy + M[6] * cz + M[7], M[8] * cx + M[9] * cy + M[10] * cz + M[11]]);
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

  // per-segment RAS anchor (centroid), and the ≤12 largest segments as cards
  const cen = centroids(res.seg.lab, res.ct.dims, res.ct.ijkToRAS);
  const term = res.seg.terminology ?? {};
  const chosen = [...sc.segments].sort((a, b) => b.voxels - a.voxels).slice(0, MAX_CARDS);
  const specs: CardSpec[] = chosen.flatMap((s) => {
    const a = cen.get(s.num); if (!a) return [];
    return [{ anchorRAS: a, title: s.name, body: bodyText(term[s.num] as Term | undefined, s.name), accent: s.color }];
  });

  const dpr = globalThis.devicePixelRatio || 1;
  const font = buildFontAtlas({ sizePx: 44, spread: 6 });
  const overlay = new CardOverlay(gpu, srgb, font);
  overlay.setCards(specs, dpr);
  // test/introspection hook: what cards were built (a screenshot is the pixel ground truth for rendering)
  (globalThis as unknown as { __cards?: unknown }).__cards = { count: specs.length, titles: specs.map((s) => s.title), bodies: specs.map((s) => s.body ?? null) };
  setStatus(`${specs.length} segment${specs.length === 1 ? "" : "s"} — drag to orbit`);

  const camera = framedCamera(sc.center, sc.radius);
  attachCameraControls(canvas, camera, { onChange: () => {/* continuous loop redraws */} });

  const resize = () => { canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr)); canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr)); };
  resize(); addEventListener("resize", resize);

  let last = performance.now();
  const frame = () => {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    const w = canvas.width, h = canvas.height;
    const view = ctx.getCurrentTexture().createView({ format: srgb });
    sc.scene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h);
    sc.scene.renderToView(view, w, h);
    overlay.render(view, camera, { w, h, dpr }, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((e) => { console.error(e); setStatus("error: " + (e as Error).message); });
