// "Islands within islands" demo: a random MULTI-MATERIAL labelmap (organs with embedded tumors,
// tumors with necrotic cores, touching cyst clusters, vessels threading an organ) rendered through the
// multi-material INTERFACE field — SegmentationLogic boundaryMode "all". One unsigned distance-to-any-
// label-change field surfaces EVERY interface, including internal label↔label ones, with per-region
// colour and per-segment opacity — so nested/embedded structures are visible without one SDF per
// segment. The stress test for the label↔label boundary case the outer-only shell couldn't show.
//
// Composition/app layer: may import all three engines; the engines stay independent (glued by logic).
import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import type { Vec3 } from "../../render/mat4.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";

const PALETTE: [number, number, number][] = [
  [0.85, 0.45, 0.35], [0.30, 0.85, 0.55], [0.35, 0.65, 0.95], [0.95, 0.80, 0.35],
  [0.90, 0.35, 0.55], [0.55, 0.45, 0.95], [0.35, 0.85, 0.90], [0.95, 0.60, 0.30],
  [0.60, 0.80, 0.40], [0.90, 0.55, 0.85], [0.50, 0.60, 0.90], [0.80, 0.82, 0.86],
];

export interface LabelLook { id: number; color: [number, number, number]; op: number; shading: "surface" | "volume" }
export interface IslandsScene {
  scene: SceneRenderer;
  seg: EditableSegmentation;
  logic: SegmentationLogic;
  center: Vec3;
  radius: number;
  dims: Vec3;
  labels: () => LabelLook[];
  onRedraw(cb: () => void): void;
  /** Generate a fresh random nested labelmap (new common scenarios) and rebake. */
  regenerate(seed?: number): void;
  /** Force the settle-refine now (JFA+2 + seam blend) — for tests / thumbnails. */
  refine(): void;
  /** Random per-segment opacity + surface/volume shading, so the options show at a glance. */
  randomizeLook(): void;
  /** Depth-based default look: outer shells translucent, inner cores opaque (nesting readable). */
  resetLook(): void;
  setAllOpacity(op: number): void;
  destroy(): void;
}

export function buildIslandsScene(gpu: Gpu, format?: GPUTextureFormat, opts: { refineDelayMs?: number; dim?: number } = {}): IslandsScene {
  const N = opts.dim ?? 112;
  const dims: Vec3 = [N, N, N];
  const sp = 1.6;
  const ijkToRAS = [sp, 0, 0, -sp * N / 2, 0, sp, 0, -sp * N / 2, 0, 0, sp, -sp * N / 2, 0, 0, 0, 1];
  const [nx, ny, nz] = dims;
  const lab = new Uint8Array(nx * ny * nz);

  // ---- geometry primitives (write into the labelmap; later ids overwrite → natural nesting) ----
  const put = (test: (x: number, y: number, z: number) => boolean, id: number) => {
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (test(x, y, z)) lab[(z * ny + y) * nx + x] = id;
    }
  };
  const ball = (c: Vec3, r: number, id: number) => put((x, y, z) => (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= r * r, id);
  const ellipsoid = (c: Vec3, rr: Vec3, id: number) => put((x, y, z) => ((x - c[0]) / rr[0]) ** 2 + ((y - c[1]) / rr[1]) ** 2 + ((z - c[2]) / rr[2]) ** 2 <= 1, id);
  const tube = (a: Vec3, b: Vec3, r: number, id: number) => {   // capsule between a and b
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    put((x, y, z) => {
      let t = ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + t * ab[0], py = a[1] + t * ab[1], pz = a[2] + t * ab[2];
      return (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 <= r * r;
    }, id);
  };
  const R = (a: number, b: number) => a + Math.random() * (b - a);
  const jitter = (c: Vec3, d: number): Vec3 => [c[0] + R(-d, d), c[1] + R(-d, d), c[2] + R(-d, d)];

  // ---- common scenarios; each returns the LabelLook descriptors it added ----
  let next = 1;
  const color = (id: number): [number, number, number] => PALETTE[(id - 1) % PALETTE.length];
  const scenarioOrganWithTumors = (): LabelLook[] => {
    const out: LabelLook[] = [];
    const c: Vec3 = [R(0.3, 0.7) * nx, R(0.35, 0.65) * ny, R(0.35, 0.65) * nz];
    const rr: Vec3 = [R(0.16, 0.24) * nx, R(0.14, 0.22) * ny, R(0.16, 0.24) * nz];
    const organ = next++; ellipsoid(c, rr, organ);
    out.push({ id: organ, color: color(organ), op: 0.3, shading: "surface" });
    const nT = 2 + Math.floor(R(0, 3));
    for (let i = 0; i < nT; i++) {
      const tc = jitter(c, Math.min(...rr) * 0.7);
      const tr = R(0.05, 0.10) * nx;
      const tumor = next++; ball(tc, tr, tumor);
      out.push({ id: tumor, color: color(tumor), op: 0.7, shading: "surface" });
      if (Math.random() < 0.6) { const core = next++; ball(tc, tr * R(0.4, 0.6), core); out.push({ id: core, color: color(core), op: 1, shading: "surface" }); }
    }
    return out;
  };
  const scenarioNested = (): LabelLook[] => {   // concentric layers = islands within islands within islands
    const out: LabelLook[] = [];
    const c: Vec3 = [R(0.35, 0.65) * nx, R(0.35, 0.65) * ny, R(0.35, 0.65) * nz];
    let r = R(0.18, 0.26) * nx;
    const layers = 3 + Math.floor(R(0, 2));
    for (let i = 0; i < layers; i++) { const id = next++; ball(c, r, id); out.push({ id, color: color(id), op: i === 0 ? 0.3 : (i === layers - 1 ? 1 : 0.6), shading: "surface" }); r *= R(0.55, 0.72); }
    return out;
  };
  const scenarioCluster = (): LabelLook[] => {   // touching cyst cluster → many label↔label seams
    const out: LabelLook[] = [];
    const c: Vec3 = [R(0.35, 0.65) * nx, R(0.35, 0.65) * ny, R(0.35, 0.65) * nz];
    const nB = 3 + Math.floor(R(0, 3));
    for (let i = 0; i < nB; i++) { const id = next++; ball(jitter(c, 0.1 * nx), R(0.07, 0.11) * nx, id); out.push({ id, color: color(id), op: R(0.5, 1), shading: "surface" }); }
    return out;
  };
  const scenarioVesselOrgan = (): LabelLook[] => {   // vessels threading through a translucent organ
    const out: LabelLook[] = [];
    const c: Vec3 = [R(0.35, 0.65) * nx, R(0.4, 0.6) * ny, R(0.4, 0.6) * nz];
    const rr: Vec3 = [R(0.18, 0.26) * nx, R(0.14, 0.2) * ny, R(0.16, 0.22) * nz];
    const organ = next++; ellipsoid(c, rr, organ); out.push({ id: organ, color: color(organ), op: 0.28, shading: "surface" });
    const vessel = next++;
    const nSeg = 3;
    let p: Vec3 = jitter(c, Math.min(...rr));
    for (let i = 0; i < nSeg; i++) { const q = jitter(c, Math.min(...rr) * 0.9); tube(p, q, R(0.02, 0.035) * nx, vessel); p = q; }
    out.push({ id: vessel, color: color(vessel), op: 1, shading: "surface" });
    return out;
  };
  const SCENARIOS = [scenarioOrganWithTumors, scenarioNested, scenarioCluster, scenarioVesselOrgan];

  let looks: LabelLook[] = [];
  const generate = () => {
    lab.fill(0); next = 1; looks = [];
    const nS = 2 + Math.floor(R(0, 2));
    for (let i = 0; i < nS; i++) looks.push(...SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)]());
  };
  generate();

  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf", boundaryMode: "all", opacity: 1.0, refineDelayMs: opts.refineDelayMs });
  const applyLooks = () => { for (const lk of looks) { logic.setLabelColor(lk.id, lk.color); logic.setLabelOpacity(lk.id, lk.op); logic.setLabelShading(lk.id, lk.shading); } };
  applyLooks();
  seg.loadLabelmap(lab);
  logic.refineNow();

  const scene = new SceneRenderer(gpu, format);
  const redrawCbs: Array<() => void> = [];
  logic.onRedraw(() => { for (const cb of redrawCbs) cb(); });
  scene.build([logic.field()]);
  scene.setBackground(0.05, 0.06, 0.09);

  const center: Vec3 = [0, 0, 0];
  const radius = sp * N * 0.5 * Math.SQRT2;

  return {
    scene, seg, logic, center, radius, dims,
    labels: () => looks,
    onRedraw(cb) { redrawCbs.push(cb); },
    regenerate() { generate(); applyLooks(); seg.loadLabelmap(lab); logic.refineNow(); for (const cb of redrawCbs) cb(); },
    refine() { logic.refineNow(); },
    randomizeLook() {
      for (const lk of looks) { lk.op = 0.3 + Math.random() * 0.7; lk.shading = Math.random() < 0.5 ? "surface" : "volume"; }
      applyLooks(); logic.refineNow();
    },
    resetLook() { for (const lk of looks) lk.shading = "surface"; applyLooks(); logic.refineNow(); },
    setAllOpacity(op) { for (const lk of looks) lk.op = op; applyLooks(); logic.refineNow(); },
    destroy() { logic.destroy(); seg.destroy(); },
  };
}
