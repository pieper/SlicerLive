// A-0 scene: the layered `algorithms/` + `logic/` + `render/` proof, headless-capable (same builder
// runs under Deno render-to-PNG and in the browser). EditableSegmentation (algorithms) owns the
// master labelmap; SegmentationLogic (logic) glues it to a surface-mode SegmentField (render); the
// demo composes all three. A "poke" stamps another sphere on-GPU through the shared master and the
// render updates in place — no editing UI, no CPU round-trip.
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

export interface AlgorithmsScene {
  scene: SceneRenderer;
  seg: EditableSegmentation;
  paint: PaintEffect;
  driver: SegEditDriver;      // consumes SegEdit ops (A-1) — the same path a Slicer stream drives
  center: Vec3;
  radius: number;
  dims: Vec3;
  /** Stamp a sphere dab through the shared buffer (A-0 live-update poke, via PaintEffect). */
  poke(centerRAS: Vec3, radiusMm: number): void;
  /** Called after any edit (post-rebake) so the app redraws. Persists across render-mode swaps. */
  onRedraw(cb: () => void): void;
  /** Swap the render path (sdf ↔ surface) live, preserving the painted segmentation. */
  setRenderMode(mode: "sdf" | "surface"): void;
  renderMode(): "sdf" | "surface";
}

/** Build the A-0 scene: a synthetic sphere segment rendered in surface mode. */
export function buildAlgorithmsScene(gpu: Gpu, format?: GPUTextureFormat): AlgorithmsScene {
  const dims: Vec3 = [96, 96, 96];
  const sp = 2; // 2 mm isotropic
  // Row-major voxel-center → RAS: 2 mm spacing, centred so voxel (48,48,48) → RAS origin.
  const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];

  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const paint = new PaintEffect(seg);
  const driver = new SegEditDriver(seg);

  const scene = new SceneRenderer(gpu, format);

  // The render path is swappable (sdf = crisp terrace-free default; surface = Gaussian gradient-
  // opacity). A swap rebuilds the SegmentationLogic over the SAME master (content preserved) and
  // rebuilds the scene fields. A persistent redraw hook survives the swap. setBackground must FOLLOW
  // scene.build (build re-creates the uniform buffer), so it's re-applied inside makeLogic.
  const redrawCbs: Array<() => void> = [];
  let mode: "sdf" | "surface" = "sdf";
  let logic!: SegmentationLogic;
  const makeLogic = () => {
    logic = new SegmentationLogic(gpu.device, seg, { renderMode: mode, color: [0.30, 0.85, 0.55], opacity: 1.0, sigmaVoxels: 1.0 });
    logic.onRedraw(() => { for (const cb of redrawCbs) cb(); });
    scene.build([logic.field()]);
    scene.setBackground(0.05, 0.06, 0.09);
  };
  makeLogic();

  // Seed an initial sphere via the CPU load path (proves loadLabelmap): id 1, ~15-voxel radius at grid centre.
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

  return {
    scene, seg, paint, driver, center, radius, dims,
    poke(centerRAS, radiusMm) { paint.stampStroke([centerRAS], { radiusMm, id: 1, mode: "add" }); },
    onRedraw(cb) { redrawCbs.push(cb); },
    setRenderMode(m) {
      if (m === mode) return;
      logic.destroy();          // unsubscribes its onDirty + frees GPU textures
      mode = m;
      makeLogic();              // new logic over the SAME master (content preserved) + rebuild scene
      for (const cb of redrawCbs) cb();
    },
    renderMode: () => mode,
  };
}
