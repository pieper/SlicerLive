// Shared ColorizeVolume demo scene: a synthetic multi-label segmentation baked to
// an rgba16float volume and rendered by an RGBAVolumeField. Exercises bake.ts +
// the "rgba" field — the path a real segmentation (e.g. nnLive's mask) will take.
import { bakeColorizeRGBA } from "../bake.ts";
import { RGBAVolumeField } from "../fields.ts";
import type { Vec3 } from "../mat4.ts";

export const D = 112, SP = 1.5, DIST = 440;

export function makeLabelmap(): Uint8Array {
  const lab = new Uint8Array(D * D * D);
  const c = (D - 1) / 2;
  const blobs: Array<[Vec3, number, number]> = [
    [[c - 30, c, c], 22, 1],
    [[c + 30, c, c], 22, 2],
    [[c, c + 6, c + 30], 18, 3],
  ];
  for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    for (const [ctr, r, label] of blobs) {
      if (Math.hypot(x - ctr[0], y - ctr[1], z - ctr[2]) <= r) { lab[(z * D + y) * D + x] = label; break; }
    }
  }
  return lab;
}

export function palette(): Float32Array {
  const p = new Float32Array(256 * 4);
  const set = (i: number, r: number, g: number, b: number, a: number) => { p[i * 4] = r; p[i * 4 + 1] = g; p[i * 4 + 2] = b; p[i * 4 + 3] = a; };
  set(1, 0.90, 0.30, 0.26, 0.95); // red
  set(2, 0.35, 0.80, 0.42, 0.95); // green
  set(3, 0.35, 0.68, 0.95, 0.95); // cyan
  return p;
}

/** Bake the synthetic segmentation and wrap it as an RGBAVolumeField. */
export function buildColorizeField(dev: GPUDevice): RGBAVolumeField {
  const dims: Vec3 = [D, D, D], sp: Vec3 = [SP, SP, SP];
  const tex = bakeColorizeRGBA(dev, makeLabelmap(), dims, palette(), 1.8);
  return new RGBAVolumeField(tex, dims, sp, { opacityUnitDistance: SP, shade: [0.30, 0.78, 0.5, 28] });
}
