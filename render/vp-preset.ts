// Murat Maga's published volume-rendering transfer functions (github.com/SlicerMorph/VPs) → the
// renderer's colour/opacity LUT. The presets are Slicer volume-property JSON with absolute
// intensity x-values (tuned to one reference volume); we REMAP them onto a target volume's observed
// [lo,hi] so a preset's shape (e.g. diceCT hot-iron) applies to any specimen regardless of its
// bit depth. CORS-fetchable, so this runs on the server or in the browser.
import { lutFromTransferFunctions, type TF } from "./scene-volume.ts";

export const VP_BASE = "https://raw.githubusercontent.com/SlicerMorph/VPs/main/presets/";
/** Named SlicerMorph presets (all @muratmaga). */
export const VP_PRESETS: Record<string, string> = {
  "diceCT_16": "diceCT_16.vp.json",
  "CT-Chest-Contrast-Enhanced": "CT-Chest-Contrast-Enhanced.vp.json",
  "Bat-8bit": "Bat-8bit.vp.json",
  "Skin": "Skin.vp.json",
  "Skin_and_Skel": "Skin_and_Skel.vp.json",
};

export interface PresetLut { lut: Uint8Array; clim: [number, number]; shade: [number, number, number, number] }

interface VpPoint { x: number; color?: number[]; y?: number }
interface VpComp { rgbTransferFunction: { points: VpPoint[] }; scalarOpacity: { points: VpPoint[] }; shade?: boolean; lighting?: { ambient: number; diffuse: number; specular: number; specularPower: number } }
interface Vp { volumeProperties: { components: VpComp[]; effectiveRange?: [number, number] }[] }

export async function fetchVP(name: string): Promise<Vp> {
  const file = VP_PRESETS[name] ?? name;
  const url = file.startsWith("http") ? file : VP_BASE + file;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`VP fetch ${r.status} ${url}`);
  return await r.json() as Vp;
}

/** Build a LUT from a fetched VP, remapping its intensity range onto the volume's [lo,hi]. */
export function lutFromVP(vp: Vp, volRange: [number, number]): PresetLut {
  const vprop = vp.volumeProperties[0];
  const comp = vprop.components[0];
  const cpts = comp.rgbTransferFunction.points;
  const eff = vprop.effectiveRange ?? [cpts[0].x, cpts[cpts.length - 1].x];
  // Some presets (e.g. diceCT_16) set effectiveRange[0] at the TOP of their opacity ramp, above the
  // transparent foot — stretching that onto the volume range clips the transparent lead-in, so air
  // (the low tail) renders as opaque black fog. Extend the low bound down to the last opacity=0
  // control point below the ramp, so air stays transparent (presets already anchored at their foot,
  // like Bat-8bit, are unaffected).
  const opRaw = comp.scalarOpacity.points.map((p: { x: number; y?: number }) => [p.x, p.y ?? 0] as [number, number]);
  const firstNZ = opRaw.find((p) => p[1] > 0);
  let effLo = eff[0];
  if (firstNZ) {
    const zerosBelow = opRaw.filter((p) => p[1] === 0 && p[0] < firstNZ[0]).map((p) => p[0]);
    if (zerosBelow.length) effLo = Math.min(effLo, Math.max(...zerosBelow));
  }
  const [vpLo, vpHi] = [effLo, eff[1]];
  const [vLo, vHi] = volRange;
  const remap = (x: number) => vLo + ((x - vpLo) / Math.max(vpHi - vpLo, 1e-9)) * (vHi - vLo);
  const colorTF: TF = cpts.map((p) => [remap(p.x), p.color![0], p.color![1], p.color![2]]);
  const opacityTF: TF = comp.scalarOpacity.points.map((p) => [remap(p.x), p.y ?? 0]);
  colorTF.sort((a, b) => a[0] - b[0]);
  opacityTF.sort((a, b) => a[0] - b[0]);
  const L = comp.lighting ?? { ambient: 0.3, diffuse: 0.6, specular: 0.5, specularPower: 40 };
  const shade: [number, number, number, number] = comp.shade !== false ? [L.ambient, L.diffuse, L.specular, L.specularPower] : [1, 0, 0, 1];
  const clim: [number, number] = [vLo, vHi];
  return { lut: lutFromTransferFunctions(colorTF, opacityTF, clim), clim, shade };
}
