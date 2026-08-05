// Multi-label demo scene: the layered `algorithms/` + `logic/` + `render/` proof, headless-capable
// (same builder runs under Deno render-to-PNG and in the browser). EditableSegmentation (algorithms)
// owns the master labelmap; SegmentationLogic (logic) glues it to a colorized surface (render); the
// demo composes all three. Each poke/stroke gets a DISTINCT label id + colour, so a complex labelmap
// renders with per-label colours and colour seams where different-label neighbours meet.
//
// This file is the composition/app layer, so it may import all three engines; the engines themselves
// stay independent (algorithms ⊥ render, glued only by logic).
import type { Gpu } from "../../render/device.ts";
import { SceneRenderer } from "../../render/scene-renderer.ts";
import type { Vec3 } from "../../render/mat4.ts";
import { EditableSegmentation } from "../editable-segmentation.ts";
import { PaintEffect } from "../effects/paint.ts";
import { SegEditDriver } from "../seg-edit-driver.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";

// A distinct, well-separated colour per label (cycled past the 12th).
const LABEL_COLORS: [number, number, number][] = [
  [0.30, 0.85, 0.55], [0.35, 0.65, 0.95], [0.95, 0.60, 0.30], [0.90, 0.35, 0.45],
  [0.70, 0.45, 0.95], [0.35, 0.85, 0.90], [0.95, 0.85, 0.35], [0.95, 0.50, 0.80],
  [0.55, 0.80, 0.35], [0.50, 0.55, 0.90], [0.90, 0.70, 0.50], [0.80, 0.80, 0.85],
];

export interface AlgorithmsScene {
  scene: SceneRenderer;
  seg: EditableSegmentation;
  paint: PaintEffect;
  driver: SegEditDriver;      // consumes SegEdit ops (A-1); each unique segmentId → a new coloured label
  center: Vec3;
  radius: number;
  dims: Vec3;
  /** Stamp a sphere dab of a NEW coloured label through the shared buffer. */
  poke(centerRAS: Vec3, radiusMm: number): void;
  /** Called after any edit (post-rebake) so the app redraws. Persists across render-mode swaps. */
  onRedraw(cb: () => void): void;
  /** Swap the render path (sdf ↔ surface) live, preserving the painted segmentation + colours. */
  setRenderMode(mode: "sdf" | "surface"): void;
  renderMode(): "sdf" | "surface";
  /** Force the settle-refine now (JFA+2 + seam blend) — for tests / thumbnails. */
  refine(): void;
  /** Set every label's opacity (0..1) — 1 = opaque surfaces, <1 = translucent surface models (see
   *  through outer segments to inner ones). Persists across render-mode swaps. */
  setAllOpacity(opacity: number): void;
  allOpacity(): number;
  /** Assign each segment a RANDOM opacity + random surface/volume shading, so the options are visible
   *  at a glance. Persists across render-mode swaps. */
  randomizeLook(): void;
  /** Reset every segment to opaque surface shading. */
  resetLook(): void;
}

export function buildAlgorithmsScene(gpu: Gpu, format?: GPUTextureFormat, opts: { refineDelayMs?: number } = {}): AlgorithmsScene {
  const dims: Vec3 = [96, 96, 96];
  const sp = 2; // 2 mm isotropic
  // Row-major voxel-center → RAS: 2 mm spacing, centred so voxel (48,48,48) → RAS origin.
  const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const paint = new PaintEffect(seg);

  // Label allocation: each unique key (a stroke's segmentId, or a poke) → a fresh id + colour. Colours
  // are remembered so they survive a render-mode swap (which rebuilds the logic).
  const keyToId = new Map<string, number>();
  const labelColors: Array<[number, [number, number, number]]> = [];
  // Per-label look (opacity + surface/volume shading), remembered so it survives a render-mode swap.
  const labelLook = new Map<number, { op: number; shading: "surface" | "volume" }>();
  let nextId = 1;
  const applyLook = (id: number) => {
    const lk = labelLook.get(id)!;
    logic.setLabelOpacity(id, lk.op); logic.setLabelShading(id, lk.shading);
  };
  const allocId = (key: string): number => {
    let id = keyToId.get(key);
    if (id !== undefined) return id;
    id = nextId++;
    const rgb = LABEL_COLORS[(id - 1) % LABEL_COLORS.length];
    keyToId.set(key, id);
    labelColors.push([id, rgb]);
    labelLook.set(id, { op: 1, shading: "surface" });
    logic.setLabelColor(id, rgb); applyLook(id);
    return id;
  };

  const scene = new SceneRenderer(gpu, format);

  // The render path is swappable (sdf = crisp terrace-free default; surface = Gaussian gradient-
  // opacity). A swap rebuilds the SegmentationLogic over the SAME master (content preserved) and
  // rebuilds the scene fields; the label colours are replayed so they persist. setBackground must
  // FOLLOW scene.build (build re-creates the uniform buffer), so it's re-applied inside makeLogic.
  const redrawCbs: Array<() => void> = [];
  let mode: "sdf" | "surface" = "sdf";
  let logic!: SegmentationLogic;
  let allOpacity = 1;
  const makeLogic = () => {
    logic = new SegmentationLogic(gpu.device, seg, { renderMode: mode, opacity: 1.0, sigmaVoxels: 1.0, refineDelayMs: opts.refineDelayMs });
    for (const [id, rgb] of labelColors) { logic.setLabelColor(id, rgb); applyLook(id); }   // persist colours + look across swaps
    logic.onRedraw(() => { for (const cb of redrawCbs) cb(); });
    scene.build([logic.field()]);
    scene.setBackground(0.05, 0.06, 0.09);
  };
  makeLogic();

  // Each unique segmentId in the SegEdit stream → a new coloured label.
  const driver = new SegEditDriver(seg, { labelForSegment: (segId) => allocId(segId) });

  // Seed an initial sphere (id 1) via the CPU load path (proves loadLabelmap): ~15-voxel radius at centre.
  allocId("seed");   // → id 1, first colour
  const [nx, ny, nz] = dims;
  const lab = new Uint8Array(nx * ny * nz);
  const c = [48, 48, 48], rv = 15;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    if (dx * dx + dy * dy + dz * dz <= rv * rv) lab[(z * ny + y) * nx + x] = 1;
  }
  seg.loadLabelmap(lab);

  const center: Vec3 = [0, 0, 0];
  const radius = Math.hypot(96, 96, 96); // half-extent of the grid in mm
  let pokeN = 0;

  return {
    scene, seg, paint, driver, center, radius, dims,
    poke(centerRAS, radiusMm) { paint.stampStroke([centerRAS], { radiusMm, id: allocId(`poke_${pokeN++}`), mode: "add" }); },
    onRedraw(cb) { redrawCbs.push(cb); },
    setRenderMode(m) {
      if (m === mode) return;
      logic.destroy();          // unsubscribes its onDirty + frees GPU textures
      mode = m;
      makeLogic();              // new logic over the SAME master (content + colours preserved) + rebuild scene
      for (const cb of redrawCbs) cb();
    },
    renderMode: () => mode,
    refine() { logic.refineNow(); },
    setAllOpacity(op) {
      allOpacity = op;
      for (const [id] of labelColors) { labelLook.get(id)!.op = op; applyLook(id); }
      logic.refineNow();   // rebakes attr + redraws
    },
    allOpacity: () => allOpacity,
    randomizeLook() {
      for (const [id] of labelColors) {
        const lk = { op: 0.3 + Math.random() * 0.7, shading: (Math.random() < 0.5 ? "surface" : "volume") as "surface" | "volume" };
        labelLook.set(id, lk); applyLook(id);
      }
      logic.refineNow();   // rebakes attr (opacity + shading) + redraws
    },
    resetLook() {
      allOpacity = 1;
      for (const [id] of labelColors) { labelLook.set(id, { op: 1, shading: "surface" }); applyLook(id); }
      logic.refineNow();
    },
  };
}
