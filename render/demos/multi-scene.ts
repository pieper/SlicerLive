// Shared synthetic multi-volume scene (two off-origin spheres, distinct LUTs) used
// by the Deno validation test and the browser gallery demo. Exercises the
// multi-field SceneRenderer.
import { ImageField } from "../fields.ts";
import type { Vec3 } from "../mat4.ts";

export const D = 96, SP = 1.5, DIST = 430;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function sphere(radiusVox: number, value: number): Float32Array {
  const data = new Float32Array(D * D * D);
  const c = (D - 1) / 2;
  for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    const r = Math.hypot(x - c, y - c, z - c);
    data[(z * D + y) * D + x] = value * clamp01((radiusVox - r) / 3);
  }
  return data;
}

export function solidLUT(rgb: [number, number, number], aMax: number): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const a = i < 20 ? 0 : aMax * clamp01((i - 20) / 120);
    lut[i * 4] = Math.round(rgb[0] * 255); lut[i * 4 + 1] = Math.round(rgb[1] * 255);
    lut[i * 4 + 2] = Math.round(rgb[2] * 255); lut[i * 4 + 3] = Math.round(a * 255);
  }
  return lut;
}

/** Two spheres side by side (warm left, cool right) as two ImageFields. */
export function buildDualSphereFields(dev: GPUDevice): ImageField[] {
  const dims: Vec3 = [D, D, D], sp: Vec3 = [SP, SP, SP], shade: [number, number, number, number] = [0.35, 0.75, 0.4, 24];
  return [
    new ImageField(dev, sphere(30, 200), dims, sp, solidLUT([0.85, 0.35, 0.30], 0.9), { clim: [0, 255], center: [-72, 0, 0], shade }),
    new ImageField(dev, sphere(30, 200), dims, sp, solidLUT([0.35, 0.65, 0.95], 0.9), { clim: [0, 255], center: [72, 0, 10], shade }),
  ];
}
