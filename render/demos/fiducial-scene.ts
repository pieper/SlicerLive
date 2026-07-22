// "Volume + Fiducials" selftest port: the synthetic soft-tissue/bone volume with a
// handful of markup pushpins placed on its surface — exercising the procedural
// FiducialField alongside the ImageField in one ray-march (same premultiplied-OVER
// compositing). Deterministic (no network) so it doubles as a visual-regression case.
import { ImageField } from "../fields.ts";
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { N, SPACING, buildLUT, syntheticVolume } from "./sphere-scene.ts";
import type { Vec3 } from "../mat4.ts";

// Slicer-ish markup palette (opaque pushpins).
const PALETTE: [number, number, number, number][] = [
  [0.95, 0.30, 0.25, 1], // red
  [0.40, 0.85, 0.35, 1], // green
  [0.95, 0.82, 0.30, 1], // yellow
  [0.60, 0.45, 0.95, 1], // violet
  [0.30, 0.80, 0.90, 1], // cyan
  [0.95, 0.55, 0.85, 1], // pink
];

/** Place `count` pushpins on the soft-tissue shell (world radius ~70mm around origin). */
export function surfaceFiducials(count = 6, radius = 70, pin = 5): Sphere[] {
  const out: Sphere[] = [];
  for (let i = 0; i < count; i++) {
    const az = (i / count) * Math.PI * 2 + 0.4;
    const el = ((i % 3) - 1) * 0.5;   // spread over three elevations
    const ce = Math.cos(el);
    const center: Vec3 = [radius * ce * Math.sin(az), -radius * ce * Math.cos(az), radius * Math.sin(el)];
    out.push({ center, radius: pin, color: PALETTE[i % PALETTE.length] });
  }
  return out;
}

export interface FiducialScene { image: ImageField; fiducials: FiducialField }

export function buildFiducialScene(dev: GPUDevice): FiducialScene {
  const image = new ImageField(dev, syntheticVolume(), [N, N, N], SPACING, buildLUT(), { clim: [0, 255], shade: [0.35, 0.75, 0.35, 24] });
  const fiducials = new FiducialField(surfaceFiducials(), { shininess: 90, kSpecular: 0.6 });
  return { image, fiducials };
}
