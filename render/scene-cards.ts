// Scene-native segment label cards: glass-slab CardFields + yarn-thread CapsuleFields composited in the
// SAME ray-march as the anatomy (no screen overlay). Reusable across demos. The force-directed layout
// (render/label-layout.ts) runs in screen space; each card is billboarded into world space (camera-facing)
// and the thread is a real 3D cylinder from the card to the segment centroid. Click a card to expand /
// trigger Isolate·Hide·Reset (the host applies opacity).

import type { Gpu } from "./device.ts";
import type { Vec3 } from "./mat4.ts";
import type { VtkCamera } from "./vtk-camera.ts";
import type { Field } from "./fields.ts";
import { CardField } from "./card-field.ts";
import { CapsuleField } from "./capsule-field.ts";
import { bakeCardFace, type CardContent, uploadCard } from "./card-bake.ts";
import { type CardBody, layoutStep, seedCards } from "./label-layout.ts";

interface Coded { scheme: string; value: string; meaning: string }
interface Term { type?: Coded | null; region?: Coded | null }
export interface CtLike { vol: Int16Array | Float32Array; dims: [number, number, number]; ijkToRAS: number[]; modality?: string }
export interface SegLike { lab: Uint8Array; terminology?: Record<number, Term> }
export interface SegmentInfo { num: number; name: string; color: [number, number, number]; voxels: number }
export interface SceneApi { setExtraFields(f: Field[]): void; sync(): void; center(): Vec3; radius(): number; setSegmentOpacity(num: number, o: number): void }

const BUTTONS = ["Isolate", "Hide", "Reset opacities"];
const HALF_THICK = 4.75;   // mm (~3/8" glass)

function bodyText(term: Term | undefined, name: string): string | undefined {
  if (!term || (!term.type && !term.region)) return undefined;
  const nz = (t?: string) => (t ?? "").trim().toLowerCase();
  const parts: string[] = [];
  if (term.type?.meaning && nz(term.type.meaning) !== nz(name)) parts.push(term.type.meaning);
  if (term.region?.meaning && nz(term.region.meaning) !== nz(name) && nz(term.region.meaning) !== nz(term.type?.meaning)) parts.push(term.region.meaning);
  if (!parts.length && term.type) parts.push(`${term.type.scheme} ${term.type.value}`.trim());
  return parts.length ? parts.join(" · ") : undefined;
}

interface Card {
  num: number; content: CardContent; anchorRAS: Vec3; corners: Vec3[];   // bbox corners for keep-out
  field: CardField; texW: number; texH: number; expanded: boolean;
}

const nrm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const crs = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface SceneCards {
  setScene(ct: CtLike | null, seg: SegLike | null, segments: SegmentInfo[]): void;
  /** Force layout + billboard + threads for one frame; call BEFORE the scene renders. Returns moving. */
  update(vpW: number, vpH: number, dtSec: number): boolean;
  clear(): void;
  count(): number;
}

export function mountSceneCards(gpu: Gpu, camera: VtkCamera, canvas: HTMLCanvasElement, api: SceneApi, hooks: { maxCards?: number } = {}): SceneCards {
  const dev = gpu.device;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  let cards: Card[] = [];
  let bodies: CardBody[] = [];
  const threads = new CapsuleField([], { screenSpace: false });   // world-space yarn
  let big: [Vec3, Vec3] = [[-1, -1, -1], [1, 1, 1]];

  const bake = (c: Card) => {
    const b = bakeCardFace(c.content, dpr);
    c.texW = b.w; c.texH = b.h;
    const tex = uploadCard(dev, b);
    if (c.field) c.field.setTexture(tex); else c.field = new CardField(tex, { aabb: big, glassOpacity: 0.82 });
  };

  const rebuildContent = (c: Card) => {
    const s = c.content;
    c.content = { ...s, expanded: c.expanded, lines: c.expanded ? s.lines : undefined, buttons: c.expanded ? BUTTONS : undefined };
    bake(c);
  };

  const setScene: SceneCards["setScene"] = (ct, seg, segments) => {
    for (const c of cards) c.field.dispose?.();
    cards = []; bodies = [];
    if (!ct || !seg) { threads.setSegments([]); api.setExtraFields([]); return; }
    const ctr = api.center(), rad = api.radius(), R = rad * 1.7; big = [[ctr[0]-R, ctr[1]-R, ctr[2]-R], [ctr[0]+R, ctr[1]+R, ctr[2]+R]];
    // per-segment stats + bbox corners (one labelmap pass)
    const [nx, ny, nz] = ct.dims, M = ct.ijkToRAS, isCT = (ct.modality ?? "CT") === "CT";
    const wanted = new Set([...segments].sort((a, b) => b.voxels - a.voxels).slice(0, hooks.maxCards ?? 12).map((s) => s.num));
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
    for (const s of segments) {
      const e = acc.get(s.num); if (!e) continue;
      const lines = [`${e.n.toLocaleString("en-US")} voxels`, `${((e.n * voxMm3) / 1000).toFixed(1)} cc`];
      if (isCT) { const m = e.s / e.n; lines.push(`${m.toFixed(0)} ± ${Math.sqrt(Math.max(0, e.s2 / e.n - m * m)).toFixed(0)} HU`); }
      const c: Card = {
        num: s.num, anchorRAS: ras(e.x / e.n, e.y / e.n, e.z / e.n),
        corners: [[e.lo[0], e.lo[1], e.lo[2]], [e.hi[0], e.lo[1], e.lo[2]], [e.lo[0], e.hi[1], e.lo[2]], [e.hi[0], e.hi[1], e.lo[2]], [e.lo[0], e.lo[1], e.hi[2]], [e.hi[0], e.lo[1], e.hi[2]], [e.lo[0], e.hi[1], e.hi[2]], [e.hi[0], e.hi[1], e.hi[2]]].map(([i, j, k]) => ras(i, j, k)),
        content: { title: s.name, subtitle: bodyText(term[s.num], s.name), swatch: s.color, lines }, field: undefined as unknown as CardField, texW: 0, texH: 0, expanded: false,
      };
      bake(c);
      cards.push(c);
    }
    api.setExtraFields([...cards.map((c) => c.field), threads]);
    bodies = [];
  };

  const cardScreenSize = (i: number) => { const c = cards[i]; return { w: c.texW / dpr, h: c.texH / dpr }; };   // css px

  const update: SceneCards["update"] = (vpW, vpH, dtSec) => {
    if (!cards.length) return false;
    const anchors = cards.map((c) => camera.worldToDisplay(c.anchorRAS, vpW, vpH));
    const anchorsPx = anchors.map((a) => ({ x: a.x, y: a.y }));
    const sizes = cards.map((_, i) => cardScreenSize(i));
    if (bodies.length !== cards.length) bodies = seedCards(anchorsPx, sizes);
    else for (let i = 0; i < bodies.length; i++) { bodies[i].w = sizes[i].w; bodies[i].h = sizes[i].h; }
    // keep-out: per-segment projected circle
    const keepOuts = cards.map((c, i) => { const cc = anchors[i]; let r = 0; for (const p of c.corners) { const q = camera.worldToDisplay(p, vpW, vpH); if (q.depth > 0) r = Math.max(r, Math.hypot(q.x - cc.x, q.y - cc.y)); } return { x: cc.x, y: cc.y, radius: r }; });
    layoutStep(bodies, anchorsPx, { w: vpW, h: vpH }, dtSec, { keepOuts });

    // camera basis for billboards
    const n = nrm([camera.position[0] - camera.focalPoint[0], camera.position[1] - camera.focalPoint[1], camera.position[2] - camera.focalPoint[2]]);
    const right = nrm(crs(camera.viewUp as Vec3, n)), up = crs(n, right);
    const depth = camera.worldToDisplay(api.center(), vpW, vpH).depth;
    const focalPx = (vpH / 2) / Math.tan((camera.viewAngle * Math.PI) / 360);
    const mmPerPx = depth / Math.max(focalPx, 1);
    const segs: { a: Vec3; b: Vec3; radius: number; color: [number, number, number, number] }[] = [];
    let moving = false;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i], b = bodies[i], a = anchors[i];
      const vis = a.depth > 0;
      const hu = (b.w / 2) * mmPerPx, hv = (b.h / 2) * mmPerPx;
      const world = camera.displayToWorldAtDepth(b.x, b.y, depth - (HALF_THICK + 3 + i * 0.6), vpW, vpH) as Vec3;
      c.field.setBillboard(world, right, up, n, vis ? hu : 0, vis ? hv : 0, HALF_THICK, 6 * dpr * mmPerPx);
      if (vis) {
        // yarn thread from the card's lower edge toward the segment centroid
        const edge: Vec3 = [world[0] - up[0] * hv, world[1] - up[1] * hv, world[2] - up[2] * hv];
        segs.push({ a: edge, b: c.anchorRAS, radius: Math.max(0.8, mmPerPx * 1.6), color: [0.12, 0.12, 0.14, 1] });
      }
      if (Math.hypot(b.vx, b.vy) > 1.5) moving = true;
    }
    threads.setSegments(segs);
    api.sync();
    return moving;
  };

  // click: hit-test in screen space against the card bodies (topmost first)
  const px = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left), y: (e.clientY - r.top) }; };
  const hit = (x: number, y: number): { i: number; button: number } | null => {
    for (let i = cards.length - 1; i >= 0; i--) {
      const b = bodies[i]; if (!b) continue;
      if (x < b.x / dpr - b.w / 2 || x > b.x / dpr + b.w / 2 || y < b.y / dpr - b.h / 2 || y > b.y / dpr + b.h / 2) continue;
      if (cards[i].expanded) { const ly = (y - (b.y / dpr - b.h / 2)); const bh = 22; const top = b.h - (BUTTONS.length * bh) - 8; for (let k = 0; k < BUTTONS.length; k++) if (ly >= top + k * bh && ly <= top + (k + 1) * bh) return { i, button: k }; }
      return { i, button: -1 };
    }
    return null;
  };
  let down: { x: number; y: number; hit: boolean } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    const p = px(e);
    if (hit(p.x, p.y)) { down = { x: e.clientX, y: e.clientY, hit: true }; e.stopPropagation(); canvas.setPointerCapture(e.pointerId); }
    else down = { x: e.clientX, y: e.clientY, hit: false };
  }, true);
  canvas.addEventListener("pointerup", (e) => {
    if (down?.hit && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      const p = px(e), h = hit(p.x, p.y);
      if (h) {
        if (h.button < 0) { cards[h.i].expanded = !cards[h.i].expanded; rebuildContent(cards[h.i]); api.setExtraFields([...cards.map((c) => c.field), threads]); }
        else { const id = cards[h.i].num; if (h.button === 0) for (const c of cards) api.setSegmentOpacity(c.num, c.num === id ? 1 : 0.4); else if (h.button === 1) api.setSegmentOpacity(id, 0); else for (const c of cards) api.setSegmentOpacity(c.num, 1); }
      }
    }
    down = null;
  }, true);

  return { setScene, update, clear: () => setScene(null, null, []), count: () => cards.length };
}
