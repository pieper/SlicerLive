// Segment label cards — a reusable overlay that puts a museum-exhibit "card" on each segment of a loaded
// segmentation (name + coded terminology; click to expand voxels/volume/HU + Isolate/Hide/Reset). Wraps
// CardOverlay (render/label-cards.ts) with the per-segment stat + terminology + keep-out plumbing so any
// 3D demo (cards, SEGRoulette, …) can add it in a few lines: build a font atlas once, mountSegmentCards
// onto the 3D canvas + camera, call setScene() on load, and draw() inside the demo's 3D frame callback.

import type { Gpu } from "./device.ts";
import type { Vec3 } from "./mat4.ts";
import type { VtkCamera } from "./vtk-camera.ts";
import type { FontAtlas } from "./sdf-text.ts";
import { CardOverlay, type CardSpec, type CardStyle } from "./label-cards.ts";

interface CodedEntry { scheme: string; value: string; meaning: string }
interface SegTerm { type?: CodedEntry | null; region?: CodedEntry | null }
export interface CtLike { vol: Int16Array | Float32Array; dims: [number, number, number]; ijkToRAS: number[]; modality?: string }
export interface SegLike { lab: Uint8Array; terminology?: Record<number, SegTerm> }
export interface SegmentInfo { num: number; name: string; color: [number, number, number]; voxels: number }

/** Coded terminology → a body line under the name: a meaning that ADDS to the name (region / a differing
 *  type), else the code (e.g. "SRT T-71000"), so it never just echoes the label. Undefined when absent. */
function bodyText(term: SegTerm | undefined, name: string): string | undefined {
  if (!term || (!term.type && !term.region)) return undefined;
  const norm = (t?: string) => (t ?? "").trim().toLowerCase();
  const parts: string[] = [];
  if (term.type?.meaning && norm(term.type.meaning) !== norm(name)) parts.push(term.type.meaning);
  if (term.region?.meaning && norm(term.region.meaning) !== norm(name) && norm(term.region.meaning) !== norm(term.type?.meaning)) parts.push(term.region.meaning);
  if (!parts.length && term.type) parts.push(`${term.type.scheme} ${term.type.value}`.trim());
  return parts.length ? parts.join(" · ") : undefined;
}

interface Geom { corners: Vec3[] }
/** One pass over the labelmap: per-segment centroid (RAS anchor), voxel count, volume (cc), HU mean/std
 *  (CT), and ijk bbox corners (for the tight keep-out circle). Returns the ≤maxCards largest segments. */
function build(ct: CtLike, seg: SegLike, segments: SegmentInfo[], maxCards: number): { specs: CardSpec[]; geom: Geom[] } {
  const [nx, ny, nz] = ct.dims, M = ct.ijkToRAS;
  const isCT = (ct.modality ?? "CT") === "CT";
  const wanted = new Set([...segments].sort((a, b) => b.voxels - a.voxels).slice(0, maxCards).map((s) => s.num));
  const acc = new Map<number, { n: number; x: number; y: number; z: number; s: number; s2: number; lo: Vec3; hi: Vec3 }>();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const idx = (k * ny + j) * nx + i, v = seg.lab[idx]; if (!v || !wanted.has(v)) continue;
    let e = acc.get(v); if (!e) { e = { n: 0, x: 0, y: 0, z: 0, s: 0, s2: 0, lo: [i, j, k], hi: [i, j, k] }; acc.set(v, e); }
    e.n++; e.x += i; e.y += j; e.z += k;
    if (i < e.lo[0]) e.lo[0] = i; if (j < e.lo[1]) e.lo[1] = j; if (k < e.lo[2]) e.lo[2] = k;
    if (i > e.hi[0]) e.hi[0] = i; if (j > e.hi[1]) e.hi[1] = j; if (k > e.hi[2]) e.hi[2] = k;
    if (isCT) { const hu = ct.vol[idx]; e.s += hu; e.s2 += hu * hu; }
  }
  const voxMm3 = Math.abs(M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]));
  const ras = (i: number, j: number, k: number): Vec3 => [M[0] * i + M[1] * j + M[2] * k + M[3], M[4] * i + M[5] * j + M[6] * k + M[7], M[8] * i + M[9] * j + M[10] * k + M[11]];
  const term = seg.terminology ?? {};
  const specs: CardSpec[] = [], geom: Geom[] = [];
  for (const s of segments) {
    const e = acc.get(s.num); if (!e) continue;
    const c = ras(e.x / e.n, e.y / e.n, e.z / e.n);
    const hu = isCT ? { mean: e.s / e.n, std: Math.sqrt(Math.max(0, e.s2 / e.n - (e.s / e.n) ** 2)) } : undefined;
    specs.push({ anchorRAS: c, id: s.num, title: s.name, subtitle: bodyText(term[s.num], s.name), swatch: s.color, stat: { voxels: e.n, volumeCc: (e.n * voxMm3) / 1000, hu } });
    const [lx, ly, lz] = e.lo, [hx, hy, hz] = e.hi;
    geom.push({ corners: [[lx, ly, lz], [hx, ly, lz], [lx, hy, lz], [hx, hy, lz], [lx, ly, hz], [hx, ly, hz], [lx, hy, hz], [hx, hy, hz]].map(([i, j, k]) => ras(i, j, k)) });
  }
  return { specs, geom };
}

export interface SegmentCards {
  /** (Re)build cards from a freshly loaded case. Pass null to clear. */
  setScene(ct: CtLike | null, seg: SegLike | null, segments: SegmentInfo[]): void;
  /** Draw the cards over the 3D view — call inside the host's 3D frame callback. Returns whether the
   *  layout is still moving (host should keep the loop alive one more frame). */
  draw(view: GPUTextureView, w: number, h: number, dpr: number, dtSec: number): boolean;
  clear(): void;
  count(): number;
}

/** Wire a CardOverlay to a 3D canvas + camera. `apply` performs an Isolate/Hide/Reset on the host's
 *  segmentation; `redraw` kicks the host's 3D loop after an interaction. Click handling is capture-phase
 *  so a click that lands on a card never starts a camera orbit. */
export function mountSegmentCards(gpu: Gpu, format: GPUTextureFormat, font: FontAtlas, canvas: HTMLCanvasElement, camera: VtkCamera, hooks: {
  apply: (id: number, action: "isolate" | "hide" | "reset", segments: SegmentInfo[]) => void;
  redraw: () => void;
  style?: CardStyle;
  maxCards?: number;
}): SegmentCards {
  const overlay = new CardOverlay(gpu, format, font, hooks.style);
  const dpr = globalThis.devicePixelRatio || 1;
  let geom: Geom[] = [];
  let segs: SegmentInfo[] = [];

  const px = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr }; };
  let down: { x: number; y: number; hit: boolean } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    const p = px(e);
    if (overlay.hitTest(p.x, p.y)) { down = { x: e.clientX, y: e.clientY, hit: true }; e.stopPropagation(); canvas.setPointerCapture(e.pointerId); }
    else down = { x: e.clientX, y: e.clientY, hit: false };
  }, true);
  canvas.addEventListener("pointerup", (e) => {
    if (down?.hit && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      const p = px(e), h = overlay.hitTest(p.x, p.y);
      if (h) { if (h.action === "toggle") overlay.toggle(h.index); else { const spec = overlay.spec(h.index); if (spec?.id != null) hooks.apply(spec.id, h.action, segs); } hooks.redraw(); }
    }
    down = null;
  }, true);

  return {
    setScene(ct, seg, segments) {
      segs = segments;
      if (!ct || !seg) { geom = []; overlay.setCards([], dpr); return; }
      const r = build(ct, seg, segments, hooks.maxCards ?? 12);
      geom = r.geom; overlay.setCards(r.specs, dpr);
    },
    draw(view, w, h, _dpr, dt) {
      if (!geom.length) return false;
      const keepOuts = geom.map((g, i) => {
        const cc = camera.worldToDisplay(overlay.spec(i)!.anchorRAS as Vec3, w, h);
        let r = 0; for (const c of g.corners) { const p = camera.worldToDisplay(c, w, h); if (p.depth > 0) r = Math.max(r, Math.hypot(p.x - cc.x, p.y - cc.y)); }
        return { x: cc.x, y: cc.y, radius: r };
      });
      overlay.render(view, camera, { w, h, dpr }, dt, keepOuts);
      return !overlay.settled();
    },
    clear() { geom = []; overlay.setCards([], dpr); },
    count() { return geom.length; },
  };
}
