// Modality-appropriate VR transfer function (shared by the seged app scene) — grayscale + bone-weighted
// opacity for CT/MR, hot-metal for PET. Kept translucent so it reads as anatomical CONTEXT behind the
// colored segmentation. (Lifted from segroulette-scene so the seged scene doesn't depend on it.)
export function modalityLUT(modality: string | undefined, maxAlpha = 0.42): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  const m = (modality ?? "CT").toUpperCase();
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number, a: number;
    if (m === "PET" || m === "PT") {
      r = Math.min(1, t * 3); g = Math.min(1, Math.max(0, t * 3 - 1)); b = Math.min(1, Math.max(0, t * 3 - 2));
      a = Math.max(0, (t - 0.25) / 0.75) * 0.9;
    } else {
      r = g = b = t;
      let aa = Math.max(0, (t - 0.42) / 0.58); aa *= aa;
      a = Math.min(maxAlpha, aa);
    }
    lut[i * 4] = Math.round(r * 255); lut[i * 4 + 1] = Math.round(g * 255); lut[i * 4 + 2] = Math.round(b * 255); lut[i * 4 + 3] = Math.round(a * 255);
  }
  return lut;
}
