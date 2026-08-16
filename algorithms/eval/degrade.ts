// Blinded-degradation eval (seged prototype) — take a gold-standard segmentation, apply a RANDOMIZED
// flaw to one segment, and hide both the pristine ground truth and the transform behind an API so the
// agent must diagnose the flaw from renders alone, refine it, and only then reveal the Dice score.
//
// v1 flaw: a BOUNDARY LEAK — the segment bleeds outward, in a biased direction, into neighboring
// background (the LNQ-relevant failure mode: a node mask leaking into an adjacent vessel/muscle). Pure
// labelmap math (no GPU) so it's trivially correct and testable; the app applies the result to the
// EditableSegmentation and re-renders.
import type { Vec3 } from "../geom.ts";

export type FlawKind = "leak" | "erode" | "dilate" | "shift" | "partial-delete";

export interface DegradeParams {
  kind: FlawKind;
  label: number;        // which segment was degraded
  radiusVox: number;    // extent of the flaw in voxels
  dir?: Vec3;           // biased direction (leak/shift), unit-ish in voxel space
}

/** Dice for one label between two labelmaps of equal length. */
export function dice(a: ArrayLike<number>, b: ArrayLike<number>, label: number): number {
  let inter = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ia = a[i] === label ? 1 : 0, ib = b[i] === label ? 1 : 0;
    inter += ia & ib; na += ia; nb += ib;
  }
  return na + nb === 0 ? 1 : (2 * inter) / (na + nb);
}

/** Count voxels of a label. */
export function labelCount(lab: ArrayLike<number>, label: number): number {
  let n = 0; for (let i = 0; i < lab.length; i++) if (lab[i] === label) n++; return n;
}

const idx = (x: number, y: number, z: number, d: Vec3) => (z * d[1] + y) * d[0] + x;

/** BOUNDARY LEAK: grow `label` by up to `radiusVox` into BACKGROUND (0) voxels, biased toward `dir`
 *  (only offsets whose projection on dir is positive leak), producing a directional bulge over the
 *  segment's surface. Returns a new labelmap. Deterministic given inputs. */
export function boundaryLeak(lab: Uint8Array, dims: Vec3, label: number, radiusVox: number, dir: Vec3): Uint8Array {
  const out = Uint8Array.from(lab);
  const [nx, ny, nz] = dims;
  const r = Math.max(1, Math.round(radiusVox));
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const u: Vec3 = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  // precompute the biased spherical offset stencil (offsets within r whose dir-projection > 0)
  const offs: Vec3[] = [];
  for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd === 0 || dd > r * r) continue;
    if (dx * u[0] + dy * u[1] + dz * u[2] <= 0.35 * Math.sqrt(dd)) continue;   // keep the leak directional (a cone-ish bulge)
    offs.push([dx, dy, dz]);
  }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (lab[idx(x, y, z, dims)] !== label) continue;   // grow from surface of the segment
    for (const [dx, dy, dz] of offs) {
      const xx = x + dx, yy = y + dy, zz = z + dz;
      if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
      const j = idx(xx, yy, zz, dims);
      if (lab[j] === 0) out[j] = label;   // leak only into background — a clean, measurable over-call
    }
  }
  return out;
}

/** A blinded degraded case: holds the pristine GT + the chosen transform PRIVATELY; exposes only the
 *  degraded labelmap and a score()/reveal() the agent calls after it has finished refining. The agent
 *  blinds itself by never calling reveal() (or reading `rng`) until it has committed its fix. */
export class BlindedCase {
  private gt: Uint8Array;
  private params: DegradeParams;
  readonly degraded: Uint8Array;

  constructor(gt: Uint8Array, dims: Vec3, label: number, rng: () => number, radiusVox = 3) {
    this.gt = Uint8Array.from(gt);
    // random biased direction (kept private)
    const az = rng() * Math.PI * 2, el = (rng() - 0.5) * Math.PI;
    const dir: Vec3 = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
    this.params = { kind: "leak", label, radiusVox, dir };
    this.degraded = boundaryLeak(this.gt, dims, label, radiusVox, dir);
  }

  /** Dice of a candidate labelmap vs the hidden GT for the degraded label (scoring only). */
  score(candidate: ArrayLike<number>): { label: number; diceVsGT: number } {
    return { label: this.params.label, diceVsGT: dice(candidate, this.gt, this.params.label) };
  }
  /** Dice of the initial degraded map vs GT — the baseline the agent must beat. */
  baselineDice(): number { return dice(this.degraded, this.gt, this.params.label); }
  /** Reveal what was done — call ONLY after committing a fix (breaks blinding). */
  reveal(): DegradeParams & { gtCount: number; degradedCount: number } {
    return { ...this.params, gtCount: labelCount(this.gt, this.params.label), degradedCount: labelCount(this.degraded, this.params.label) };
  }
}
