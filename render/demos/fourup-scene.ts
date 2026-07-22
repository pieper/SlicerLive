// Shared 4-up scene: a CT-like scalar volume (nested sphere) + a 2-label
// segmentation baked to a colored volume. Feeds three MPR slices (grayscale CT +
// colored overlay) and a 3D ColorizeVolume view.
import { N, SPACING, syntheticVolume } from "./sphere-scene.ts";
import { createScalarTexture } from "../textures.ts";
import { bakeColorizeRGBA } from "../bake.ts";
import { RGBAVolumeField } from "../fields.ts";
import type { Vec3 } from "../mat4.ts";

export interface FourUpScene {
  scalarTex: GPUTexture;
  colorizeTex: GPUTexture;
  dims: Vec3;
  spacing: Vec3;
  win: number;
  lev: number;
  field3d: RGBAVolumeField; // 3D colorized-segmentation view
}

export function buildFourUpScene(dev: GPUDevice): FourUpScene {
  const dims: Vec3 = [N, N, N], spacing: Vec3 = [SPACING[0], SPACING[1], SPACING[2]];
  const data = syntheticVolume();
  const lab = new Uint8Array(N * N * N);
  for (let i = 0; i < lab.length; i++) { const v = data[i]; lab[i] = v >= 150 ? 1 : v >= 20 ? 2 : 0; } // core / shell

  const pal = new Float32Array(256 * 4);
  const set = (i: number, r: number, g: number, b: number, a: number) => { pal[i * 4] = r; pal[i * 4 + 1] = g; pal[i * 4 + 2] = b; pal[i * 4 + 3] = a; };
  set(1, 0.95, 0.80, 0.35, 0.95); // dense core -> gold
  set(2, 0.30, 0.62, 0.72, 0.55); // soft shell -> teal (translucent)

  const scalarTex = createScalarTexture(dev, data, dims);
  const colorizeTex = bakeColorizeRGBA(dev, lab, dims, pal, 1.5);
  const field3d = new RGBAVolumeField(colorizeTex, dims, spacing, { opacityUnitDistance: SPACING[0], shade: [0.30, 0.78, 0.5, 28] });

  return { scalarTex, colorizeTex, dims, spacing, win: 240, lev: 110, field3d };
}
