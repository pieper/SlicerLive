// Shared synthetic scene used by the Deno PNG test and the browser demo:
// a translucent warm soft-tissue shell with a dense bone-white inner blob.
import type { Vec3 } from "../mat4.ts";

export const N = 128;
export const SPACING: Vec3 = [1.5, 1.5, 1.5];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function syntheticVolume(): Float32Array {
  const data = new Float32Array(N * N * N);
  const c = (N - 1) / 2;
  const ic = [c + 16, c, c + 12]; // inner dense sphere, offset so it reads as a distinct blob
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const ro = Math.hypot(x - c, y - c, z - c);
        const ri = Math.hypot(x - ic[0], y - ic[1], z - ic[2]);
        const soft = 45 * clamp01((44 - ro) / 3);
        const dense = 210 * clamp01((20 - ri) / 3);
        data[(z * N + y) * N + x] = Math.max(soft, dense);
      }
    }
  }
  return data;
}

export function buildLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    if (i >= 15 && i < 120) {
      const t = clamp01((i - 25) / 55);
      r = 0.78; g = 0.40; b = 0.34; a = 0.02 + 0.11 * t;
    } else if (i >= 120) {
      const t = clamp01((i - 120) / 100);
      r = 0.80 + 0.15 * t; g = 0.76 + 0.16 * t; b = 0.66 + 0.19 * t; a = 0.25 + 0.65 * t;
    }
    lut[i * 4] = Math.round(r * 255); lut[i * 4 + 1] = Math.round(g * 255);
    lut[i * 4 + 2] = Math.round(b * 255); lut[i * 4 + 3] = Math.round(a * 255);
  }
  return lut;
}

// Orbit camera: eye on a sphere around the origin (azimuth/elevation, radians; RAS up=+z).
export function orbitEye(azimuth: number, elevation: number, distance: number): Vec3 {
  const ce = Math.cos(elevation);
  return [
    distance * ce * Math.sin(azimuth),
    -distance * ce * Math.cos(azimuth),
    distance * Math.sin(elevation),
  ];
}
